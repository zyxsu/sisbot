import type { SectionState } from '../../domain/section-state.js';
import {
  findCourseAction,
  parseActivityGuide,
  parseActivityGuidePreprocessingTarget,
  parseClassSelection,
  parseHiddenFields,
} from '../parsers/index.js';
import { assertPeopleSoftSessionActive, type PeopleSoftSession } from '../session.js';

export interface CourseCheckTarget {
  courseCode: string;
  classNumber?: string | undefined;
  term: string;
  termLabel?: string;
}

export interface CheckCourseSectionsRequest extends CourseCheckTarget {
  session: PeopleSoftSession;
  checkedAt?: Date;
}

export interface CheckCoursesRequest {
  session: PeopleSoftSession;
  targets: readonly CourseCheckTarget[];
  checkedAt?: Date;
}

export interface CourseCheckResult {
  target: CourseCheckTarget;
  sections: SectionState[];
}

export interface SectionChecker {
  checkCourseSections(request: CheckCourseSectionsRequest): Promise<SectionState[]>;
  checkCoursesSequentially(request: CheckCoursesRequest): Promise<CourseCheckResult[]>;
}

export interface FixtureWorkflowResponses {
  courseRequirements: string;
  activityGuide: string;
  activityGuidePreprocessing: string;
  classSelection: string;
}

export interface FixtureWorkflowEntry {
  courseCode: string;
  term: string;
  responses: FixtureWorkflowResponses;
}

export interface FixtureWorkflowSource {
  getResponses(target: CourseCheckTarget): FixtureWorkflowResponses | null;
}

export class FixtureWorkflowMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FixtureWorkflowMismatchError';
  }
}

