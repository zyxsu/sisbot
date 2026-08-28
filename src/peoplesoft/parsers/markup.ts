import { load, type CheerioAPI } from 'cheerio';

/**
 * PeopleSoft AJAX responses commonly wrap replacement HTML in XML CDATA nodes.
 * Expanding those nodes lets every parser operate on the same DOM regardless of
 * whether a fixture is a full XML envelope or the extracted HTML fragment.
 */
export function loadPeopleSoftMarkup(markup: string): CheerioAPI {
  const expandedMarkup = markup.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  return load(expandedMarkup);
}

export function normalizePeopleSoftText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
