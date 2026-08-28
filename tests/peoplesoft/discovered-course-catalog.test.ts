import { describe, expect, it } from 'vitest';
import {
  createDiscoveredCourseResolver,
  DISCOVERED_COURSE_CATALOG,
} from '../../src/peoplesoft/http/index.js';

describe('sanitized discovered course catalog', () => {
  it('contains every confirmed course and section without duplicate class numbers', () => {
    expect(
      DISCOVERED_COURSE_CATALOG.map(({ courseCode, crseId, sections }) => ({
        courseCode,
        crseId,
        classNumbers: sections.map(({ classNumber }) => classNumber),
      })),
    ).toEqual([
      { courseCode: 'PHA 500', crseId: '000702', classNumbers: ['1494', '1495'] },
      {
        courseCode: 'ENL 201',
        crseId: '000375',
        classNumbers: [
          '1243',
          '1244',
          '1245',
          '1246',
          '1247',
          '1249',
          '1250',
          '1251',
          '1254',
          '1255',
        ],
      },
      { courseCode: 'HCT 480', crseId: '000966', classNumbers: ['1544'] },
    ]);

    for (const course of DISCOVERED_COURSE_CATALOG) {
      expect(new Set(course.sections.map(({ classNumber }) => classNumber)).size).toBe(
        course.sections.length,
      );
    }
  });

  it('resolves every catalog course by subject, catalog number, and term', async () => {
    const resolver = createDiscoveredCourseResolver();

    for (const course of DISCOVERED_COURSE_CATALOG) {
      await expect(
        resolver.resolveCourse({
          subject: course.subject,
          catalogNumber: course.catalogNumber,
          term: course.term,
        }),
      ).resolves.toMatchObject({
        crseId: course.crseId,
        crseOfferNbr: course.crseOfferNbr,
      });
    }
  });
});
