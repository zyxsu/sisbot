import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { logger } from '../../config/logger.js';
import type { SectionState, SectionStatus } from '../../domain/section-state.js';
import { redactSecrets } from '../../security/redact.js';
import { PeopleSoftHttpClient, PeopleSoftSessionExpiredError } from '../http/peoplesoft-client.js';
import { parseClassAvailability } from '../parsers/class-availability.js';
import { parseSectionStatus } from '../parsers/class-selection.js';
import {
  parseRequirementChoices,
  parseRequirementCourses,
} from '../parsers/requirement-browser.js';
import { assertPeopleSoftSessionActive } from '../session.js';
import type {
  CheckCourseSectionsRequest,
  CheckCoursesRequest,
  CourseCheckResult,
  CourseCheckTarget,
  SectionChecker,
} from './check-course-sections.js';
import type {
  RequirementBrowser,
  RequirementChoice,
  RequirementCourseChoice,
  RequirementTermChoice,
} from './requirement-browser.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MANAGE_CLASSES_NAV_URL =
  'https://sis.auib.edu.iq/psc/ps/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_START_PAGE_FL.GBL?GMenu=SSR_STUDENT_FL&GComp=SSR_START_PAGE_FL&GPage=SSR_START_PAGE_FL&scname=CS_SSR_MANAGE_CLASSES_NAV';
const REQUIREMENTS_DIRECT_URL =
  'https://sis.auib.edu.iq/psc/ps/EMPLOYEE/SA/c/SAA_STUDENT_FL.SAA_REQ_ENRL_FL.GBL';
const BROWSE_SESSION_TTL_MS = 15 * 60 * 1000;

export function normalizeCourseCode(courseCode: string): string {
  return courseCode.replace(/\s+/g, '').toUpperCase();
}

export function courseKey(target: CourseCheckTarget): string {
  return `${target.term.trim()}\u0000${normalizeCourseCode(target.courseCode)}`;
}

export function deriveTermCode(label: string, defaultTerm = '2701'): string {
  const match = /(\d{4})\/(\d{4})\s+(Fall|Spring|Summer)/i.exec(label);
  if (match?.[2] !== undefined && match[3] !== undefined) {
    const year = match[2].slice(-2); // e.g. 2027 -> 27
    const season = match[3].toLowerCase();
    let code = '01';
    if (season === 'fall') code = '01';
    else if (season === 'spring') code = '02';
    else if (season === 'summer') code = '03';
    return `${year}${code}`;
  }
  return defaultTerm;
}

interface QueuedOperation<T> {
  priority: 'interactive' | 'background';
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

class SessionQueue {
  private active = false;
  private readonly interactiveQueue: QueuedOperation<unknown>[] = [];
  private readonly backgroundQueue: QueuedOperation<unknown>[] = [];
  public lastInteractiveAt = 0;

  public enqueue<T>(priority: 'interactive' | 'background', operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueuedOperation<unknown> = {
        priority,
        run: operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (priority === 'interactive') {
        this.lastInteractiveAt = Date.now();
        this.interactiveQueue.push(item);
      } else {
        this.backgroundQueue.push(item);
      }

      this.processNext();
    });
  }

  private processNext(): void {
    if (this.active) return;

    // Interactive operations always take precedence
    const next = this.interactiveQueue.shift() ?? this.backgroundQueue.shift();
    if (next === undefined) return;

    this.active = true;
    void Promise.resolve()
      .then(() => next.run())
      .then(
        (result) => {
          this.active = false;
          next.resolve(result);
          this.processNext();
        },
        (error: unknown) => {
          this.active = false;
          next.reject(error);
          this.processNext();
        },
      );
  }
}

interface StudentContext {
  context: BrowserContext;
  page: Page;
  queue: SessionQueue;
  cleanupTimer: NodeJS.Timeout;
}

export class PlaywrightSectionChecker implements SectionChecker, RequirementBrowser {
  private readonly courseRequirementCache = new Map<string, string>();
  private readonly studentContexts = new Map<string, StudentContext>();
  private sharedBrowser: Browser | null = null;
  private browserLaunchPromise: Promise<Browser> | null = null;
  private readonly executablePath: string;

  public constructor(executablePath?: string) {
    this.executablePath = executablePath ?? EDGE_PATH;
  }

  private async getSharedBrowser(): Promise<Browser> {
    if (this.sharedBrowser?.isConnected()) {
      return this.sharedBrowser;
    }

    if (this.browserLaunchPromise !== null) {
      return this.browserLaunchPromise;
    }

    this.browserLaunchPromise = (async () => {
      let browser: Browser;
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
        browser = await chromium.launch({
          channel: 'msedge',
          headless: true,
          args: launchArgs,
        });
      } catch {
        if (process.platform === 'win32' || this.executablePath !== EDGE_PATH) {
          try {
            browser = await chromium.launch({
              executablePath: this.executablePath,
              headless: true,
              args: launchArgs,
            });
            this.sharedBrowser = browser;
            return browser;
          } catch {
            // Fall through to generic chromium
          }
        }

        browser = await chromium.launch({
          headless: true,
          args: launchArgs,
        });
      }
      this.sharedBrowser = browser;
      browser.on('disconnected', () => {
        this.sharedBrowser = null;
        this.browserLaunchPromise = null;
      });
      return browser;
    })();

