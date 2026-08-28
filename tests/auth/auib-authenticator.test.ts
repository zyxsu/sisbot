import { describe, expect, it, vi } from 'vitest';
import { DefaultAuibAuthenticator } from '../../src/auth/auib-authenticator.js';

describe('DefaultAuibAuthenticator', () => {
  it('rejects invalid email formats early', async () => {
    const auth = new DefaultAuibAuthenticator();
    const result = await auth.startLogin('invalid-email', 'somepassword');
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.error).toContain('valid AUIB email');
    }
  });

  it('rejects empty passwords early', async () => {
    const auth = new DefaultAuibAuthenticator();
    const result = await auth.startLogin('student@auib.edu.iq', '');
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.error).toContain('cannot be empty');
    }
  });

  it('handles direct successful authentication returning session cookies', async () => {
    const mockFetch = vi
      .fn()
      // Initial GET to login portal
      .mockResolvedValueOnce(
        new Response('<html><body>Login Page</body></html>', {
          status: 200,
          headers: { 'set-cookie': 'JSESSIONID=sess-initial-123; path=/' },
        }),
      )
      // POST primary credentials
      .mockResolvedValueOnce(
        new Response('<html><body>Welcome to AUIB SIS</body></html>', {
          status: 200,
          headers: {
            'set-cookie':
              'PS_TOKEN=valid-ps-token-abc; path=/, PS_DEVICEFEATURES=width:1920; path=/',
          },
        }),
      );

    const auth = new DefaultAuibAuthenticator({ fetchFn: mockFetch });
    const result = await auth.startLogin('student@auib.edu.iq', 'SecurePass123!');

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.cookies).toContain('PS_TOKEN=valid-ps-token-abc');
      expect(result.cookies).toContain('JSESSIONID=sess-initial-123');
    }
  });

  it('detects 2FA requirement and completes 2FA verification flow', async () => {
    const mockFetch = vi
      .fn()
      // Initial GET
      .mockResolvedValueOnce(
        new Response('<html><body>Login Page</body></html>', {
          status: 200,
          headers: { 'set-cookie': 'JSESSIONID=sess-2fa-123; path=/' },
        }),
      )
      // POST primary credentials -> challenges for Two-Factor code
      .mockResolvedValueOnce(
        new Response(
          '<html><body><div>Please enter code sent to your phone (Two-Factor authentication)</div></body></html>',
          {
            status: 200,
            headers: {
              'set-cookie': '2FA_SESSION=challenge-token-xyz; path=/',
            },
          },
        ),
      )
      // POST 2FA verification code
      .mockResolvedValueOnce(
        new Response('<html><body>2FA Verified. Redirecting to SIS...</body></html>', {
          status: 200,
          headers: {
            'set-cookie': 'PS_TOKEN=authenticated-after-2fa-token; path=/',
          },
        }),
      );

    const auth = new DefaultAuibAuthenticator({ fetchFn: mockFetch });

    // Step 1: Start login
    const loginResult = await auth.startLogin('student@auib.edu.iq', 'SecurePass123!');
    expect(loginResult.status).toBe('REQUIRES_2FA');

    if (loginResult.status === 'REQUIRES_2FA') {
      expect(loginResult.method).toBe('OTP');
      expect(loginResult.message).toContain('6-digit verification code');

      // Step 2: Submit 2FA code
      const twoFaResult = await auth.submit2Fa(loginResult.challengeContext, '123456');
      expect(twoFaResult.status).toBe('SUCCESS');

      if (twoFaResult.status === 'SUCCESS') {
        expect(twoFaResult.cookies).toContain('PS_TOKEN=authenticated-after-2fa-token');
      }
    }
  });

  it('handles invalid 2FA code rejection', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response('<html><body>Invalid code. Please try again.</body></html>', {
        status: 200,
      }),
    );

    const auth = new DefaultAuibAuthenticator({ fetchFn: mockFetch });
    const result = await auth.submit2Fa(
      { actionUrl: 'https://sis.auib.edu.iq/2fa', cookieJar: 'temp=123' },
      '000000',
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.error).toContain('Incorrect or expired 2FA code');
    }
  });
});
