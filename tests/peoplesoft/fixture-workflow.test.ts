import { describe, expect, it } from 'vitest';

import { MonitoringSession } from '../../src/peoplesoft/session.js';
import {
  FixtureSectionChecker,
  FixtureWorkflowMismatchError,
  InMemoryFixtureWorkflowSource,
} from '../../src/peoplesoft/workflow/check-course-sections.js';
import { readPeopleSoftFixture } from './fixture.js';

function fixtureSession(): MonitoringSession {
  return new MonitoringSession({
    id: 'offline-fixture-session',
    owner: { type: 'FIXTURE', id: null },
  });
}

function fixtureChecker(courseRequirements = readPeopleSoftFixture('course-requirements.html')) {
  return new FixtureSectionChecker(
    new InMemoryFixtureWorkflowSource([
      {
        courseCode: 'PHA 500',
        term: '2701',
        responses: {
          courseRequirements,
          activityGuide: readPeopleSoftFixture('activity-guide.xml'),
          activityGuidePreprocessing: readPeopleSoftFixture('activity-guide-preprocessing.xml'),
          classSelection: readPeopleSoftFixture('class-selection.xml'),
        },
      },
    ]),
  );
}

describe('FixtureSectionChecker', () => {
  it('composes the offline checkpoints into normalized section states', async () => {
    const checkedAt = new Date('2026-08-26T09:00:00.000Z');
    const sections = await fixtureChecker().checkCourseSections({
      session: fixtureSession(),
      courseCode: 'PHA 500',
      term: '2701',
      termLabel: '2026/2027 Fall',
      checkedAt,
    });

    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({
      term: '2701',
      termLabel: '2026/2027 Fall',
      courseCode: 'PHA 500',
      classNumber: '1494',
      status: 'CLOSED',
      availableSeats: null,
      checkedAt,
    });
  });

  it('continues to work when the current course action row suffix changes', async () => {
    const reindexedPage = readPeopleSoftFixture('course-requirements.html').replaceAll(
      'CRSE_DESCR1$32',
      () => 'CRSE_DESCR1$27',
    );
    const sections = await fixtureChecker(reindexedPage).checkCourseSections({
      session: fixtureSession(),
      courseCode: 'PHA 500',
      term: '2701',
    });

    expect(sections.map(({ classNumber }) => classNumber)).toEqual(['1494', '1495', '1510']);
  });

  it('fails closed when the requested course is absent from the fixture', async () => {
    await expect(
      fixtureChecker().checkCourseSections({
        session: fixtureSession(),
        courseCode: 'BIO 210',
        term: '2701',
      }),
    ).rejects.toBeInstanceOf(FixtureWorkflowMismatchError);
  });

  it('checks multiple courses sequentially and keeps a result for each target', async () => {
    const sharedCoursePage = readPeopleSoftFixture('course-requirements-multiple.html');
    const activityGuide = readPeopleSoftFixture('activity-guide.xml');
    const activityGuidePreprocessing = readPeopleSoftFixture('activity-guide-preprocessing.xml');
    const checker = new FixtureSectionChecker(
      new InMemoryFixtureWorkflowSource([
        {
          courseCode: 'PHA 500',
          term: '2701',
          responses: {
            courseRequirements: sharedCoursePage,
            activityGuide,
            activityGuidePreprocessing,
            classSelection: readPeopleSoftFixture('class-selection.xml'),
          },
        },
        {
          courseCode: 'PHA 510',
          term: '2701',
          responses: {
            courseRequirements: sharedCoursePage,
            activityGuide,
            activityGuidePreprocessing,
            classSelection: readPeopleSoftFixture('class-selection-pha510.xml'),
          },
        },
      ]),
    );

    const results = await checker.checkCoursesSequentially({
      session: fixtureSession(),
      targets: [
        { courseCode: 'pha500', classNumber: '1495', term: '2701' },
        { courseCode: 'PHA 510', classNumber: '9102', term: '2701' },
      ],
    });

    expect(results).toHaveLength(2);
    expect(
      results.map(({ target, sections }) => [target.courseCode, sections[0]?.classNumber]),
    ).toEqual([
      ['PHA500', '1495'],
      ['PHA 510', '9102'],
    ]);
  });
});
