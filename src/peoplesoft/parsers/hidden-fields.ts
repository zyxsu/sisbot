import { loadPeopleSoftMarkup } from './markup.js';

export type PeopleSoftHiddenFields = Record<string, string>;

/**
 * Reads the current component form state. Callers should parse this again after
 * every response instead of retaining values from a previous component state.
 */
export function parseHiddenFields(markup: string): PeopleSoftHiddenFields {
  const $ = loadPeopleSoftMarkup(markup);
  const fields: PeopleSoftHiddenFields = {};

  $('input').each((_index, element) => {
    const input = $(element);
    const type = input.attr('type')?.trim().toLowerCase();
    const name = input.attr('name');

    if (type !== 'hidden' || name === undefined || name.length === 0) {
      return;
    }

    fields[name] = input.attr('value') ?? '';
  });

  return fields;
}
