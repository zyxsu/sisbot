import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

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
import { deriveTermCode } from './playwright-section-checker.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MANAGE_CLASSES_NAV_URL =
  'https://sis.auib.edu.iq/psc/ps/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_START_PAGE_FL.GBL?GMenu=SSR_STUDENT_FL&GComp=SSR_START_PAGE_FL&GPage=SSR_START_PAGE_FL&scname=CS_SSR_MANAGE_CLASSES_NAV';
const BROWSE_SESSION_TTL_MS = 15 * 60 * 1000;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function normalizeCourseCode(courseCode: string): string {
  return courseCode.replace(/\s+/g, '').toUpperCase();
}

function courseKey(target: CourseCheckTarget): string {
  return `${target.term.trim()}\u0000${normalizeCourseCode(target.courseCode)}`;
}

export class PuppeteerSectionChecker implements SectionChecker, RequirementBrowser {
  private readonly courseRequirementCache = new Map<string, string>();
  private readonly browsePages = new Map<
    string,
    { browser: Browser; page: Page; cleanupTimer: NodeJS.Timeout }
  >();
  private browserOperationTail: Promise<void> = Promise.resolve();

  public listRequirements(cookiesPayload: unknown): Promise<RequirementChoice[]> {
    return this.withBrowsePage(cookiesPayload, async (page) => {
      const requirementsPage = await this.openRequirementsPage(page);
      return this.readRequirementChoices(requirementsPage);
    });
  }

