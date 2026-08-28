import { parseAvailableSeats } from './available-seats.js';

/**
 * Reads only a seat number explicitly labelled by the Class Availability page.
 * Capacity and enrollment totals are intentionally not used to derive a value.
 */
export function parseClassAvailability(markupOrText: string): number | null {
  return parseAvailableSeats(markupOrText.replace(/<[^>]*>/g, ' '));
}
