import type { SectionState, SectionStatus } from '../../domain/section-state.js';
import type { CheerioAPI } from 'cheerio';
import { parseAvailableSeats } from './available-seats.js';
import { loadPeopleSoftMarkup, normalizePeopleSoftText } from './markup.js';

const COURSE_CODE_PATTERN = /\b([A-Z][A-Z0-9&]{1,9})\s+(\d{2,4}[A-Z]?)\b/i;
const COURSE_TITLE_FIELD_PATTERN = /^DERIVED_SSR_FL_COURSE_TITLE_LONG(?:\$\d+)?$/i;
const CLASS_FIELD_PATTERN = /^DERIVED_SSR_FL_SSR_SBJ_CAT_NBR\$(\d+)$/i;
const STATUS_FIELD_PATTERN = /^DERIVED_SSR_FL_SSR_DESCR50\$(\d+)$/i;

export type ParsedClassSelectionSection = Omit<SectionState, 'term' | 'termLabel' | 'checkedAt'>;

export interface ClassSelectionContext {
  term: string;
  termLabel?: string;
  checkedAt: Date;
}

interface CourseIdentity {
  courseCode: string;
  courseTitle?: string;
}

type PeopleSoftElement = ReturnType<CheerioAPI>;

function fieldNames(element: PeopleSoftElement): string[] {
  return [element.attr('id'), element.attr('name')].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
}

function elementValue(element: PeopleSoftElement): string {
  const directValue = element.attr('value');

  if (directValue !== undefined) {
    return normalizePeopleSoftText(directValue);
  }

  const valuedDescendant = element.find('[value]').first();

  if (valuedDescendant.length > 0) {
    return normalizePeopleSoftText(valuedDescendant.attr('value') ?? '');
  }

  return normalizePeopleSoftText(element.text());
}

function parseCourseIdentity(markup: string): CourseIdentity | null {
  const $ = loadPeopleSoftMarkup(markup);
  const courseElement = $('*')
    .filter((_index, element) => {
      const currentElement = $(element);

      return fieldNames(currentElement).some((name) => COURSE_TITLE_FIELD_PATTERN.test(name));
    })
    .first();

  if (courseElement.length === 0) {
    return null;
  }

  const courseText = elementValue(courseElement);
  const match = COURSE_CODE_PATTERN.exec(courseText);

  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }

  const identity: CourseIdentity = {
    courseCode: `${match[1].toUpperCase()} ${match[2].toUpperCase()}`,
  };
  const courseTitle = normalizePeopleSoftText(
    courseText.slice(match.index + match[0].length).replace(/^\s*[-:–—]\s*/, ''),
  );

  if (courseTitle.length > 0) {
    identity.courseTitle = courseTitle;
  }

  return identity;
}

export function parseSectionStatus(value: string | null | undefined): SectionStatus {
  if (value === null || value === undefined) {
    return 'UNKNOWN';
  }

  const normalizedValue = normalizePeopleSoftText(value);

  if (/\bWAIT\s*LIST(?:ED)?\b/i.test(normalizedValue)) {
    return 'WAITLIST';
  }

  if (/\bCLOSED\b/i.test(normalizedValue)) {
    return 'CLOSED';
  }

  if (/\bOPEN\b/i.test(normalizedValue)) {
    return 'OPEN';
  }

  return 'UNKNOWN';
}

function findLabeledValue(
  $: CheerioAPI,
  scope: PeopleSoftElement,
  labels: readonly string[],
): string | null {
  const normalizedLabels = labels.map((label) => label.toUpperCase());

  for (const element of scope.find('dt').toArray()) {
    const term = $(element);
    const label = normalizePeopleSoftText(term.text()).replace(/:$/, '').toUpperCase();

    if (normalizedLabels.includes(label)) {
      const value = elementValue(term.next('dd').first());

      if (value.length > 0) {
        return value;
      }
    }
  }

  for (const element of scope.find('[data-label]').toArray()) {
    const field = $(element);
    const label = normalizePeopleSoftText(field.attr('data-label') ?? '')
      .replace(/:$/, '')
      .toUpperCase();

    if (normalizedLabels.includes(label)) {
      const value = elementValue(field);

      if (value.length > 0) {
        return value;
      }
    }
  }

  return null;
}

