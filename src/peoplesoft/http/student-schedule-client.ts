import { load } from 'cheerio';
import { PeopleSoftHttpClient } from './peoplesoft-client.js';

const SCHEDULE_COMPONENT = '/psc/ps_newwin/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_MD_SP_FL.GBL';

export interface StudentScheduleEntry {
  classNumber: string;
  component: string;
  status: string;
  meetingDates: string;
  days: string;
  time: string;
  room: string;
}

export interface StudentSchedule {
  entries: StudentScheduleEntry[];
  fetchedAt: Date;
}

export class StudentScheduleParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StudentScheduleParseError';
  }
}

function normalizedText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function parseStudentSchedule(html: string): StudentScheduleEntry[] {
  const document = load(html);
  const values = new Map<string, string>();
  document('[id]').each((_index, element) => {
    const id = document(element).attr('id');
    if (id !== undefined) values.set(id, normalizedText(document(element).text()));
  });

  const entries: StudentScheduleEntry[] = [];
  for (const [id, label] of values) {
    const rowMatch = /^DERIVED_SSR_FL_SSR_SBJ_CAT_NBR\$355\$\$(\d+)$/.exec(id);
    if (rowMatch?.[1] === undefined) continue;
    const sectionMatch = /^(.*?)\s*-\s*(\d{3,8})$/.exec(label);
    if (sectionMatch?.[1] === undefined || sectionMatch[2] === undefined) continue;
    const row = rowMatch[1];
    entries.push({
      component: sectionMatch[1].trim(),
      classNumber: sectionMatch[2],
      status: values.get(`DERIVED_SSR_FL_SSR_DRV_STAT$392$$${row}`) ?? 'Unknown',
      meetingDates: values.get(`DERIVED_SSR_FL_SSR_ST_END_DT1$${row}`) ?? 'TBA',
      days: (values.get(`DERIVED_SSR_FL_SSR_DAYS1$${row}`) ?? 'TBA').replace(/^Days:\s*/i, ''),
      time: (values.get(`DERIVED_SSR_FL_SSR_DAYSTIMES1$${row}`) ?? 'TBA').replace(
        /^Times:\s*/i,
        '',
      ),
      room: (values.get(`DERIVED_SSR_FL_SSR_DRV_ROOM1$${row}`) ?? 'TBA')
        .replaceAll('_', ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }

  if (entries.length === 0 && !/Show Enrolled Classes/i.test(document.text())) {
    throw new StudentScheduleParseError('PeopleSoft schedule fields were not found');
  }
  return entries.sort((left, right) => left.classNumber.localeCompare(right.classNumber));
}

export interface StudentScheduleClientOptions {
  baseUrl?: string;
  httpClient?: PeopleSoftHttpClient;
}

export class StudentScheduleClient {
  private readonly baseUrl: string;
  private readonly httpClient: PeopleSoftHttpClient;

  public constructor(options: StudentScheduleClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://sis.auib.edu.iq').replace(/\/+$/, '');
    this.httpClient = options.httpClient ?? new PeopleSoftHttpClient({ baseUrl: this.baseUrl });
  }

  public async fetch(cookiesPayload: unknown): Promise<StudentSchedule> {
    const cookieHeader = PeopleSoftHttpClient.normalizeCookieHeader(cookiesPayload);
    if (cookieHeader.length === 0)
      throw new Error('An authenticated PeopleSoft session is required');

    const navUrl = new URL(SCHEDULE_COMPONENT, this.baseUrl);
    navUrl.search = new URLSearchParams({
      Action: 'U',
      MD: 'Y',
      GMenu: 'SSR_STUDENT_FL',
      GComp: 'SSR_START_PAGE_FL',
      GPage: 'SSR_START_PAGE_FL',
      scname: 'CS_SSR_MANAGE_CLASSES_NAV',
    }).toString();

    // Step 1: Open Master-Detail Manage Classes frame
    await this.httpClient.get(navUrl.toString(), cookieHeader);

    // Step 2: Fetch View My Classes component
    const scheduleUrl = new URL(
      '/psc/ps/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_COMPONENT_FL.GBL',
      this.baseUrl,
    );
    scheduleUrl.search = new URLSearchParams({
      Page: 'SSR_VW_CLASS_FL',
      pslnkid: 'CS_S201605040129258749603935',
      ICAJAX: '1',
      ICMDTarget: 'start',
      ICPanelControlStyle: ' pst_side1-fixed pst_panel-mode ',
    }).toString();

    const response = await this.httpClient.get(scheduleUrl.toString(), cookieHeader, {
      Referer: navUrl.toString(),
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
    });

    return { entries: parseStudentSchedule(response.body), fetchedAt: new Date() };
  }
}
