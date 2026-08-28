import type { SectionState } from './section-state.js';

export interface SectionChange {
  previous: SectionState;
  current: SectionState;
  statusChanged: boolean;
  availableSeatsChanged: boolean;
}

/**
 * Compares two observations of the same section for notification-worthy changes.
 *
 * The first observation establishes a baseline. A missing numeric count means the
 * SIS did not expose that value, so losing a known count is not treated as a seat
 * change. Timestamps and descriptive metadata are deliberately ignored.
 */
export function detectSectionChange(
  previous: SectionState | null,
  current: SectionState,
): SectionChange | null {
  if (previous === null) {
    return null;
  }

  const statusChanged = previous.status !== current.status;
  const availableSeatsChanged =
    current.availableSeats !== null && previous.availableSeats !== current.availableSeats;

  if (!statusChanged && !availableSeatsChanged) {
    return null;
  }

  return {
    previous,
    current,
    statusChanged,
    availableSeatsChanged,
  };
}
