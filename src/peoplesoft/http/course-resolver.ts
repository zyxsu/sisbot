export interface CourseLookup {
  subject: string;
  catalogNumber: string;
  term: string;
}

export interface ResolvedCourse {
  subject: string;
  catalogNumber: string;
  term: string;
  crseId: string;
  crseOfferNbr: string;
  acadCareer: string;
  institution: string;
}

export interface CourseResolver {
  resolveCourse(lookup: CourseLookup): Promise<ResolvedCourse | null>;
}

function courseKey(lookup: CourseLookup): string {
  return `${lookup.term.trim()}\u0000${lookup.subject.trim().toUpperCase()}\u0000${lookup.catalogNumber.trim().toUpperCase()}`;
}

export class InMemoryCourseResolver implements CourseResolver {
  private readonly entries = new Map<string, ResolvedCourse>();

  public constructor(courses: readonly ResolvedCourse[]) {
    for (const course of courses) {
      this.entries.set(courseKey(course), { ...course });
    }
  }

  public resolveCourse(lookup: CourseLookup): Promise<ResolvedCourse | null> {
    return Promise.resolve(this.entries.get(courseKey(lookup)) ?? null);
  }
}
