import { readFileSync } from 'node:fs';

export function readPeopleSoftFixture(name: string): string {
  return readFileSync(new URL(`../../src/fixtures/peopleSoft/${name}`, import.meta.url), 'utf8');
}
