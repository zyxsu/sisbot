export interface CatalogSection {
  classNumber: string;
  component: string;
  status: 'OPEN' | 'CLOSED';
  availableSeats: number;
  capacity: number | null;
  schedule: string;
  room: string;
  meetingDates: string;
}

export interface CatalogCourse {
  courseCode: string;
  title: string;
  crseId: string;
  units: number;
  sections: CatalogSection[];
}

export interface ScheduledCatalog {
  term: string;
  termLabel: string;
  generatedAt: Date;
  declaredOfferedCourses: number;
  courses: CatalogCourse[];
}

const COURSE_PATTERN = /^\[([^\]]+)]\s+(.+?)\s+\(CRSE_ID:\s*(\d{1,12}),\s*Units:\s*([\d.]+)\)$/;
const SECTION_PATTERN =
  /^\s*•\s*(.+?)\s+-\s+(\d{3,8})\s*\|\s*Status:\s*(OPEN|CLOSED)\s*\((?:(\d+)\/(\d+) seats|(\d+) seats)\)\s*\|\s*Schedule:\s*(.*?)\s*\|\s*Room:\s*(.*?)\s*\|\s*Dates:\s*(.*?)\s*$/;

export function parseScheduledCatalog(source: string): ScheduledCatalog {
  const termMatch = /^\s*TERM:\s*(\d+)\s+\(([^)]+)\)/m.exec(source);
  const generatedMatch = /^\s*Generated:\s*(.+?)\s*$/m.exec(source);
  const offeredMatch = /SECTION 1:.*?\((\d+) COURSES\)/i.exec(source);
  if (termMatch?.[1] === undefined || termMatch[2] === undefined) {
    throw new Error('Catalog term header was not found');
  }
  if (generatedMatch?.[1] === undefined || offeredMatch?.[1] === undefined) {
    throw new Error('Catalog metadata header was incomplete');
  }

  const start = source.indexOf('SECTION 1:');
  const end = source.indexOf('SECTION 2:');
  if (start < 0 || end <= start) throw new Error('Scheduled catalog section was not found');

  const courses: CatalogCourse[] = [];
  let current: CatalogCourse | null = null;
  for (const line of source.slice(start, end).split(/\r?\n/)) {
    const courseMatch = COURSE_PATTERN.exec(line.trim());
    if (courseMatch !== null) {
      const [, courseCode, title, crseId, units] = courseMatch;
      if (
        courseCode === undefined ||
        title === undefined ||
        crseId === undefined ||
        units === undefined
      ) {
        throw new Error(`Malformed course row: ${line.trim()}`);
      }
      current = {
        courseCode: courseCode.trim().toUpperCase(),
        title: title.trim(),
        crseId: crseId.padStart(6, '0'),
        units: Number(units),
        sections: [],
      };
      courses.push(current);
      continue;
    }

    const sectionMatch = SECTION_PATTERN.exec(line);
    if (sectionMatch !== null) {
      if (current === null) throw new Error(`Section appeared before course: ${line.trim()}`);
      const [
        ,
        component,
        classNumber,
        status,
        openSeats,
        capacity,
        closedSeats,
        schedule,
        room,
        dates,
      ] = sectionMatch;
      if (
        component === undefined ||
        classNumber === undefined ||
        status === undefined ||
        schedule === undefined ||
        room === undefined ||
        dates === undefined
      ) {
        throw new Error(`Malformed section row: ${line.trim()}`);
      }
      const availableSeats = Number(openSeats ?? closedSeats);
      current.sections.push({
        component: component.trim(),
        classNumber,
        status: status as 'OPEN' | 'CLOSED',
        availableSeats,
        capacity: capacity === undefined ? null : Number(capacity),
        schedule: schedule.trim(),
        room: room.trim(),
        meetingDates: dates.trim(),
      });
    }
  }

  const declaredOfferedCourses = Number(offeredMatch[1]);
  if (courses.length !== declaredOfferedCourses) {
    throw new Error(
      `Catalog declared ${String(declaredOfferedCourses)} courses but parsed ${String(courses.length)}`,
    );
  }
  const courseIds = new Set<string>();
  const classNumbers = new Set<string>();
  for (const course of courses) {
    if (courseIds.has(course.crseId)) throw new Error(`Duplicate CRSE_ID ${course.crseId}`);
    courseIds.add(course.crseId);
    if (course.sections.length === 0)
      throw new Error(`Course ${course.courseCode} has no sections`);
    for (const section of course.sections) {
      if (classNumbers.has(section.classNumber)) {
        throw new Error(`Duplicate class number ${section.classNumber}`);
      }
      classNumbers.add(section.classNumber);
    }
  }

  const generatedAt = new Date(generatedMatch[1]);
  if (Number.isNaN(generatedAt.getTime()))
    throw new Error('Catalog generated timestamp is invalid');
  return {
    term: termMatch[1],
    termLabel: termMatch[2].trim(),
    generatedAt,
    declaredOfferedCourses,
    courses,
  };
}
