import { logger } from '../config/logger.js';
import { detectSectionChange } from '../domain/section-change.js';
import type { SectionState, SectionStatus } from '../domain/section-state.js';
import {
  NotificationLogRepository,
  type MonitoredSection,
  type SectionRepository,
  type SectionSnapshot,
  type SubscriptionRepository,
  type UserRepository,
  type UserSessionRepository,
} from '../db/index.js';
import { MonitoringSession } from '../peoplesoft/session.js';
import {
  PeopleSoftAvailabilityClient,
  PeopleSoftSessionExpiredError,
} from '../peoplesoft/http/index.js';
import type { SectionChecker } from '../peoplesoft/workflow/check-course-sections.js';
import { redactSecrets } from '../security/redact.js';
import { formatChangeAlert } from '../telegram/formatters.js';
import type { AuibAuthenticator } from '../auth/types.js';

export interface BotMessageSender {
  sendMessage(
    chatId: number | string | bigint,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface PollingSchedulerConfig {
  pollIntervalSeconds: number;
  pollJitterSeconds: number;
  minRequestDelayMs: number;
  encryptionKey: string;
  defaultTerm: string;
  defaultTermLabel?: string;
}

export interface PollingSchedulerRepositories {
  userRepository: UserRepository;
  userSessionRepository: UserSessionRepository;
  sectionRepository: SectionRepository;
  subscriptionRepository: SubscriptionRepository;
  notificationLogRepository: NotificationLogRepository;
}

export interface PollingSchedulerOptions {
  repositories: PollingSchedulerRepositories;
  botApi: BotMessageSender;
  sectionChecker: SectionChecker;
  authenticator?: AuibAuthenticator;
  availabilityClient?: PeopleSoftAvailabilityClient;
  config: PollingSchedulerConfig;
}

export class PollingScheduler {
  private readonly repositories: PollingSchedulerRepositories;
  private readonly botApi: BotMessageSender;
  private readonly sectionChecker: SectionChecker;
  private readonly authenticator: AuibAuthenticator | undefined;
  private readonly availabilityClient: PeopleSoftAvailabilityClient | undefined;
  private readonly config: PollingSchedulerConfig;

  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private isCycleInProgress = false;

  public constructor(options: PollingSchedulerOptions) {
    this.repositories = options.repositories;
    this.botApi = options.botApi;
    this.sectionChecker = options.sectionChecker;
    this.authenticator = options.authenticator;
    this.availabilityClient = options.availabilityClient;
    this.config = options.config;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    logger.info(
      {
        intervalSeconds: this.config.pollIntervalSeconds,
        jitterSeconds: this.config.pollJitterSeconds,
      },
      'Starting section polling scheduler',
    );

    this.scheduleNextRun(0);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Stopped section polling scheduler');
  }

  public getStatus(): { isRunning: boolean; isCycleInProgress: boolean } {
    return {
      isRunning: this.isRunning,
      isCycleInProgress: this.isCycleInProgress,
    };
  }

  private scheduleNextRun(delayMs?: number): void {
    if (!this.isRunning) {
      return;
    }

    let timeoutMs: number;
    if (delayMs !== undefined) {
      timeoutMs = delayMs;
    } else {
      const baseMs = this.config.pollIntervalSeconds * 1000;
      const jitterMs = Math.floor(Math.random() * (this.config.pollJitterSeconds * 1000));
      timeoutMs = baseMs + jitterMs;
    }

    this.timer = setTimeout(() => {
      void (async () => {
        try {
          await this.runCycle();
        } catch (error) {
          logger.error({ err: redactSecrets(error) }, 'Unhandled error in polling cycle');
        } finally {
          this.scheduleNextRun();
        }
      })();
    }, timeoutMs);
  }

  /**
   * Executes a complete polling cycle across all active users with subscriptions.
   */
  public async runCycle(): Promise<void> {
    if (this.isCycleInProgress) {
      logger.warn('Skipping polling cycle because previous cycle is still in progress');
      return;
    }

    this.isCycleInProgress = true;
    logger.info('Beginning section polling cycle');

    try {
      const activeUserIds =
        await this.repositories.subscriptionRepository.getActiveUserIdsWithSubscriptions();

      if (activeUserIds.length === 0) {
        logger.info('No active subscriptions found for this cycle');
        return;
      }

      logger.info({ userCount: activeUserIds.length }, 'Polling subscriptions for active users');

      for (const userId of activeUserIds) {
        try {
          await this.checkUserSubscriptions(userId);
        } catch (userError) {
          logger.error(
            { userId, err: redactSecrets(userError) },
            'Failed checking subscriptions for user',
          );
        }

        // Apply delay between user batches if configured
        if (this.config.minRequestDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.config.minRequestDelayMs));
        }
      }
    } finally {
      this.isCycleInProgress = false;
      logger.info('Finished section polling cycle');
    }
  }

