import { Bot } from 'grammy';
import type { AuibAuthenticator } from '../auth/types.js';
import type { RequirementBrowser } from '../peoplesoft/workflow/requirement-browser.js';
import type { SectionStatusService } from '../peoplesoft/http/section-status-service.js';
import type { AdminScheduleForwarder } from './admin-schedule-forwarder.js';
import { redactSecrets } from '../security/redact.js';
import { handleHelp } from './handlers/help.js';
import { handleCancel, handleLogin, loginConversationMiddleware } from './handlers/login.js';
import { handleBrowse, handleBrowseCallback } from './handlers/browse.js';
import { handleSession, handleSetSession } from './handlers/session.js';
import { handleStart } from './handlers/start.js';
import { handleMyId } from './handlers/myid.js';
import { handleStatus, handleStatusCallback } from './handlers/status.js';
import { handleUnwatch } from './handlers/unwatch.js';
import { handleWatch, handleWatchCallback } from './handlers/watch.js';
import { handleWatches } from './handlers/watches.js';
import { authMiddleware } from './middleware/auth.js';
import { archiveMessageMiddleware } from './middleware/archive-message.js';
import type { BotContext, BotRepositories } from './types.js';

export interface CreateTelegramBotOptions {
  token: string;
  repositories: BotRepositories;
  encryptionKey: string;
  defaultTerm?: string;
  defaultTermLabel?: string;
  authenticator?: AuibAuthenticator;
  requirementBrowser?: RequirementBrowser;
  sectionStatusService?: SectionStatusService;
  adminScheduleForwarder?: AdminScheduleForwarder;
}

export function createTelegramBot(options: CreateTelegramBotOptions): Bot<BotContext> {
  const bot = new Bot<BotContext>(options.token);

  // 1. Inject services and repositories into context
  bot.use(async (ctx, next) => {
    ctx.services = {
      repositories: options.repositories,
      config: {
        encryptionKey: options.encryptionKey,
        defaultTerm: options.defaultTerm ?? '2701',
        defaultTermLabel: options.defaultTermLabel ?? '2026/2027 Fall',
      },
      ...(options.authenticator !== undefined ? { authenticator: options.authenticator } : {}),
      ...(options.requirementBrowser !== undefined
        ? { requirementBrowser: options.requirementBrowser }
        : {}),
      ...(options.sectionStatusService !== undefined
        ? { sectionStatusService: options.sectionStatusService }
        : {}),
      ...(options.adminScheduleForwarder !== undefined
        ? { adminScheduleForwarder: options.adminScheduleForwarder }
        : {}),
    };
    await next();
  });

  // 2. Auth & user registration middleware
  bot.use(authMiddleware);

  // 3. Archive every incoming user message before command/conversation handling
  bot.use(archiveMessageMiddleware);

  // 4. Login conversation state middleware (intercepts email/password/2FA input)
  bot.use(loginConversationMiddleware);

  // 5. Register command handlers
  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('login', handleLogin);
  bot.command('browse', handleBrowse);
  bot.command('cancel', handleCancel);
  bot.command('watch', handleWatch);
  bot.command('unwatch', handleUnwatch);
  bot.command('watches', handleWatches);
  bot.command('status', handleStatus);
  bot.command('session', handleSession);
  bot.command('myid', handleMyId);
  bot.command('set_session', handleSetSession);
  bot.callbackQuery(/^browse:/, handleBrowseCallback);
  bot.callbackQuery(/^catalog:status:/, handleStatusCallback);
  bot.callbackQuery(/^catalog:watch:/, handleWatchCallback);

  // 6. Global error handler with secret redaction
  bot.catch((err) => {
    const redactedError = redactSecrets(err);
    console.error('Telegram bot error:', redactedError);
  });

  return bot;
}
