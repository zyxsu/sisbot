import { describe, expect, it } from 'vitest';
import { parseScheduledCatalog } from '../../src/catalog/catalog-parser.js';

const fixture = `
TERM: 2701 (2026/2027 Fall)
Generated: 2026-08-28 01:21:12 UTC
SECTION 1: OFFERED & SCHEDULED COURSES IN FALL 2026 (1 COURSES)
[PHA 500] Pharmacoeconomics and Drug Marketing (CRSE_ID: 000702, Units: 3.00)
  • Lecture - 1495 | Status: CLOSED (0 seats) | Schedule: Tuesday Sunday 3:30PM to 4:45PM | Room: Lecture Hall_3-E | Dates: 23/08/2026 - 15/12/2026
  • Lecture - 1494 | Status: OPEN (2/35 seats) | Schedule: TBA | Room: TBA | Dates: 23/08/2026 - 15/12/2026
SECTION 2: CATALOG COURSES NOT SCHEDULED
`;

describe('scheduled catalog parser', () => {
  it('maps course IDs and every class number', () => {
    const catalog = parseScheduledCatalog(fixture);
    expect(catalog.term).toBe('2701');
    expect(catalog.courses[0]?.crseId).toBe('000702');
    expect(catalog.courses[0]?.sections.map((section) => section.classNumber)).toEqual([
      '1495',
      '1494',
    ]);
    expect(catalog.courses[0]?.sections[1]?.availableSeats).toBe(2);
    expect(catalog.courses[0]?.sections[1]?.capacity).toBe(35);
  });
});
