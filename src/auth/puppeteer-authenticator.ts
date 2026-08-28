import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { logger } from '../config/logger.js';
import { redactSecrets } from '../security/redact.js';
import type { AuibAuthenticator, LoginResult } from './types.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LOGIN_ENTRY_URL =
  'https://sis.auib.edu.iq/datawiza/ab-login?idp_id=285709d6693140b1ab855af4c58d3c7b&dw_from_uri=%2Fpsp%2Fps%2FEMPLOYEE/SA/h/%3Ftab%3DDEFAULT';

interface ActiveBrowserSession {
  browser: Browser;
  page: Page;
  createdAt: number;
}

const activeBrowserSessions = new Map<string, ActiveBrowserSession>();

// Cleanup stale browser sessions after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeBrowserSessions.entries()) {
    if (now - session.createdAt > 10 * 60 * 1000) {
      void session.browser.close().catch(() => undefined);
      activeBrowserSessions.delete(id);
    }
  }
}, 60 * 1000);

export class PuppeteerAuibAuthenticator implements AuibAuthenticator {
  private readonly executablePath: string;

  public constructor(executablePath?: string) {
    this.executablePath = executablePath ?? EDGE_PATH;
  }

  /**
   * Launches headless browser and performs email + password login on AUIB/Microsoft SSO.
   */
  public async startLogin(email: string, password: string): Promise<LoginResult> {
    const sessionId = Math.random().toString(36).slice(2, 12);
    logger.info({ emailDomain: email.split('@')[1] }, 'Starting automated headless browser login');

    let browser: Browser | null = null;

    try {
      browser = await puppeteer.launch({
        executablePath: this.executablePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--ignore-certificate-errors',
          '--window-size=1280,800',
        ],
      });

      const page = await browser.newPage();
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      );

