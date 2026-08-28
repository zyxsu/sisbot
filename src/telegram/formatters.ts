import type { MonitoredSection, SectionSnapshot, UserSubscriptionDetail } from '../db/index.js';

function escapeMarkdown(value: string, maximumLength = 160): string {
  const printableValue = Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('');

  return printableValue
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength)
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('`', '\\`')
    .replaceAll('[', '\\[');
}

function cleanCourseTitle(value: string): string {
  return escapeMarkdown(value.replace(/\bClass Details\b.*$/i, '').trim());
}

interface DisplaySchedule {
  days: string | null;
  time: string | null;
  room: string | null;
  fallback: string | null;
}

function cleanSisText(value: string): string {
  return value.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
}

function formatClock(value: string): string {
  return value.replace(/(\d)(AM|PM)$/i, '$1 $2').toUpperCase();
}

function formatDays(value: string): string {
  const days = value.trim().split(/\s+/);
  const weekdays = new Set([
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ]);
  return days.length > 1 && days.every((day) => weekdays.has(day))
    ? days.join(' & ')
    : value.trim();
}

function parseDisplaySchedule(value: string): DisplaySchedule {
  const cleaned = cleanSisText(value);
  const [meeting = '', roomPart] = cleaned.split(/\s*\|\s*Room:\s*/i, 2);
  const room = roomPart?.trim();
  const match = /^(.*?)\s+(\d{1,2}:\d{2}(?:AM|PM))\s+to\s+(\d{1,2}:\d{2}(?:AM|PM))$/i.exec(meeting);
  if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
    return {
      days: formatDays(match[1]),
      time: `${formatClock(match[2])}–${formatClock(match[3])}`,
      room: room === undefined || room === '' ? null : room,
      fallback: null,
    };
  }
  return {
    days: null,
    time: null,
    room: room === undefined || room === '' ? null : room,
    fallback: meeting.trim() === '' ? null : meeting.trim(),
  };
}

function formatMeetingDates(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (match === null) return cleanSisText(value);
  const [, startDay, startMonthNumber, startYear, endDay, endMonthNumber, endYear] = match;
  if (
    startDay === undefined ||
    startMonthNumber === undefined ||
    startYear === undefined ||
    endDay === undefined ||
    endMonthNumber === undefined ||
    endYear === undefined
  ) {
    return cleanSisText(value);
  }
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const startMonth = months[Number(startMonthNumber) - 1];
  const endMonth = months[Number(endMonthNumber) - 1];
  if (startMonth === undefined || endMonth === undefined) return cleanSisText(value);
  return startYear === endYear
    ? `${String(Number(startDay))} ${startMonth}–${String(Number(endDay))} ${endMonth} ${endYear}`
    : `${String(Number(startDay))} ${startMonth} ${startYear}–${String(Number(endDay))} ${endMonth} ${endYear}`;
}

function formatBaghdadTime(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Baghdad',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(value)
    .replace(/\b(am|pm)\b/i, (period) => period.toUpperCase());
}

export function getStatusBadge(status: string): string {
  switch (status.toUpperCase()) {
    case 'OPEN':
      return '🟢 OPEN';
    case 'CLOSED':
      return '🔴 CLOSED';
    case 'WAITLIST':
      return '🟡 WAITLIST';
    default:
      return '⚪ UNKNOWN';
  }
}

export function formatSectionCard(
  section: MonitoredSection,
  snapshot: SectionSnapshot | null,
): string {
  const statusText = snapshot !== null ? getStatusBadge(snapshot.status) : '⚪ NO OBSERVATIONS YET';
  const seatsText =
    snapshot?.availableSeats !== null && snapshot?.availableSeats !== undefined
      ? `${String(snapshot.availableSeats)} seat(s) available`
      : 'Seats count not exposed';
  const courseCode = escapeMarkdown(section.courseCode, 32);
  const courseTitle = section.courseTitle ? cleanCourseTitle(section.courseTitle) : '';
  const classNumber = escapeMarkdown(section.classNumber, 16);
  const component = section.component ? escapeMarkdown(section.component, 40) : '';
  const term = escapeMarkdown(section.termLabel ?? section.term, 80);

  const lines = [
    `📚 *${courseCode}*`,
    ...(courseTitle ? [`_${courseTitle}_`] : []),
    `\`${classNumber}\`${component ? ` · ${component}` : ''} · ${term}`,
    '',
    `${statusText}  ·  💺 ${seatsText}`,
  ];

  if (snapshot?.schedule) {
    const schedule = parseDisplaySchedule(snapshot.schedule);
    lines.push('');
    if (schedule.days !== null) lines.push(`🗓 ${escapeMarkdown(schedule.days, 100)}`);
    if (schedule.time !== null) lines.push(`🕒 ${escapeMarkdown(schedule.time, 60)}`);
    if (schedule.fallback !== null) lines.push(`🗓 ${escapeMarkdown(schedule.fallback, 160)}`);
    if (schedule.room !== null) lines.push(`📍 ${escapeMarkdown(schedule.room, 100)}`);
  }
  if (snapshot?.meetingDates) {
    lines.push(`📅 ${escapeMarkdown(formatMeetingDates(snapshot.meetingDates), 100)}`);
  }
  if (snapshot?.checkedAt) {
    lines.push(
      '',
      `↻ Checked ${escapeMarkdown(formatBaghdadTime(snapshot.checkedAt), 60)} · Baghdad`,
    );
  }

  return lines.join('\n');
}