function normalizeCourseCode(courseCode: string): string {
  return courseCode.trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeTarget(target: CourseCheckTarget): CourseCheckTarget {
  const normalizedTarget: CourseCheckTarget = {
    courseCode: normalizeCourseCode(target.courseCode),
    term: target.term.trim(),
  };

  if (target.classNumber !== undefined) {
    normalizedTarget.classNumber = target.classNumber.trim();
  }

  if (target.termLabel !== undefined) {
    normalizedTarget.termLabel = target.termLabel;
  }

  return normalizedTarget;
}

function workflowKey(target: CourseCheckTarget): string {
  const normalizedTarget = normalizeTarget(target);

  return `${normalizedTarget.term}\u0000${normalizedTarget.courseCode.replace(/\s+/g, '')}`;
}

function requestKey(target: CourseCheckTarget): string {
  const normalizedTarget = normalizeTarget(target);

  return `${workflowKey(normalizedTarget)}\u0000${normalizedTarget.classNumber ?? ''}`;
}

/** In-memory fixture catalog keyed by normalized `(term, courseCode)`. */
export class InMemoryFixtureWorkflowSource implements FixtureWorkflowSource {
  private readonly responsesByTarget = new Map<string, FixtureWorkflowResponses>();

  public constructor(entries: readonly FixtureWorkflowEntry[]) {
    for (const entry of entries) {
      const key = workflowKey(entry);

      if (this.responsesByTarget.has(key)) {
        throw new FixtureWorkflowMismatchError(
          `Duplicate fixture workflow for ${normalizeCourseCode(entry.courseCode)} in term ${entry.term}`,
        );
      }

      this.responsesByTarget.set(key, entry.responses);
    }
  }

  public getResponses(target: CourseCheckTarget): FixtureWorkflowResponses | null {
    return this.responsesByTarget.get(workflowKey(target)) ?? null;
  }
}

/**
 * Offline composition of the known workflow checkpoints.
 *
 * A batch holds one session mutex and processes courses with `for...of`. That
 * mirrors the stateful live requirement: course B cannot begin until course A's
 * selection/review workflow is complete. Each target resolves its own fresh
 * response sequence so no hidden state or transient Activity Guide identifiers
 * are reused across courses.
 *
 * This fixture implementation validates response prerequisites, but it does not
 * pretend that an HTTP post, redirect, cookie exchange, or server-side state
 * transition occurred.
 */
export class FixtureSectionChecker implements SectionChecker {
  public constructor(private readonly source: FixtureWorkflowSource) {}

  public async checkCourseSections(request: CheckCourseSectionsRequest): Promise<SectionState[]> {
    const [result] = await this.checkCoursesSequentially({
      session: request.session,
      targets: [request],
      ...(request.checkedAt === undefined ? {} : { checkedAt: request.checkedAt }),
    });

    if (result === undefined) {
      throw new FixtureWorkflowMismatchError('A single-course fixture check returned no result');
    }

    return result.sections;
  }

  public checkCoursesSequentially(request: CheckCoursesRequest): Promise<CourseCheckResult[]> {
    const targets = this.deduplicateTargets(request.targets);

    if (targets.length === 0) {
      return Promise.resolve([]);
    }

    return request.session.runSerialized(() => {
      const results: CourseCheckResult[] = [];

      for (const target of targets) {
        // A live implementation may mark the held session expired after any
        // request. Never continue the next course in that case.
        assertPeopleSoftSessionActive(request.session);
        const sections = this.checkOneWithinHeldSession(target, request.checkedAt ?? new Date());
        results.push({ target, sections });
      }

      return results;
    });
  }

  private deduplicateTargets(targets: readonly CourseCheckTarget[]): CourseCheckTarget[] {
    const uniqueTargets: CourseCheckTarget[] = [];
    const seen = new Set<string>();

    for (const candidate of targets) {
      const target = normalizeTarget(candidate);
      const key = requestKey(target);

      if (target.courseCode.length === 0 || target.term.length === 0) {
        throw new FixtureWorkflowMismatchError('Course code and term are required');
      }

      if (!seen.has(key)) {
        seen.add(key);
        uniqueTargets.push(target);
      }
    }

    return uniqueTargets;
  }

  private checkOneWithinHeldSession(target: CourseCheckTarget, checkedAt: Date): SectionState[] {
    const responses = this.source.getResponses(target);

    if (responses === null) {
      throw new FixtureWorkflowMismatchError(
        `No fixture workflow exists for ${target.courseCode} in term ${target.term}`,
      );
    }

    const hiddenFields = parseHiddenFields(responses.courseRequirements);

    if (hiddenFields.ICStateNum === undefined || hiddenFields.ICElementNum === undefined) {
      throw new FixtureWorkflowMismatchError(
        'The fixture course page does not contain current PeopleSoft component state',
      );
    }

    const courseAction = findCourseAction(responses.courseRequirements, target.courseCode);

    if (courseAction === null) {
      throw new FixtureWorkflowMismatchError(
        `The requested course is absent from its fixture response: ${target.courseCode}`,
      );
    }

    const activityGuide = parseActivityGuide(responses.activityGuide);

    if (activityGuide === null) {
      throw new FixtureWorkflowMismatchError(
        'The fixture does not contain the Review Class Selection Activity Guide step',
      );
    }

    const targetUrl = parseActivityGuidePreprocessingTarget(responses.activityGuidePreprocessing);

    if (targetUrl === null) {
      throw new FixtureWorkflowMismatchError(
        'The fixture preprocessing response does not contain the review component target',
      );
    }

    const sections = parseClassSelection(responses.classSelection, {
      term: target.term,
      checkedAt,
      ...(target.termLabel === undefined ? {} : { termLabel: target.termLabel }),
    });

    if (sections.length === 0) {
      throw new FixtureWorkflowMismatchError('The fixture review response has no section rows');
    }

    if (
      sections.some(
        ({ courseCode }) =>
          courseCode.replace(/\s+/g, '') !== target.courseCode.replace(/\s+/g, ''),
      )
    ) {
      throw new FixtureWorkflowMismatchError(
        'The selected course and class-selection fixture do not match',
      );
    }

    return target.classNumber === undefined
      ? sections
      : sections.filter(({ classNumber }) => classNumber === target.classNumber);
  }
}
