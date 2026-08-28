import type { Environment } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { SectionState } from '../../domain/section-state.js';
import { PeopleSoftHttpClient, PeopleSoftSessionExpiredError } from '../http/index.js';
import { assertPeopleSoftLiveModeEnabled } from '../live-mode.js';
import {
  findCourseAction,
  parseActivityGuide,
  parseActivityGuidePreprocessingTarget,
  parseClassSelection,
  parseHiddenFields,
} from '../parsers/index.js';
import { assertPeopleSoftSessionActive } from '../session.js';
import type {
  CheckCourseSectionsRequest,
  CheckCoursesRequest,
  CourseCheckResult,
  CourseCheckTarget,
  SectionChecker,
} from './check-course-sections.js';

export interface LiveSectionCheckerOptions {
  environment: Pick<Environment, 'PEOPLESOFT_LIVE_ENABLED'>;
  httpClient?: PeopleSoftHttpClient;
  baseComponentUrl?: string;
}

export class LiveWorkflowExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LiveWorkflowExecutionError';
  }
}

/**
 * Stateful live HTTP section checker that queries the live AUIB PeopleSoft Fluid SIS portal.
 */
export class LiveSectionChecker implements SectionChecker {
  private readonly environment: Pick<Environment, 'PEOPLESOFT_LIVE_ENABLED'>;
  private readonly httpClient: PeopleSoftHttpClient;
  private readonly baseComponentUrl: string;

  public constructor(options: LiveSectionCheckerOptions) {
    this.environment = options.environment;
    this.httpClient = options.httpClient ?? new PeopleSoftHttpClient();
    this.baseComponentUrl =
      options.baseComponentUrl ?? '/psc/ps/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_MANAGE_CLASSES_FL.GBL';
  }

  public async checkCourseSections(request: CheckCourseSectionsRequest): Promise<SectionState[]> {
    const [result] = await this.checkCoursesSequentially({
      session: request.session,
      targets: [request],
      ...(request.checkedAt !== undefined ? { checkedAt: request.checkedAt } : {}),
    });

    if (result === undefined) {
      throw new LiveWorkflowExecutionError('Live course check produced no results');
    }

    return result.sections;
  }

  public async checkCoursesSequentially(
    request: CheckCoursesRequest,
  ): Promise<CourseCheckResult[]> {
    assertPeopleSoftLiveModeEnabled(this.environment);

    if (request.targets.length === 0) {
      return [];
    }

    return request.session.runSerialized(async () => {
      const results: CourseCheckResult[] = [];
      const checkedAt = request.checkedAt ?? new Date();

      for (const target of request.targets) {
        assertPeopleSoftSessionActive(request.session);

        try {
          const sections = await this.executeLiveWorkflowForTarget(
            request.session.id,
            target,
            checkedAt,
          );
          results.push({ target, sections });
        } catch (error) {
          if (error instanceof PeopleSoftSessionExpiredError) {
            request.session.markExpired();
            logger.warn(
              { sessionId: request.session.id, err: error.message },
              'PeopleSoft session expired during live check',
            );
          }
          throw error;
        }
      }

      return results;
    });
  }

  /**
   * Executes the 4-step PeopleSoft Fluid navigation sequence for a single course target.
   */
  private async executeLiveWorkflowForTarget(
    cookiesPayload: unknown,
    target: CourseCheckTarget,
    checkedAt: Date,
  ): Promise<SectionState[]> {
    const cookieHeader = PeopleSoftHttpClient.normalizeCookieHeader(cookiesPayload);

    // Step 1: Request Course Requirements / Planner page
    const step1Response = await this.httpClient.get(this.baseComponentUrl, cookieHeader);
    const hiddenFields = parseHiddenFields(step1Response.body);

    if (hiddenFields.ICStateNum === undefined && hiddenFields.ICSID === undefined) {
      throw new LiveWorkflowExecutionError(
        'Missing state identifier (ICStateNum/ICSID) from PeopleSoft course requirements response',
      );
    }

    const courseAction = findCourseAction(step1Response.body, target.courseCode);
    if (courseAction === null) {
      throw new LiveWorkflowExecutionError(
        `Course ${target.courseCode} was not found on the student's requirements page`,
      );
    }

    // Step 2: Post course action (CRSE_DESCR1$xx)
    const formData: Record<string, string> = {
      ...(hiddenFields.ICStateNum !== undefined ? { ICStateNum: hiddenFields.ICStateNum } : {}),
      ...(hiddenFields.ICElementNum !== undefined
        ? { ICElementNum: hiddenFields.ICElementNum }
        : {}),
      ...(hiddenFields.ICType !== undefined ? { ICType: hiddenFields.ICType } : {}),
      ...(hiddenFields.ICSID !== undefined ? { ICSID: hiddenFields.ICSID } : {}),
      ICAction: courseAction.action,
    };

    const step2Response = await this.httpClient.postForm(
      this.baseComponentUrl,
      formData,
      cookieHeader,
    );

    const activityGuide = parseActivityGuide(step2Response.body);
    if (activityGuide === null) {
      throw new LiveWorkflowExecutionError(
        `Failed to locate Activity Guide step for course ${target.courseCode}`,
      );
    }

    // Step 3: Request Activity Guide preprocessing endpoint or use direct target
    let reviewTargetUrl = activityGuide.targetUrl;

    if (reviewTargetUrl === null && activityGuide.preprocessingUrl.length > 0) {
      const step3Response = await this.httpClient.get(activityGuide.preprocessingUrl, cookieHeader);
      reviewTargetUrl = parseActivityGuidePreprocessingTarget(step3Response.body);
    }

    if (reviewTargetUrl === null) {
      throw new LiveWorkflowExecutionError(
        `Failed to resolve review target URL from preprocessing response for course ${target.courseCode}`,
      );
    }

    // Step 4: Request Class Selection review page and parse sections
    const step4Response = await this.httpClient.get(reviewTargetUrl, cookieHeader);
    const sections = parseClassSelection(step4Response.body, {
      term: target.term,
      ...(target.termLabel !== undefined ? { termLabel: target.termLabel } : {}),
      checkedAt,
    });

    if (sections.length === 0) {
      throw new LiveWorkflowExecutionError(
        `No class sections found on review page for course ${target.courseCode}`,
      );
    }

    return sections;
  }
}
