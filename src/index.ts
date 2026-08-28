try {
  process.loadEnvFile?.();
} catch {
  // Ignore if .env is missing or already loaded
}

import { PlaywrightAuibAuthenticator } from './auth/index.js';
import { loadEnvironment } from './config/env.js';
import { logger } from './config/logger.js';
import {
  createDatabaseClient,
  NotificationLogRepository,
  SectionRepository,
  SubscriptionRepository,
  UserRepository,
  UserMessageRepository,
  UserSessionRepository,
} from './db/index.js';
import {
  FixtureSectionChecker,
  InMemoryFixtureWorkflowSource,
  PlaywrightSectionChecker,
} from './peoplesoft/workflow/index.js';
import { PollingScheduler } from './scheduler/index.js';
import {
  PeopleSoftAvailabilityClient,
  SectionStatusService,
  StudentScheduleClient,
} from './peoplesoft/http/index.js';
import { redactSecrets } from './security/redact.js';
import { createTelegramBot } from './telegram/index.js';
import { AdminScheduleForwarder } from './telegram/admin-schedule-forwarder.js';

async function bootstrap(): Promise<void> {
  const env = loadEnvironment();
  logger.info({ nodeEnv: env.NODE_ENV }, 'Bootstrapping AUIB Section Monitor');

  // 1. Initialize PostgreSQL database connection
  const dbClient = createDatabaseClient(env.DATABASE_URL);
  const isHealthy = await dbClient.checkHealth();
  if (!isHealthy) {
    logger.warn('Database health check failed; ensure PostgreSQL is running');
  } else {
    logger.info('Database connection established and verified');
  }

  // 2. Initialize Repositories
  const repositories = {
    userRepository: new UserRepository(dbClient.db),
    userMessageRepository: new UserMessageRepository(dbClient.db),
    userSessionRepository: new UserSessionRepository(dbClient.db),
    sectionRepository: new SectionRepository(dbClient.db),
    subscriptionRepository: new SubscriptionRepository(dbClient.db),
    notificationLogRepository: new NotificationLogRepository(dbClient.db),
  };

  // 3. Initialize Section Checker
  // (Uses PlaywrightSectionChecker when PEOPLESOFT_LIVE_ENABLED=true; otherwise offline FixtureSectionChecker)
  const sectionChecker = env.PEOPLESOFT_LIVE_ENABLED
    ? new PlaywrightSectionChecker()
    : new FixtureSectionChecker(new InMemoryFixtureWorkflowSource([]));

  // 4. Initialize Telegram Bot & Authenticator
  const botToken = env.TELEGRAM_BOT_TOKEN ?? 'DISABLED';
  const encryptionKey = env.SESSION_ENCRYPTION_KEY ?? 'development-default-encryption-key-12345';
  const authenticator = new PlaywrightAuibAuthenticator();
  const sectionStatusService = new SectionStatusService({
    sectionRepository: repositories.sectionRepository,
    userSessionRepository: repositories.userSessionRepository,
    availabilityClient: new PeopleSoftAvailabilityClient({ baseUrl: env.PEOPLESOFT_BASE_URL }),
    encryptionKey,
  });
  const adminScheduleForwarder =
    env.ADMIN_TELEGRAM_CHAT_ID === undefined
      ? undefined
      : new AdminScheduleForwarder({
          adminChatId: env.ADMIN_TELEGRAM_CHAT_ID,
          userRepository: repositories.userRepository,
          sectionRepository: repositories.sectionRepository,
          scheduleClient: new StudentScheduleClient({ baseUrl: env.PEOPLESOFT_BASE_URL }),
          term: '2701',
          termLabel: '2026/2027 Fall',
        });

  const bot = createTelegramBot({
    token: botToken,
    repositories,
    encryptionKey,
    defaultTerm: '2701',
    defaultTermLabel: '2026/2027 Fall',
    authenticator,
    sectionStatusService,
    ...(adminScheduleForwarder !== undefined ? { adminScheduleForwarder } : {}),
    ...(sectionChecker instanceof PlaywrightSectionChecker
      ? { requirementBrowser: sectionChecker }
      : {}),
  });

  // 5. Initialize Polling Scheduler
  const scheduler = new PollingScheduler({
    repositories,
    botApi: bot.api,
    sectionChecker,
    authenticator,
    config: {
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
      pollJitterSeconds: env.POLL_JITTER_SECONDS,
      minRequestDelayMs: env.MIN_REQUEST_DELAY_MS,
      encryptionKey,
      defaultTerm: '2701',
      defaultTermLabel: '2026/2027 Fall',
    },
  });

  // 6. Graceful Shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down AUIB Section Monitor');
    scheduler.stop();
    await bot.stop();
    if (sectionChecker instanceof PlaywrightSectionChecker) {
      await sectionChecker.closeAll();
    }
    await dbClient.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 7. Start Services
  scheduler.start();

  if (env.TELEGRAM_BOT_TOKEN !== undefined) {
    logger.info('Starting Telegram bot polling');
    void bot.start({
      onStart: (info) => {
        logger.info({ username: info.username }, 'Telegram bot is online and listening');
      },
    });
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN is not configured; bot long-polling skipped');
  }
}

void bootstrap().catch((error: unknown) => {
  logger.fatal({ err: redactSecrets(error) }, 'Failed to start AUIB Section Monitor');
  process.exit(1);
});
