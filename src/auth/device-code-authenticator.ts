import { Agent } from 'undici';
import { logger } from '../config/logger.js';
import { redactSecrets } from '../security/redact.js';
import type { LoginResult } from './types.js';

const sslTolerantAgent = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  message: string;
}

export interface MicrosoftDeviceCodeAuthenticatorOptions {
  tenantId?: string;
  clientId?: string;
  scope?: string;
  fetchFn?: typeof fetch;
}

interface DeviceCodeInitResponse {
  user_code?: string;
  device_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
  error?: string;
  error_description?: string;
}

interface TokenPollResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Handles Microsoft 365 Entra ID Device Code authentication flow for AUIB students.
 */
export class MicrosoftDeviceCodeAuthenticator {
  private readonly tenantId: string;
  private readonly clientId: string;
  private readonly scope: string;
  private readonly fetchFn: typeof fetch;

  public constructor(options?: MicrosoftDeviceCodeAuthenticatorOptions) {
    this.tenantId = options?.tenantId ?? '9da9cdef-03cb-4ac9-88b5-2aab060b2491';
    this.clientId = options?.clientId ?? 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
    this.scope = options?.scope ?? 'User.Read openid profile email offline_access';
    this.fetchFn =
      options?.fetchFn ??
      ((url, init) =>
        fetch(url, {
          ...init,
          // @ts-expect-error Node.js undici fetch accepts dispatcher
          dispatcher: sslTolerantAgent,
        }));
  }

  /**
   * Requests a new Device Code from Microsoft Entra ID.
   */
  public async requestDeviceCode(): Promise<{
    userCode: string;
    deviceCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
    message: string;
  }> {
    const url = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/devicecode`;
    const payload = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scope,
    }).toString();

    const response = await this.fetchFn(url, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = (await response.json()) as DeviceCodeInitResponse;

    if (
      data.error !== undefined ||
      data.user_code === undefined ||
      data.device_code === undefined
    ) {
      const errorMsg =
        data.error_description ?? data.error ?? 'Failed to initialize Microsoft login';
      logger.error({ err: errorMsg }, 'Error from Microsoft devicecode endpoint');
      throw new Error(errorMsg);
    }

    return {
      userCode: data.user_code,
      deviceCode: data.device_code,
      verificationUri: data.verification_uri ?? 'https://login.microsoft.com/device',
      expiresIn: data.expires_in ?? 900,
      interval: data.interval ?? 5,
      message:
        data.message ?? `Go to https://login.microsoft.com/device and enter code ${data.user_code}`,
    };
  }

  /**
   * Polls Microsoft token endpoint until student authorizes on their phone or times out.
   */
  public async pollForToken(
    deviceCode: string,
    intervalSeconds = 5,
    maxWaitSeconds = 600,
    onPending?: () => void,
  ): Promise<LoginResult> {
    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const startTime = Date.now();
    const pollIntervalMs = Math.max(intervalSeconds, 3) * 1000;

    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      try {
        const payload = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: this.clientId,
          device_code: deviceCode,
        }).toString();

        const response = await this.fetchFn(tokenUrl, {
          method: 'POST',
          body: payload,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });

        const data = (await response.json()) as TokenPollResponse;

        if (data.access_token !== undefined) {
          logger.info('Microsoft 365 OAuth authorization completed successfully');

          // Exchange tokens for PeopleSoft / Datawiza authenticated session
          const sessionCookies = await this.exchangeTokenForSession(
            data.access_token,
            data.id_token,
          );

          return {
            status: 'SUCCESS',
            cookies: sessionCookies,
            rawSession: {
              accessToken: data.access_token,
              idToken: data.id_token,
              refreshToken: data.refresh_token,
            },
          };
        }

        if (data.error === 'authorization_pending') {
          if (onPending !== undefined) {
            onPending();
          }
          continue;
        }

        if (data.error === 'authorization_declined') {
          return {
            status: 'FAILED',
            error: 'Sign-in was declined on the Microsoft approval page.',
          };
        }

        if (data.error === 'expired_token') {
          return {
            status: 'FAILED',
            error: 'Sign-in code expired. Please use /login to generate a new code.',
          };
        }

        if (data.error !== undefined) {
          return {
            status: 'FAILED',
            error: data.error_description ?? data.error,
          };
        }
      } catch (pollError) {
        logger.error({ err: redactSecrets(pollError) }, 'Error polling Microsoft token endpoint');
      }
    }

    return {
      status: 'FAILED',
      error: 'Sign-in timed out. Please run /login to try again.',
    };
  }

  /**
   * Exchanges the OAuth tokens with Datawiza / PeopleSoft to establish authenticated cookies.
   */
  private async exchangeTokenForSession(accessToken: string, idToken?: string): Promise<string> {
    try {
      const response = await this.fetchFn(
        'https://sis.auib.edu.iq/datawiza/authorization-code/callback',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(idToken !== undefined ? { 'X-ID-Token': idToken } : {}),
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
        },
      );

      const setCookies = response.headers.get('set-cookie');
      if (setCookies) {
        return setCookies;
      }
    } catch (err) {
      logger.warn({ err: redactSecrets(err) }, 'Datawiza token exchange notice');
    }

    // Fallback: Return token authorization header format for authenticated calls
    return `Bearer ${accessToken}`;
  }
}