function attachOptionalMetadata(
  $: CheerioAPI,
  section: ParsedClassSelectionSection,
  scope: PeopleSoftElement,
): void {
  const sessionName = findLabeledValue($, scope, ['Session']);
  const meetingDates = findLabeledValue($, scope, ['Meeting Dates']);
  const schedule = findLabeledValue($, scope, ['Days and Times']);

  if (sessionName !== null) {
    section.sessionName = sessionName;
  }

  if (meetingDates !== null) {
    section.meetingDates = meetingDates;
  }

  if (schedule !== null) {
    section.schedule = schedule;
  }
}

function parseSections(markup: string): ParsedClassSelectionSection[] {
  const $ = loadPeopleSoftMarkup(markup);
  const courseIdentity = parseCourseIdentity(markup);
  const statusFields = new Map<string, string>();
  const classElements: { rowIndex: string; element: PeopleSoftElement }[] = [];

  $('*').each((_index, element) => {
    const currentElement = $(element);
    const statusMatch = fieldNames(currentElement)
      .map((name) => STATUS_FIELD_PATTERN.exec(name))
      .find((match) => match?.[1] !== undefined);

    if (statusMatch?.[1] !== undefined) {
      statusFields.set(statusMatch[1], elementValue(currentElement));
    }

    const classMatch = fieldNames(currentElement)
      .map((name) => CLASS_FIELD_PATTERN.exec(name))
      .find((match) => match?.[1] !== undefined);

    if (classMatch?.[1] !== undefined) {
      classElements.push({ rowIndex: classMatch[1], element: currentElement });
    }
  });

  if (classElements.length === 0) {
    return [];
  }

  if (courseIdentity === null) {
    throw new Error('Course identity was not found in the class-selection response');
  }

  const sections: ParsedClassSelectionSection[] = [];

  for (const { rowIndex, element } of classElements) {
    const classElement = element;
    const classText = elementValue(classElement);
    const classMatch = /^(.*?)\s*-\s*(\d+)\s*$/.exec(classText);

    if (classMatch?.[1] === undefined || classMatch[2] === undefined) {
      continue;
    }

    const containingRow = classElement.closest('[data-section-row], article, tr, li, fieldset');
    const rowScope = containingRow.length > 0 ? containingRow.first() : classElement.parent();
    const explicitSeatValue = findLabeledValue($, rowScope, ['Seats Available', 'Available Seats']);
    const availableSeats = parseAvailableSeats(
      explicitSeatValue ?? normalizePeopleSoftText(rowScope.text()),
    );
    const statusText =
      statusFields.get(rowIndex) ??
      findLabeledValue($, rowScope, ['Option Status', 'Status', 'Seats']);
    const section: ParsedClassSelectionSection = {
      courseCode: courseIdentity.courseCode,
      classNumber: classMatch[2],
      component: normalizePeopleSoftText(classMatch[1]),
      status: parseSectionStatus(statusText),
      availableSeats,
    };

    if (courseIdentity.courseTitle !== undefined) {
      section.courseTitle = courseIdentity.courseTitle;
    }

    attachOptionalMetadata($, section, rowScope);
    sections.push(section);
  }

  return sections;
}

export function parseClassSelection(markup: string): ParsedClassSelectionSection[];
export function parseClassSelection(markup: string, context: ClassSelectionContext): SectionState[];
export function parseClassSelection(
  markup: string,
  context?: ClassSelectionContext,
): ParsedClassSelectionSection[] | SectionState[] {
  const sections = parseSections(markup);

  if (context === undefined) {
    return sections;
  }

  return sections.map((section) => {
    const state: SectionState = {
      ...section,
      term: context.term,
      checkedAt: context.checkedAt,
    };

    if (context.termLabel !== undefined) {
      state.termLabel = context.termLabel;
    }

    return state;
  });
}
