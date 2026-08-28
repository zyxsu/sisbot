import { describe, expect, it } from 'vitest';

import { detectSectionChange } from '../../src/domain/section-change.js';
import type { SectionState, SectionStatus } from '../../src/domain/section-state.js';

const checkedAt = new Date('2026-08-26T00:00:00.000Z');

function sectionState(overrides: Partial<SectionState> = {}): SectionState {
  return {
    term: '2701',
    termLabel: '2026/2027 Fall',
    courseCode: 'PHA 500',
    courseTitle: 'Pharmacoeconomics and Drug Marketing',
    classNumber: '1494',
    component: 'Lecture',
    status: 'CLOSED',
    availableSeats: null,
    meetingDates: '23/08/2026 - 15/12/2026',
    schedule: 'Tuesday Sunday 08:00 to 09:15',
    sessionName: 'Regular Academic Session',
    checkedAt,
    ...overrides,
  };
}

describe('detectSectionChange', () => {
  it('establishes the initial observation as a baseline without an alert', () => {
    expect(detectSectionChange(null, sectionState())).toBeNull();
  });

  it.each<[SectionStatus, SectionStatus]>([
    ['CLOSED', 'OPEN'],
    ['OPEN', 'CLOSED'],
    ['OPEN', 'WAITLIST'],
    ['WAITLIST', 'UNKNOWN'],
  ])('detects a status transition from %s to %s', (from, to) => {
    const previous = sectionState({ status: from });
    const current = sectionState({ status: to });

    expect(detectSectionChange(previous, current)).toEqual({
      previous,
      current,
      statusChanged: true,
      availableSeatsChanged: false,
    });
  });

  it.each([
    [0, 3],
    [3, 5],
    [5, 2],
    [2, 0],
  ])('detects a numeric seat transition from %i to %i', (from, to) => {
    const previous = sectionState({ availableSeats: from });
    const current = sectionState({ availableSeats: to });

    expect(detectSectionChange(previous, current)).toEqual({
      previous,
      current,
      statusChanged: false,
      availableSeatsChanged: true,
    });
  });

  it('detects when an unknown seat count becomes known', () => {
    const previous = sectionState({ availableSeats: null });
    const current = sectionState({ availableSeats: 3 });

    expect(detectSectionChange(previous, current)).toEqual({
      previous,
      current,
      statusChanged: false,
      availableSeatsChanged: true,
    });
  });

  it('does not alert when a known seat count becomes unknown', () => {
    const previous = sectionState({ availableSeats: 3 });
    const current = sectionState({ availableSeats: null });

    expect(detectSectionChange(previous, current)).toBeNull();
  });

  it('does not alert when status and known seat count are unchanged', () => {
    const previous = sectionState({ status: 'OPEN', availableSeats: 3 });
    const current = sectionState({ status: 'OPEN', availableSeats: 3 });

    expect(detectSectionChange(previous, current)).toBeNull();
  });

  it('ignores checkedAt and descriptive metadata', () => {
    const previous = sectionState();
    const current = sectionState({
      courseTitle: 'Updated display title',
      schedule: 'Updated display schedule',
      checkedAt: new Date('2026-08-26T00:02:00.000Z'),
    });

    expect(detectSectionChange(previous, current)).toBeNull();
  });

  it('reports status and seat changes independently when both occur', () => {
    const previous = sectionState({ status: 'CLOSED', availableSeats: 0 });
    const current = sectionState({ status: 'OPEN', availableSeats: 2 });

    expect(detectSectionChange(previous, current)).toEqual({
      previous,
      current,
      statusChanged: true,
      availableSeatsChanged: true,
    });
  });
});
