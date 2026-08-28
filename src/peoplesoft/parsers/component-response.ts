import { XMLValidator } from 'fast-xml-parser';

export class MalformedPeopleSoftResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MalformedPeopleSoftResponseError';
  }
}

export function assertValidPeopleSoftResponse(markup: string): void {
  const trimmed = markup.trimStart();
  if (!trimmed.startsWith('<?xml') && !/^<PAGE(?:\s|>)/i.test(trimmed)) return;

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- See import rationale above.
  const validation = XMLValidator.validate(markup);
  if (validation !== true) {
    throw new MalformedPeopleSoftResponseError(
      `Malformed PeopleSoft XML response near line ${String(validation.err.line)}`,
    );
  }
}

export function expandPeopleSoftResponse(markup: string): string {
  assertValidPeopleSoftResponse(markup);
  return markup.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