  /**
   * Handles PeopleSoftSessionExpiredError with silent KMSI refresh or notification.
   */
  private async handleSessionExpired(
    userId: string,
    userSession: { id: string; sessionData: unknown },
  ): Promise<boolean> {
    const sessionDataObj =
      typeof userSession.sessionData === 'object' && userSession.sessionData !== null
        ? (userSession.sessionData as Record<string, unknown>)
        : null;
    const savedStorageState = sessionDataObj?.storageState;

    if (this.authenticator?.refreshSession !== undefined && savedStorageState !== undefined) {
      logger.info(
        { userId },
        'PeopleSoft session expired; attempting silent auto-refresh via Microsoft KMSI',
      );
      try {
        const refreshed = await this.authenticator.refreshSession(savedStorageState);
        if (refreshed !== null && refreshed.cookies.length > 0) {
          await this.repositories.userSessionRepository.saveUserSession({
            userId,
            sessionData: {
              rawCookies: refreshed.cookies,
              ...(refreshed.storageState !== undefined
                ? { storageState: refreshed.storageState }
                : { storageState: savedStorageState }),
              ...(sessionDataObj?.rawSession !== undefined
                ? { rawSession: sessionDataObj.rawSession }
                : {}),
            },
            encryptionKey: this.config.encryptionKey,
            ...(refreshed.expiresAt !== undefined ? { expiresAt: refreshed.expiresAt } : {}),
          });
          logger.info(
            { userId },
            'Successfully auto-refreshed student session silently; /watch monitoring will continue uninterrupted',
          );
          return true;
        }
      } catch (refreshErr) {
        logger.warn({ userId, err: redactSecrets(refreshErr) }, 'Silent auto-refresh failed');
      }
    }

    await this.repositories.userSessionRepository.markExpired(userSession.id);
    const user = await this.repositories.userRepository.findById(userId);

    if (user !== null && !user.isBlocked) {
      await this.botApi
        .sendMessage(
          user.telegramId.toString(),
          '⚠️ *Your AUIB SIS session expired.*\n\nUse `/login` to authenticate again. Monitoring will resume automatically after login.',
          { parse_mode: 'Markdown' },
        )
        .catch((notificationError: unknown) => {
          logger.warn(
            { userId, err: redactSecrets(notificationError) },
            'Could not deliver the session-expired notice',
          );
        });
    }

    logger.warn({ userId }, 'Stored AUIB session marked expired; polling paused for user');
    return false;
  }

