/**
 * Parses only an explicit numeric availability value. Capacity and enrollment
 * figures are deliberately ignored because their relationship has not been
 * verified for this SIS response.
 */
export function parseAvailableSeats(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalizedValue = value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const labeledMatch = /(?:seats?\s+available|available\s+seats?)\s*:?\s*(\d+)\b/i.exec(
    normalizedValue,
  );
  const numericOnlyMatch = /^\d+$/.exec(normalizedValue);
  const numericText = labeledMatch?.[1] ?? numericOnlyMatch?.[0] ?? null;

  if (numericText === null) {
    return null;
  }

  const availableSeats = Number(numericText);

  return Number.isSafeInteger(availableSeats) ? availableSeats : null;
}