      // Navigate to AUIB Datawiza SSO entry URL
      await page.goto(LOGIN_ENTRY_URL, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Wait for Microsoft Email Input or Account Tile
      const emailInput = await page
        .waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 10000 })
        .catch(() => null);

      if (emailInput) {
        await emailInput.type(email, { delay: 30 });
        await page.keyboard.press('Enter');
      } else {
        const tile = await page.$('.table-row, [data-test-id], #tilesHolder');
        if (tile) {
          await tile.click().catch(() => undefined);
        }
      }

      // Wait for Password Input or Error
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));

      const passwordInput = await page.waitForSelector(
        'input[type="password"], input[name="passwd"]',
        { timeout: 15000 },
      );

      if (!passwordInput) {
        const errorText = (await page.evaluate(
          'document.querySelector("#usernameError, .error") ? document.querySelector("#usernameError, .error").textContent : null',
        )) as string | null;

        throw new Error(errorText ?? 'Invalid email address or account not found on Microsoft');
      }

      await passwordInput.type(password, { delay: 30 });
      await page.keyboard.press('Enter');

      // Wait for post-password outcome (KMSI, 2FA, or SIS redirect)
      await new Promise((r) => setTimeout(r, 3500));

      // Check for wrong password error
      const passwordError = (await page.evaluate(
        'document.querySelector("#passwordError, .error") ? document.querySelector("#passwordError, .error").textContent : null',
      )) as string | null;

      if (passwordError) {
        await browser.close();
        return {
          status: 'FAILED',
          error: passwordError.trim(),
        };
      }

      // Check if "Verify your identity" method picker screen is displayed
      const isMethodPicker = (await page.evaluate(
        'Boolean(document.body && document.body.innerText && document.body.innerText.includes("Verify your identity"))',
      )) as boolean;

      if (isMethodPicker) {
        // Automatically select "Approve a request on my Microsoft Authenticator app"
        await page.evaluate(`
          (function() {
            var elements = Array.from(document.querySelectorAll('#idDiv_SAOTCS_Proofs .table-row, [data-value], div[role="button"]'));
            var pushOption = elements.find(function(el) { return (el.textContent || '').includes('Approve a request'); }) ||
              document.querySelector('div[data-value="PhoneAppNotification"]') ||
              elements[0];
            if (pushOption && typeof pushOption.click === 'function') {
              pushOption.click();
            }
          })()
        `);
        // Give Microsoft time to send notification and render number match screen
        await new Promise((r) => setTimeout(r, 3000));
      }

      // Check if 2FA (number matching or OTP) is active
      const isTwoFaPage = (await page.evaluate(
        '(function() { var text = document.body ? document.body.innerText : ""; return text.includes("Approve sign in request") || text.includes("Enter code") || text.includes("Verify your identity") || document.querySelector("#idRichContext_DisplaySign") !== null || document.querySelector("input[name=\\"otc\\"]") !== null; })()',
      )) as boolean;

      if (isTwoFaPage) {
        // Poll briefly for the 2-digit number matching display if present
        let displaySign: string | null = null;
        for (let i = 0; i < 5; i++) {
          displaySign = (await page.evaluate(
            'document.querySelector("#idRichContext_DisplaySign, .displaySign") ? document.querySelector("#idRichContext_DisplaySign, .displaySign").textContent.trim() : null',
          )) as string | null;
          if (displaySign) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        activeBrowserSessions.set(sessionId, {
          browser,
          page,
          createdAt: Date.now(),
        });

        const promptMessage = displaySign
          ? `📲 *Number Matching 2FA Required*\n\nOpen your Microsoft Authenticator app and tap number: **${displaySign}**\n\n_Reply with any message once you have approved it, or reply with your backup OTP code:_`
          : '🔐 *Two-Factor Authentication Required*\n\nPlease reply with your 6-digit verification code sent to your authenticator or SMS:';

        return {
          status: 'REQUIRES_2FA',
          method: displaySign ? 'NUMBER_MATCH' : 'OTP',
          challengeContext: { sessionId, displaySign: displaySign ?? undefined },
          message: promptMessage,
        };
      }

      // Wait for cookies and handle KMSI gracefully
      const cookies = await this.waitForCookiesAndComplete(page);
      await browser.close();

      return {
        status: 'SUCCESS',
        cookies,
        rawSession: { email },
      };
    } catch (err) {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      logger.error({ err: redactSecrets(err) }, 'Headless login failed');
      return {
        status: 'FAILED',
        error: err instanceof Error ? err.message : 'Login failed connecting to AUIB SIS',
      };
    }
  }

  /**
   * Submits 2FA verification code or waits for student app approval.
   */
  public async submit2Fa(challengeContext: unknown, code: string): Promise<LoginResult> {
    const ctx = challengeContext as { sessionId?: string } | undefined;
    const sessionId = ctx?.sessionId;

    if (!sessionId || !activeBrowserSessions.has(sessionId)) {
      return {
        status: 'FAILED',
        error: 'Login session expired or not found. Please start over with /login.',
      };
    }

    const session = activeBrowserSessions.get(sessionId);
    if (session === undefined) {
      return {
        status: 'FAILED',
        error: 'Login session expired or not found. Please start over with /login.',
      };
    }
    const { browser, page } = session;

    try {
      const cleanCode = code.trim().replace(/\s+/g, '');

      // If user provided a numeric verification code (e.g. 6-digit code)
      if (/^\d{6}$/.test(cleanCode)) {
        try {
          const otcInput = await page.$(
            'input[name="otc"], input[type="tel"], #idTxtBx_SAOTCC_OTC',
          );
          if (otcInput) {
            await otcInput.type(cleanCode, { delay: 30 });
            await page.keyboard.press('Enter');
          } else {
            // Click "Use a verification code" if on method picker or another way
            await page.evaluate(`
              (function() {
                var elements = Array.from(document.querySelectorAll('#idDiv_SAOTCS_Proofs .table-row, [data-value], div[role="button"], #idA_SAASTO_OTC'));
                var codeOpt = elements.find(function(el) { return (el.textContent || '').includes('verification code'); });
                if (codeOpt && typeof codeOpt.click === 'function') {
                  codeOpt.click();
                }
              })()
            `);
            await new Promise((r) => setTimeout(r, 1500));
            const newInput = await page.$(
              'input[name="otc"], input[type="tel"], #idTxtBx_SAOTCC_OTC',
            );
            if (newInput) {
              await newInput.type(cleanCode, { delay: 30 });
              await page.keyboard.press('Enter');
            }
          }
        } catch {
          // Ignore
        }
      }

      // Wait for cookies and handle post-2FA KMSI and natural redirection to AUIB SIS
      const cookies = await this.waitForCookiesAndComplete(page);

      await browser.close().catch(() => undefined);
      activeBrowserSessions.delete(sessionId);

      return {
        status: 'SUCCESS',
        cookies,
      };
    } catch (err) {
      // Save debug screenshot on failure
      try {
        await page.screenshot({ path: 'F:\\sis-bot\\login-debug.png' });
      } catch {
        // Ignore screenshot errors
      }

      await browser.close().catch(() => undefined);
      activeBrowserSessions.delete(sessionId);

      return {
        status: 'FAILED',
        error: err instanceof Error ? err.message : 'Failed to verify 2FA code',
      };
    }
  }

  /**
   * Completes Microsoft KMSI, waits for the browser to arrive inside PeopleSoft (/psp/ps/ or /psc/ps/), and extracts all cookies via CDP.
   */
  private async waitForCookiesAndComplete(page: Page): Promise<string> {
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const cdpClient = await page.target().createCDPSession();

    while (Date.now() - startTime < 60000) {
      // 1. Native click on KMSI / "Stay signed in?" screen
      try {
        const kmsiBtn = await page.$('#idSIButton9, input[value="Yes"], #idBtn_Back');
        if (kmsiBtn) {
          await kmsiBtn.click();
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch {
        // Ignore
      }

      const currentUrl = page.url();

      if (Date.now() - startTime > 3000 && Math.floor((Date.now() - startTime) / 1000) % 5 === 0) {
        logger.info({ url: currentUrl }, 'Waiting for login completion');
      }

      // Check if we reached PeopleSoft portal (/psp/ps/ or /psc/ps/) and not Datawiza/Microsoft login pages
      const isInsidePeopleSoft =
        currentUrl.includes('sis.auib.edu.iq') &&
        (currentUrl.includes('/psp/ps/') || currentUrl.includes('/psc/ps/')) &&
        !currentUrl.includes('datawiza/ab-login') &&
        !currentUrl.includes('login.microsoftonline.com');

      if (isInsidePeopleSoft) {
        const result = (await cdpClient.send('Network.getAllCookies')) as {
          cookies: { name: string; value: string; domain: string }[];
        };
        const allCookies = result.cookies;

        const auibCookies = allCookies.filter(
          (c) =>
            c.domain.includes('auib.edu.iq') ||
            c.name.startsWith('PS_') ||
            c.name.startsWith('DW-') ||
            c.name === 'JSESSIONID',
        );

        if (auibCookies.length > 0) {
          logger.info(
            { url: currentUrl, cookieNames: auibCookies.map((c) => c.name) },
            'Successfully arrived inside PeopleSoft portal and captured authenticated cookies',
          );
          return auibCookies.map((c) => `${c.name}=${c.value}`).join('; ');
        }
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    throw new Error('Timed out waiting for PeopleSoft portal redirect after Microsoft 2FA');
  }
}
