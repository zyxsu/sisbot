import { describe, expect, it } from 'vitest';

import { parseHiddenFields } from '../../src/peoplesoft/parsers/hidden-fields.js';
import { readPeopleSoftFixture } from './fixture.js';

const fixture = readPeopleSoftFixture('course-requirements.html');

describe('parseHiddenFields', () => {
  it('parses the current hidden component state and preserves empty values', () => {
    expect(parseHiddenFields(fixture)).toEqual({
      ICStateNum: '7',
      ICElementNum: '3',
      ICAction: '',
      ICChanged: '-1',
      ICResubmit: '0',
    });
  });

  it('ignores visible controls and hidden controls without a name', () => {
    const fields = parseHiddenFields(fixture);

    expect(fields).not.toHaveProperty('search');
    expect(Object.values(fields)).not.toContain('ignored because it has no name');
  });
});
