import { describe, expect, it } from 'vitest';
import { parseStudentSchedule } from '../../src/peoplesoft/http/student-schedule-client.js';

describe('PeopleSoft student schedule parser', () => {
  it('parses stable row fields without relying on row order', () => {
    const html = `
      <div>Show Enrolled Classes</div>
      <div id="DERIVED_SSR_FL_SSR_DRV_ROOM1$3">Lecture Hall_3-E</div>
      <div id="DERIVED_SSR_FL_SSR_DAYSTIMES1$3">Times: 15:30 to 16:45</div>
      <div id="DERIVED_SSR_FL_SSR_SBJ_CAT_NBR$355$$3">Lecture - 1495</div>
      <div id="DERIVED_SSR_FL_SSR_DAYS1$3">Days: Tuesday Sunday</div>
      <div id="DERIVED_SSR_FL_SSR_ST_END_DT1$3">23/08/2026 - 15/12/2026</div>
      <div id="DERIVED_SSR_FL_SSR_DRV_STAT$392$$3">Enrolled</div>
    `;
    expect(parseStudentSchedule(html)).toEqual([
      {
        classNumber: '1495',
        component: 'Lecture',
        status: 'Enrolled',
        meetingDates: '23/08/2026 - 15/12/2026',
        days: 'Tuesday Sunday',
        time: '15:30 to 16:45',
        room: 'Lecture Hall 3-E',
      },
    ]);
  });
});
