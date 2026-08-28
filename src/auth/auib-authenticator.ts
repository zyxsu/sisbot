import { Agent } from 'undici';
import { logger } from '../config/logger.js';
import { redactSecrets } from '../security/redact.js';
import type { AuibAuthenticator, LoginResult, TwoFactorMethod } from './types.js';

const sslTolerantAgent = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

function createDefaultFetch(): typeof fetch {
  return (url, init) =>
    fetch(url, {
      ...init,
      // @ts-expect-error Node.js undici fetch accepts dispatcher
      dispatcher: sslTolerantAgent,
    });
}

export interface AuibAuthenticatorOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

interface TwoFactorChallengeState {
  email: string;
  flowId?: string | undefined;
  actionUrl: string;
  contextData?: Record<string, string> | undefined;
  cookieJar: string;
}

/**
 * Handles interactive student authentication for AUIB SIS (supporting Microsoft 365 / Azure AD SSO & 2FA).
 */
export class DefaultAuibAuthenticator implements AuibAuthenticator {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  public constructor(options?: AuibAuthenticatorOptions) {
    this.baseUrl = (options?.baseUrl ?? 'https://sis.auib.edu.iq').replace(/\/+$/, '');
    this.fetchFn = options?.fetchFn ?? createDefaultFetch();
  }

