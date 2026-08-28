import { logger } from '../../config/logger.js';
import {
  findPanelAction,
  findSectionAction,
  parseAvailability,
  type AvailabilityResult,
} from '../parsers/index.js';
import { PeopleSoftComponentState } from './component-state.js';
import { PeopleSoftHttpClient } from './peoplesoft-client.js';

const NEW_WINDOW_COMPONENT = '/psc/ps_newwin/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_START_PAGE_FL.GBL';

export interface SectionAvailabilityRequest {
  cookiesPayload: unknown;
  crseId: string;
  crseOfferNbr: string;
  term: string;
  classNumber: string;
  acadCareer?: string;
  institution?: string;
}

export interface PeopleSoftAvailabilityClientOptions {
  httpClient?: PeopleSoftHttpClient;
  baseUrl?: string;
}

export class PeopleSoftAvailabilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PeopleSoftAvailabilityError';
  }
}

function requiredDigits(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!new RegExp(`^\\d{1,${String(maximumLength)}}$`).test(normalized)) {
    throw new PeopleSoftAvailabilityError(`${label} must contain digits only`);
  }
  return normalized;
}

function requiredCode(value: string, label: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,12}$/.test(normalized)) {
    throw new PeopleSoftAvailabilityError(`${label} is invalid`);
  }
  return normalized;
}

export class PeopleSoftAvailabilityClient {
  private readonly httpClient: PeopleSoftHttpClient;
  private readonly baseUrl: string;

  public constructor(options: PeopleSoftAvailabilityClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://sis.auib.edu.iq').replace(/\/+$/, '');
    this.httpClient = options.httpClient ?? new PeopleSoftHttpClient({ baseUrl: this.baseUrl });
  }

  public async checkSection(request: SectionAvailabilityRequest): Promise<AvailabilityResult> {
    const cookieHeader = PeopleSoftHttpClient.normalizeCookieHeader(request.cookiesPayload);
    if (cookieHeader.length === 0) {
      throw new PeopleSoftAvailabilityError('An authenticated PeopleSoft session is required');
    }

    const crseId = requiredDigits(request.crseId, 'CRSE_ID', 12).padStart(6, '0');
    const crseOfferNbr = requiredDigits(request.crseOfferNbr, 'CRSE_OFFER_NBR', 4);
    const term = requiredDigits(request.term, 'Term', 8);
    const classNumber = requiredDigits(request.classNumber, 'Class number', 8);
    const acadCareer = requiredCode(request.acadCareer ?? 'UGRD', 'Academic career');
    const institution = requiredCode(request.institution ?? 'AUIB', 'Institution');

    logger.info({ crseId, term, classNumber }, 'Starting PeopleSoft HTTP availability check');

    const state = new PeopleSoftComponentState();
    const bootstrap = await this.httpClient.get(this.buildNewWindowUrl(), cookieHeader, {
      Accept: '*/*',
    });
    state.updateFromResponse(bootstrap.body, bootstrap.url);

    const courseUrl = this.buildCourseUrl(state, {
      crseId,
      crseOfferNbr,
      term,
      acadCareer,
      institution,
    });
    const courseResponse = await this.httpClient.get(courseUrl, cookieHeader, { Accept: '*/*' });
    state.updateFromResponse(courseResponse.body, courseResponse.url);

    const section = findSectionAction(courseResponse.body, classNumber);
    if (section === null) {
      throw new PeopleSoftAvailabilityError(
        `Class ${classNumber} was not found on the course page`,
      );
    }
    logger.info(
      { classNumber, component: section.component },
      'PeopleSoft section action resolved',
    );

    const componentUrl = state.componentUrl;
    if (componentUrl === null) {
      throw new PeopleSoftAvailabilityError('Dynamic PeopleSoft component URL was not discovered');
    }

    const postHeaders = { Accept: '*/*', Origin: this.baseUrl, Referer: componentUrl };
    const classResponse = await this.httpClient.postForm(
      componentUrl,
      state.toFormData(section.action),
      cookieHeader,
      postHeaders,
    );
    state.updateFromResponse(classResponse.body, classResponse.url);

    const cd = findPanelAction(classResponse.body, 'CD');
    if (cd === null) throw new PeopleSoftAvailabilityError('Class Details control was not found');

    const detailsResponse = await this.httpClient.postForm(
      componentUrl,
      state.toFormData(cd.action, { [cd.action]: 'CD' }),
      cookieHeader,
      postHeaders,
    );
    const detailsTransition = state.updateFromResponse(detailsResponse.body, detailsResponse.url);

    const ca =
      findPanelAction(detailsResponse.body, 'CA') ?? findPanelAction(classResponse.body, 'CA');
    if (ca === null)
      throw new PeopleSoftAvailabilityError('Class Availability control was not found');

    const availabilityResponse = await this.httpClient.postForm(
      componentUrl,
      state.toFormData(ca.action, { [ca.action]: 'CA' }),
      cookieHeader,
      postHeaders,
    );
    const availabilityTransition = state.updateFromResponse(
      availabilityResponse.body,
      availabilityResponse.url,
    );
    const result = parseAvailability(availabilityResponse.body, classNumber);

    if (result === null) {
      throw new PeopleSoftAvailabilityError(
        'Class Availability returned no changed seat fields after the CD to CA transition',
      );
    }

    logger.info(
      {
        classNumber,
        availableSeats: result.availableSeats,
        fromState: detailsTransition.currentStateNum,
        toState: availabilityTransition.currentStateNum,
      },
      'PeopleSoft HTTP availability check completed',
    );
    return result;
  }

  private buildNewWindowUrl(): string {
    const url = new URL(NEW_WINDOW_COMPONENT, this.baseUrl);
    url.search = new URLSearchParams({
      Page: 'SSR_START_PAGE_FL',
      Action: 'U',
      scname: 'CS_SSR_MANAGE_CLASSES_NAV',
      MD: 'Y',
      ICDoModal: '1',
      ICGrouplet: '1',
      ICLoc: '1',
      nWidth: '286',
      nHeight: '740',
    }).toString();
    return url.toString();
  }

  private buildCourseUrl(
    state: PeopleSoftComponentState,
    course: {
      crseId: string;
      crseOfferNbr: string;
      term: string;
      acadCareer: string;
      institution: string;
    },
  ): string {
    if (state.componentUrl === null || !/\/psc\/ps_\d+\//i.test(state.componentUrl)) {
      throw new PeopleSoftAvailabilityError(
        'New PeopleSoft window did not expose a dynamic component window',
      );
    }

    const url = new URL(state.componentUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new PeopleSoftAvailabilityError(
        'PeopleSoft component URL changed to an unexpected host',
      );
    }

    if (!/\/c\/[^/]+$/i.test(url.pathname)) {
      throw new PeopleSoftAvailabilityError('PeopleSoft component path was malformed');
    }
    url.pathname = url.pathname.replace(
      /\/c\/[^/]+$/i,
      '/c/SSR_STUDENT_FL.SSR_CRSE_INFO_FL.GBL',
    );
    url.search = new URLSearchParams({
      Page: 'SSR_CRSE_INFO_FL',
      Action: 'U',
      ACAD_CAREER: course.acadCareer,
      CRSE_ID: course.crseId,
      CRSE_OFFER_NBR: course.crseOfferNbr,
      INSTITUTION: course.institution,
      STRM: course.term,
      ICAJAX: '1',
      ICMDTarget: 'start',
      ICPanelControlStyle: ' pst_side1-fixed pst_panel-mode ',
    }).toString();
    return url.toString();
  }
}
