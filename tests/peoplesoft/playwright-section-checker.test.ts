import { describe, expect, it } from 'vitest';

import {
  PlaywrightSectionChecker,
  deriveTermCode,
} from '../../src/peoplesoft/workflow/playwright-section-checker.js';

describe('PlaywrightSectionChecker class-list parsing and term derivation', () => {
  it('derives correct PeopleSoft term codes from academic term labels', () => {
    expect(deriveTermCode('2026/2027 Fall')).toBe('2701');
    expect(deriveTermCode('2025/2026 Spring')).toBe('2602');
    expect(deriveTermCode('2025/2026 Summer')).toBe('2603');
    expect(deriveTermCode('Unknown Term', '2701')).toBe('2701');
  });

  it('keeps each live-style class row status and schedule isolated', () => {
    const markup = `
      <main>
        <h1>PHA 500 - Pharmacoeconomics and Drug Marketing</h1>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Session</th>
              <th>Class</th>
              <th>Meeting Dates</th>
              <th>Days and Times</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Open / Enrolled</td>
              <td>Regular Academic Session</td>
              <td><a>Lecture - 1495</a></td>
              <td>08/23/2026 - 12/15/2026</td>
              <td>Tuesday Sunday 3:30PM to 4:45PM Room Lecture Hall_3-E</td>
            </tr>
            <tr>
              <td>Closed</td>
              <td>Regular Academic Session</td>
              <td><a>Lecture - 1494</a></td>
              <td>08/23/2026 - 12/15/2026</td>
              <td>Monday Wednesday 9:00AM to 10:15AM</td>
            </tr>
          </tbody>
        </table>
      </main>
    `;
    const checkedAt = new Date('2026-08-27T10:00:00.000Z');
    const checker = new PlaywrightSectionChecker();

    expect(
      checker.parseVisibleSections(
        markup,
        {
          courseCode: 'PHA500',
          term: '2701',
          termLabel: '2026/2027 Fall',
        },
        checkedAt,
      ),
    ).toEqual([
      {
        term: '2701',
        termLabel: '2026/2027 Fall',
        courseCode: 'PHA 500',
        courseTitle: 'Pharmacoeconomics and Drug Marketing',
        classNumber: '1495',
        component: 'Lecture',
        status: 'OPEN',
        availableSeats: null,
        meetingDates: '08/23/2026 - 12/15/2026',
        schedule: 'Tuesday Sunday 3:30PM to 4:45PM Room Lecture Hall_3-E',
        sessionName: 'Regular Academic Session',
        checkedAt,
      },
      {
        term: '2701',
        termLabel: '2026/2027 Fall',
        courseCode: 'PHA 500',
        courseTitle: 'Pharmacoeconomics and Drug Marketing',
        classNumber: '1494',
        component: 'Lecture',
        status: 'CLOSED',
        availableSeats: null,
        meetingDates: '08/23/2026 - 12/15/2026',
        schedule: 'Monday Wednesday 9:00AM to 10:15AM',
        sessionName: 'Regular Academic Session',
        checkedAt,
      },
    ]);
  });

  it('reads icon-only status metadata from the matching class row', () => {
    const markup = `
      <main>
        <h1>PHA 500 - Pharmacoeconomics and Drug Marketing</h1>
        <table>
          <tr><th>Status</th><th>Class</th></tr>
          <tr>
            <td><img aria-label="Open / Enrolled" /></td>
            <td><a>Lecture - 1495</a></td>
          </tr>
          <tr>
            <td><img title="Closed" /></td>
            <td><a>Lecture - 1494</a></td>
          </tr>
        </table>
      </main>
    `;
    const checker = new PlaywrightSectionChecker();
    const results = checker.parseVisibleSections(
      markup,
      { courseCode: 'PHA 500', term: '2701' },
      new Date('2026-08-27T10:00:00.000Z'),
    );

    expect(results.find((section) => section.classNumber === '1495')?.status).toBe('OPEN');
    expect(results.find((section) => section.classNumber === '1494')?.status).toBe('CLOSED');
  });

  it('selects the requested course without hard-coding PHA 500 or the term', () => {
    const markup = `
      <main>
        <div class="ps_box-group">
          <h2>PHA 500 - Pharmacoeconomics and Drug Marketing</h2>
          <a>Lecture - 1495</a>
          <p>Open</p>
          <p>Days: Tuesday Sunday Times: 3:30PM to 4:45PM Room: TBA</p>
        </div>
        <div class="ps_box-group">
          <h2>PHA 510 - Clinical Pharmacy</h2>
          <a>Lecture - 9102</a>
          <p>Closed</p>
        </div>
      </main>
    `;
    const checkedAt = new Date('2026-08-27T10:00:00.000Z');
    const checker = new PlaywrightSectionChecker();

    expect(
      checker.parseVisibleSections(
        markup,
        {
          courseCode: 'PHA 510',
          term: '2801',
          termLabel: '2027/2028 Fall',
        },
        checkedAt,
      ),
    ).toEqual([
      {
        term: '2801',
        termLabel: '2027/2028 Fall',
        courseCode: 'PHA 510',
        courseTitle: 'Clinical Pharmacy',
        classNumber: '9102',
        component: 'Lecture',
        status: 'CLOSED',
        availableSeats: null,
        checkedAt,
      },
    ]);
  });
});