  /**
   * Checks all watched courses for a single user using that user's own AUIB session.
   */
  private async checkUserSubscriptions(userId: string): Promise<void> {
    const userSession = await this.repositories.userSessionRepository.getActiveUserSession(
      userId,
      this.config.encryptionKey,
    );

    if (userSession === null) {
      logger.warn({ userId }, 'User has subscriptions but no active AUIB session; skipping checks');
      return;
    }

    const watchedItems =
      await this.repositories.subscriptionRepository.getSubscriptionsForUserPolling(userId);

    if (watchedItems.length === 0) {
      return;
    }

    // Partition watched items into fast direct HTTP checks (if crseId is available) and browser fallbacks
    const httpCourses = new Map<
      string,
      {
        section: MonitoredSection;
        classNumbers: Set<string>;
      }
    >();
    const fallbackItems: typeof watchedItems = [];

    if (this.availabilityClient !== undefined) {
      for (const item of watchedItems) {
        if (item.section.crseId !== null && item.section.crseId.trim().length > 0) {
          const key = `${item.section.term}:${item.section.crseId}`;
          const existing = httpCourses.get(key);
          const hasSpecificClass =
            item.section.classNumber !== null &&
            item.section.classNumber !== '' &&
            item.section.classNumber !== 'PENDING';

          if (existing !== undefined) {
            if (hasSpecificClass) {
              existing.classNumbers.add(item.section.classNumber);
            }
          } else {
            httpCourses.set(key, {
              section: item.section,
              classNumbers: new Set(hasSpecificClass ? [item.section.classNumber] : []),
            });
          }
        } else {
          fallbackItems.push(item);
        }
      }
    } else {
      fallbackItems.push(...watchedItems);
    }

    let sessionPayload = userSession.sessionData;

    // 1. Direct HTTP Course Polling
    if (httpCourses.size > 0 && this.availabilityClient !== undefined) {
      for (const group of httpCourses.values()) {
        try {
          const results = await this.availabilityClient.checkCourse({
            cookiesPayload: sessionPayload,
            crseId: group.section.crseId!,
            crseOfferNbr: group.section.crseOfferNbr ?? '1',
            term: group.section.term,
            acadCareer: group.section.acadCareer ?? 'UGRD',
            institution: group.section.institution ?? 'AUIB',
          });

          const observedStates: SectionState[] = [];
          for (const res of results) {
            if (group.classNumbers.size > 0 && !group.classNumbers.has(res.classNumber)) {
              continue;
            }

            const status: SectionStatus =
              res.status.toUpperCase() === 'OPEN'
                ? 'OPEN'
                : res.status.toUpperCase() === 'CLOSED'
                  ? 'CLOSED'
                  : res.status.toUpperCase() === 'WAITLIST'
                    ? 'WAITLIST'
                    : 'UNKNOWN';

            const courseTitle = (res.description || group.section.courseTitle) ?? undefined;
            const component = (res.component || group.section.component) ?? undefined;

            observedStates.push({
              term: group.section.term,
              ...(group.section.termLabel !== null ? { termLabel: group.section.termLabel } : {}),
              courseCode: res.courseCode || group.section.courseCode,
              ...(courseTitle !== undefined ? { courseTitle } : {}),
              ...(group.section.crseId !== null && group.section.crseId !== undefined
                ? { crseId: group.section.crseId }
                : {}),
              ...(group.section.crseOfferNbr !== null && group.section.crseOfferNbr !== undefined
                ? { crseOfferNbr: group.section.crseOfferNbr }
                : {}),
              ...(group.section.acadCareer !== null && group.section.acadCareer !== undefined
                ? { acadCareer: group.section.acadCareer }
                : {}),
              ...(group.section.institution !== null && group.section.institution !== undefined
                ? { institution: group.section.institution }
                : {}),
              classNumber: res.classNumber,
              ...(component !== undefined ? { component } : {}),
              status,
              availableSeats: res.availableSeats,
              ...(res.schedule ? { schedule: res.schedule } : {}),
              ...(res.meetingDates ? { meetingDates: res.meetingDates } : {}),
              ...(res.sessionName ? { sessionName: res.sessionName } : {}),
              checkedAt: new Date(),
            });
          }

          if (observedStates.length > 0) {
            await this.processObservedSections(observedStates);
          }
          await this.repositories.userSessionRepository.updateLastUsed(userSession.id);
        } catch (checkError) {
          if (checkError instanceof PeopleSoftSessionExpiredError) {
            const refreshed = await this.handleSessionExpired(userId, userSession);
            if (refreshed) {
              const updatedSession =
                await this.repositories.userSessionRepository.getActiveUserSession(
                  userId,
                  this.config.encryptionKey,
                );
              if (updatedSession !== null) {
                sessionPayload = updatedSession.sessionData;
                try {
                  const retryResults = await this.availabilityClient.checkCourse({
                    cookiesPayload: sessionPayload,
                    crseId: group.section.crseId!,
                    crseOfferNbr: group.section.crseOfferNbr ?? '1',
                    term: group.section.term,
                    acadCareer: group.section.acadCareer ?? 'UGRD',
                    institution: group.section.institution ?? 'AUIB',
                  });

                  const observedStates: SectionState[] = [];
                  for (const res of retryResults) {
                    if (group.classNumbers.size > 0 && !group.classNumbers.has(res.classNumber)) {
                      continue;
                    }
                    const status: SectionStatus =
                      res.status.toUpperCase() === 'OPEN'
                        ? 'OPEN'
                        : res.status.toUpperCase() === 'CLOSED'
                          ? 'CLOSED'
                          : res.status.toUpperCase() === 'WAITLIST'
                            ? 'WAITLIST'
                            : 'UNKNOWN';

                    const courseTitle = (res.description || group.section.courseTitle) ?? undefined;
                    const component = (res.component || group.section.component) ?? undefined;

                    observedStates.push({
                      term: group.section.term,
                      ...(group.section.termLabel !== null
                        ? { termLabel: group.section.termLabel }
                        : {}),
                      courseCode: res.courseCode || group.section.courseCode,
                      ...(courseTitle !== undefined ? { courseTitle } : {}),
                      ...(group.section.crseId !== null && group.section.crseId !== undefined
                        ? { crseId: group.section.crseId }
                        : {}),
                      ...(group.section.crseOfferNbr !== null && group.section.crseOfferNbr !== undefined
                        ? { crseOfferNbr: group.section.crseOfferNbr }
                        : {}),
                      ...(group.section.acadCareer !== null && group.section.acadCareer !== undefined
                        ? { acadCareer: group.section.acadCareer }
                        : {}),
                      ...(group.section.institution !== null && group.section.institution !== undefined
                        ? { institution: group.section.institution }
                        : {}),
                      classNumber: res.classNumber,
                      ...(component !== undefined ? { component } : {}),
                      status,
                      availableSeats: res.availableSeats,
                      ...(res.schedule ? { schedule: res.schedule } : {}),
                      ...(res.meetingDates ? { meetingDates: res.meetingDates } : {}),
                      ...(res.sessionName ? { sessionName: res.sessionName } : {}),
                      checkedAt: new Date(),
                    });
                  }
                  if (observedStates.length > 0) {
                    await this.processObservedSections(observedStates);
                  }
                  await this.repositories.userSessionRepository.updateLastUsed(userSession.id);
                } catch (retryErr) {
                  logger.warn(
                    { userId, crseId: group.section.crseId, err: redactSecrets(retryErr) },
                    'Failed retry course availability check after silent session refresh',
                  );
                }
              }
            } else {
              return;
            }
          } else {
            logger.warn(
              { userId, crseId: group.section.crseId, err: redactSecrets(checkError) },
              'Direct HTTP check failed for course; will fallback if needed',
            );
            fallbackItems.push(
              ...watchedItems.filter(
                (item) =>
                  item.section.term === group.section.term &&
                  item.section.crseId === group.section.crseId,
              ),
            );
          }
        }
      }
    }

    // 2. Process Fallback items via browser SectionChecker
    if (fallbackItems.length > 0) {
      const courseTargets = new Map<
        string,
        { term: string; termLabel?: string; courseCode: string; classNumber?: string }
      >();

      for (const item of fallbackItems) {
        const term = item.section.term;
        const courseCode = item.section.courseCode;
        const classNumber = item.section.classNumber;

        const key = `${term}:${courseCode}:${classNumber}`;
        if (!courseTargets.has(key)) {
          courseTargets.set(key, {
            term,
            ...(item.section.termLabel !== null ? { termLabel: item.section.termLabel } : {}),
            courseCode,
            ...(classNumber && classNumber !== 'PENDING' ? { classNumber } : {}),
          });
        }
      }

      const rawCookies =
        typeof sessionPayload === 'object' &&
        sessionPayload !== null &&
        'rawCookies' in sessionPayload
          ? String((sessionPayload as Record<string, unknown>).rawCookies)
          : userSession.id;

      const monitoringSession = new MonitoringSession({
        id: rawCookies,
        owner: { type: 'TELEGRAM_USER', id: userId },
      });

      const targets = [...courseTargets.values()];

      try {
        const results = await this.sectionChecker.checkCoursesSequentially({
          session: monitoringSession,
          targets,
          checkedAt: new Date(),
        });

        for (const result of results) {
          await this.processObservedSections(result.sections);
        }
        await this.repositories.userSessionRepository.updateLastUsed(userSession.id);
      } catch (checkError) {
        if (checkError instanceof PeopleSoftSessionExpiredError) {
          await this.handleSessionExpired(userId, userSession);
          return;
        }

        logger.error(
          { userId, targetCount: targets.length, err: redactSecrets(checkError) },
          'Error checking fallback course sections for user',
        );
      }
    }
  }

