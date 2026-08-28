import { Agent } from 'undici';
import { logger } from '../../config/logger.js';
import { redactSecrets } from '../../security/redact.js';

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

export interface PeopleSoftHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export interface PeopleSoftClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  requestTimeoutMs?: number;
}

export class PeopleSoftSessionExpiredError extends Error {
  public constructor(message = 'PeopleSoft session has expired or is invalid') {
    super(message);
    this.name = 'PeopleSoftSessionExpiredError';
  }
}

export class PeopleSoftHttpError extends Error {
  public readonly status: number;
  public readonly statusText: string;

  public constructor(status: number, statusText: string, message: string) {
    super(message);
    this.name = 'PeopleSoftHttpError';
    this.status = status;
    this.statusText = statusText;
  }
}

/**
 * Low-level HTTP transport client for PeopleSoft Fluid portal requests.
 */
export class PeopleSoftHttpClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly requestTimeoutMs: number;

  public constructor(options?: PeopleSoftClientOptions) {
    this.baseUrl = (options?.baseUrl ?? 'https://sis.auib.edu.iq').replace(/\/+$/, '');
    this.fetchFn = options?.fetchFn ?? createDefaultFetch();
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 20_000;
    this.defaultHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options?.defaultHeaders ?? {}),
    };
  }

  /**
   * Normalizes cookies from string or object to a standard Cookie header string.
   */
  public static normalizeCookieHeader(cookies: unknown): string {
    if (typeof cookies === 'string') {
      return cookies.trim();
    }

    if (typeof cookies === 'object' && cookies !== null) {
      if ('rawCookies' in cookies && typeof cookies.rawCookies === 'string') {
        return cookies.rawCookies.trim();
      }

      if ('cookies' in cookies && typeof cookies.cookies === 'string') {
        return cookies.cookies.trim();
      }

      return Object.entries(cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('; ');
    }

    return '';
  }

  /**
   * Checks if response body or status indicates session timeout/expiration.
   */
  public static isSessionExpired(status: number, body: string, url: string): boolean {
    if (status === 401 || status === 403) {
      return true;
    }

    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.includes('signon') ||
      lowerUrl.includes('login') ||
      lowerUrl.includes('pspologin')
    ) {
      return true;
    }

    const lowerBody = body.toLowerCase();
    if (
      lowerBody.includes('your session has expired') ||
      lowerBody.includes('session timeout') ||
      lowerBody.includes('sign in with your account') ||
      (lowerBody.includes('name="userid"') && lowerBody.includes('name="pwd"'))
    ) {
      return true;
    }

    return false;
  }

  public async get(
    pathOrUrl: string,
    cookieHeader: string,
    additionalHeaders?: Record<string, string>,
  ): Promise<PeopleSoftHttpResponse> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

    return this.request(url, {
      method: 'GET',
      headers: {
        ...this.defaultHeaders,
        Cookie: cookieHeader,
        ...(additionalHeaders ?? {}),
      },
    });
  }

  public async postForm(
    pathOrUrl: string,
    formData: Record<string, string>,
    cookieHeader: string,
    additionalHeaders?: Record<string, string>,
  ): Promise<PeopleSoftHttpResponse> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

    const body = new URLSearchParams(formData).toString();

    return this.request(url, {
      method: 'POST',
      body,
      headers: {
        ...this.defaultHeaders,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookieHeader,
        ...(additionalHeaders ?? {}),
      },
    });
  }

  private async request(url: string, init: RequestInit): Promise<PeopleSoftHttpResponse> {
    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
      });
      const responseBody = await response.text();

      const headersRecord: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersRecord[key.toLowerCase()] = value;
      });

      const httpResponse: PeopleSoftHttpResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: headersRecord,
        body: responseBody,
        url: response.url || url,
      };

      if (
        PeopleSoftHttpClient.isSessionExpired(
          httpResponse.status,
          httpResponse.body,
          httpResponse.url,
        )
      ) {
        throw new PeopleSoftSessionExpiredError(
          `PeopleSoft session expired at URL: ${url} (HTTP ${String(httpResponse.status)})`,
        );
      }

      if (!response.ok) {
        throw new PeopleSoftHttpError(
          response.status,
          response.statusText,
          `PeopleSoft HTTP error ${String(response.status)} ${response.statusText} at ${url}`,
        );
      }

      return httpResponse;
    } catch (error) {
      if (error instanceof PeopleSoftSessionExpiredError || error instanceof PeopleSoftHttpError) {
        throw error;
      }

      logger.error({ err: redactSecrets(error) }, 'Network error during PeopleSoft request');
      throw error;
    }
  }
}