export function formatWatchesList(watches: UserSubscriptionDetail[]): string {
  if (watches.length === 0) {
    return '📭 You currently have no active class subscriptions.\n\nUse `/watch <class_id>` or `/watch <course_code>` to start monitoring a class!';
  }

  const lines = [`📋 *Your Active Subscriptions (${String(watches.length)}):*\n`];

  watches.forEach(({ section, latestSnapshot }, index) => {
    const status = latestSnapshot !== null ? getStatusBadge(latestSnapshot.status) : '⚪ PENDING';
    const seats =
      latestSnapshot?.availableSeats !== null && latestSnapshot?.availableSeats !== undefined
        ? `• ${String(latestSnapshot.availableSeats)} seats`
        : '';

    lines.push(
      `${String(index + 1)}. *${section.courseCode}* (ID: \`${section.classNumber}\`${section.component ? `, ${section.component}` : ''})\n   └ ${status} ${seats}`,
    );
  });

  lines.push('\nTo stop watching a section: `/unwatch <class_id>`');

  return lines.join('\n');
}

export function formatChangeAlert(
  section: MonitoredSection,
  previousStatus: string | null | undefined,
  currentStatus: string,
  previousSeats: number | null | undefined,
  currentSeats: number | null | undefined,
): string {
  const isNowOpen = currentStatus.toUpperCase() === 'OPEN';
  const headerEmoji = isNowOpen ? '🚨🎉' : '🔔';

  const lines = [
    `${headerEmoji} *SEAT AVAILABILITY UPDATE!*`,
    `\n📚 *${section.courseCode}* ${section.courseTitle ? `– ${section.courseTitle}` : ''}`,
    `🔢 *Class ID:* \`${section.classNumber}\`${section.component ? ` (${section.component})` : ''}`,
    `🗓 *Term:* ${section.termLabel ?? section.term}`,
    `\n*Status Change:* ${getStatusBadge(previousStatus ?? 'UNKNOWN')} ➔ ${getStatusBadge(currentStatus)}`,
  ];

  if (currentSeats !== null && currentSeats !== undefined) {
    const prevText =
      previousSeats !== null && previousSeats !== undefined ? `${String(previousSeats)} ➔ ` : '';
    lines.push(`*Available Seats:* ${prevText}*${String(currentSeats)}*`);
  }

  lines.push('\n_Log in to your AUIB SIS portal immediately if you wish to register!_');

  return lines.join('\n');
}

export function formatSessionStatus(
  status: 'ACTIVE' | 'EXPIRED' | 'DISABLED' | 'NOT_SET',
  expiresAt?: Date | null,
): string {
  if (status === 'ACTIVE') {
    const expText = expiresAt ? ` (expires ${expiresAt.toUTCString()})` : '';
    return `✅ *AUIB SIS Session Status: Active*${expText}\n\nYour account is authenticated for automated availability checks.`;
  }

  if (status === 'EXPIRED') {
    return `⚠️ *AUIB SIS Session Status: Expired*\n\nYour session credentials have expired. Please update your session using \`/set_session <cookies>\` to resume automated checks.`;
  }

  if (status === 'DISABLED') {
    return `🚫 *AUIB SIS Session Status: Disabled*\n\nYour session has been disabled. Please update your session using \`/set_session <cookies>\` to re-enable checks.`;
  }

  return `ℹ️ *AUIB SIS Session Status: Not Configured*\n\nTo allow the bot to query the SIS on your behalf using your own student session, set your session using \`/set_session <cookies>\`.`;
}

export function formatStartMessage(firstName?: string | null): string {
  const name = firstName ? `, ${escapeMarkdown(firstName, 40)}` : '';
  return `👋 *Welcome${name}!*

Get notified when a seat opens in any AUIB class.

*Get started*
1️⃣ \`/login\` — connect your SIS account
2️⃣ check a class for example: \`/status enl 201\`
 or class number : \`/status 1495\`

3️⃣ \`/watch 1495\` — receive seat alerts

Don’t know the class number? Use \`/browse\` or try \`/status PHA 500\`.

\`/watches\` · \`/help\`

🔒 Read-only — the bot never registers or drops courses.`;
}

export function formatHelpMessage(): string {
  return `📖 *AUIB SIS Monitor – Commands Guide*

• \`/login\`
  Interactive login wizard. Prompts for your AUIB email, password, and 2FA code. Passwords are automatically deleted from chat history immediately for privacy.

• \`/cancel\`
  Aborts an active login process.

• \`/browse\`
  Opens button-based navigation for all requirement groups in your SIS report. Choose a requirement, course, term, and class, then tap Watch.

• \`/watch 1494\`
  Subscribes to class ID \`1494\` and sends you alerts whenever seats or status change.

• \`/watch PHA 500\`
  Shows every scheduled section of \`PHA 500\` so you can choose which class to watch.

• \`/unwatch 1494\` or \`/unwatch PHA 500\`
  Unsubscribes from the specified class ID or course.

• \`/watches\`
  Displays all your active subscriptions along with the latest observed status.

• \`/status 1494\` or \`/status PHA 500\`
  Shows real-time / latest snapshot status without modifying your watch list.

• \`/session\`
  Checks whether your AUIB student session is active.

• \`/set_session <cookies>\`
  Saves your encrypted AUIB SIS session credentials manually. Plaintext credentials are encrypted using AES-256-GCM and never stored in the clear.

⚠️ *Notice:* This bot is strictly read-only and will never perform registration or modify student records.`;
}