  /**
   * Processes parsed section states, records snapshots, detects transitions, and dispatches alerts.
   */
  public async processObservedSections(sections: SectionState[]): Promise<void> {
    for (const state of sections) {
      const section = await this.repositories.sectionRepository.upsertSection(state);
      const previousSnapshot = await this.repositories.sectionRepository.getLatestSnapshot(
        section.id,
      );

      const previousState: SectionState | null =
        previousSnapshot !== null
          ? {
              term: section.term,
              ...(section.termLabel !== null ? { termLabel: section.termLabel } : {}),
              courseCode: section.courseCode,
              ...(section.courseTitle !== null ? { courseTitle: section.courseTitle } : {}),
              classNumber: section.classNumber,
              ...(section.component !== null ? { component: section.component } : {}),
              status: previousSnapshot.status as SectionStatus,
              availableSeats: previousSnapshot.availableSeats,
              checkedAt: previousSnapshot.checkedAt,
            }
          : null;

      // Detect change against baseline/previous
      const change = detectSectionChange(previousState, state);

      // Record new snapshot
      await this.repositories.sectionRepository.recordSnapshot(section.id, state);

      if (change !== null) {
        logger.info(
          {
            sectionId: section.id,
            classNumber: section.classNumber,
            fromStatus: previousSnapshot?.status,
            toStatus: state.status,
            fromSeats: previousSnapshot?.availableSeats,
            toSeats: state.availableSeats,
          },
          'Section state change detected; dispatching alerts',
        );

        await this.dispatchSectionChangeAlerts(section, previousSnapshot, state);
      }
    }
  }

