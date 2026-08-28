import * as cheerio from 'cheerio';
import type {
  RequirementChoice,
  RequirementCourseChoice,
} from '../workflow/requirement-browser.js';

export function parseRequirementChoices(markup: string): RequirementChoice[] {
  const $ = cheerio.load(markup);
  const choices: RequirementChoice[] = [];
  const seen = new Set<string>();

  $('span[title^="Requirement Details:"]').each((_index, element) => {
    const label = $(element).text().replace(/\s+/g, ' ').trim();
    if (label.length === 0 || seen.has(label)) return;
    const rowText = $(element).closest('li, tr, [role="row"]').text().replace(/\s+/g, ' ').trim();
    seen.add(label);
    choices.push({
      label,
      satisfied: /\bSatisfied\b/i.test(rowText) && !/\bNot Satisfied\b/i.test(rowText),
    });
  });

  return choices;
}

export function parseRequirementCourses(markup: string): RequirementCourseChoice[] {
  const $ = cheerio.load(markup);
  const courses: RequirementCourseChoice[] = [];
  const seen = new Set<string>();

  $('tr[id^="CRSE_GRID_LIST_NFF"], [role="row"]').each((_index, element) => {
    const row = $(element);
    const courseCode = row
      .find('span[id^="CRSE_NAME1$"]')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
    if (!/^[A-Z][A-Z0-9&]{1,9}\s+\d{2,4}[A-Z]?$/.test(courseCode) || seen.has(courseCode)) {
      return;
    }

    const rowText = row.text().replace(/\s+/g, ' ').trim();
    const explicitTitle = row
      .find('span[id^="CRSE_DESCR1$"]')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const afterCode = rowText.slice(rowText.toUpperCase().indexOf(courseCode) + courseCode.length);
    const inferredTitle = afterCode.replace(/\s+\d+(?:\.\d+)?\s.*$/, '').trim();
    const progressText = rowText.replace(/[^A-Z]+/gi, '').toUpperCase();
    const progress = progressText.includes('NOTTAKEN')
      ? 'Not Taken'
      : progressText.includes('INPROGRESS')
        ? 'In Progress'
        : progressText.includes('PLANNED')
          ? 'Planned'
          : progressText.includes('TAKEN')
            ? 'Taken'
            : null;
    seen.add(courseCode);
    courses.push({
      courseCode,
      courseTitle: explicitTitle || inferredTitle || courseCode,
      progress,
    });
  });

  return courses;
}
