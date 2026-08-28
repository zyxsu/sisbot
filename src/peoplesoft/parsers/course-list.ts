import { loadPeopleSoftMarkup, normalizePeopleSoftText } from './markup.js';

const COURSE_ACTION_PATTERN = /\bCRSE_DESCR1\$\d+\b/i;
const COURSE_CODE_PATTERN = /\b([A-Z][A-Z0-9&]{1,9})\s+(\d{2,4}[A-Z]?)\b/i;

export interface PeopleSoftCourseAction {
  courseCode: string;
  action: string;
}

function extractAction(values: (string | undefined)[]): string | null {
  for (const value of values) {
    const action = value?.match(COURSE_ACTION_PATTERN)?.[0];

    if (action !== undefined) {
      return action;
    }
  }

  return null;
}

function extractCourseIdentity(text: string): {
  courseCode: string;
} | null {
  const match = COURSE_CODE_PATTERN.exec(text);

  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }

  return {
    courseCode: `${match[1].toUpperCase()} ${match[2].toUpperCase()}`,
  };
}

/**
 * Associates each rendered course row with its current PeopleSoft action. The
 * numeric suffix is read from the response and is never treated as course data.
 */
export function parseCourseActions(markup: string): PeopleSoftCourseAction[] {
  const $ = loadPeopleSoftMarkup(markup);
  const courses: PeopleSoftCourseAction[] = [];
  const seenActions = new Set<string>();

  $('a, button, input, [onclick]').each((_index, element) => {
    const actionElement = $(element);
    const action = extractAction([
      actionElement.attr('data-icaction'),
      actionElement.attr('id'),
      actionElement.attr('name'),
      actionElement.attr('value'),
      actionElement.attr('href'),
      actionElement.attr('onclick'),
    ]);

    if (action === null || seenActions.has(action)) {
      return;
    }

    const row = actionElement.closest('tr, [role="row"], article, li');
    const scope = row.length > 0 ? row.first() : actionElement.parent();
    const scopeText = normalizePeopleSoftText(scope.text());
    const identity = extractCourseIdentity(scopeText);

    if (identity === null) {
      return;
    }

    const course: PeopleSoftCourseAction = {
      courseCode: identity.courseCode,
      action,
    };

    seenActions.add(action);
    courses.push(course);
  });

  return courses;
}

export function findCourseAction(
  markup: string,
  requestedCourseCode: string,
): PeopleSoftCourseAction | null {
  const normalizedRequestedCode = normalizePeopleSoftText(requestedCourseCode)
    .replace(/\s+/g, '')
    .toUpperCase();

  return (
    parseCourseActions(markup).find(
      ({ courseCode }) => courseCode.replace(/\s+/g, '').toUpperCase() === normalizedRequestedCode,
    ) ?? null
  );
}
