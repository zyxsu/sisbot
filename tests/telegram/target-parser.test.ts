import { describe, expect, it } from 'vitest';
import { parseTargetIdentifier } from '../../src/telegram/types.js';

describe('Telegram parseTargetIdentifier', () => {
  it('parses numeric class numbers accurately', () => {
    expect(parseTargetIdentifier('1494')).toEqual({
      type: 'CLASS_NUMBER',
      value: '1494',
    });
    expect(parseTargetIdentifier(' 1510 ')).toEqual({
      type: 'CLASS_NUMBER',
      value: '1510',
    });
    expect(parseTargetIdentifier('12345')).toEqual({
      type: 'CLASS_NUMBER',
      value: '12345',
    });
  });

  it('parses course codes with or without space', () => {
    expect(parseTargetIdentifier('PHA 500')).toEqual({
      type: 'COURSE_CODE',
      value: 'PHA 500',
    });
    expect(parseTargetIdentifier('pha500')).toEqual({
      type: 'COURSE_CODE',
      value: 'PHA 500',
    });
    expect(parseTargetIdentifier('cs 101a')).toEqual({
      type: 'COURSE_CODE',
      value: 'CS 101A',
    });
    expect(parseTargetIdentifier('bio 210')).toEqual({
      type: 'COURSE_CODE',
      value: 'BIO 210',
    });
  });

  it('returns null for empty or invalid strings', () => {
    expect(parseTargetIdentifier('')).toBeNull();
    expect(parseTargetIdentifier('   ')).toBeNull();
    expect(parseTargetIdentifier('!@#$%')).toBeNull();
  });
});
