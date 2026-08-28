import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { logger } from '../config/logger.js';
import { redactSecrets } from '../security/redact.js';
import { clickMicrosoftPushOption, inspectMicrosoftTwoFactor } from './microsoft-two-factor.js';
import type { AuibAuthenticator, LoginResult } from './types.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LOGIN_ENTRY_URL =
  'https://sis.auib.edu.iq/datawiza/ab-login?idp_id=285709d6693140b1ab855af4c58d3c7b&dw_from_uri=%2Fpsp%2Fps%2FEMPLOYEE/SA/h/%3Ftab%3DDEFAULT';

interface ActiveBrowserSession {
  browser: Browser;
  context: BrowserContext;
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
}, 60 * 1000).unref();

export class PlaywrightAuibAuthenticator implements AuibAuthenticator {
  private readonly executablePath: string;

  public constructor(executablePath?: string) {
    this.executablePath = executablePath ?? EDGE_PATH;
  }

  private async launchBrowser(): Promise<Browser> {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-http2',
      '--ignore-certificate-errors',
      '--window-size=1280,800',
    ];

    try {
      return await chromium.launch({
        channel: 'msedge',
        headless: true,
        args: launchArgs,
      });
    } catch {
      if (process.platform === 'win32' || this.executablePath !== EDGE_PATH) {
        try {
          return await chromium.launch({
            executablePath: this.executablePath,
            headless: true,
            args: launchArgs,
          });
        } catch {
          // Fall through to generic chromium
        }
      }

      return await chromium.launch({
        headless: true,
        args: launchArgs,
      });
    }
  }

  /**
   * Launches headless browser and performs email + password login on AUIB/Microsoft SSO.
   */
  public async startLogin(email: string, password: string): Promise<LoginResult> {
    const sessionId = Math.random().toString(36).slice(2, 12);
    logger.info({ emailDomain: email.split('@')[1] }, 'Starting automated headless browser login');

    let browser: Browser | null = null;

    try {
      browser = await this.launchBrowser();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();

      // Navigate to AUIB Datawiza SSO entry URL
      await page.goto(LOGIN_ENTRY_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait for Microsoft Email Input or Account Tile
      const emailInput = page.locator('input[type="email"], input[name="loginfmt"]');
      const accountTile = page.locator('.table-row, [data-test-id], #tilesHolder');

      const foundEmail = await emailInput
        .waitFor({ state: 'visible', timeout: 10000 })
        .then(() => true)
        .catch(() => false);

      if (foundEmail) {
        await emailInput.fill(email);
        await page.keyboard.press('Enter');
      } else {
        const foundTile = await accountTile
          .first()
          .isVisible()
          .catch(() => false);
        if (foundTile) {
          await accountTile
            .first()
            .click()
            .catch(() => undefined);
        }
      }

      // Wait for Password Input or Error
      const passwordInput = page.locator('input[type="password"], input[name="passwd"]');
      const foundPassword = await passwordInput
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (!foundPassword) {
        const errorText = await page
          .locator('#usernameError, .error')
          .first()
          .textContent()
          .catch(() => null);
        throw new Error(
          errorText?.trim() ?? 'Invalid email address or account not found on Microsoft',
        );
      }

      // Type password with keystroke emulation so Microsoft input event listeners register
      await passwordInput.click();
      await passwordInput.fill('');
      await passwordInput.pressSequentially(password, { delay: 20 });
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');

      // Also ensure submit button is triggered if navigation didn't start
      await page.waitForTimeout(1000);
      const isPasswordStillShowing = await passwordInput.isVisible().catch(() => false);
      if (isPasswordStillShowing) {
        const submitBtn = page
          .locator(
            '#idSIButton9, input[type="submit"], button[type="submit"], input[value="Sign in"]',
          )
          .first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click().catch(() => undefined);
        }
      }

      // Keep checking every possible post-password outcome. Microsoft can render
      // number matching well after the first document and password submission
      // have completed, especially while the local scheduler is also active.
      const postPasswordStartedAt = Date.now();
      const postPasswordDeadline = postPasswordStartedAt + 120000;
      let nextProgressLogAt = postPasswordStartedAt + 15000;

      while (Date.now() < postPasswordDeadline) {
        // 1. Check for wrong password error
        const passwordErrorLocator = page
          .locator('#passwordError, .error, [data-test-id="passwordError"]')
          .first();
        // textContent() auto-waits for a missing locator. In the normal success
        // path that added the default 30-second timeout to every poll. Check
        // attachment immediately; a later error will be seen on the next pass.
        const passwordError =
          (await passwordErrorLocator.count().catch(() => 0)) > 0
            ? await passwordErrorLocator.textContent({ timeout: 500 }).catch(() => null)
            : null;

        if (passwordError && passwordError.trim().length > 0) {
          await browser.close();
          return {
            status: 'FAILED',
            error: passwordError.trim(),
          };
        }

        const currentUrl = page.url();

        // 2. Check if arrived directly on PeopleSoft portal
        const isInsidePeopleSoft =
          currentUrl.includes('sis.auib.edu.iq') &&
          (currentUrl.includes('/psp/ps/') || currentUrl.includes('/psc/ps/')) &&
          !currentUrl.includes('datawiza/ab-login') &&
          !currentUrl.includes('login.microsoftonline.com');

        if (isInsidePeopleSoft) {
          const cookies = await this.extractAUIBCookies(context);
          await browser.close();
          return {
            status: 'SUCCESS',
            cookies,
            rawSession: { email },
          };
        }

        // 3. Check for "Verify your identity" method picker screen
        const bodyText = await page.innerText('body').catch(() => '');
        if (bodyText.includes('Verify your identity')) {
          if (await clickMicrosoftPushOption(page).catch(() => false)) {
            await page.waitForTimeout(1500);
            continue;
          }
        }

        // 4. Check if 2FA (number matching, push, or OTP) is active
        let twoFactor = await inspectMicrosoftTwoFactor(page);

        if (twoFactor.detected || currentUrl.includes('/SAS/') || currentUrl.includes('proof')) {
          logger.info('2FA challenge detected on Microsoft SSO; extracting challenge details');

          let displaySign = twoFactor.displaySign;
          if (!twoFactor.hasOtcInput && displaySign === null) {
            for (let i = 0; displaySign === null && i < 3; i += 1) {
              await page.waitForTimeout(1000);
              twoFactor = await inspectMicrosoftTwoFactor(page);
              displaySign = twoFactor.displaySign;

              if (displaySign !== null) {
                logger.info('Successfully captured Microsoft 2FA number matching display sign');
                break;
              }
              if (twoFactor.hasOtcInput) {
                break;
              }
            }
          }

          activeBrowserSessions.set(sessionId, {
            browser,
            context,
            page,
            createdAt: Date.now(),
          });

          let promptMessage: string;
          let method: 'NUMBER_MATCH' | 'OTP';

          if (displaySign !== null) {
            method = 'NUMBER_MATCH';
            promptMessage = `📲 *Number Matching 2FA Required*\n\nOpen your Microsoft Authenticator app and tap number: **${displaySign}**\n\n_Reply with any message once you have approved it, or reply with your backup OTP code:_`;
          } else if (twoFactor.hasOtcInput || /enter\s+(?:the\s+)?code/i.test(bodyText)) {
            method = 'OTP';
            promptMessage =
              '🔐 *Two-Factor Authentication Required*\n\nPlease reply with your 6-digit verification code sent to your authenticator or SMS:';
          } else {
            method = 'OTP';
            promptMessage =
              '📲 *Approval Required in Microsoft Authenticator*\n\nA sign-in notification was sent to your Microsoft Authenticator app. Please tap **Approve** on your phone.\n\n_Reply with any message once approved, or reply with your 6-digit code:_';
          }

          return {
            status: 'REQUIRES_2FA',
            method,
            challengeContext: { sessionId, displaySign: displaySign ?? undefined },
            message: promptMessage,
          };
        }

        // 5. Check for KMSI screen ("Stay signed in?")
        const kmsiBtn = page.locator('#idSIButton9, input[value="Yes"]').first();
        if (await kmsiBtn.isVisible().catch(() => false)) {
          logger.info('KMSI screen detected, clicking Yes');
          await kmsiBtn.click().catch(() => undefined);
          await page.waitForTimeout(2000);
          continue;
        }

        if (Date.now() >= nextProgressLogAt) {
          const contextPages = context.pages();
          logger.info(
            {
              elapsedSeconds: Math.floor((Date.now() - postPasswordStartedAt) / 1000),
              pageCount: contextPages.length,
              frameCount: contextPages.reduce(
                (count, contextPage) => count + contextPage.frames().length,
                0,
              ),
            },
            'Waiting for Microsoft sign-in outcome',
          );
          nextProgressLogAt += 15000;
        }

        await page.waitForTimeout(500);
      }

      throw new Error('Timed out waiting for Microsoft sign-in challenge or PeopleSoft portal');
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
    const ctx = challengeContext as { sessionId?: string } | null | undefined;
    const sessionId = ctx?.sessionId;

    if (!sessionId) {
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

    const { browser, context, page } = session;

    try {
      const cleanCode = code.trim().replace(/\s+/g, '');

      // If user provided a numeric verification code (e.g. 6-digit code)
      if (/^\d{6}$/.test(cleanCode)) {
        try {
          const otcInput = page
            .locator('input[name="otc"], input[type="tel"], #idTxtBx_SAOTCC_OTC')
            .first();
          if (await otcInput.isVisible().catch(() => false)) {
            await otcInput.fill(cleanCode);
            await page.keyboard.press('Enter');
          } else {
            // Click "Use a verification code" if available
            const codeOpt = page
              .locator(
                '#idDiv_SAOTCS_Proofs .table-row, #idA_SAASTO_OTC, div[role="button"]:has-text("verification code")',
              )
              .first();
            if (await codeOpt.isVisible().catch(() => false)) {
              await codeOpt.click().catch(() => undefined);
              await page.waitForTimeout(1500);
              const newInput = page
                .locator('input[name="otc"], input[type="tel"], #idTxtBx_SAOTCC_OTC')
                .first();
              if (await newInput.isVisible().catch(() => false)) {
                await newInput.fill(cleanCode);
                await page.keyboard.press('Enter');
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      // Wait for cookies and handle post-2FA KMSI and natural redirection to AUIB SIS
      const cookies = await this.waitForCookiesAndComplete(context, page);

      await browser.close().catch(() => undefined);
      activeBrowserSessions.delete(sessionId);

      return {
        status: 'SUCCESS',
        cookies,
      };
    } catch (err) {
      await browser.close().catch(() => undefined);
      activeBrowserSessions.delete(sessionId);

      return {
        status: 'FAILED',
        error: err instanceof Error ? err.message : 'Failed to verify 2FA code',
      };
    }
  }

  private async extractAUIBCookies(context: BrowserContext): Promise<string> {
    const allCookies = await context.cookies().catch(() => []);
    const auibCookies = allCookies.filter(
      (c) =>
        c.domain.includes('auib.edu.iq') ||
        c.name.startsWith('PS_') ||
        c.name.startsWith('DW-') ||
        c.name === 'JSESSIONID',
    );

    if (auibCookies.length > 0) {
      logger.info(
        'Successfully arrived inside PeopleSoft portal and captured authenticated cookies',
      );
      return auibCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    return '';
  }

  /**
   * Completes Microsoft KMSI, waits for the browser to arrive inside PeopleSoft (/psp/ps/ or /psc/ps/), and extracts all cookies.
   */
  private async waitForCookiesAndComplete(context: BrowserContext, page: Page): Promise<string> {
    const startTime = Date.now();

    while (Date.now() - startTime < 60000) {
      // 1. Native click on KMSI / "Stay signed in?" screen (only when on KMSI)
      try {
        const pageText = await page.innerText('body').catch(() => '');
        if (pageText.includes('Stay signed in')) {
          const kmsiBtn = page.locator('#idSIButton9, input[value="Yes"]').first();
          if (await kmsiBtn.isVisible().catch(() => false)) {
            await kmsiBtn.click().catch(() => undefined);
            await page.waitForTimeout(2000);
          }
        }
      } catch {
        // Ignore
      }

      const currentUrl = page.url();

      if (Date.now() - startTime > 3000 && Math.floor((Date.now() - startTime) / 1000) % 5 === 0) {
        logger.info('Waiting for login completion');
      }

      // Check if we reached PeopleSoft portal (/psp/ps/ or /psc/ps/) and not Datawiza/Microsoft login pages
      const isInsidePeopleSoft =
        currentUrl.includes('sis.auib.edu.iq') &&
        (currentUrl.includes('/psp/ps/') || currentUrl.includes('/psc/ps/')) &&
        !currentUrl.includes('datawiza/ab-login') &&
        !currentUrl.includes('login.microsoftonline.com');

      if (isInsidePeopleSoft) {
        const cookieHeader = await this.extractAUIBCookies(context);
        if (cookieHeader.length > 0) {
          return cookieHeader;
        }
      }

      await page.waitForTimeout(1500);
    }

    try {
      await page.screenshot({ path: 'login-timeout-debug.png' });
    } catch {
      // Ignore screenshot error
    }

    throw new Error('Timed out waiting for PeopleSoft portal redirect after Microsoft 2FA');
  }
}
