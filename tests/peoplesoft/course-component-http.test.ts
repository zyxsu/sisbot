import { describe, expect, it } from 'vitest';
import {
  PeopleSoftAvailabilityClient,
  PeopleSoftHttpClient,
} from '../../src/peoplesoft/http/index.js';
import { PeopleSoftComponentState } from '../../src/peoplesoft/http/component-state.js';
import {
  findPanelAction,
  findSectionAction,
  MalformedPeopleSoftResponseError,
  parseAvailability,
  PeopleSoftComponentParseError,
} from '../../src/peoplesoft/parsers/index.js';
import { readPeopleSoftFixture } from './fixture.js';

describe('PeopleSoft course component HTTP parsing', () => {
  const course = readPeopleSoftFixture('hct480-course.xml');
  const classPage = readPeopleSoftFixture('hct480-class.html');
  const availability = readPeopleSoftFixture('hct480-availability.xml');
  const classDetails = readPeopleSoftFixture('hct480-class-details.xml');
  const emptyDiff = readPeopleSoftFixture('hct480-empty-diff.xml');

  it('resolves class 1544 to its dynamic section action', () => {
    expect(findSectionAction(course, '1544')).toEqual({
      action: 'SSR_CLSRCH_F_WK_SSR_CMPNT_DESCR_1$900$$0',
      classNumber: '1544',
      component: 'Lecture',
      label: 'Lecture - 1544',
    });
  });

  it('discovers CA and CD actions from values rather than numeric suffixes', () => {
    expect(findPanelAction(classPage, 'CD')).toEqual({
      action: 'DERIVED_SSR_FL_SSR_CL_DTLS_LFF$700$',
      value: 'CD',
    });
    expect(findPanelAction(classPage, 'CA')).toEqual({
      action: 'DERIVED_SSR_FL_SSR_CL_DTLS_LFF$799$',
      value: 'CA',
    });
  });

  it('tracks hidden and differential component state without fixed window numbers', () => {
    const state = new PeopleSoftComponentState();
    const first = state.updateFromResponse(
      course,
      'https://sis.auib.edu.iq/psc/ps_77/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_CRSE_INFO_FL.GBL',
    );
    const second = state.updateFromResponse(availability);

    expect(first).toEqual({ previousStateNum: null, currentStateNum: '5' });
    expect(second).toEqual({ previousStateNum: '5', currentStateNum: '8' });
    expect(state.componentUrl).toContain('/psc/ps_77/');
    expect(state.windowName).toBe('win77');
    expect(state.elementNum).toBe('77');
    expect(state.icsid).toBe('TEST_ICSID');
    expect(state.icBcDomData).toBe('TEST_BREADCRUMB_DATA');

    expect(state.toFormData('TEST_ACTION', { TEST_CONTROL: 'CA' })).toMatchObject({
      ICAJAX: '1',
      ICType: 'Panel',
      ICStateNum: '8',
      ICElementNum: '77',
      ICSID: 'TEST_ICSID',
      ICAction: 'TEST_ACTION',
      TEST_CONTROL: 'CA',
    });
  });

  it('parses exact HCT 480 availability only while CA is active', () => {
    expect(parseAvailability(availability, '1544')).toEqual({
      courseCode: 'HCT 480',
      description: 'Marketing in the Healthcare Sector',
      classNumber: '1544',
      component: 'Lecture',
      status: 'Closed',
      capacity: 25,
      enrollmentTotal: 25,
      availableSeats: 0,
      waitlistCapacity: 0,
      waitlistTotal: 0,
    });
    expect(parseAvailability(classDetails, '1544')).toBeNull();
    expect(parseAvailability(emptyDiff, '1544')).toBeNull();
  });

  it('rejects a response for a different class instead of returning stale data', () => {
    expect(() => parseAvailability(availability, '9999')).toThrow(PeopleSoftComponentParseError);
  });

  it('fails clearly when a class number maps to multiple different actions', () => {
    const duplicate = course.replace(
      '</form>',
      '<a id="DIFFERENT_ACTION$1" href="#">Lecture - 1544</a></form>',
    );
    expect(() => findSectionAction(duplicate, '1544')).toThrow(PeopleSoftComponentParseError);
  });

  it('detects malformed PeopleSoft XML', () => {
    expect(() => findSectionAction('<?xml version="1.0"?><PAGE><FIELD></PAGE>', '1544')).toThrow(
      MalformedPeopleSoftResponseError,
    );
  });

  it('executes dynamic course -> section -> CD -> CA HTTP state transitions', async () => {
    const bootstrap = '<!doctype html><div id="win77divSCC_NAV_TAB$0">Manage Classes</div>';
    const responses = [bootstrap, course, classPage, classDetails, availability];
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      const body = responses.shift();
      if (body === undefined) throw new Error('Unexpected extra HTTP request');
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const httpClient = new PeopleSoftHttpClient({ fetchFn, requestTimeoutMs: 1_000 });
    const client = new PeopleSoftAvailabilityClient({ httpClient });

    const result = await client.checkSection({
      cookiesPayload: { rawCookies: 'TEST_SESSION=authorized' },
      crseId: '000966',
      crseOfferNbr: '1',
      term: '2701',
      classNumber: '1544',
    });

    expect(result.availableSeats).toBe(0);
    expect(calls).toHaveLength(5);
    expect(calls[0]?.url).toContain('/psc/ps_newwin/');
    expect(calls[1]?.url).toContain('/psc/ps_77/');
    expect(calls[1]?.url).toContain('CRSE_ID=000966');

    const sectionBody = calls[2]?.init?.body;
    const detailsBody = calls[3]?.init?.body;
    const availabilityBody = calls[4]?.init?.body;
    expect(typeof sectionBody).toBe('string');
    expect(typeof detailsBody).toBe('string');
    expect(typeof availabilityBody).toBe('string');
    if (
      typeof sectionBody !== 'string' ||
      typeof detailsBody !== 'string' ||
      typeof availabilityBody !== 'string'
    ) {
      throw new Error('Expected URL-encoded PeopleSoft POST bodies');
    }

    const sectionPost = new URLSearchParams(sectionBody);
    expect(sectionPost.get('ICAction')).toBe('SSR_CLSRCH_F_WK_SSR_CMPNT_DESCR_1$900$$0');

    const detailsPost = new URLSearchParams(detailsBody);
    expect(detailsPost.get('ICAction')).toBe('DERIVED_SSR_FL_SSR_CL_DTLS_LFF$700$');
    expect(detailsPost.get('DERIVED_SSR_FL_SSR_CL_DTLS_LFF$700$')).toBe('CD');

    const availabilityPost = new URLSearchParams(availabilityBody);
    expect(availabilityPost.get('ICAction')).toBe('DERIVED_SSR_FL_SSR_CL_DTLS_LFF$799$');
    expect(availabilityPost.get('DERIVED_SSR_FL_SSR_CL_DTLS_LFF$799$')).toBe('CA');
    expect(availabilityPost.get('ICStateNum')).toBe('7');
  });
});
