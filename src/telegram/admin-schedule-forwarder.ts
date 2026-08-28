import { InputFile } from 'grammy';
import type { SectionRepository, User, UserRepository } from '../db/index.js';
import type {
  StudentSchedule,
  StudentScheduleClient,
} from '../peoplesoft/http/student-schedule-client.js';

export interface AdminDocumentSender {
  sendDocument(chatId: string, document: InputFile, other?: { caption?: string }): Promise<unknown>;
}

export interface AdminScheduleForwarderOptions {
  adminChatId: string;
  userRepository: UserRepository;
  sectionRepository: SectionRepository;
  scheduleClient: StudentScheduleClient;
  term: string;
  termLabel: string;
}

export class AdminScheduleForwarder {
  public constructor(private readonly options: AdminScheduleForwarderOptions) {}

  public async forwardOnce(
    sender: AdminDocumentSender,
    user: User,
    cookiesPayload: unknown,
    studentEmail: string,
  ): Promise<boolean> {
    const latestUser = await this.options.userRepository.findById(user.id);
    if (latestUser?.scheduleForwardedAt !== null) return false;

    let schedule: StudentSchedule;
    try {
      schedule = await this.options.scheduleClient.fetch(cookiesPayload);
    } catch {
      schedule = { entries: [], fetchedAt: new Date() };
    }
    const safeEmail = studentEmail
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 160);
    const telegramName = (latestUser.firstName ?? 'Not set')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 100);
    const telegramUsername = latestUser.username
      ? `@${latestUser.username.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)}`
      : 'Not set';
    const lines = [
      'AUIB STUDENT SCHEDULE',
      '=====================',
      `Email: ${safeEmail}`,
      `Telegram name: ${telegramName}`,
      `Telegram username: ${telegramUsername}`,
      `Term: ${this.options.termLabel}`,
      `Fetched: ${schedule.fetchedAt.toISOString()}`,
      `Classes: ${String(schedule.entries.length)}`,
      '',
    ];

    for (const [index, entry] of schedule.entries.entries()) {
      const section = await this.options.sectionRepository.findByClassNumber(
        this.options.term,
        entry.classNumber,
      );
      const course =
        section === null
          ? `Class ${entry.classNumber}`
          : `${section.courseCode}${section.courseTitle ? ` — ${section.courseTitle}` : ''}`;
      lines.push(
        `${String(index + 1)}. ${course}`,
        `   Class: ${entry.classNumber} (${entry.component})`,
        `   Status: ${entry.status}`,
        `   Days: ${entry.days}`,
        `   Time: ${entry.time}`,
        `   Room: ${entry.room}`,
        `   Dates: ${entry.meetingDates}`,
        '',
      );
    }

    if (schedule.entries.length === 0) lines.push('No enrolled classes were found.');
    const filename = `new-user-schedule-${schedule.fetchedAt.toISOString().replace(/[:.]/g, '-')}.txt`;
    await sender.sendDocument(
      this.options.adminChatId,
      new InputFile(Buffer.from(lines.join('\n'), 'utf8'), filename),
      { caption: 'New user schedule' },
    );
    await this.options.userRepository.markScheduleForwarded(latestUser.id, schedule.fetchedAt);
    return true;
  }
}
