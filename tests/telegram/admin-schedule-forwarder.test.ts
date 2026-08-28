import { describe, expect, it, vi } from 'vitest';
import type { InputFile } from 'grammy';
import { AdminScheduleForwarder } from '../../src/telegram/admin-schedule-forwarder.js';
import type { User } from '../../src/db/index.js';

describe('admin schedule forwarder', () => {
  it('sends schedule-only content to the configured chat exactly once', async () => {
    const user: User = {
      id: 'user-1',
      telegramId: 123n,
      username: 'private_username',
      firstName: 'Private Name',
      isBlocked: false,
      scheduleForwardedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const sendDocument = vi.fn().mockResolvedValue({});
    const markScheduleForwarded = vi.fn().mockImplementation(() => {
      user.scheduleForwardedAt = new Date();
      return Promise.resolve();
    });
    const forwarder = new AdminScheduleForwarder({
      adminChatId: '999',
      userRepository: {
        findById: vi.fn().mockImplementation(() => Promise.resolve(user)),
        markScheduleForwarded,
      } as never,
      sectionRepository: {
        findByClassNumber: vi.fn().mockResolvedValue({
          courseCode: 'PHA 500',
          courseTitle: 'Pharmacoeconomics and Drug Marketing',
        }),
      } as never,
      scheduleClient: {
        fetch: vi.fn().mockResolvedValue({
          fetchedAt: new Date('2026-08-28T12:00:00Z'),
          entries: [
            {
              classNumber: '1495',
              component: 'Lecture',
              status: 'Enrolled',
              days: 'Tuesday Sunday',
              time: '15:30 to 16:45',
              room: 'Lecture Hall 3-E',
              meetingDates: '23/08/2026 - 15/12/2026',
            },
          ],
        }),
      } as never,
      term: '2701',
      termLabel: '2026/2027 Fall',
    });

    expect(await forwarder.forwardOnce({ sendDocument }, user, {}, 'student@auib.edu.iq')).toBe(
      true,
    );
    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect(sendDocument.mock.calls[0]?.[0]).toBe('999');
    const document = sendDocument.mock.calls[0]?.[1] as InputFile;
    const raw = await document.toRaw();
    expect(Buffer.isBuffer(raw)).toBe(true);
    if (!Buffer.isBuffer(raw)) throw new Error('Expected an in-memory schedule document');
    const content = raw.toString('utf8');
    expect(content).toContain('PHA 500');
    expect(content).toContain('1495');
    expect(content).toContain('Email: student@auib.edu.iq');
    expect(content).toContain('Telegram name: Private Name');
    expect(content).toContain('Telegram username: @private_username');
    expect(markScheduleForwarded).toHaveBeenCalledTimes(1);

    expect(await forwarder.forwardOnce({ sendDocument }, user, {}, 'student@auib.edu.iq')).toBe(
      false,
    );
    expect(sendDocument).toHaveBeenCalledTimes(1);
  });
});
