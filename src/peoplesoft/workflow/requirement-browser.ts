import type { SectionState } from '../../domain/section-state.js';

export interface RequirementChoice {
  label: string;
  satisfied: boolean;
}

export interface RequirementCourseChoice {
  courseCode: string;
  courseTitle: string;
  progress: string | null;
}

export interface RequirementTermChoice {
  label: string;
  termCode: string;
}

export interface RequirementBrowser {
  listRequirements(cookiesPayload: unknown): Promise<RequirementChoice[]>;
  listCourses(
    cookiesPayload: unknown,
    requirementLabel: string,
  ): Promise<RequirementCourseChoice[]>;
  listCourseTerms(
    cookiesPayload: unknown,
    requirementLabel: string,
    courseCode: string,
  ): Promise<RequirementTermChoice[]>;
  listCourseSections(
    cookiesPayload: unknown,
    requirementLabel: string,
    courseCode: string,
    term: string,
    termLabel: string,
  ): Promise<SectionState[]>;
}
