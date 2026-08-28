import { describe, expect, it } from 'vitest';

import { findCourseAction, parseCourseActions } from '../../src/peoplesoft/parsers/course-list.js';
import { readPeopleSoftFixture } from './fixture.js';

const fixture = readPeopleSoftFixture('course-requirements.html');

describe('course action parser', () => {
  it('associates each course with the action rendered in its current row', () => {
    expect(parseCourseActions(fixture)).toEqual([
      {
        courseCode: 'PHA 410',
        action: 'CRSE_DESCR1$11',
      },
      {
        courseCode: 'PHA 500',
        action: 'CRSE_DESCR1$32',
      },
    ]);
  });

  it('looks up a requested course without relying on its position', () => {
    expect(findCourseAction(fixture, '  pha   500 ')).toMatchObject({
      courseCode: 'PHA 500',
      action: 'CRSE_DESCR1$32',
    });
  });

  it('parses a changed PeopleSoft row suffix rather than hard-coding 32', () => {
    const reindexedFixture = fixture.replaceAll('CRSE_DESCR1$32', () => 'CRSE_DESCR1$27');

    expect(findCourseAction(reindexedFixture, 'PHA 500')?.action).toBe('CRSE_DESCR1$27');
  });
});
