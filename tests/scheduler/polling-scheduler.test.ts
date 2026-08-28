import { describe, expect, it, vi } from 'vitest';
import type { SectionState } from '../../src/domain/section-state.js';
import { PeopleSoftSessionExpiredError } from '../../src/peoplesoft/http/index.js';
import type {
  BotMessageSender,
  PollingSchedulerRepositories,
} from '../../src/scheduler/polling-scheduler.js';
import { PollingScheduler } from '../../src/scheduler/polling-scheduler.js';
import type { AuibAuthenticator } from '../../src/auth/types.js';

describe('PollingScheduler', () => {
  const encryptionKey = 'test-encryption-key-for-scheduler-32';

  function createMockScheduler(options?: {
    usersWithSubs?: string[];
    userSessionActive?: boolean;
    sessionData?: Record<string, unknown>;
    authenticator?: AuibAuthenticator;
    watchedItems?: {
      section: { id: string; term: string; courseCode: string; termLabel?: string };
    }[];
    subscribers?: { user: { id: string; telegramId: bigint } }[];
    checkedSections?: SectionState[];
    checkError?: Error;
  }) {
    const sentMessages: { chatId: number | string | bigint; text: string }[] = [];
    const recordedSnapshots: { sectionId: string; state: SectionState }[] = [];
    const recordedNotifications: { userId: string; sectionId: string; fingerprint: string }[] = [];
    const sentFingerprints = new Set<string>();

    let latestSnapshot: {
      status: string;
      availableSeats: number | null;
      checkedAt: Date;
    } | null = null;

    const mockRepositories: PollingSchedulerRepositories = {
      subscriptionRepository: {
        getActiveUserIdsWithSubscriptions: vi
          .fn()
          .mockResolvedValue(options?.usersWithSubs ?? ['user-1']),
        getSubscriptionsForUserPolling: vi.fn().mockResolvedValue(
          options?.watchedItems ?? [
            {
              section: {
                id: 'sec-1',
                term: '2701',
                termLabel: '2026/2027 Fall',
                courseCode: 'PHA 500',
              },
            },
          ],
        ),
        getActiveSubscribersForSection: vi.fn().mockResolvedValue(
          options?.subscribers ?? [
            {
              user: { id: 'user-1', telegramId: BigInt(123456789) },
            },
          ],
        ),
        getActiveSubscribersForSectionOrCourse: vi.fn().mockResolvedValue(
          options?.subscribers ?? [
            {
              user: { id: 'user-1', telegramId: BigInt(123456789) },
            },
          ],
        ),
      } as unknown as PollingSchedulerRepositories['subscriptionRepository'],

      userSessionRepository: {
        getActiveUserSession: vi.fn().mockImplementation((userId: string) => {
          if (options?.userSessionActive === false) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            id: 'sess-1',
            userId,
            status: 'ACTIVE',
            sessionData: options?.sessionData ?? { cookies: 'test-cookie' },
            lastUsedAt: null,
            expiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }),
        markExpired: vi.fn().mockResolvedValue(undefined),
        saveUserSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as PollingSchedulerRepositories['userSessionRepository'],

      sectionRepository: {
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
        getLatestSnapshot: vi.fn().mockImplementation(() => Promise.resolve(latestSnapshot)),
        recordSnapshot: vi.fn().mockImplementation((sectionId: string, state: SectionState) => {
          recordedSnapshots.push({ sectionId, state });
          latestSnapshot = {
            status: state.status,
            availableSeats: state.availableSeats,
            checkedAt: state.checkedAt,
          };
          return Promise.resolve({
            id: 'snap-1',
            sectionId,
            status: state.status,
            availableSeats: state.availableSeats,
            schedule: state.schedule ?? null,
            meetingDates: state.meetingDates ?? null,
            sessionName: state.sessionName ?? null,
            checkedAt: state.checkedAt,
            createdAt: new Date(),
          });
        }),
      } as unknown as PollingSchedulerRepositories['sectionRepository'],

      notificationLogRepository: {
        hasNotificationBeenSent: vi
          .fn()
          .mockImplementation((userId: string, fp: string) =>
            Promise.resolve(sentFingerprints.has(`${userId}:${fp}`)),
          ),
        recordNotificationSent: vi
          .fn()
          .mockImplementation((userId: string, sectionId: string, fp: string) => {
            sentFingerprints.add(`${userId}:${fp}`);
            recordedNotifications.push({ userId, sectionId, fingerprint: fp });
            return Promise.resolve({
              id: 'notif-1',
              userId,
              sectionId,
              fingerprint: fp,
              sentAt: new Date(),
              details: null,
            });
          }),
      } as unknown as PollingSchedulerRepositories['notificationLogRepository'],

      userRepository: {
        findById: vi.fn().mockResolvedValue({
          id: 'user-1',
          telegramId: BigInt(123456789),
          isBlocked: false,
        }),
      } as unknown as PollingSchedulerRepositories['userRepository'],
    };

    const mockBotApi: BotMessageSender = {
      sendMessage: vi.fn().mockImplementation((chatId: number | string | bigint, text: string) => {
        sentMessages.push({ chatId, text });
        return Promise.resolve({ message_id: 999 });
      }),
    };

    const checkedSections = options?.checkedSections ?? [
      {
        term: '2701',
        termLabel: '2026/2027 Fall',
        courseCode: 'PHA 500',
        classNumber: '1494',
        component: 'Lecture',
        status: 'OPEN' as const,
        availableSeats: 5,
        checkedAt: new Date(),
      },
    ];
    const mockSectionChecker = {
      checkCourseSections: vi.fn().mockResolvedValue(checkedSections),
      checkCoursesSequentially: vi
        .fn()
        .mockImplementation(
          (request: { targets: { courseCode: string; classNumber?: string; term: string }[] }) => {
            if (options?.checkError !== undefined) {
              return Promise.reject(options.checkError);
            }

            return Promise.resolve(
              request.targets.map((target) => ({
                target,
                sections: checkedSections.filter(
                  (section) =>
                    section.courseCode === target.courseCode &&
                    (target.classNumber === undefined ||
                      section.classNumber === target.classNumber),
                ),
              })),
            );
          },
        ),
    };

    const scheduler = new PollingScheduler({
      repositories: mockRepositories,
      botApi: mockBotApi,
      sectionChecker: mockSectionChecker,
      ...(options?.authenticator !== undefined ? { authenticator: options.authenticator } : {}),
      config: {
        pollIntervalSeconds: 300,
        pollJitterSeconds: 0,
        minRequestDelayMs: 0,
        encryptionKey,
        defaultTerm: '2701',
        defaultTermLabel: '2026/2027 Fall',
      },
    });

    return {
      scheduler,
      mockRepositories,
      mockBotApi,
      mockSectionChecker,
      sentMessages,
      recordedSnapshots,
      recordedNotifications,
      setLatestSnapshot: (snap: typeof latestSnapshot) => {
        latestSnapshot = snap;
      },
    };
  }

  it('initializes in stopped state and manages start/stop lifecycle', () => {
    const { scheduler } = createMockScheduler();
    expect(scheduler.getStatus().isRunning).toBe(false);

    scheduler.start();
    expect(scheduler.getStatus().isRunning).toBe(true);

    scheduler.stop();
    expect(scheduler.getStatus().isRunning).toBe(false);
  });

  it('runs cycle and records baseline snapshot without sending alert on first observation', async () => {
    const { scheduler, recordedSnapshots, sentMessages } = createMockScheduler();

    await scheduler.runCycle();

    expect(recordedSnapshots).toHaveLength(1);
    expect(recordedSnapshots[0]?.state.classNumber).toBe('1494');
    expect(recordedSnapshots[0]?.state.status).toBe('OPEN');
    // First observation establishes baseline, so no alert is dispatched
    expect(sentMessages).toHaveLength(0);
  });

  it('detects status change from CLOSED to OPEN and dispatches Telegram alert', async () => {
    const { scheduler, sentMessages, recordedNotifications, setLatestSnapshot } =
      createMockScheduler();

    // Establish previous state as CLOSED with 0 seats
    setLatestSnapshot({
      status: 'CLOSED',
      availableSeats: 0,
      checkedAt: new Date('2026-08-26T10:00:00Z'),
    });

    // Run cycle where section becomes OPEN with 5 seats
    await scheduler.runCycle();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.text).toContain('SEAT AVAILABILITY UPDATE!');
    expect(sentMessages[0]?.text).toContain('PHA 500');
    expect(sentMessages[0]?.text).toContain('🔴 CLOSED ➔ 🟢 OPEN');
    expect(sentMessages[0]?.text).toContain('0 ➔ *5*');

    expect(recordedNotifications).toHaveLength(1);
    expect(recordedNotifications[0]?.userId).toBe('user-1');
  });

  it('does not send duplicate alert on subsequent cycle with identical state (idempotency)', async () => {
    const { scheduler, sentMessages, setLatestSnapshot } = createMockScheduler();

    setLatestSnapshot({
      status: 'CLOSED',
      availableSeats: 0,
      checkedAt: new Date('2026-08-26T10:00:00Z'),
    });

    // First cycle sends alert
    await scheduler.runCycle();
    expect(sentMessages).toHaveLength(1);

    // Second cycle with same state should NOT send a duplicate
    await scheduler.runCycle();
    expect(sentMessages).toHaveLength(1);
  });

  it('skips users without active session and does not crash', async () => {
    const { scheduler, mockSectionChecker } = createMockScheduler({
      userSessionActive: false,
    });

    await scheduler.runCycle();
    expect(mockSectionChecker.checkCourseSections).not.toHaveBeenCalled();
  });

  it('persists a live session expiration and tells the user to log in again', async () => {
    const { scheduler, mockRepositories, sentMessages } = createMockScheduler({
      checkError: new PeopleSoftSessionExpiredError(),
    });

    await scheduler.runCycle();

    // Repository methods are intentionally mocked as standalone Vitest functions here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRepositories.userSessionRepository.markExpired).toHaveBeenCalledWith('sess-1');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.text).toContain('/login');
  });

  it('silently auto-refreshes session via Microsoft KMSI storageState without notifying user', async () => {
    const mockRefreshSession = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      cookies: 'refreshed-cookie=xyz',
      storageState: { cookies: [{ name: 'ESTSAUTHPERSISTENT', value: 'secret' }] },
    });

    const mockAuthenticator: AuibAuthenticator = {
      startLogin: vi.fn(),
      submit2Fa: vi.fn(),
      refreshSession: mockRefreshSession,
    };

    const { scheduler, mockRepositories, sentMessages } = createMockScheduler({
      checkError: new PeopleSoftSessionExpiredError(),
      sessionData: {
        rawCookies: 'old-cookie',
        storageState: { cookies: [{ name: 'ESTSAUTHPERSISTENT', value: 'secret' }] },
      },
      authenticator: mockAuthenticator,
    });

    await scheduler.runCycle();

    expect(mockRefreshSession).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRepositories.userSessionRepository.saveUserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionData: expect.objectContaining({
          rawCookies: 'refreshed-cookie=xyz',
        }),
      }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRepositories.userSessionRepository.markExpired).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
  });
});
