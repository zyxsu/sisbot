import { describe, expect, it, vi } from 'vitest';
import {
  PeopleSoftHttpClient,
  PeopleSoftSessionExpiredError,
} from '../../src/peoplesoft/http/index.js';
import { PeopleSoftLiveModeDisabledError } from '../../src/peoplesoft/live-mode.js';
import { MonitoringSession } from '../../src/peoplesoft/session.js';
import { LiveSectionChecker } from '../../src/peoplesoft/workflow/live-section-checker.js';
import { readPeopleSoftFixture } from './fixture.js';

describe('PeopleSoftHttpClient', () => {
  it('normalizes various cookie representations to string', () => {
    expect(PeopleSoftHttpClient.normalizeCookieHeader('PS_TOKEN=abc; JSESSIONID=xyz')).toBe(
      'PS_TOKEN=abc; JSESSIONID=xyz',
    );

    expect(
      PeopleSoftHttpClient.normalizeCookieHeader({ rawCookies: 'PS_TOKEN=123; PS_DEVICE=abc' }),
    ).toBe('PS_TOKEN=123; PS_DEVICE=abc');

    expect(PeopleSoftHttpClient.normalizeCookieHeader({ PS_TOKEN: '123', JSESSIONID: 'abc' })).toBe(
      'PS_TOKEN=123; JSESSIONID=abc',
    );

    expect(PeopleSoftHttpClient.normalizeCookieHeader(null)).toBe('');
  });

  it('detects session expiration indicators from status, url, and body', () => {
    expect(PeopleSoftHttpClient.isSessionExpired(401, '', 'https://sis.auib.edu.iq')).toBe(true);
    expect(PeopleSoftHttpClient.isSessionExpired(403, '', 'https://sis.auib.edu.iq')).toBe(true);
    expect(
      PeopleSoftHttpClient.isSessionExpired(
        200,
        '',
        'https://sis.auib.edu.iq/psp/ps/EMPLOYEE/SA/s/WEBLIB_LOGIN.ISCRIPT1.FieldFormula.IScript_SignOn',
      ),
    ).toBe(true);
    expect(
      PeopleSoftHttpClient.isSessionExpired(
        200,
        '<html><body>Your session has expired. Please sign in again.</body></html>',
        'https://sis.auib.edu.iq/psc/ps/',
      ),
    ).toBe(true);
    expect(
      PeopleSoftHttpClient.isSessionExpired(
        200,
        '<html><body><table><tr><td>Valid Portal</td></tr></table></body></html>',
        'https://sis.auib.edu.iq/psc/ps/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_MANAGE_CLASSES_FL.GBL',
      ),
    ).toBe(false);
  });
});

describe('LiveSectionChecker', () => {
  const sampleCourseRequirements = readPeopleSoftFixture('course-requirements.html');
  const sampleActivityGuide = readPeopleSoftFixture('activity-guide-observed.html');
  const samplePreprocessing = `
    <html>
      <head>
        <script>
          window.location = "/psc/ps/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_ENRL_SELECT_FL.GBL?Page=SSR_ENRL_SELECT_FL";
        </script>
      </head>
    </html>
  `;
  const sampleClassSelection = readPeopleSoftFixture('class-selection.xml');

  it('rejects execution when PEOPLESOFT_LIVE_ENABLED is false', async () => {
    const checker = new LiveSectionChecker({
      environment: { PEOPLESOFT_LIVE_ENABLED: false },
    });

    const session = new MonitoringSession({
      id: 'sess-test-1',
      owner: { type: 'TELEGRAM_USER', id: 'usr-1' },
    });

    await expect(
      checker.checkCourseSections({
        session,
        courseCode: 'PHA 500',
        term: '2701',
      }),
    ).rejects.toThrow(PeopleSoftLiveModeDisabledError);
  });

  it('executes full 4-step live workflow against mocked HTTP responses', async () => {
    const mockFetch = vi
      .fn()
      // Step 1: Course Requirements View
      .mockResolvedValueOnce(
        new Response(sampleCourseRequirements, {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html' },
        }),
      )
      // Step 2: POST course action (CRSE_DESCR1$32) -> Activity Guide
      .mockResolvedValueOnce(
        new Response(sampleActivityGuide, {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html' },
        }),
      )
      // Step 3: GET Activity Guide preprocessing -> reviewTargetUrl
      .mockResolvedValueOnce(
        new Response(samplePreprocessing, {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html' },
        }),
      )
      // Step 4: GET Class Selection review page
      .mockResolvedValueOnce(
        new Response(sampleClassSelection, {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html' },
        }),
      );

    const httpClient = new PeopleSoftHttpClient({
      baseUrl: 'https://sis.auib.edu.iq',
      fetchFn: mockFetch,
    });

    const checker = new LiveSectionChecker({
      environment: { PEOPLESOFT_LIVE_ENABLED: true },
      httpClient,
    });

    const session = new MonitoringSession({
      id: 'PS_TOKEN=valid-student-token; JSESSIONID=test',
      owner: { type: 'TELEGRAM_USER', id: 'usr-1' },
    });

    const sections = await checker.checkCourseSections({
      session,
      courseCode: 'PHA 500',
      term: '2701',
      termLabel: '2026/2027 Fall',
    });

    expect(sections).toHaveLength(3);
    expect(sections[0]?.classNumber).toBe('1494');
    expect(sections[0]?.courseCode).toBe('PHA 500');
    expect(sections[0]?.status).toBe('CLOSED');
    expect(sections[0]?.availableSeats).toBeNull();
    expect(sections[0]?.schedule).toBe('Tuesday Sunday 08:00 to 09:15');

    expect(sections[1]?.classNumber).toBe('1495');
    expect(sections[1]?.status).toBe('OPEN');
    expect(sections[1]?.availableSeats).toBe(4);

    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('marks session expired when receiving login redirect / session timeout', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response('<html><body>Your session has expired.</body></html>', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/html' },
      }),
    );

    const httpClient = new PeopleSoftHttpClient({
      baseUrl: 'https://sis.auib.edu.iq',
      fetchFn: mockFetch,
    });

    const checker = new LiveSectionChecker({
      environment: { PEOPLESOFT_LIVE_ENABLED: true },
      httpClient,
    });

    const session = new MonitoringSession({
      id: 'PS_TOKEN=expired-token',
      owner: { type: 'TELEGRAM_USER', id: 'usr-1' },
    });

    expect(session.status).toBe('ACTIVE');

    await expect(
      checker.checkCourseSections({
        session,
        courseCode: 'PHA 500',
        term: '2701',
      }),
    ).rejects.toThrow(PeopleSoftSessionExpiredError);

    expect(session.status).toBe('EXPIRED');
  });
});
