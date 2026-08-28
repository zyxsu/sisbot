import { describe, expect, it } from 'vitest';
import {
  formatChangeAlert,
  formatHelpMessage,
  formatSectionCard,
  formatSessionStatus,
  formatStartMessage,
  formatWatchesList,
  getStatusBadge,
} from '../../src/telegram/formatters.js';

describe('Telegram Formatters', () => {
  it('formats status badges with appropriate emoji', () => {
    expect(getStatusBadge('OPEN')).toBe('🟢 OPEN');
    expect(getStatusBadge('CLOSED')).toBe('🔴 CLOSED');
    expect(getStatusBadge('WAITLIST')).toBe('🟡 WAITLIST');
    expect(getStatusBadge('OTHER')).toBe('⚪ UNKNOWN');
  });

  it('formats section status card with snapshot details', () => {
    const section = {
      id: 'sec-1',
      term: '2701',
      termLabel: '2026/2027 Fall',
      courseCode: 'PHA 500',
      courseTitle: 'Pharmacy Practice',
      crseId: '000702',
      crseOfferNbr: '1',
      acadCareer: 'UGRD',
      institution: 'AUIB',
      classNumber: '1494',
      component: 'Lecture',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const snapshot = {
      id: 'snap-1',
      sectionId: 'sec-1',
      status: 'OPEN',
      availableSeats: 4,
      schedule: 'Tuesday Sunday 3:30PM to 4:45PM | Room: Lecture Hall_3',
      meetingDates: '23/08/2026 - 15/12/2026',
      sessionName: 'Regular Academic Session',
      checkedAt: new Date('2026-08-26T12:00:00Z'),
      createdAt: new Date(),
    };

    const card = formatSectionCard(section, snapshot);
    expect(card).toContain('PHA 500');
    expect(card).toContain('1494');
    expect(card).toContain('🟢 OPEN');
    expect(card).toContain('4 seat(s) available');
    expect(card).toContain('Tuesday & Sunday');
    expect(card).toContain('3:30 PM–4:45 PM');
    expect(card).toContain('Lecture Hall 3');
    expect(card).toContain('23 Aug–15 Dec 2026');
    expect(card).toContain('Baghdad');
  });

  it('formats empty watches list message', () => {
    const msg = formatWatchesList([]);
    expect(msg).toContain('no active class subscriptions');
  });

  it('formats active watches list with items', () => {
    const watches = [
      {
        subscription: {
          id: 'sub-1',
          userId: 'u-1',
          sectionId: 'sec-1',
          isActive: true,
          baselineStatus: 'CLOSED',
          baselineAvailableSeats: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        section: {
          id: 'sec-1',
          term: '2701',
          termLabel: '2026/2027 Fall',
          courseCode: 'PHA 500',
          courseTitle: 'Pharmacy Practice',
          crseId: '000702',
          crseOfferNbr: '1',
          acadCareer: 'UGRD',
          institution: 'AUIB',
          classNumber: '1494',
          component: 'Lecture',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        latestSnapshot: {
          id: 'snap-1',
          sectionId: 'sec-1',
          status: 'OPEN',
          availableSeats: 3,
          schedule: null,
          meetingDates: null,
          sessionName: null,
          checkedAt: new Date(),
          createdAt: new Date(),
        },
      },
    ];

    const msg = formatWatchesList(watches);
    expect(msg).toContain('Active Subscriptions (1)');
    expect(msg).toContain('PHA 500');
    expect(msg).toContain('1494');
    expect(msg).toContain('🟢 OPEN');
    expect(msg).toContain('3 seats');
  });

  it('formats change alert notifications with transition emojis', () => {
    const section = {
      id: 'sec-1',
      term: '2701',
      termLabel: '2026/2027 Fall',
      courseCode: 'PHA 500',
      courseTitle: 'Pharmacy Practice',
      crseId: '000702',
      crseOfferNbr: '1',
      acadCareer: 'UGRD',
      institution: 'AUIB',
      classNumber: '1494',
      component: 'Lecture',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const alert = formatChangeAlert(section, 'CLOSED', 'OPEN', 0, 5);
    expect(alert).toContain('SEAT AVAILABILITY UPDATE!');
    expect(alert).toContain('PHA 500');
    expect(alert).toContain('🔴 CLOSED ➔ 🟢 OPEN');
    expect(alert).toContain('0 ➔ *5*');
  });

  it('formats session status indicators', () => {
    expect(formatSessionStatus('ACTIVE')).toContain('Session Status: Active');
    expect(formatSessionStatus('EXPIRED')).toContain('Session Status: Expired');
    expect(formatSessionStatus('NOT_SET')).toContain('Session Status: Not Configured');
  });

  it('formats start and help messages', () => {
    expect(formatStartMessage('Ali')).toContain('👋 *Welcome, Ali!*');
    expect(formatStartMessage('Ali')).toContain('/status enl 201');
    expect(formatStartMessage('Ali')).toContain('/status 1495');
    expect(formatHelpMessage()).toContain('/watch 1494');
    expect(formatHelpMessage()).toContain('/status 1494');
  });
});
