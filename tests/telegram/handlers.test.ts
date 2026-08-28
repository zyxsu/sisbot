import { describe, expect, it, vi } from 'vitest';
import { handleStart } from '../../src/telegram/handlers/start.js';
import { handleHelp } from '../../src/telegram/handlers/help.js';
import { handleWatch } from '../../src/telegram/handlers/watch.js';
import { handleUnwatch } from '../../src/telegram/handlers/unwatch.js';
import { handleWatches } from '../../src/telegram/handlers/watches.js';
import { handleStatus } from '../../src/telegram/handlers/status.js';
import { handleSession, handleSetSession } from '../../src/telegram/handlers/session.js';
import { authMiddleware } from '../../src/telegram/middleware/auth.js';
import type { SectionState } from '../../src/domain/section-state.js';
import type { BotContext, BotServices } from '../../src/telegram/types.js';

function createMockContext(match = ''): {
  ctx: BotContext;
  replies: { text: string; options?: unknown }[];
  deletedMessages: number[];
} {
  const replies: { text: string; options?: unknown }[] = [];
  const deletedMessages: number[] = [];

  const mockServices: BotServices = {
    config: {
      encryptionKey: 'test-key-32-chars-long-secret-key-1',
      defaultTerm: '2701',
      defaultTermLabel: '2026/2027 Fall',
    },
    repositories: {
      userRepository: {
        upsertTelegramUser: vi.fn().mockResolvedValue({
          id: 'user-1',
          telegramId: BigInt(123456789),
          username: 'teststudent',
          firstName: 'Student',
          isBlocked: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      } as unknown as BotServices['repositories']['userRepository'],
      userMessageRepository: {
        archive: vi.fn().mockResolvedValue(null),
      } as unknown as BotServices['repositories']['userMessageRepository'],
      userSessionRepository: {
        getActiveUserSession: vi.fn().mockResolvedValue(null),
        saveUserSession: vi.fn().mockResolvedValue({
          id: 'sess-1',
          userId: 'user-1',
          status: 'ACTIVE',
          encryptedData: 'v1:iv:tag:cipher',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      } as unknown as BotServices['repositories']['userSessionRepository'],
      sectionRepository: {
        findByClassNumber: vi.fn().mockResolvedValue({
          id: 'sec-1',
          term: '2701',
          termLabel: '2026/2027 Fall',
          courseCode: 'PHA 500',
          courseTitle: 'Pharmacy Practice',
          classNumber: '1494',
          component: 'Lecture',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        findByCourseCode: vi.fn().mockResolvedValue([
          {
            id: 'sec-1',
            term: '2701',
            termLabel: '2026/2027 Fall',
            courseCode: 'PHA 500',
            courseTitle: 'Pharmacy Practice',
            classNumber: '1494',
            component: 'Lecture',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        upsertSection: vi.fn().mockImplementation((state: SectionState) =>
          Promise.resolve({
            id: 'sec-1',
            term: state.term,
            termLabel: state.termLabel ?? null,
            courseCode: state.courseCode,
            courseTitle: state.courseTitle ?? null,
            classNumber: state.classNumber,
            component: state.component ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
        getLatestSnapshot: vi.fn().mockResolvedValue({
          id: 'snap-1',
          sectionId: 'sec-1',
          status: 'CLOSED',
          availableSeats: 0,
          schedule: 'MoWe 10:00AM',
          meetingDates: 'Fall 2026',
          sessionName: 'Regular',
          checkedAt: new Date(),
          createdAt: new Date(),
        }),
        getLatestSnapshotForClassNumber: vi.fn().mockResolvedValue({
          section: {
            id: 'sec-1',
            term: '2701',
            termLabel: '2026/2027 Fall',
            courseCode: 'PHA 500',
            courseTitle: 'Pharmacy Practice',
            classNumber: '1494',
            component: 'Lecture',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          snapshot: {
            id: 'snap-1',
            sectionId: 'sec-1',
            status: 'CLOSED',
            availableSeats: 0,
            schedule: 'MoWe 10:00AM',
            meetingDates: 'Fall 2026',
            sessionName: 'Regular',
            checkedAt: new Date(),
            createdAt: new Date(),
          },
        }),
      } as unknown as BotServices['repositories']['sectionRepository'],
      subscriptionRepository: {
        subscribe: vi.fn().mockResolvedValue({
          id: 'sub-1',
          userId: 'user-1',
          sectionId: 'sec-1',
          isActive: true,
          baselineStatus: 'CLOSED',
          baselineAvailableSeats: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        unsubscribe: vi.fn().mockResolvedValue({
          id: 'sub-1',
          userId: 'user-1',
          sectionId: 'sec-1',
          isActive: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getUserActiveSubscriptions: vi.fn().mockResolvedValue([
          {
            subscription: {
              id: 'sub-1',
              userId: 'user-1',
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
              classNumber: '1494',
              component: 'Lecture',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            latestSnapshot: {
              id: 'snap-1',
              sectionId: 'sec-1',
              status: 'CLOSED',
              availableSeats: 0,
              checkedAt: new Date(),
              createdAt: new Date(),
            },
          },
        ]),
      } as unknown as BotServices['repositories']['subscriptionRepository'],
      notificationLogRepository: {} as BotServices['repositories']['notificationLogRepository'],
    },
  };

  const ctx = {
    match,
    from: {
      id: 123456789,
      username: 'teststudent',
      first_name: 'Student',
    },
    chat: { id: 123456789 },
    message: { message_id: 101 },
    user: {
      id: 'user-1',
      telegramId: BigInt(123456789),
      username: 'teststudent',
      firstName: 'Student',
      isBlocked: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    services: mockServices,
    reply: vi.fn().mockImplementation((text: string, options?: unknown) => {
      replies.push({ text, options });
      return Promise.resolve();
    }),
    api: {
      deleteMessage: vi.fn().mockImplementation((_chatId: number, msgId: number) => {
        deletedMessages.push(msgId);
        return Promise.resolve(true);
      }),
    },
  } as unknown as BotContext;

  return { ctx, replies, deletedMessages };
}

describe('Telegram Command Handlers', () => {
  it('/start sends welcome message and instructions', async () => {
    const { ctx, replies } = createMockContext();
    await handleStart(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('Get notified when a seat opens');
    expect(replies[0]?.text).toContain('Student');
  });

  it('/help sends command help list', async () => {
    const { ctx, replies } = createMockContext();
    await handleHelp(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('/watch 1494');
    expect(replies[0]?.text).toContain('/status 1494');
  });

  it('/watch requires an argument if empty', async () => {
    const { ctx, replies } = createMockContext('');
    await handleWatch(ctx);

    expect(replies[0]?.text).toContain('Please specify a Class ID or Course Code');
  });

  it('/watch 1494 subscribes user by class number and returns card', async () => {
    const { ctx, replies } = createMockContext('1494');
    await handleWatch(ctx);

    expect(replies[0]?.text).toContain('Subscribed to class ID `1494`');
    expect(replies[0]?.text).toContain('PHA 500');
    expect(replies[0]?.text).toContain('🔴 CLOSED');
  });

  it('/watch PHA 500 asks the user to choose a section', async () => {
    const { ctx, replies } = createMockContext('PHA 500');
    await handleWatch(ctx);

    expect(replies[0]?.text).toContain('choose the section you want to watch');
  });

  it('/unwatch 1494 unsubscribes user', async () => {
    const { ctx, replies } = createMockContext('1494');
    await handleUnwatch(ctx);

    expect(replies[0]?.text).toContain('Unsubscribed from class ID `1494`');
  });

  it('/watches lists active subscriptions', async () => {
    const { ctx, replies } = createMockContext();
    await handleWatches(ctx);

    expect(replies[0]?.text).toContain('Your Active Subscriptions (1)');
    expect(replies[0]?.text).toContain('PHA 500');
    expect(replies[0]?.text).toContain('1494');
  });

  it('/status 1494 shows current status card without subscribing', async () => {
    const { ctx, replies } = createMockContext('1494');
    await handleStatus(ctx);

    expect(replies[0]?.text).toContain('PHA 500');
    expect(replies[0]?.text).toContain('🔴 CLOSED');
  });

  it('/session shows status when not set', async () => {
    const { ctx, replies } = createMockContext();
    await handleSession(ctx);

    expect(replies[0]?.text).toContain('Session Status: Not Configured');
  });

  it('/set_session encrypts payload and deletes original message', async () => {
    const { ctx, replies, deletedMessages } = createMockContext(
      'JSESSIONID=secret123; PS_TOKEN=abc',
    );
    await handleSetSession(ctx);

    expect(deletedMessages).toContain(101);
    expect(replies[0]?.text).toContain('AUIB SIS Session Saved & Encrypted');
  });

  describe('authMiddleware', () => {
    it('allows unblocked users to proceed and attaches user', async () => {
      const { ctx } = createMockContext();
      const next = vi.fn().mockResolvedValue(undefined);

      await authMiddleware(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(ctx.user.isBlocked).toBe(false);
    });

    it('blocks users marked isBlocked = true', async () => {
      const { ctx, replies } = createMockContext();
      ctx.services.repositories.userRepository.upsertTelegramUser = vi.fn().mockResolvedValue({
        id: 'user-blocked',
        telegramId: BigInt(123456789),
        username: 'baduser',
        firstName: 'Bad',
        isBlocked: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const next = vi.fn().mockResolvedValue(undefined);

      await authMiddleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
      expect(replies[0]?.text).toContain('Your account has been restricted');
    });
  });
});