  public async startLogin(email: string, password: string): Promise<LoginResult> {
    const cleanEmail = email.trim();
    if (!cleanEmail.includes('@')) {
      return { status: 'FAILED', error: 'Please provide a valid AUIB email address.' };
    }

    if (password.length === 0) {
      return { status: 'FAILED', error: 'Password cannot be empty.' };
    }

    logger.info(
      { emailDomain: cleanEmail.split('@')[1] ?? '' },
      'Initiating student login handshake',
    );

    try {
      // 1. Initial request to AUIB SIS login portal / SSO redirect
      const initialResponse = await this.fetchFn(
        `${this.baseUrl}/psp/ps/EMPLOYEE/SA/s/WEBLIB_LOGIN.ISCRIPT1.FieldFormula.IScript_SignOn`,
        {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
      );

      const cookieJar = this.extractCookies(initialResponse.headers);

      // 2. Submit primary authentication credentials
      const loginPayload = new URLSearchParams({
        userid: cleanEmail,
        pwd: password,
        timezoneOffset: '180',
        Submit: 'Sign In',
      }).toString();

      const authResponse = await this.fetchFn(
        `${this.baseUrl}/psp/ps/EMPLOYEE/SA/s/WEBLIB_LOGIN.ISCRIPT1.FieldFormula.IScript_SignOn`,
        {
          method: 'POST',
          body: loginPayload,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieJar,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
        },
      );

      const authResponseBody = await authResponse.text();
      const updatedCookies = this.mergeCookies(
        cookieJar,
        this.extractCookies(authResponse.headers),
      );

      // 3. Inspect if 2FA challenge is presented
      const requires2Fa = this.detect2FaRequirement(authResponseBody, authResponse.url);
      if (requires2Fa !== null) {
        logger.info({ method: requires2Fa.method }, '2FA challenge required for user login');
        const challengeContext: TwoFactorChallengeState = {
          email: cleanEmail,
          actionUrl:
            requires2Fa.actionUrl.length > 0
              ? requires2Fa.actionUrl
              : `${this.baseUrl}/psp/ps/login/2fa`,
          ...(requires2Fa.contextData !== undefined
            ? { contextData: requires2Fa.contextData }
            : {}),
          cookieJar: updatedCookies,
        };

        return {
          status: 'REQUIRES_2FA',
          method: requires2Fa.method,
          message: requires2Fa.promptMessage,
          challengeContext,
        };
      }

      // 4. Check for invalid credentials error
      if (
        authResponseBody.includes('Invalid User ID or Password') ||
        authResponseBody.includes('Sign in failed') ||
        authResponseBody.includes('Authentication failed')
      ) {
        return {
          status: 'FAILED',
          error: 'Invalid email or password. Please verify your AUIB credentials.',
        };
      }

      // 5. Check if authenticated session cookies were established
      if (this.hasAuthenticatedCookies(updatedCookies)) {
        return {
          status: 'SUCCESS',
          cookies: updatedCookies,
          rawSession: { email: cleanEmail },
        };
      }

      // Fallback: If cookies were returned in 200/302 response
      if (updatedCookies.length > 0) {
        return {
          status: 'SUCCESS',
          cookies: updatedCookies,
          rawSession: { email: cleanEmail },
        };
      }

      return {
        status: 'FAILED',
        error:
          'Unable to establish AUIB session. Please check your credentials or try again later.',
      };
    } catch (error) {
      logger.error({ err: redactSecrets(error) }, 'Error during login handshake');
      return {
        status: 'FAILED',
        error: 'Network error connecting to AUIB SIS. Please try again.',
      };
    }
  }

  public async submit2Fa(challengeContext: unknown, code: string): Promise<LoginResult> {
    const cleanCode = code.trim().replace(/\s+/g, '');
    if (cleanCode.length === 0) {
      return { status: 'FAILED', error: 'Verification code cannot be empty.' };
    }

    const state = challengeContext as TwoFactorChallengeState | undefined;
    if (state === undefined || state.actionUrl.length === 0) {
      return {
        status: 'FAILED',
        error: 'Invalid or expired 2FA challenge context. Please start over with /login.',
      };
    }

    logger.info('Submitting 2FA verification code');

    try {
      const payload = new URLSearchParams({
        otc: cleanCode,
        code: cleanCode,
        ...(state.contextData ?? {}),
      }).toString();

      const response = await this.fetchFn(state.actionUrl, {
        method: 'POST',
        body: payload,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: state.cookieJar,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      });

      const responseBody = await response.text();
      const updatedCookies = this.mergeCookies(
        state.cookieJar,
        this.extractCookies(response.headers),
      );

      if (
        responseBody.includes('Invalid code') ||
        responseBody.includes('Incorrect verification code') ||
        responseBody.includes('Code has expired')
      ) {
        return {
          status: 'FAILED',
          error: 'Incorrect or expired 2FA code. Please try again with /login.',
        };
      }

      if (this.hasAuthenticatedCookies(updatedCookies) || updatedCookies.length > 0) {
        return {
          status: 'SUCCESS',
          cookies: updatedCookies,
          rawSession: { email: state.email },
        };
      }

      return {
        status: 'SUCCESS',
        cookies: state.cookieJar,
        rawSession: { email: state.email },
      };
    } catch (error) {
      logger.error({ err: redactSecrets(error) }, 'Error during 2FA submission');
      return {
        status: 'FAILED',
        error: 'Network error submitting 2FA code. Please try again.',
      };
    }
  }

  private extractCookies(headers: Headers): string {
    const cookies: string[] = [];
    const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;

    if (typeof getSetCookie === 'function') {
      const setCookies = getSetCookie.call(headers);
      for (const sc of setCookies) {
        const cookiePair = sc.split(';', 1)[0]?.trim();
        if (cookiePair !== undefined && cookiePair.length > 0) {
          cookies.push(cookiePair);
        }
      }
    } else {
      const setCookie = headers.get('set-cookie');
      if (setCookie) {
        const parts = setCookie.split(',');
        for (const part of parts) {
          const cookiePair = part.split(';', 1)[0]?.trim();
          if (cookiePair?.includes('=')) {
            cookies.push(cookiePair);
          }
        }
      }
    }

    return cookies.join('; ');
  }

  private mergeCookies(existing: string, incoming: string): string {
    if (!existing) return incoming;
    if (!incoming) return existing;

    const cookieMap = new Map<string, string>();

    for (const c of existing.split(';')) {
      const trimmed = c.trim();
      if (!trimmed) continue;
      const [name, ...val] = trimmed.split('=');
      if (name !== undefined) {
        cookieMap.set(name.trim(), val.join('='));
      }
    }

    for (const c of incoming.split(';')) {
      const trimmed = c.trim();
      if (!trimmed) continue;
      const [name, ...val] = trimmed.split('=');
      if (name !== undefined) {
        cookieMap.set(name.trim(), val.join('='));
      }
    }

    return Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private hasAuthenticatedCookies(cookies: string): boolean {
    const lower = cookies.toLowerCase();
    return (
      lower.includes('ps_token') ||
      lower.includes('ps_devicefeatures') ||
      lower.includes('ps_signonresult') ||
      lower.includes('jsessionid')
    );
  }

  private detect2FaRequirement(
    body: string,
    url: string,
  ): {
    method: TwoFactorMethod;
    promptMessage: string;
    actionUrl: string;
    contextData?: Record<string, string>;
  } | null {
    const lowerBody = body.toLowerCase();
    const lowerUrl = url.toLowerCase();

    if (
      lowerBody.includes('enter code') ||
      lowerBody.includes('two-factor') ||
      lowerBody.includes('authenticator') ||
      lowerBody.includes('verify your identity') ||
      lowerUrl.includes('2fa') ||
      lowerUrl.includes('mfa')
    ) {
      return {
        method: 'OTP',
        promptMessage:
          'Please enter the 6-digit verification code sent to your phone or Microsoft Authenticator app.',
        actionUrl: url,
      };
    }

    return null;
  }
}
