import { describe, expect, it } from 'vitest';

import {
  parseActivityGuide,
  parseActivityGuidePreprocessingTarget,
  REVIEW_CLASS_SELECTION_SERVICE_ID,
} from '../../src/peoplesoft/parsers/activity-guide.js';
import { readPeopleSoftFixture } from './fixture.js';

const fixture = readPeopleSoftFixture('activity-guide.xml');

describe('parseActivityGuide', () => {
  it('finds Review Class Selection, its service, transient parameters, and target', () => {
    expect(parseActivityGuide(fixture)).toEqual({
      label: 'Review Class Selection',
      serviceId: 'SSR_ENRL_SELECT_FL',
      preprocessingUrl:
        '/s/WEBLIB_PTAI.ISCRIPT1.FieldFormula.IScript_AIPreProcessing?SERVICEID=SSR_ENRL_SELECT_FL&PTAI_LIST_ID=list-fixture-a91f&PTAI_ITEM_ID=item-fixture-c73d&PTAI_INSTANCE=instance-fixture-5e20',
      targetUrl: null,
      parameters: {
        SERVICEID: 'SSR_ENRL_SELECT_FL',
        PTAI_LIST_ID: 'list-fixture-a91f',
        PTAI_ITEM_ID: 'item-fixture-c73d',
        PTAI_INSTANCE: 'instance-fixture-5e20',
      },
    });
  });

  it('uses response-provided transient identifiers instead of captured values', () => {
    const changedFixture = fixture
      .replaceAll('list-fixture-a91f', () => 'list-runtime-7cc4')
      .replaceAll('item-fixture-c73d', () => 'item-runtime-83ba')
      .replaceAll('instance-fixture-5e20', () => 'instance-runtime-1d60');
    const result = parseActivityGuide(changedFixture);

    expect(result?.parameters).toMatchObject({
      PTAI_LIST_ID: 'list-runtime-7cc4',
      PTAI_ITEM_ID: 'item-runtime-83ba',
      PTAI_INSTANCE: 'instance-runtime-1d60',
    });
  });

  it('can select a service explicitly and returns null when it is absent', () => {
    expect(parseActivityGuide(fixture, REVIEW_CLASS_SELECTION_SERVICE_ID)).not.toBeNull();
    expect(parseActivityGuide(fixture, 'UNOBSERVED_SERVICE')).toBeNull();
  });

  it('handles the observed split href and onclick Activity Guide attributes', () => {
    const observedFixture = readPeopleSoftFixture('activity-guide-observed.html');
    const result = parseActivityGuide(observedFixture);

    expect(result).toMatchObject({
      label: 'Review Class Selection',
      serviceId: 'SSR_ENRL_SELECT_FL',
      parameters: {
        PTAI_ACTION: 'select',
        PTAI_ITEM_ID: 'item-sanitized-8',
      },
      stepAttributes: {
        ptgpid: 'group-sanitized-8',
        stepnumber: '8',
        steplabel: 'Step 8',
        steptitle: 'Review Class Selection',
      },
    });
    expect(result?.preprocessingUrl).toContain('AIPreProcessingNUI');
  });

  it('parses the component target from the separate preprocessing response', () => {
    const preprocessingFixture = readPeopleSoftFixture('activity-guide-preprocessing.xml');

    expect(parseActivityGuidePreprocessingTarget(preprocessingFixture)).toBe(
      '/psp/SANITIZED/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_ENRL_SELECT_FL.GBL?PTAI_LIST_ID=list-fixture-a91f&PTAI_ITEM_ID=item-fixture-c73d',
    );
  });

  it('discovers changed transient target parameters from that response', () => {
    const preprocessingFixture = readPeopleSoftFixture('activity-guide-preprocessing.xml')
      .replaceAll('list-fixture-a91f', () => 'list-runtime-7cc4')
      .replaceAll('item-fixture-c73d', () => 'item-runtime-83ba');
    const target = parseActivityGuidePreprocessingTarget(preprocessingFixture);

    expect(target).toContain('PTAI_LIST_ID=list-runtime-7cc4');
    expect(target).toContain('PTAI_ITEM_ID=item-runtime-83ba');
  });
});
