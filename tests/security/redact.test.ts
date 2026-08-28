import { describe, expect, it } from 'vitest';

import {
  REDACTED_VALUE,
  isSensitiveLogKey,
  redactSecrets,
  redactString,
} from '../../src/security/redact.js';

describe('secret redaction', () => {
  it.each([
    'Cookie',
    'cookie',
    'Set-Cookie',
    'authorization',
    'PS_TOKEN',
    'JSESSIONID',
    'ICSID',
    'cf_clearance',
    'userId',
    'telegramId',
    'sessionId',
  ])('recognizes %s as sensitive', (key) => {
    expect(isSensitiveLogKey(key)).toBe(true);
  });

  it('redacts sensitive headers and fields throughout an object', () => {
    const secrets = {
      authorization: 'authorization-secret-for-test',
      psToken: 'ps-token-secret-for-test',
      javaSession: 'java-session-secret-for-test',
      icSession: 'ic-session-secret-for-test',
      cloudflare: 'cloudflare-secret-for-test',
    };
    const source = {
      request: {
        headers: {
          Authorization: `Bearer ${secrets.authorization}`,
          Cookie: `PS_TOKEN=${secrets.psToken}; JSESSIONID=${secrets.javaSession}`,
          accept: 'text/html',
        },
      },
      response: {
        headers: {
          'Set-Cookie': [
            `ICSID=${secrets.icSession}; Secure`,
            `cf_clearance=${secrets.cloudflare}; HttpOnly`,
          ],
        },
      },
      session: {
        PS_TOKEN: secrets.psToken,
        JSESSIONID: secrets.javaSession,
        ICSID: secrets.icSession,
        cf_clearance: secrets.cloudflare,
      },
    };

    const redacted = redactSecrets(source);
    const serialized = JSON.stringify(redacted);

    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }

    expect(redacted).toEqual({
      request: {
        headers: {
          Authorization: REDACTED_VALUE,
          Cookie: REDACTED_VALUE,
          accept: 'text/html',
        },
      },
      response: {
        headers: {
          'Set-Cookie': REDACTED_VALUE,
        },
      },
      session: {
        PS_TOKEN: REDACTED_VALUE,
        JSESSIONID: REDACTED_VALUE,
        ICSID: REDACTED_VALUE,
        cf_clearance: REDACTED_VALUE,
      },
    });
    expect(source.request.headers.Authorization).toContain(secrets.authorization);
  });

  it('redacts header blocks, serialized objects, and named cookie pairs in strings', () => {
    const secrets = [
      'authorization-secret-for-string-test',
      'ps-secret-for-string-test',
      'jsession-secret-for-string-test',
      'icsid-secret-for-string-test',
      'cloudflare-secret-for-string-test',
    ] as const;
    const source = [
      `Authorization: Bearer ${secrets[0]}`,
      `Cookie: PS_TOKEN=${secrets[1]}; JSESSIONID=${secrets[2]}`,
      `Set-Cookie: ICSID=${secrets[3]}; Path=/`,
      `redirect=/continue?cf_clearance=${secrets[4]}&safe=true`,
      `{"PS_TOKEN":"${secrets[1]}","safe":"kept"}`,
    ].join('\n');

    const redacted = redactString(source);

    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }

    expect(redacted).toContain(`Authorization: ${REDACTED_VALUE}`);
    expect(redacted).toContain(`Cookie: ${REDACTED_VALUE}`);
    expect(redacted).toContain(`Set-Cookie: ${REDACTED_VALUE}`);
    expect(redacted).toContain(`cf_clearance=${REDACTED_VALUE}`);
    expect(redacted).toContain('"safe":"kept"');
  });

  it('leaves ordinary structured values unchanged', () => {
    const checkedAt = new Date('2026-08-26T00:00:00.000Z');
    const source = {
      method: 'GET',
      statusCode: 200,
      enabled: true,
      checkedAt,
      metadata: ['safe', null],
    };

    const redacted = redactSecrets(source);

    expect(redacted).toEqual(source);
    expect(redacted).not.toBe(source);
    expect(redacted.checkedAt).toBe(checkedAt);
  });

  it('redacts credentials embedded in error messages and stacks', () => {
    const secret = 'error-cookie-secret-for-test';
    const source = new Error(`Request failed with PS_TOKEN=${secret}`);

    const redacted = redactSecrets(source);

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).not.toContain(secret);
    expect(redacted.message).toContain(`PS_TOKEN=${REDACTED_VALUE}`);
    expect(redacted.stack).not.toContain(secret);
    expect(source.message).toContain(secret);
  });

  it('redacts Fetch Headers and sensitive URL query parameters', () => {
    const headerSecret = 'header-instance-secret-for-test';
    const querySecret = 'query-secret-for-test';
    const source = {
      headers: new Headers({
        Authorization: `Bearer ${headerSecret}`,
        Accept: 'text/html',
      }),
      url: new URL(`https://example.invalid/path?PS_TOKEN=${querySecret}&safe=kept`),
    };

    const redacted = redactSecrets(source);

    expect(redacted.headers.get('authorization')).toBe(REDACTED_VALUE);
    expect(redacted.headers.get('accept')).toBe('text/html');
    expect(redacted.url.searchParams.get('PS_TOKEN')).toBe(REDACTED_VALUE);
    expect(redacted.url.searchParams.get('safe')).toBe('kept');
    expect(redacted.headers).not.toBe(source.headers);
    expect(redacted.url).not.toBe(source.url);
  });

  it('redacts sensitive values held by Map-backed header containers', () => {
    const source = new Map<string, string>([
      ['Cookie', 'PS_TOKEN=map-secret-for-test'],
      ['Accept', 'text/html'],
    ]);
    const redacted = redactSecrets(source);

    expect(redacted.get('Cookie')).toBe(REDACTED_VALUE);
    expect(redacted.get('Accept')).toBe('text/html');
  });
});