    try {
      return await this.browserLaunchPromise;
    } finally {
      this.browserLaunchPromise = null;
    }
  }

  private async withStudentPage<T>(
    cookiesPayload: unknown,
    priority: 'interactive' | 'background',
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    const cookieHeader = PeopleSoftHttpClient.normalizeCookieHeader(cookiesPayload);
    const sessionKey = createHash('sha256').update(cookieHeader).digest('hex');

    let student = this.studentContexts.get(sessionKey);

    if (
      student === undefined ||
      student.page.isClosed() ||
      !student.context.browser()?.isConnected()
    ) {
      if (student !== undefined) {
        clearTimeout(student.cleanupTimer);
        await student.context.close().catch(() => undefined);
      }

      const browser = await this.getSharedBrowser();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true,
      });

      await this.installCookies(context, cookieHeader);
      const page = await context.newPage();
      const queue = new SessionQueue();
      const cleanupTimer = this.createCleanupTimer(sessionKey, context);

      student = { context, page, queue, cleanupTimer };
      this.studentContexts.set(sessionKey, student);
    } else {
      clearTimeout(student.cleanupTimer);
      student.cleanupTimer = this.createCleanupTimer(sessionKey, student.context);
    }

    const currentStudent = student;

    // Execute with serialized session queue prioritizing interactive requests
    return currentStudent.queue.enqueue(priority, async () => {
      try {
        return await operation(currentStudent.page);
      } catch (error) {
        if (error instanceof PeopleSoftSessionExpiredError) {
          clearTimeout(currentStudent.cleanupTimer);
          this.studentContexts.delete(sessionKey);
          await currentStudent.context.close().catch(() => undefined);
        }
        throw error;
      }
    });
  }

  private createCleanupTimer(sessionKey: string, context: BrowserContext): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const cached = this.studentContexts.get(sessionKey);
      if (cached?.context !== context) return;
      this.studentContexts.delete(sessionKey);
      void context.close().catch(() => undefined);
    }, BROWSE_SESSION_TTL_MS);
    timer.unref();
    return timer;
  }

  private async installCookies(context: BrowserContext, cookieHeader: string): Promise<void> {
    const pairs = cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean);

    const cookies = pairs
      .map((pair) => {
        const [name, ...valueParts] = pair.split('=');
        if (!name || valueParts.length === 0) return null;
        return {
          name: name.trim(),
          value: valueParts.join('='),
          url: 'https://sis.auib.edu.iq',
          sameSite: 'None' as const,
          secure: true,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
  }

  public async closeSession(cookiesPayload: unknown): Promise<void> {
    const cookieHeader = PeopleSoftHttpClient.normalizeCookieHeader(cookiesPayload);
    const sessionKey = createHash('sha256').update(cookieHeader).digest('hex');
    const cached = this.studentContexts.get(sessionKey);
    if (cached !== undefined) {
      clearTimeout(cached.cleanupTimer);
      this.studentContexts.delete(sessionKey);
      await cached.context.close().catch(() => undefined);
    }
  }

  public async closeAll(): Promise<void> {
    for (const [key, student] of this.studentContexts.entries()) {
      clearTimeout(student.cleanupTimer);
      await student.context.close().catch(() => undefined);
      this.studentContexts.delete(key);
    }
    if (this.sharedBrowser !== null) {
      await this.sharedBrowser.close().catch(() => undefined);
      this.sharedBrowser = null;
    }
  }

  // --- RequirementBrowser implementation ---

  public listRequirements(cookiesPayload: unknown): Promise<RequirementChoice[]> {
    return this.withStudentPage(cookiesPayload, 'interactive', async (page) => {
      await this.openRequirementsPage(page);
      const markup = await this.collectAllMarkup(page);
      return parseRequirementChoices(markup);
    });
  }

  public listCourses(
    cookiesPayload: unknown,
    requirementLabel: string,
  ): Promise<RequirementCourseChoice[]> {
    return this.withStudentPage(cookiesPayload, 'interactive', async (page) => {
      await this.openRequirementsPage(page);
      const courses = await this.openRequirementCourseList(page, requirementLabel);
      for (const course of courses) {
        this.courseRequirementCache.set(normalizeCourseCode(course.courseCode), requirementLabel);
      }
      return courses;
    });
  }

  public listCourseTerms(
    cookiesPayload: unknown,
    requirementLabel: string,
    courseCode: string,
  ): Promise<RequirementTermChoice[]> {
    return this.withStudentPage(cookiesPayload, 'interactive', async (page) => {
      await this.openRequirementsPage(page);
      await this.openCourseClasses(page, requirementLabel, courseCode);
      this.courseRequirementCache.set(normalizeCourseCode(courseCode), requirementLabel);
      return this.waitForTermChoices(page, 20_000);
    });
  }

  public listCourseSections(
    cookiesPayload: unknown,
    requirementLabel: string,
    courseCode: string,
    term: string,
    termLabel: string,
  ): Promise<SectionState[]> {
    return this.withStudentPage(cookiesPayload, 'interactive', async (page) => {
      await this.openRequirementsPage(page);
      await this.openCourseClasses(page, requirementLabel, courseCode);
      this.courseRequirementCache.set(normalizeCourseCode(courseCode), requirementLabel);
      await this.waitForTermChoices(page, 20_000);

      const clicked = await this.clickTerm(page, [termLabel, term]);
      if (!clicked) {
        throw new Error(`Term was not found for ${courseCode}: ${termLabel}`);
      }

      await this.waitForClassRows(page, 20_000);
      const markup = await this.collectAllMarkup(page);
      const sections = this.parseVisibleSections(
        markup,
        { courseCode, term, termLabel },
        new Date(),
      );

      return sections.filter(
        (section) => normalizeCourseCode(section.courseCode) === normalizeCourseCode(courseCode),
      );
    });
  }

  // --- SectionChecker implementation ---

  public async checkCourseSections(request: CheckCourseSectionsRequest): Promise<SectionState[]> {
    const [result] = await this.checkCoursesSequentially({
      session: request.session,
      targets: [request],
      ...(request.checkedAt !== undefined ? { checkedAt: request.checkedAt } : {}),
    });
    return result?.sections ?? [];
  }

  public checkCoursesSequentially(request: CheckCoursesRequest): Promise<CourseCheckResult[]> {
    if (request.targets.length === 0) {
      return Promise.resolve([]);
    }

    return request.session.runSerialized(async () => {
      assertPeopleSoftSessionActive(request.session);

      try {
        const allSections = await this.withStudentPage(
          request.session.id,
          'background',
          (page) => this.fetchLiveSections(page, request.targets, request.checkedAt ?? new Date()),
        );

        return request.targets.map((target) => ({
          target,
          sections: allSections.filter((section) => {
            const courseMatches =
              normalizeCourseCode(section.courseCode) === normalizeCourseCode(target.courseCode);
            const classMatches =
              target.classNumber === undefined || section.classNumber === target.classNumber;
            return courseMatches && classMatches && section.term === target.term;
          }),
        }));
      } catch (error) {
        if (error instanceof PeopleSoftSessionExpiredError) {
          request.session.markExpired();
        }
        throw error;
      }
    });
  }

  private async fetchLiveSections(
    page: Page,
    targets: readonly CourseCheckTarget[],
    checkedAt: Date,
  ): Promise<SectionState[]> {
    const targetsByCourse = new Map<
      string,
      {
        target: CourseCheckTarget;
        requestedClassNumbers: Set<string>;
        includeAllClasses: boolean;
      }
    >();

    for (const target of targets) {
      const key = courseKey(target);
      const existing = targetsByCourse.get(key);

      if (existing !== undefined) {
        if (target.classNumber === undefined) {
          existing.includeAllClasses = existing.requestedClassNumbers.size === 0;
        } else {
          existing.requestedClassNumbers.add(target.classNumber);
          existing.includeAllClasses = false;
        }
        continue;
      }

      targetsByCourse.set(key, {
        target,
        requestedClassNumbers: new Set(
          target.classNumber === undefined ? [] : [target.classNumber],
        ),
        includeAllClasses: target.classNumber === undefined,
      });
    }

    const observedSections: SectionState[] = [];

    for (const group of targetsByCourse.values()) {
      try {
        await this.navigateToCourseClasses(page, group.target);
        const coursePageMarkup = await this.collectAllMarkup(page);
        this.assertPageSessionActive(page, coursePageMarkup);

        const sections = this.parseVisibleSections(
          coursePageMarkup,
          group.target,
          checkedAt,
        ).filter(
          (section) =>
            group.includeAllClasses || group.requestedClassNumbers.has(section.classNumber),
        );

        sections.sort((left, right) => {
          const leftReq = group.requestedClassNumbers.has(left.classNumber) ? 0 : 1;
          const rightReq = group.requestedClassNumbers.has(right.classNumber) ? 0 : 1;
          return leftReq - rightReq;
        });

        logger.info(
          {
            courseCode: group.target.courseCode,
            sectionCount: sections.length,
            requestedSectionCount: sections.filter((s) =>
              group.requestedClassNumbers.has(s.classNumber),
            ).length,
          },
          'Parsed live class rows before availability checks',
        );

        for (let index = 0; index < sections.length; index += 1) {
          const section = sections[index];
          if (section === undefined) continue;

          if (index > 0) {
            await this.closeClassDetails(page);
          }

          const availability = await this.readClassAvailability(page, section.classNumber);
          const availableSeats = availability?.availableSeats ?? null;
          const status =
            availability !== null && availability.status !== 'UNKNOWN'
              ? availability.status
              : section.status !== 'UNKNOWN'
                ? section.status
                : availableSeats !== null && availableSeats > 0
                  ? 'OPEN'
                  : 'UNKNOWN';

          sections[index] = { ...section, status, availableSeats };
          logger.info(
            { classNumber: section.classNumber, status, availableSeats },
            'Read authoritative class availability',
          );
        }

        observedSections.push(...sections);
      } catch (error) {
        if (error instanceof PeopleSoftSessionExpiredError) {
          throw error;
        }
        logger.warn(
          { courseCode: group.target.courseCode, err: redactSecrets(error) },
          'Could not complete a live course availability check',
        );
      }
    }

    const deduped = this.deduplicateSections(observedSections);
    logger.info(
      { sectionCount: deduped.length, targetCount: targets.length },
      'Fetched live class status and explicit availability values',
    );
    return deduped;
  }

  // --- Navigation & Action Methods ---

  private async openRequirementsPage(page: Page): Promise<void> {
    // Try navigating directly to the Requirements component
    await page.goto(REQUIREMENTS_DIRECT_URL, {
      waitUntil: 'commit',
      timeout: 30000,
    }).catch(() => undefined);

    let ready = await this.waitForAnySelector(
      page,
      [
        'a[id^="DERIVED_SAA_FL_SAA_DESCR80$"]',
        'span[title^="Requirement Details:"]',
        'span[title^="Requirement:"]',
      ],
      15000,
    );

    if (!ready) {
      // Fallback: navigate through Manage Classes sidebar
      await page.goto(MANAGE_CLASSES_NAV_URL, {
        waitUntil: 'commit',
        timeout: 30000,
      }).catch(() => undefined);

      this.assertPageSessionActive(page, await this.collectAllMarkup(page));

      const navItem = await this.findFirstActionable(page, [
        'a[id*="SCC_LO_FL_WRK_SCC_VIEW_BTN$3"]',
        'a:has-text("Enroll by My Requirements")',
        'div[role="button"]:has-text("Enroll by My Requirements")',
        'span:has-text("Enroll by My Requirements")',
        '[id*="SSR_ENRL_MY_REQ"]',
      ]);

      if (navItem !== null) {
        await navItem.click();
        ready = await this.waitForAnySelector(
          page,
          [
            'a[id^="DERIVED_SAA_FL_SAA_DESCR80$"]',
            'span[title^="Requirement Details:"]',
            'span[title^="Requirement:"]',
          ],
          30000,
        );
      }
    }

    if (!ready) {
      this.assertPageSessionActive(page, await this.collectAllMarkup(page));
      throw new Error('Academic requirements report did not finish loading');
    }

    this.assertPageSessionActive(page, await this.collectAllMarkup(page));
  }

  private async openRequirementCourseList(
    page: Page,
    requirementLabel: string,
  ): Promise<RequirementCourseChoice[]> {
    const expected = requirementLabel.replace(/\s+/g, ' ').trim();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await this.openRequirementsPage(page);
      }

      // Find the requirement action link matching the exact label
      const clicked = await this.clickRequirementAnchor(page, expected);
      if (!clicked) continue;

      // Wait for course table rows to be visible
      const courses = await this.waitForRequirementCourses(page, 20000);
      if (courses.length > 0) {
        return courses;
      }
    }

    return [];
  }

  private async clickRequirementAnchor(page: Page, requirementLabel: string): Promise<boolean> {
    for (const frame of page.frames()) {
      const anchors = frame.locator('a[id^="DERIVED_SAA_FL_SAA_DESCR80$"]');
      const count = await anchors.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const anchor = anchors.nth(i);
        const text = (await anchor.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim();
        if (text === requirementLabel && (await anchor.isVisible().catch(() => false))) {
          await anchor.click();
          return true;
        }
      }
    }

    // Fallback: check all anchors matching the text
    for (const frame of page.frames()) {
      const matching = frame.locator(`a:has-text("${requirementLabel}")`);
      const count = await matching.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const anchor = matching.nth(i);
        const text = (await anchor.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim();
        if (text === requirementLabel && (await anchor.isVisible().catch(() => false))) {
          await anchor.click();
          return true;
        }
      }
    }

    return false;
  }

  private async waitForRequirementCourses(
    page: Page,
    timeoutMs: number,
  ): Promise<RequirementCourseChoice[]> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const markup = await this.collectAllMarkup(page);
      const courses = parseRequirementCourses(markup);
      if (courses.length > 0 && (await this.hasVisibleCourseRow(page))) {
        return courses;
      }
      await page.waitForTimeout(250);
    }

    return [];
  }

  private async hasVisibleCourseRow(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      const rows = frame.locator('tr[id^="CRSE_GRID_LIST_NFF"], tr:has(span[id^="CRSE_NAME1$"])');
      const count = await rows.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        if (await rows.nth(i).isVisible().catch(() => false)) {
          return true;
        }
      }
    }
    return false;
  }

  private async openCourseClasses(
    page: Page,
    requirementLabel: string,
    courseCode: string,
  ): Promise<void> {
    const courses = await this.openRequirementCourseList(page, requirementLabel);
    const targetNorm = normalizeCourseCode(courseCode);

    if (!courses.some((c) => normalizeCourseCode(c.courseCode) === targetNorm)) {
      throw new Error(`Course was not found in ${requirementLabel}: ${courseCode}`);
    }

    const clickedRow = await this.clickCourseRow(page, courseCode);
    if (!clickedRow) {
      throw new Error(`Course was not found in ${requirementLabel}: ${courseCode}`);
    }

    // Wait for "View Classes" anchor to become visible
    const viewClassesReady = await this.waitForAnySelector(
      page,
      ['a[id^="DERIVED_SAA_CRS_SSR_PB_FETCH$"]', 'a:has-text("View Classes")'],
      20000,
    );

    if (!viewClassesReady) {
      throw new Error(`View Classes is not available for ${courseCode}`);
    }

    const clickedViewClasses = await this.clickViewClasses(page);
    if (!clickedViewClasses) {
      throw new Error(`View Classes could not be opened for ${courseCode}`);
    }
  }

  private async clickCourseRow(page: Page, courseCode: string): Promise<boolean> {
    const targetNorm = normalizeCourseCode(courseCode);

    for (const frame of page.frames()) {
      const courseSpans = frame.locator('span[id^="CRSE_NAME1$"]');
      const count = await courseSpans.count().catch(() => 0);

      for (let i = 0; i < count; i += 1) {
        const span = courseSpans.nth(i);
        const text = (await span.textContent().catch(() => ''))?.trim() ?? '';
        if (normalizeCourseCode(text) === targetNorm) {
          const row = span.locator('xpath=ancestor::tr[1]');
          const actionLink = row.locator('a[id^="CRSE_DESCR1$"], a').first();
          if (await actionLink.isVisible().catch(() => false)) {
            await actionLink.click();
            return true;
          }
          if (await row.isVisible().catch(() => false)) {
            await row.click();
            return true;
          }
        }
      }
    }

    return false;
  }

  private async clickViewClasses(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      const link = frame.locator('a[id^="DERIVED_SAA_CRS_SSR_PB_FETCH$"]').first();
      if (await link.isVisible().catch(() => false)) {
        await link.click();
        return true;
      }
    }

    // Fallback: look for exact "View Classes" anchor (avoiding wrapper divs)
    for (const frame of page.frames()) {
      const anchors = frame.locator('a:has-text("View Classes")');
      const count = await anchors.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const anchor = anchors.nth(i);
        if (await anchor.isVisible().catch(() => false)) {
          await anchor.click();
          return true;
        }
      }
    }

    return false;
  }

  private async readTermChoices(page: Page): Promise<RequirementTermChoice[]> {
    const terms: RequirementTermChoice[] = [];
    const seen = new Set<string>();

    for (const frame of page.frames()) {
      const links = frame.locator('a[id^="SSR_CRS_TERM_WK_SSS_TERM_LINK$"]');
      const count = await links.count().catch(() => 0);

      for (let i = 0; i < count; i += 1) {
        const link = links.nth(i);
        const label = (await link.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim() ?? '';
        if (label.length === 0 || seen.has(label)) continue;
        seen.add(label);

        // Check if there is an explicit STRM field in the containing row
        const row = link.locator('xpath=ancestor::tr[1]');
        const strmField = row.locator('[id*="STRM"], [name*="STRM"]').first();
        const textContent = (await strmField.textContent().catch(() => ''))?.trim();
        const attrValue = (await strmField.getAttribute('value').catch(() => null))?.trim();
        const strmVal = textContent !== undefined && textContent.length > 0 ? textContent : attrValue;

        const termCode = strmVal && /^\d{4}$/.test(strmVal) ? strmVal : deriveTermCode(label);
        terms.push({ label, termCode });
      }
    }

    return terms;
  }

  private async waitForTermChoices(
    page: Page,
    timeoutMs: number,
  ): Promise<RequirementTermChoice[]> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const choices = await this.readTermChoices(page);
      if (choices.length > 0) return choices;
      await page.waitForTimeout(250);
    }

    return [];
  }

  private async clickTerm(page: Page, labels: readonly string[]): Promise<boolean> {
    const expected = labels.map((l) => l.replace(/\s+/g, ' ').trim().toUpperCase());

    for (const frame of page.frames()) {
      const links = frame.locator('a[id^="SSR_CRS_TERM_WK_SSS_TERM_LINK$"]');
      const count = await links.count().catch(() => 0);

      for (let i = 0; i < count; i += 1) {
        const link = links.nth(i);
        const text = (await link.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim().toUpperCase() ?? '';
        if (expected.some((exp) => text === exp || text.includes(exp))) {
          if (await link.isVisible().catch(() => false)) {
            await link.click();
            return true;
          }
        }
      }
    }

    return false;
  }

  private async waitForClassRows(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const rows = frame.locator('tr:has-text("Lecture"), tr:has-text("Lab"), tr:has-text("Discussion")');
        if ((await rows.count().catch(() => 0)) > 0) return true;
      }
      await page.waitForTimeout(250);
    }

    return false;
  }

  private async navigateToCourseClasses(page: Page, target: CourseCheckTarget): Promise<void> {
    const cacheKey = normalizeCourseCode(target.courseCode);
    const cachedRequirement = this.courseRequirementCache.get(cacheKey);

    await this.openRequirementsPage(page);
    const markup = await this.collectAllMarkup(page);
    const requirementChoices = parseRequirementChoices(markup);

    const ordered = [
      ...(cachedRequirement === undefined ? [] : [cachedRequirement]),
      ...requirementChoices.map((r) => r.label).filter((l) => l !== cachedRequirement),
    ];

    let selectedRequirement: string | null = null;

    for (let index = 0; index < ordered.length; index += 1) {
      const reqLabel = ordered[index];
      if (reqLabel === undefined) continue;

      if (index > 0) {
        await this.openRequirementsPage(page);
      }

      const courses = await this.openRequirementCourseList(page, reqLabel);
      if (courses.some((c) => normalizeCourseCode(c.courseCode) === cacheKey)) {
        selectedRequirement = reqLabel;
        this.courseRequirementCache.set(cacheKey, reqLabel);
        break;
      }
    }

    if (selectedRequirement === null) {
      throw new Error(`Course was not found in any SIS requirement: ${target.courseCode}`);
    }

    const clickedCourse = await this.clickCourseRow(page, target.courseCode);
    if (!clickedCourse) {
      throw new Error(`Course row could not be opened: ${target.courseCode}`);
    }

    const viewClassesReady = await this.waitForAnySelector(
      page,
      ['a[id^="DERIVED_SAA_CRS_SSR_PB_FETCH$"]', 'a:has-text("View Classes")'],
      20000,
    );
    if (!viewClassesReady) {
      throw new Error(`View Classes is not available for ${target.courseCode}`);
    }

    const clickedViewClasses = await this.clickViewClasses(page);
    if (!clickedViewClasses) {
      throw new Error(`View Classes could not be opened for ${target.courseCode}`);
    }

    const termLabels = [
      ...(target.termLabel === undefined ? [] : [target.termLabel]),
      target.term,
    ];

    await this.waitForTermChoices(page, 20000);
    const selectedTerm = await this.clickTerm(page, termLabels);
    if (!selectedTerm) {
      throw new Error(`Term was not found for ${target.courseCode}: ${termLabels.join(' / ')}`);
    }

    await this.waitForClassRows(page, 20000);
  }

  private async readClassAvailability(
    page: Page,
    classNumber: string,
  ): Promise<{ status: SectionStatus; availableSeats: number | null } | null> {
    // Click on class link
    const classClicked = await this.clickClassLink(page, classNumber);
    if (!classClicked) {
      return null;
    }

    // Wait for "Class Availability" tab
    const tabReady = await this.waitForAnySelector(
      page,
      ['text="Class Availability"', 'a:has-text("Class Availability")', '[id*="SSR_CLS_DTL_WRK_SSR_TAB"]'],
      10000,
    );

    if (!tabReady) {
      logger.warn({ classNumber }, 'Class details opened but availability tab was not found');
      return null;
    }

    for (const frame of page.frames()) {
      const tab = frame.locator('a:has-text("Class Availability"), text="Class Availability"').first();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click().catch(() => undefined);
        break;
      }
    }

    // Wait for availability content (Status or Available Seats)
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const availability = await this.extractAvailabilityFromDOM(page);
      if (availability !== null) {
        return {
          status: parseSectionStatus(availability.status),
          availableSeats: parseClassAvailability(availability.availableSeats),
        };
      }
      await page.waitForTimeout(250);
    }

    return null;
  }

  private async clickClassLink(page: Page, classNumber: string): Promise<boolean> {
    for (const frame of page.frames()) {
      const classLink = frame
        .locator(`a:has-text("${classNumber}"), a:has-text("Lecture - ${classNumber}")`)
        .first();
      if (await classLink.isVisible().catch(() => false)) {
        await classLink.click();
        return true;
      }
    }
    return false;
  }

  private async closeClassDetails(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      const closeBtn = frame.locator('a:has-text("Close"), button:has-text("Close"), input[value="Close"]').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click().catch(() => undefined);
        await page.waitForTimeout(500);
        return;
      }
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }

  private async extractAvailabilityFromDOM(
    page: Page,
  ): Promise<{ status: string; availableSeats: string } | null> {
    for (const frame of page.frames()) {
      const result = await frame
        .evaluate(`
          (function() {
            var roots = [];
            var collect = function(r) {
              roots.push(r);
              Array.from(r.querySelectorAll('*')).forEach(function(el) {
                if (el.shadowRoot) collect(el.shadowRoot);
              });
            };
            collect(document);
            var statusVal = null;
            var seatsVal = null;

            for (var i = 0; i < roots.length; i++) {
              var root = roots[i];
              var tables = Array.from(root.querySelectorAll('table, [role="table"], [role="grid"]'));
              for (var t = 0; t < tables.length; t++) {
                var table = tables[t];
                var rows = Array.from(table.querySelectorAll('tr, [role="row"]'));
                for (var r = 0; r < rows.length; r++) {
                  var headers = Array.from(rows[r].querySelectorAll('th, [role="columnheader"]')).map(function(th) {
                    return (th.textContent || '').replace(/[^A-Z0-9]+/gi, '').toUpperCase();
                  });
                  var statusIdx = headers.indexOf('STATUS');
                  var seatIdx = headers.findIndex(function(h) { return h.indexOf('AVAILABLESEATS') !== -1; });

                  if (seatIdx !== -1) {
                    for (var d = r + 1; d < rows.length; d++) {
                      var cells = Array.from(rows[d].querySelectorAll('td, [role="cell"]'));
                      if (cells[seatIdx]) seatsVal = (cells[seatIdx].textContent || '').trim();
                      if (statusIdx !== -1 && cells[statusIdx]) statusVal = (cells[statusIdx].textContent || '').trim();
                      if (seatsVal !== null) break;
                    }
                  }
                }
              }

              // Fallback dt/dd or label scan
              var elements = Array.from(root.querySelectorAll('dt, th, td, span, label'));
              for (var e = 0; e < elements.length; e++) {
                var el = elements[e];
                var txt = (el.textContent || '').replace(/[^A-Z0-9]+/gi, '').toUpperCase();
                if (txt === 'STATUS' && !statusVal) {
                  var next = el.nextElementSibling;
                  if (next) statusVal = (next.textContent || '').trim();
                }
                if ((txt === 'AVAILABLESEATS' || txt === 'SEATSAVAILABLE') && !seatsVal) {
                  var nextS = el.nextElementSibling;
                  if (nextS) seatsVal = (nextS.textContent || '').trim();
                }
              }
            }

            if (seatsVal !== null || statusVal !== null) {
              return { status: statusVal || '', availableSeats: seatsVal || '' };
            }
            return null;
          })()
        `)
        .catch(() => null);

      if (
        result !== null &&
        typeof result === 'object' &&
        'status' in result &&
        'availableSeats' in result &&
        typeof result.status === 'string' &&
        typeof result.availableSeats === 'string'
      ) {
        return { status: result.status.trim(), availableSeats: result.availableSeats.trim() };
      }
    }
    return null;
  }

  // --- Utility & Pure Parsing Methods ---

  private async collectAllMarkup(page: Page): Promise<string> {
    const markups = await Promise.all(
      page.frames().map((f) => f.content().catch(() => '')),
    );
    return markups.join('\n');
  }

  private assertPageSessionActive(page: Page, content: string): void {
    if (PeopleSoftHttpClient.isSessionExpired(200, content, page.url())) {
      throw new PeopleSoftSessionExpiredError();
    }
  }

  private async findFirstActionable(
    page: Page,
    selectors: readonly string[],
  ): Promise<{ click(): Promise<void> } | null> {
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          return locator;
        }
      }
    }
    return null;
  }

  private async waitForAnySelector(
    page: Page,
    selectors: readonly string[],
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        for (const selector of selectors) {
          const locator = frame.locator(selector).first();
          if (await locator.isVisible().catch(() => false)) {
            return true;
          }
        }
      }
      await page.waitForTimeout(250);
    }
    return false;
  }

  /** Pure Cheerio parser for visible sections. */
  public parseVisibleSections(
    html: string,
    target: CourseCheckTarget,
    checkedAt: Date,
  ): SectionState[] {
    const $ = cheerio.load(html);
    const parsed: SectionState[] = [];
    const normalizedTarget = normalizeCourseCode(target.courseCode);
    let pageCourseTitle: string | undefined;

    const titleCandidates = $('h1, h2, h3, div.ps_box-group')
      .toArray()
      .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
      .filter((t) => normalizeCourseCode(t).includes(normalizedTarget))
      .sort((a, b) => a.length - b.length);

    for (const candidate of titleCandidates) {
      const match = /\b([A-Z]{2,5})\s*(\d{3,4}[A-Z]?)\b/i.exec(candidate);
      if (match === null) continue;
      const title = candidate
        .slice(match.index + match[0].length)
        .replace(/^\s*[-:–—]\s*/, '')
        .replace(/\b(?:Course Information|Class Selection|Class Details|View Classes)\b.*$/i, '')
        .trim();
      if (title.length > 0) {
        pageCourseTitle = title.slice(0, 160);
        break;
      }
    }

    $('tr, [role="row"]').each((_idx, el) => {
      const row = $(el);
      const rowText = row.text().replace(/\s+/g, ' ').trim();
      const classMatch = /\b(Lecture|Lab|Discussion|Seminar|Clinical)\s*-\s*(\d{4,5})\b/i.exec(
        rowText,
      );
      if (classMatch?.[1] === undefined || classMatch[2] === undefined) return;

      const table = row.closest('table, [role="table"], [role="grid"]');
      const headerRow = table
        .find('tr, [role="row"]')
        .filter((_, h) => /\bStatus\b/i.test($(h).text()))
        .first();

      const headers = headerRow
        .find('th, [role="columnheader"]')
        .toArray()
        .map((h) => $(h).text().replace(/[^A-Z0-9]+/gi, '').toUpperCase());

      const cells = row
        .find('td, [role="cell"], [role="gridcell"]')
        .toArray()
        .map((c) => $(c).text().replace(/\s+/g, ' ').trim());

      const val = (name: string): string | undefined => {
        const wanted = name.replace(/[^A-Z0-9]+/gi, '').toUpperCase();
        const idx = headers.findIndex((h) => h.includes(wanted));
        return idx === -1 ? undefined : cells[idx];
      };

      const rowMeta = row
        .find('*')
        .toArray()
        .flatMap((c) =>
          ['aria-label', 'title', 'alt', 'data-label', 'value']
            .map((attr) => $(c).attr(attr))
            .filter((v): v is string => v !== undefined),
        )
        .join(' ');

      const statusText = `${val('Status') ?? ''} ${rowText} ${rowMeta}`;
      let status: SectionState['status'] = 'UNKNOWN';
      if (/\bwaitlist(?:ed)?\b/i.test(statusText)) status = 'WAITLIST';
      else if (/\bclosed\b/i.test(statusText)) status = 'CLOSED';
      else if (/\bopen\b/i.test(statusText)) status = 'OPEN';

      const meetingDates = val('Meeting Dates');
      const schedule = val('Days and Times');
      const sessionName = val('Session');

      parsed.push({
        term: target.term,
        ...(target.termLabel === undefined ? {} : { termLabel: target.termLabel }),
        courseCode: target.courseCode.trim().replace(/([A-Z]+)\s*(\d+)/i, '$1 $2').toUpperCase(),
        ...(pageCourseTitle === undefined ? {} : { courseTitle: pageCourseTitle }),
        classNumber: classMatch[2],
        component: classMatch[1],
        status,
        availableSeats: null,
        ...(meetingDates === undefined ? {} : { meetingDates }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(sessionName === undefined ? {} : { sessionName }),
        checkedAt,
      });
    });

    if (parsed.length > 0) {
      return this.deduplicateSections(parsed);
    }

    $('h1, h2, h3, div.ps_box-group').each((_idx, el) => {
      const heading = $(el).text().replace(/\s+/g, ' ').trim();
      const match = /\b([A-Z]{2,5})\s*(\d{3,4}[A-Z]?)\b/.exec(heading);
      if (!match?.[1] || !match[2]) return;

      const code = `${match[1]} ${match[2]}`;
      if (normalizeCourseCode(code) !== normalizedTarget) return;

      const container = $(el).closest('article, li, tr, [role="row"], div.ps_box-group, section');
      const containerText = container.text().replace(/\s+/g, ' ').trim();
      const classMatch = /\b(Lecture|Lab|Discussion|Seminar|Clinical)\s*-\s*(\d{4,5})\b/i.exec(
        containerText,
      );
      if (!classMatch?.[1] || !classMatch[2]) return;

      let status: SectionState['status'] = 'UNKNOWN';
      if (/\bclosed\b/i.test(containerText)) status = 'CLOSED';
      else if (/\bwaitlist(?:ed)?\b/i.test(containerText)) status = 'WAITLIST';
      else if (/\bopen\b/i.test(containerText)) status = 'OPEN';

      const scheduleMatch = /Days:\s*(.+?)\s+Times:\s*(.+?)(?:\s+Room\b|\s+Dates\b|$)/i.exec(
        containerText,
      );
      const title = heading
        .slice(match.index + match[0].length)
        .replace(/^\s*[-:–—]\s*/, '')
        .replace(/\b(?:Lecture|Lab|Discussion|Seminar|Clinical)\s*-\s*\d{4,5}.*$/i, '')
        .replace(/\b(?:Class Details|View Classes|StatusUnits|\d+\s+rows?)\b.*$/i, '')
        .trim();

      parsed.push({
        term: target.term,
        ...(target.termLabel === undefined ? {} : { termLabel: target.termLabel }),
        courseCode: code,
        ...(title.length === 0 ? {} : { courseTitle: title.slice(0, 160) }),
        classNumber: classMatch[2],
        component: classMatch[1],
        status,
        availableSeats: null,
        ...(scheduleMatch?.[1] && scheduleMatch[2]
          ? { schedule: `${scheduleMatch[1]} ${scheduleMatch[2]}`.trim() }
          : {}),
        checkedAt,
      });
    });

    return this.deduplicateSections(parsed);
  }

  private deduplicateSections(sections: readonly SectionState[]): SectionState[] {
    const seen = new Set<string>();
    const deduped: SectionState[] = [];

    for (const section of sections) {
      const key = `${section.term}\u0000${normalizeCourseCode(section.courseCode)}\u0000${section.classNumber}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(section);
      }
    }

    return deduped;
  }
}
