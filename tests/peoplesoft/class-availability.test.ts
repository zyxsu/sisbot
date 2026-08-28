import { describe, expect, it } from 'vitest';

import { parseClassAvailability } from '../../src/peoplesoft/parsers/class-availability.js';

describe('parseClassAvailability', () => {
  it.each([
    ['Available Seats: 7', 7],
    ['Seats Available 12', 12],
    ['<div><span>Available Seats</span><strong>3</strong></div>', 3],
  ])('reads an explicitly labelled value from %s', (value, expected) => {
    expect(parseClassAvailability(value)).toBe(expected);
  });

  it('does not infer availability from capacity and enrollment totals', () => {
    expect(
      parseClassAvailability('Enrollment Capacity 30 Enrollment Total 28 Wait List Total 0'),
    ).toBeNull();
  });

  it('returns null when the Class Availability page exposes no numeric seat label', () => {
    expect(parseClassAvailability('Class Availability Status Open')).toBeNull();
  });
});