  public listCourses(
    cookiesPayload: unknown,
    requirementLabel: string,
  ): Promise<RequirementCourseChoice[]> {
    return this.withBrowsePage(cookiesPayload, async (page) => {
      const requirementsPage = await this.openRequirementsPage(page);
      const { courses } = await this.openRequirementCourseList(requirementsPage, requirementLabel);
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
    return this.withBrowsePage(cookiesPayload, async (page) => {
      const requirementsPage = await this.openRequirementsPage(page);
      const coursePage = await this.openCourseClasses(
        requirementsPage,
        requirementLabel,
        courseCode,
      );
      this.courseRequirementCache.set(normalizeCourseCode(courseCode), requirementLabel);
      const labels = await this.waitForTermLabels(coursePage, 20_000);
      return labels.map((label) => ({ label, termCode: deriveTermCode(label) }));
    });
  }

  public listCourseSections(
    cookiesPayload: unknown,
    requirementLabel: string,
    courseCode: string,
    term: string,
    termLabel: string,
  ): Promise<SectionState[]> {
    return this.withBrowsePage(cookiesPayload, async (page) => {
      const requirementsPage = await this.openRequirementsPage(page);
      const coursePage = await this.openCourseClasses(
        requirementsPage,
        requirementLabel,
        courseCode,
      );
      this.courseRequirementCache.set(normalizeCourseCode(courseCode), requirementLabel);
      await this.waitForTermLabels(coursePage, 20_000);
      const selectedTerm = await this.clickTerm(coursePage, [termLabel, term]);
      if (!selectedTerm) {
        throw new Error(`Term was not found for ${courseCode}: ${termLabel}`);
      }
      await sleep(2_000);
      const classPage = await this.newestBrowserPage(coursePage);
      const sections = this.parseVisibleSections(
        await this.collectFrameMarkup(classPage),
        { courseCode, term, termLabel },
        new Date(),
      );
      return sections.filter(
        (section) => normalizeCourseCode(section.courseCode) === normalizeCourseCode(courseCode),
      );
    });
  }
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
        const allSections = await this.runBrowserOperation(() =>
          this.fetchLiveSections(
            request.session.id,
            request.targets,
            request.checkedAt ?? new Date(),
          ),
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

  private withBrowsePage<T>(
    cookiesPayload: unknown,
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    return this.runBrowserOperation(async () => {
      const cookieHeader = PeopleSoftHttpClient.normalizeCookieHeader(cookiesPayload);
      const sessionKey = createHash('sha256').update(cookieHeader).digest('hex');
      let cached = this.browsePages.get(sessionKey);

      if (cached === undefined || !cached.browser.connected || cached.page.isClosed()) {
        if (cached !== undefined) {
          clearTimeout(cached.cleanupTimer);
          await cached.browser.close().catch(() => undefined);
        }
        const browser = await puppeteer.launch({
          executablePath: EDGE_PATH,
          headless: true,
          defaultViewport: { width: 1280, height: 800 },
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--ignore-certificate-errors',
            '--window-size=1280,800',
          ],
        });
        await this.installCookies(browser, cookieHeader);
        const page = await browser.newPage();
        const cleanupTimer = this.createBrowseCleanupTimer(sessionKey, browser);
        cached = { browser, page, cleanupTimer };
        this.browsePages.set(sessionKey, cached);
      } else {
        clearTimeout(cached.cleanupTimer);
        cached.cleanupTimer = this.createBrowseCleanupTimer(sessionKey, cached.browser);
      }

      try {
        return await operation(cached.page);
      } catch (error) {
        if (error instanceof PeopleSoftSessionExpiredError) {
          clearTimeout(cached.cleanupTimer);
          this.browsePages.delete(sessionKey);
          await cached.browser.close().catch(() => undefined);
        }
        throw error;
      }
    });
  }

  private runBrowserOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.browserOperationTail.then(operation, operation);
    this.browserOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private createBrowseCleanupTimer(sessionKey: string, browser: Browser): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const cached = this.browsePages.get(sessionKey);
      if (cached?.browser !== browser) return;
      this.browsePages.delete(sessionKey);
      void browser.close().catch(() => undefined);
    }, BROWSE_SESSION_TTL_MS);
    timer.unref();
    return timer;
  }

  private async fetchLiveSections(
    cookiesPayload: unknown,
    targets: readonly CourseCheckTarget[],
    checkedAt: Date,
  ): Promise<SectionState[]> {
    const cookieHeader = PeopleSoftHttpClient.normalizeCookieHeader(cookiesPayload);
    let browser: Browser | null = null;

    try {
      browser = await puppeteer.launch({
        executablePath: EDGE_PATH,
        headless: true,
        defaultViewport: { width: 1280, height: 800 },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--ignore-certificate-errors',
          '--window-size=1280,800',
        ],
      });

      let page = await browser.newPage();
      await this.installCookies(browser, cookieHeader);

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
          page = await this.navigateToCourseClasses(page, group.target);
          const coursePageMarkup = await this.collectFrameMarkup(page);
          this.assertBrowserSessionActive(page, coursePageMarkup);

          const sections = this.parseVisibleSections(
            coursePageMarkup,
            group.target,
            checkedAt,
          ).filter(
            (section) =>
              group.includeAllClasses || group.requestedClassNumbers.has(section.classNumber),
          );

          sections.sort((left, right) => {
            const leftRequested = group.requestedClassNumbers.has(left.classNumber) ? 0 : 1;
            const rightRequested = group.requestedClassNumbers.has(right.classNumber) ? 0 : 1;
            return leftRequested - rightRequested;
          });

          logger.info(
            {
              courseCode: group.target.courseCode,
              sectionCount: sections.length,
              requestedSectionCount: sections.filter((section) =>
                group.requestedClassNumbers.has(section.classNumber),
              ).length,
            },
            'Parsed live class rows before availability checks',
          );

          for (let index = 0; index < sections.length; index += 1) {
            const section = sections[index];

            if (section === undefined) {
              continue;
            }

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

        await sleep(750);
      }

      const deduped = this.deduplicateSections(observedSections);
      logger.info(
        { sectionCount: deduped.length, targetCount: targets.length },
        'Fetched live class status and explicit availability values',
      );

      return deduped;
    } finally {
      if (browser !== null) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  private async installCookies(browser: Browser, cookieHeader: string): Promise<void> {
    const pairs = cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean);

    for (const pair of pairs) {
      const [name, ...valueParts] = pair.split('=');

      if (name === undefined || name.trim().length === 0 || valueParts.length === 0) {
        continue;
      }

      await browser
        .setCookie({
          name: name.trim(),
          value: valueParts.join('='),
          domain: 'sis.auib.edu.iq',
          path: '/',
        })
        .catch(() => undefined);
    }
  }

  private async openRequirementsPage(page: Page): Promise<Page> {
    await page.goto(MANAGE_CLASSES_NAV_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await sleep(2_000);
    this.assertBrowserSessionActive(page, await this.collectFrameMarkup(page));

    const clicked = await this.clickVisibleText(page, ['Enroll by My Requirements']);
    if (!clicked) {
      throw new Error('Enroll by My Requirements navigation entry was not found');
    }
    const requirementsPage = await this.findRequirementsReportPage(page, 45_000);

    if (requirementsPage === null) {
      throw new Error('Academic requirements report did not finish loading');
    }
    this.assertBrowserSessionActive(
      requirementsPage,
      await this.collectFrameMarkup(requirementsPage),
    );
    return requirementsPage;
  }

  private async findRequirementsReportPage(
    currentPage: Page,
    timeoutMs: number,
  ): Promise<Page | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const pages = await currentPage.browser().pages();
      for (const candidate of [...pages].reverse()) {
        const markup = await this.collectFrameMarkup(candidate);
        const $ = cheerio.load(markup);
        if (
          $('span[title^="Requirement Details:"]').length > 0 ||
          /Report\s+data\s+generated\s+on/i.test($.text())
        ) {
          return candidate;
        }
      }
      await sleep(250);
    }

    return null;
  }

  private async readRequirementChoices(page: Page): Promise<RequirementChoice[]> {
    return parseRequirementChoices(await this.collectFrameMarkup(page));
  }

  private async clickRequirementChoice(page: Page, requirementLabel: string): Promise<boolean> {
    const expected = requirementLabel.replace(/\s+/g, ' ').trim();
    const script = `
      (function() {
        var expected = ${JSON.stringify(expected)};
        var links = Array.from(document.querySelectorAll('a[id^="DERIVED_SAA_FL_SAA_DESCR80$"], a'));
        var target = links.find(function(link) {
          var rect = link.getBoundingClientRect();
          var style = window.getComputedStyle(link);
          return String(link.textContent || '').replace(/\\s+/g, ' ').trim() === expected &&
            rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (!target) return false;
        target.click();
        return true;
      })()
    `;

    for (const frame of page.frames()) {
      if ((await frame.evaluate(script).catch(() => false)) === true) {
        await sleep(1_500);
        return true;
      }
    }

    return false;
  }

  private async readRequirementCourses(page: Page): Promise<RequirementCourseChoice[]> {
    return parseRequirementCourses(await this.collectFrameMarkup(page));
  }

  private async waitForRequirementCourses(
    page: Page,
    timeoutMs: number,
  ): Promise<RequirementCourseChoice[]> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const courses = await this.readRequirementCourses(page);
      if (courses.length > 0 && (await this.hasVisibleRequirementCourseRow(page))) return courses;
      await sleep(250);
    }

    return [];
  }

  private async hasVisibleRequirementCourseRow(page: Page): Promise<boolean> {
    const script = `
      (function() {
        return Array.from(document.querySelectorAll('span[id^="CRSE_NAME1$"]')).some(function(course) {
          var row = course.closest('tr[id^="CRSE_GRID_LIST_NFF"], tr, [role="row"]');
          if (!row) return false;
          var rect = row.getBoundingClientRect();
          var style = window.getComputedStyle(row);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
      })()
    `;

    for (const frame of page.frames()) {
      if ((await frame.evaluate(script).catch(() => false)) === true) return true;
    }
    return false;
  }

  private async openRequirementCourseList(
    initialPage: Page,
    requirementLabel: string,
  ): Promise<{ page: Page; courses: RequirementCourseChoice[] }> {
    let page = initialPage;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) page = await this.openRequirementsPage(page);
      if (!(await this.clickRequirementChoice(page, requirementLabel))) continue;
      const courses = await this.waitForRequirementCourses(page, 15_000);
      if (courses.length > 0) return { page, courses };
    }

    return { page, courses: [] };
  }

  private async clickCourseRow(page: Page, courseCode: string): Promise<boolean> {
    const expected = normalizeCourseCode(courseCode);
    const script = `
      (function() {
        var expected = ${JSON.stringify(expected)};
        var courses = Array.from(document.querySelectorAll('span[id^="CRSE_NAME1$"]'));
        var matches = courses.filter(function(element) {
          return String(element.textContent || '').replace(/\\s+/g, '').toUpperCase() === expected;
        });
        var row = matches.map(function(target) {
          return target.closest('tr[id^="CRSE_GRID_LIST_NFF"], tr, [role="row"]');
        }).find(function(candidate) {
          if (!candidate) return false;
          var candidateRect = candidate.getBoundingClientRect();
          var candidateStyle = window.getComputedStyle(candidate);
          return candidateRect.width > 0 && candidateRect.height > 0 &&
            candidateStyle.display !== 'none' && candidateStyle.visibility !== 'hidden';
        });
        if (!row) return false;
        row.click();
        return true;
      })()
    `;

    for (const frame of page.frames()) {
      if ((await frame.evaluate(script).catch(() => false)) === true) {
        await sleep(1_500);
        return true;
      }
    }

    return false;
  }

  private async openCourseClasses(
    requirementsPage: Page,
    requirementLabel: string,
    courseCode: string,
  ): Promise<Page> {
    const opened = await this.openRequirementCourseList(requirementsPage, requirementLabel);
    requirementsPage = opened.page;
    const courses = opened.courses;
    if (
      !courses.some(
        (course) => normalizeCourseCode(course.courseCode) === normalizeCourseCode(courseCode),
      )
    ) {
      throw new Error(`Course was not found in ${requirementLabel}: ${courseCode}`);
    }
    if (!(await this.clickCourseRow(requirementsPage, courseCode))) {
      throw new Error(`Course was not found in ${requirementLabel}: ${courseCode}`);
    }
    requirementsPage = await this.newestBrowserPage(requirementsPage);
    const courseDetailsLoaded = await this.waitForAnyText(
      requirementsPage,
      ['View Classes'],
      15_000,
    );
    if (!courseDetailsLoaded || !(await this.clickViewClasses(requirementsPage))) {
      throw new Error(`View Classes is not available for ${courseCode}`);
    }
    await sleep(2_000);
    return this.newestBrowserPage(requirementsPage);
  }

  private async readTermLabels(page: Page): Promise<string[]> {
    const labels = new Set<string>();
    const termPattern = /^\d{4}\/\d{4}\s+(?:Fall|Spring|Summer)(?:\s+\w+)?$/i;

    for (const frame of page.frames()) {
      const values = await frame
        .evaluate(
          `(function() {
            var roots = [];
            var collectRoots = function(root) {
              roots.push(root);
              Array.from(root.querySelectorAll('*')).forEach(function(element) {
                if (element.shadowRoot) collectRoots(element.shadowRoot);
              });
            };
            collectRoots(document);
            return roots.flatMap(function(root) {
              return Array.from(root.querySelectorAll('a, button, [role="link"], [role="button"], [onclick], span'))
                .map(function(element) { return String(element.textContent || '').replace(/\\s+/g, ' ').trim(); })
                .filter(Boolean);
            });
          })()`,
        )
        .catch(() => []);
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === 'string' && termPattern.test(value)) labels.add(value);
        }
      }
    }

    return [...labels];
  }

  private async waitForTermLabels(page: Page, timeoutMs: number): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const labels = await this.readTermLabels(page);
      if (labels.length > 0) return labels;
      await sleep(250);
    }

    return [];
  }

  private async navigateToCourseClasses(page: Page, target: CourseCheckTarget): Promise<Page> {
    const cacheKey = normalizeCourseCode(target.courseCode);
    const cachedRequirement = this.courseRequirementCache.get(cacheKey);
    page = await this.openRequirementsPage(page);
    const requirementChoices = await this.readRequirementChoices(page);
    const orderedRequirements = [
      ...(cachedRequirement === undefined ? [] : [cachedRequirement]),
      ...requirementChoices
        .map(({ label }) => label)
        .filter((label) => label !== cachedRequirement),
    ];
    let selectedRequirement: string | null = null;

    for (let index = 0; index < orderedRequirements.length; index += 1) {
      const requirementLabel = orderedRequirements[index];
      if (requirementLabel === undefined) continue;
      if (index > 0) page = await this.openRequirementsPage(page);
      const opened = await this.openRequirementCourseList(page, requirementLabel);
      page = opened.page;
      const courses = opened.courses;
      if (
        courses.some(
          ({ courseCode }) =>
            normalizeCourseCode(courseCode) === normalizeCourseCode(target.courseCode),
        )
      ) {
        selectedRequirement = requirementLabel;
        this.courseRequirementCache.set(cacheKey, requirementLabel);
        break;
      }
    }

    if (selectedRequirement === null) {
      throw new Error(`Course was not found in any SIS requirement: ${target.courseCode}`);
    }
    if (!(await this.clickCourseRow(page, target.courseCode))) {
      throw new Error(`Course row could not be opened: ${target.courseCode}`);
    }
    page = await this.newestBrowserPage(page);
    if (!(await this.waitForAnyText(page, ['View Classes'], 15_000))) {
      throw new Error(`View Classes is not available for ${target.courseCode}`);
    }
    if (!(await this.clickViewClasses(page))) {
      throw new Error(`View Classes could not be opened for ${target.courseCode}`);
    }
    await sleep(2_000);
    page = await this.newestBrowserPage(page);

    const termLabels = [...(target.termLabel === undefined ? [] : [target.termLabel]), target.term];
    await this.waitForTermLabels(page, 20_000);
    const selectedTerm = await this.clickTerm(page, termLabels);
    if (!selectedTerm) {
      throw new Error(`Term was not found for ${target.courseCode}: ${termLabels.join(' / ')}`);
    }
    await sleep(2_000);
    page = await this.newestBrowserPage(page);
    if (target.classNumber !== undefined) {
      await this.waitForAnyText(page, [target.classNumber], 10_000);
    }

    const pageFacts = await this.inspectPageFacts(page, target);
    logger.info(
      {
        courseCode: target.courseCode,
        requirementLabel: selectedRequirement,
        selectedTerm,
        ...pageFacts,
      },
      'Completed read-only PeopleSoft course navigation',
    );

    return page;
  }

  private async clickViewClasses(page: Page): Promise<boolean> {
    const script = `
      (function() {
        var links = Array.from(document.querySelectorAll('a[id^="DERIVED_SAA_CRS_SSR_PB_FETCH$"]'));
        var target = links.find(function(link) {
          var rect = link.getBoundingClientRect();
          var style = window.getComputedStyle(link);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (!target) return false;
        target.click();
        return true;
      })()
    `;

    for (const frame of page.frames()) {
      if ((await frame.evaluate(script).catch(() => false)) === true) return true;
    }

    return false;
  }

  private async clickTerm(page: Page, labels: readonly string[]): Promise<boolean> {
    const expected = labels.map((label) => label.replace(/\s+/g, ' ').trim());
    const script = `
      (function() {
        var expected = ${JSON.stringify(expected)};
        var links = Array.from(document.querySelectorAll('a[id^="SSR_CRS_TERM_WK_SSS_TERM_LINK$"]'));
        var target = links.find(function(link) {
          var text = String(link.textContent || '').replace(/\\s+/g, ' ').trim();
          var rect = link.getBoundingClientRect();
          var style = window.getComputedStyle(link);
          return expected.indexOf(text) !== -1 && rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (!target) return false;
        target.click();
        return true;
      })()
    `;

    for (const frame of page.frames()) {
      if ((await frame.evaluate(script).catch(() => false)) === true) return true;
    }

    return false;
  }

  private async newestBrowserPage(currentPage: Page): Promise<Page> {
    const pages = await currentPage.browser().pages();
    const newestPage = pages.at(-1) ?? currentPage;

    if (newestPage !== currentPage) {
      await newestPage
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5_000 })
        .catch(() => null);
    }

    return newestPage;
  }

  private async waitForRequirementsReport(page: Page): Promise<void> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const loading = await this.pageContainsAnyText(page, [
        'Loading Academic Requirements report',
      ]);

      if (!loading) {
        return;
      }

      await sleep(250);
    }
  }

  private async pageContainsAnyText(page: Page, labels: readonly string[]): Promise<boolean> {
    const wanted = labels.map((label) => label.replace(/[^A-Z0-9]+/gi, '').toUpperCase());

    for (const frame of page.frames()) {
      const visibleText = await frame
        .evaluate(
          '(function() { return document.body ? String(document.body.innerText || "") : ""; })()',
        )
        .catch(() => '');

      if (typeof visibleText !== 'string') {
        continue;
      }

      const canonicalText = visibleText.replace(/[^A-Z0-9]+/gi, '').toUpperCase();
      if (wanted.some((label) => canonicalText.includes(label))) {
        return true;
      }
    }

    return false;
  }

  private async waitForAnyText(
    page: Page,
    labels: readonly string[],
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.pageContainsAnyText(page, labels)) {
        return true;
      }

      await sleep(250);
    }

    return false;
  }

  private async inspectPageFacts(
    page: Page,
    target: CourseCheckTarget,
  ): Promise<{
    frameCount: number;
    hasTargetCourse: boolean;
    hasViewClasses: boolean;
    hasTargetClass: boolean;
    hasClassAvailability: boolean;
  }> {
    const facts = {
      frameCount: page.frames().length,
      hasTargetCourse: false,
      hasViewClasses: false,
      hasTargetClass: false,
      hasClassAvailability: false,
    };
    const wantedCourse = normalizeCourseCode(target.courseCode);

    for (const frame of page.frames()) {
      const visibleText = await frame
        .evaluate(
          '(function() { return document.body ? String(document.body.innerText || "") : ""; })()',
        )
        .catch(() => '');

      if (typeof visibleText !== 'string') {
        continue;
      }

      const compactText = visibleText.replace(/\s+/g, '').toUpperCase();
      facts.hasTargetCourse ||= compactText.includes(wantedCourse);
      facts.hasViewClasses ||= /VIEW\s+CLASSES/i.test(visibleText);
      facts.hasTargetClass ||=
        target.classNumber !== undefined && visibleText.includes(target.classNumber);
      facts.hasClassAvailability ||= /CLASS\s+AVAILABILITY/i.test(visibleText);
    }

    return facts;
  }

  private async clickVisibleText(page: Page, labels: readonly string[]): Promise<boolean> {
    const normalizedLabels = labels
      .map((label) => label.replace(/[^A-Z0-9]+/gi, '').toUpperCase())
      .filter(Boolean);

    if (normalizedLabels.length === 0) {
      return false;
    }

    for (const exactMatch of [true, false]) {
      for (const frame of page.frames()) {
        const candidates = await frame.$$(
          'a, button, input, [role="link"], [role="button"], [onclick], span, div, h1, h2, h3',
        );

        for (const candidate of candidates) {
          const values = await candidate
            .evaluate((element) => {
              const candidateElement = element as unknown as {
                textContent?: string | null;
                getAttribute(name: string): string | null;
              };

              return [
                candidateElement.textContent ?? '',
                candidateElement.getAttribute('value') ?? '',
                candidateElement.getAttribute('aria-label') ?? '',
                candidateElement.getAttribute('title') ?? '',
              ];
            })
            .catch(() => []);
          const normalizedValues = values.map((value) =>
            value.replace(/[^A-Z0-9]+/gi, '').toUpperCase(),
          );
          const matches = normalizedLabels.some((label) =>
            normalizedValues.some((value) =>
              exactMatch ? value === label : value.includes(label),
            ),
          );

          if (!matches || !(await candidate.isVisible().catch(() => false))) {
            continue;
          }

          await candidate.evaluate((element, labels) => {
            interface CandidateNode {
              tagName: string;
              textContent: string | null;
              parentElement: CandidateNode | null;
              tabIndex: number;
              getAttribute(name: string): string | null;
              hasAttribute(name: string): boolean;
              querySelectorAll(selector: string): CandidateNode[];
              setAttribute(name: string, value: string): void;
            }

            const normalize = (value: string | null): string =>
              (value ?? '').replace(/[^A-Z0-9]+/gi, '').toUpperCase();
            const original = element as unknown as CandidateNode;
            let current: CandidateNode | null = original;

            for (let depth = 0; depth < 8 && current !== null; depth += 1) {
              const role = current.getAttribute('role')?.toLowerCase();
              const isInteractive =
                current.tagName === 'A' ||
                current.tagName === 'BUTTON' ||
                role === 'link' ||
                role === 'button' ||
                current.hasAttribute('onclick') ||
                current.tabIndex >= 0;

              if (isInteractive) {
                const nestedAction = Array.from(
                  current.querySelectorAll('a, button, [role="link"], [role="button"], [onclick]'),
                ).find((action) =>
                  labels.some((label) =>
                    [
                      action.textContent,
                      action.getAttribute('value'),
                      action.getAttribute('aria-label'),
                      action.getAttribute('title'),
                    ].some((value) => normalize(value) === label),
                  ),
                );
                if (nestedAction !== undefined) {
                  nestedAction.setAttribute('data-seat-monitor-click-target', 'true');
                  return;
                }
                current.setAttribute('data-seat-monitor-click-target', 'true');
                return;
              }

              current = current.parentElement;
            }

            original.setAttribute('data-seat-monitor-click-target', 'true');
          }, normalizedLabels);
          const clickable = await frame.$('[data-seat-monitor-click-target="true"]');

          if (clickable === null) {
            continue;
          }

          await clickable.evaluate((element) => {
            (element as unknown as { click(): void }).click();
          });
          await clickable.dispose();
          await frame
            .evaluate(
              '(function() { document.querySelectorAll("[data-seat-monitor-click-target]").forEach(function(element) { element.removeAttribute("data-seat-monitor-click-target"); }); })()',
            )
            .catch(() => undefined);
          await Promise.all(candidates.map((handle) => handle.dispose().catch(() => undefined)));
          return true;
        }

        await Promise.all(candidates.map((handle) => handle.dispose().catch(() => undefined)));
      }
    }

    return this.clickVisibleTextInShadowRoots(page, normalizedLabels);
  }

  private async clickVisibleTextInShadowRoots(
    page: Page,
    normalizedLabels: readonly string[],
  ): Promise<boolean> {
    const script = `
      (function() {
        var labels = ${JSON.stringify(normalizedLabels)};
        var normalize = function(value) {
          return String(value || '').replace(/[^A-Z0-9]+/gi, '').toUpperCase();
        };
        var roots = [];
        var collectRoots = function(root) {
          roots.push(root);
          Array.from(root.querySelectorAll('*')).forEach(function(element) {
            if (element.shadowRoot) collectRoots(element.shadowRoot);
          });
        };
        var isVisible = function(element) {
          var rect = element.getBoundingClientRect();
          var style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        var interactive = function(element) {
          var current = element;
          for (var depth = 0; depth < 8 && current; depth += 1) {
            var role = String(current.getAttribute('role') || '').toLowerCase();
            if (current.tagName === 'A' || current.tagName === 'BUTTON' || role === 'link' || role === 'button' || current.hasAttribute('onclick') || current.tabIndex >= 0) {
              return current;
            }
            current = current.parentElement;
          }
          return null;
        };
        collectRoots(document);

        for (var exactIndex = 0; exactIndex < 2; exactIndex += 1) {
          var exact = exactIndex === 0;
          for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
            var candidates = Array.from(roots[rootIndex].querySelectorAll('a, button, input, [role="link"], [role="button"], [onclick], [tabindex], span, div'));
            for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
              var candidate = candidates[candidateIndex];
              var values = [candidate.textContent, candidate.getAttribute('value'), candidate.getAttribute('aria-label'), candidate.getAttribute('title')].map(normalize);
              var matches = labels.some(function(label) {
                return values.some(function(value) { return exact ? value === label : value.indexOf(label) !== -1; });
              });
              if (!matches || !isVisible(candidate)) continue;
              var target = interactive(candidate) || candidate;
              if (!isVisible(target)) continue;
              target.click();
              return true;
            }
          }
        }

        return false;
      })()
    `;

    for (const frame of page.frames()) {
      const clicked = await frame.evaluate(script).catch(() => false);
      if (clicked === true) {
        return true;
      }
    }

    return false;
  }

  /** Pure parser kept public so captured/synthetic class-list markup can be regression-tested. */
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
      .map((element) => $(element).text().replace(/\s+/g, ' ').trim())
      .filter((text) => normalizeCourseCode(text).includes(normalizedTarget))
      .sort((left, right) => left.length - right.length);

    for (const candidate of titleCandidates) {
      const courseMatch = /\b([A-Z]{2,5})\s*(\d{3,4}[A-Z]?)\b/i.exec(candidate);
      if (courseMatch === null) continue;

      const candidateTitle = candidate
        .slice(courseMatch.index + courseMatch[0].length)
        .replace(/^\s*[-:–—]\s*/, '')
        .replace(/\b(?:Course Information|Class Selection|Class Details|View Classes)\b.*$/i, '')
        .trim();

      if (candidateTitle.length > 0) {
        pageCourseTitle = candidateTitle.slice(0, 160);
        break;
      }
    }

    $('tr, [role="row"]').each((_index, element) => {
      const row = $(element);
      const rowText = row.text().replace(/\s+/g, ' ').trim();
      const classMatch = /\b(Lecture|Lab|Discussion|Seminar|Clinical)\s*-\s*(\d{4,5})\b/i.exec(
        rowText,
      );

      if (classMatch?.[1] === undefined || classMatch[2] === undefined) {
        return;
      }

      const table = row.closest('table, [role="table"], [role="grid"]');
      const headerRow = table
        .find('tr, [role="row"]')
        .filter((_headerIndex, headerElement) => /\bStatus\b/i.test($(headerElement).text()))
        .first();
      const headers = headerRow
        .find('th, [role="columnheader"]')
        .toArray()
        .map((header) =>
          $(header)
            .text()
            .replace(/[^A-Z0-9]+/gi, '')
            .toUpperCase(),
        );
      const cells = row
        .find('td, [role="cell"], [role="gridcell"]')
        .toArray()
        .map((cell) => $(cell).text().replace(/\s+/g, ' ').trim());
      const valueForHeader = (headerName: string): string | undefined => {
        const wanted = headerName.replace(/[^A-Z0-9]+/gi, '').toUpperCase();
        const cellIndex = headers.findIndex((header) => header.includes(wanted));
        return cellIndex === -1 ? undefined : cells[cellIndex];
      };
      const rowMetadata = row
        .find('*')
        .toArray()
        .flatMap((candidate) => {
          const current = $(candidate);
          return ['aria-label', 'title', 'alt', 'data-label', 'value']
            .map((attribute) => current.attr(attribute))
            .filter((value): value is string => value !== undefined);
        })
        .join(' ');
      const statusText = `${valueForHeader('Status') ?? ''} ${rowText} ${rowMetadata}`;
      let status: SectionState['status'] = 'UNKNOWN';
      if (/\bwaitlist(?:ed)?\b/i.test(statusText)) status = 'WAITLIST';
      else if (/\bclosed\b/i.test(statusText)) status = 'CLOSED';
      else if (/\bopen\b/i.test(statusText)) status = 'OPEN';

      const meetingDates = valueForHeader('Meeting Dates');
      const schedule = valueForHeader('Days and Times');
      const sessionName = valueForHeader('Session');

      parsed.push({
        term: target.term,
        ...(target.termLabel === undefined ? {} : { termLabel: target.termLabel }),
        courseCode: target.courseCode
          .trim()
          .replace(/([A-Z]+)\s*(\d+)/i, '$1 $2')
          .toUpperCase(),
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

    $('h1, h2, h3, div.ps_box-group').each((_index, element) => {
      const headingText = $(element).text().replace(/\s+/g, ' ').trim();
      const courseMatch = /\b([A-Z]{2,5})\s*(\d{3,4}[A-Z]?)\b/.exec(headingText);

      if (courseMatch?.[1] === undefined || courseMatch[2] === undefined) {
        return;
      }

      const courseCode = `${courseMatch[1]} ${courseMatch[2]}`;
      if (normalizeCourseCode(courseCode) !== normalizedTarget) {
        return;
      }

      const container = $(element).closest(
        'article, li, tr, [role="row"], div.ps_box-group, section',
      );
      const containerText = container.text().replace(/\s+/g, ' ').trim();
      const containerMetadata = container
        .find('*')
        .toArray()
        .flatMap((candidate) => {
          const current = $(candidate);
          return ['aria-label', 'title', 'alt', 'data-label', 'value']
            .map((attribute) => current.attr(attribute))
            .filter((value): value is string => value !== undefined);
        })
        .join(' ');
      const statusSource = `${containerText} ${containerMetadata}`;
      const classMatch = /\b(Lecture|Lab|Discussion|Seminar|Clinical)\s*-\s*(\d{4,5})\b/i.exec(
        containerText,
      );

      if (classMatch?.[1] === undefined || classMatch[2] === undefined) {
        return;
      }

      let status: SectionState['status'] = 'UNKNOWN';
      if (/\bclosed\b/i.test(statusSource)) status = 'CLOSED';
      else if (/\bwaitlist(?:ed)?\b/i.test(statusSource)) status = 'WAITLIST';
      else if (/\bopen\b/i.test(statusSource)) status = 'OPEN';

      const scheduleMatch = /Days:\s*(.+?)\s+Times:\s*(.+?)(?:\s+Room\b|\s+Dates\b|$)/i.exec(
        containerText,
      );
      const courseTitle = headingText
        .slice(courseMatch.index + courseMatch[0].length)
        .replace(/^\s*[-:–—]\s*/, '')
        .replace(/\b(?:Lecture|Lab|Discussion|Seminar|Clinical)\s*-\s*\d{4,5}.*$/i, '')
        .replace(/\b(?:Class Details|View Classes|StatusUnits|\d+\s+rows?)\b.*$/i, '')
        .trim();

      parsed.push({
        term: target.term,
        ...(target.termLabel === undefined ? {} : { termLabel: target.termLabel }),
        courseCode,
        ...(courseTitle.length === 0 ? {} : { courseTitle: courseTitle.slice(0, 160) }),
        classNumber: classMatch[2],
        component: classMatch[1],
        status,
        availableSeats: null,
        ...(scheduleMatch?.[1] === undefined || scheduleMatch[2] === undefined
          ? {}
          : { schedule: `${scheduleMatch[1]} ${scheduleMatch[2]}`.trim() }),
        checkedAt,
      });
    });

    return this.deduplicateSections(parsed);
  }

  private async readClassAvailability(
    page: Page,
    classNumber: string,
  ): Promise<{ status: SectionStatus; availableSeats: number | null } | null> {
    const clicked = await this.clickVisibleText(page, [classNumber, `Lecture - ${classNumber}`]);

    if (!clicked) {
      return null;
    }

    await sleep(750);

    let openedAvailability = false;
    const tabDeadline = Date.now() + 5_000;
    while (!openedAvailability && Date.now() < tabDeadline) {
      openedAvailability = await this.clickVisibleText(page, ['Class Availability']);
      if (!openedAvailability) {
        await sleep(250);
      }
    }

    if (!openedAvailability) {
      logger.warn({ classNumber }, 'Class details opened but availability tab was not found');
      return null;
    }

    await sleep(750);

    const deadline = Date.now() + 8_000;

    while (Date.now() < deadline) {
      const availability = await this.extractClassAvailabilityCells(page);

      if (availability !== null) {
        return {
          status: parseSectionStatus(availability.status),
          availableSeats: parseClassAvailability(availability.availableSeats),
        };
      }

      await sleep(250);
    }

    this.assertBrowserSessionActive(page, await this.collectFrameMarkup(page));
    return null;
  }

  private async closeClassDetails(page: Page): Promise<void> {
    const clickedClose = await this.clickVisibleText(page, ['Close']);
    if (!clickedClose) {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await sleep(500);
  }

  private async extractClassAvailabilityCells(
    page: Page,
  ): Promise<{ status: string; availableSeats: string } | null> {
    const script = `
      (function() {
        var roots = [];
        var collectRoots = function(root) {
          roots.push(root);
          Array.from(root.querySelectorAll('*')).forEach(function(element) {
            if (element.shadowRoot) collectRoots(element.shadowRoot);
          });
        };
        var normalize = function(value) {
          return String(value || '').replace(/[^A-Z0-9]+/gi, '').toUpperCase();
        };
        collectRoots(document);
        var seatValue = null;
        var statusValue = null;

        for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
          var root = roots[rootIndex];
          var rootStatusMatch = /STATUS(OPEN|CLOSED|WAITLISTED|WAITLIST)/.exec(normalize(root.textContent));
          if (rootStatusMatch && rootStatusMatch[1]) statusValue = rootStatusMatch[1];
          var tables = Array.from(root.querySelectorAll('table, [role="table"], [role="grid"]'));
          for (var tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
            var rows = Array.from(tables[tableIndex].querySelectorAll('tr, [role="row"]'));
            for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
              var headers = Array.from(rows[rowIndex].querySelectorAll('th, [role="columnheader"]'));
              var normalizedHeaders = headers.map(function(header) {
                return normalize(header.textContent);
              });
              var statusIndex = normalizedHeaders.findIndex(function(header) {
                return header === 'STATUS';
              });
              var seatIndex = normalizedHeaders.findIndex(function(header) {
                return header === 'AVAILABLESEATS';
              });
              if (seatIndex === -1) continue;

              for (var dataIndex = rowIndex + 1; dataIndex < rows.length; dataIndex += 1) {
                var cells = Array.from(rows[dataIndex].querySelectorAll('td, [role="cell"], [role="gridcell"]'));
                if (cells[seatIndex]) seatValue = String(cells[seatIndex].textContent || '').trim();
                if (statusIndex !== -1 && cells[statusIndex]) statusValue = String(cells[statusIndex].textContent || '').trim();
                if (seatValue !== null) break;
              }

              if (seatValue !== null && statusValue === null) {
                var container = tables[tableIndex];
                for (var containerDepth = 0; containerDepth < 12 && container; containerDepth += 1) {
                  var containerText = normalize(container.textContent);
                  if (containerText.indexOf('AVAILABLESEATS') !== -1 && containerText.indexOf('STATUS') !== -1) {
                    var statusCandidates = Array.from(container.querySelectorAll('*'));
                    for (var statusCandidateIndex = 0; statusCandidateIndex < statusCandidates.length; statusCandidateIndex += 1) {
                      var statusCandidate = statusCandidates[statusCandidateIndex];
                      var candidateValues = [
                        statusCandidate.textContent,
                        statusCandidate.getAttribute('value'),
                        statusCandidate.getAttribute('aria-label'),
                        statusCandidate.getAttribute('title'),
                        statusCandidate.getAttribute('alt')
                      ];
                      for (var candidateValueIndex = 0; candidateValueIndex < candidateValues.length; candidateValueIndex += 1) {
                        var candidateValue = String(candidateValues[candidateValueIndex] || '').trim();
                        if (/^(OPEN|CLOSED|WAITLIST|WAITLISTED)$/i.test(candidateValue)) {
                          statusValue = candidateValue;
                          break;
                        }
                      }
                      if (statusValue !== null) break;
                    }
                  }
                  if (statusValue !== null) break;
                  container = container.parentElement;
                }
              }
            }
          }

          var statusLabels = Array.from(root.querySelectorAll('label, dt, th, td, [role="cell"], span, div')).filter(function(element) {
            return normalize(element.textContent) === 'STATUS';
          });
          for (var labelIndex = 0; labelIndex < statusLabels.length && statusValue === null; labelIndex += 1) {
            var label = statusLabels[labelIndex];
            var sibling = label.nextElementSibling;
            if (sibling && /^(OPEN|CLOSED|WAITLIST|WAITLISTED)$/i.test(String(sibling.textContent || '').trim())) {
              statusValue = String(sibling.textContent || '').trim();
              break;
            }
            var parentChildren = label.parentElement ? Array.from(label.parentElement.children) : [];
            var labelPosition = parentChildren.indexOf(label);
            if (labelPosition !== -1 && parentChildren[labelPosition + 1]) {
              var adjacentValue = String(parentChildren[labelPosition + 1].textContent || '').trim();
              if (/^(OPEN|CLOSED|WAITLIST|WAITLISTED)$/i.test(adjacentValue)) statusValue = adjacentValue;
            }
          }
        }

        return seatValue === null ? null : {
          status: statusValue || '',
          availableSeats: seatValue
        };
      })()
    `;

    for (const frame of page.frames()) {
      const value = await frame.evaluate(script).catch(() => null);
      if (
        typeof value === 'object' &&
        value !== null &&
        'status' in value &&
        'availableSeats' in value &&
        typeof value.status === 'string' &&
        typeof value.availableSeats === 'string'
      ) {
        return { status: value.status.trim(), availableSeats: value.availableSeats.trim() };
      }
    }

    return null;
  }

  private async collectFrameMarkup(page: Page): Promise<string> {
    const frameMarkup = await Promise.all(
      page.frames().map((frame) => frame.content().catch(() => '')),
    );

    return frameMarkup.join('\n');
  }

  private assertBrowserSessionActive(page: Page, content: string): void {
    if (PeopleSoftHttpClient.isSessionExpired(200, content, page.url())) {
      throw new PeopleSoftSessionExpiredError();
    }
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