  /**
   * Dispatches alerts to all subscribed users for a changed section.
   */
  private async dispatchSectionChangeAlerts(
    section: MonitoredSection,
    previousSnapshot: SectionSnapshot | null,
    currentState: SectionState,
  ): Promise<void> {
    const subscribers =
      await this.repositories.subscriptionRepository.getActiveSubscribersForSectionOrCourse(
        section,
      );

    if (subscribers.length === 0) {
      return;
    }

    const transition = {
      fromStatus: previousSnapshot?.status ?? null,
      toStatus: currentState.status,
      fromSeats: previousSnapshot?.availableSeats ?? null,
      toSeats: currentState.availableSeats,
    };

    const message = formatChangeAlert(
      section,
      previousSnapshot?.status,
      currentState.status,
      previousSnapshot?.availableSeats,
      currentState.availableSeats,
    );

    for (const { user } of subscribers) {
      const fingerprint = NotificationLogRepository.buildFingerprint(
        user.id,
        section.id,
        transition,
      );

      const alreadySent = await this.repositories.notificationLogRepository.hasNotificationBeenSent(
        user.id,
        fingerprint,
      );

      if (alreadySent) {
        continue;
      }

      try {
        await this.botApi.sendMessage(user.telegramId.toString(), message, {
          parse_mode: 'Markdown',
        });

        await this.repositories.notificationLogRepository.recordNotificationSent(
          user.id,
          section.id,
          fingerprint,
          {
            classNumber: section.classNumber,
            courseCode: section.courseCode,
            transition,
          },
        );

        logger.info(
          { userId: user.id, telegramId: user.telegramId.toString(), sectionId: section.id },
          'Notification delivered successfully',
        );
      } catch (sendError) {
        logger.error(
          { userId: user.id, err: redactSecrets(sendError) },
          'Failed delivering Telegram notification to user',
        );
      }
    }
  }
}
