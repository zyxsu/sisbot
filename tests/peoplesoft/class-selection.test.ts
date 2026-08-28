import { describe, expect, it } from 'vitest';

import { parseAvailableSeats } from '../../src/peoplesoft/parsers/available-seats.js';
import { parseClassSelection } from '../../src/peoplesoft/parsers/class-selection.js';
import { readPeopleSoftFixture } from './fixture.js';

const fixture = readPeopleSoftFixture('class-selection.xml');

describe('parseAvailableSeats', () => {
  it.each<[string, number | null]>([
    ['Seats Available: 4', 4],
    ['Available Seats 0', 0],
    [' 12 ', 12],
    ['Closed', null],
    ['Capacity 30 Enrollment 26', null],
    ['Seats: Closed', null],
  ])('parses %j as %j', (value, expected) => {
    expect(parseAvailableSeats(value)).toBe(expected);
  });
});

describe('parseClassSelection', () => {
  it('parses all dynamically indexed section rows in an XML/HTML response', () => {
    const sections = parseClassSelection(fixture);

    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({
      courseCode: 'PHA 500',
      courseTitle: 'Pharmacoeconomics and Drug Marketing',
      classNumber: '1494',
      component: 'Lecture',
      status: 'CLOSED',
      availableSeats: null,
      sessionName: 'Regular Academic Session',
      meetingDates: '23/08/2026 - 15/12/2026',
      schedule: 'Tuesday Sunday 08:00 to 09:15',
    });
    expect(sections[1]).toMatchObject({
      classNumber: '1495',
      component: 'Lecture',
      status: 'OPEN',
      availableSeats: 4,
    });
    expect(sections[2]).toMatchObject({
      classNumber: '1510',
      component: 'Lab',
      status: 'CLOSED',
      availableSeats: 0,
    });
  });

  it('does not infer zero seats merely because a section is closed', () => {
    expect(parseClassSelection(fixture)[0]).toMatchObject({
      status: 'CLOSED',
      availableSeats: null,
    });
  });

  it('matches class and status fields after every row index changes', () => {
    const reindexedFixture = fixture
      .replaceAll('$7', () => '$103')
      .replaceAll('$18', () => '$204')
      .replaceAll('$41', () => '$305');

    expect(
      parseClassSelection(reindexedFixture).map(({ classNumber, status }) => ({
        classNumber,
        status,
      })),
    ).toEqual([
      { classNumber: '1494', status: 'CLOSED' },
      { classNumber: '1495', status: 'OPEN' },
      { classNumber: '1510', status: 'CLOSED' },
    ]);
  });

  it('supports matching PeopleSoft fields by name and reading input values', () => {
    const inputFixture = fixture
      .replace(
        '<span id="DERIVED_SSR_FL_COURSE_TITLE_LONG">\n          PHA 500 - Pharmacoeconomics and Drug Marketing\n        </span>',
        '<input id="generic-course-wrapper" name="DERIVED_SSR_FL_COURSE_TITLE_LONG" value="PHA 500 - Pharmacoeconomics and Drug Marketing" />',
      )
      .replace(
        '<a id="DERIVED_SSR_FL_SSR_SBJ_CAT_NBR$7">Lecture - 1494</a>',
        '<input id="generic-class-wrapper" name="DERIVED_SSR_FL_SSR_SBJ_CAT_NBR$7" value="Lecture - 1494" />',
      )
      .replace(
        '<dd id="DERIVED_SSR_FL_SSR_DESCR50$7">Closed</dd>',
        '<dd><input id="generic-status-wrapper" name="DERIVED_SSR_FL_SSR_DESCR50$7" value="Closed" /></dd>',
      );

    expect(parseClassSelection(inputFixture)[0]).toMatchObject({
      courseCode: 'PHA 500',
      classNumber: '1494',
      status: 'CLOSED',
    });
  });

  it('adds caller-supplied term and observation time to complete SectionState values', () => {
    const checkedAt = new Date('2026-08-26T09:00:00.000Z');
    const sections = parseClassSelection(fixture, {
      term: '2701',
      termLabel: '2026/2027 Fall',
      checkedAt,
    });

    expect(sections[0]).toMatchObject({
      term: '2701',
      termLabel: '2026/2027 Fall',
      checkedAt,
      classNumber: '1494',
    });
  });
});
