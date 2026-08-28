import type { NextFunction } from 'grammy';
import type { UserLoginState } from '../../auth/types.js';
import { logger } from '../../config/logger.js';
import { redactSecrets } from '../../security/redact.js';
import type { BotContext } from '../types.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// In-memory conversation state for active login handshakes
const activeLoginStates = new Map<string, UserLoginState>();

async function forwardNewUserSchedule(
  ctx: BotContext,
  cookiesPayload: unknown,
  studentEmail: string,
): Promise<void> {
  const forwarder = ctx.services.adminScheduleForwarder;
  if (forwarder === undefined) return;
  try {
    await forwarder.forwardOnce(ctx.api, ctx.user, cookiesPayload, studentEmail);
  } catch (error) {
    logger.error(
      { err: redactSecrets(error) },
      'Failed to forward new user schedule to configured admin chat',
    );
  }
}

export function getActiveLoginState(telegramId: number | bigint): UserLoginState | null {
  const key = String(telegramId);
  const state = activeLoginStates.get(key);
  if (state === undefined) {
    return null;
  }

  if (Date.now() - state.startedAt > LOGIN_TIMEOUT_MS) {
    activeLoginStates.delete(key);
    return null;
  }

  return state;
}

export function clearLoginState(telegramId: number | bigint): void {
  activeLoginStates.delete(String(telegramId));
}

export function setLoginState(telegramId: number | bigint, state: UserLoginState): void {
  activeLoginStates.set(String(telegramId), state);
}

/**
 * Initiates the interactive student login wizard.
 */
export async function handleLogin(ctx: BotContext): Promise<void> {
  const from = ctx.from;
  if (from === undefined) {
    return;
  }

  clearLoginState(from.id);

  setLoginState(from.id, {
    step: 'AWAITING_EMAIL',
    startedAt: Date.now(),
  });

  await ctx.reply(
    '🎓 *AUIB SIS Automated Login*\n\nPlease reply with your student email (e.g. `first.last@auib.edu.iq` or `s12345@auib.edu.iq`).\n\n_Type `/cancel` at any time to abort._',
    { parse_mode: 'Markdown' },
  );
}

export async function handleCancel(ctx: BotContext): Promise<void> {
  const from = ctx.from;
  if (from === undefined) {
    return;
  }

  const existingState = getActiveLoginState(from.id);
  if (existingState !== null) {
    clearLoginState(from.id);
    await ctx.reply('🚫 *Login cancelled.* You can start again anytime with `/login`.', {
      parse_mode: 'Markdown',
    });
  } else {
    await ctx.reply('ℹ️ No active login session in progress.');
  }
}

export async function loginConversationMiddleware(
  ctx: BotContext,
  next: NextFunction,
): Promise<void> {
  const from = ctx.from;
  const message = ctx.message;

  if (from === undefined || message?.text === undefined) {
    await next();
    return;
  }

  const text = message.text.trim();

  // Let slash commands pass through
  if (text.startsWith('/')) {
    await next();
    return;
  }

  const state = getActiveLoginState(from.id);
  if (state === null) {
    await next();
    return;
  }

  const authenticator = ctx.services.authenticator;
  if (authenticator === undefined) {
    await ctx.reply('⚠️ Authentication service is currently unavailable.');
    clearLoginState(from.id);
    return;
  }

  if (state.step === 'AWAITING_EMAIL') {
    try {
      if (ctx.chat !== undefined) {
        await ctx.api.deleteMessage(ctx.chat.id, message.message_id);
      }
    } catch {
      // Ignore deletion errors
    }

    if (!text.includes('@') || text.length < 5) {
      await ctx.reply(
        '⚠️ *Invalid email address format.*\n\nPlease reply with your full AUIB student email (e.g. `first.last@auib.edu.iq`):',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    setLoginState(from.id, {
      step: 'AWAITING_PASSWORD',
      email: text,
      startedAt: Date.now(),
    });

    await ctx.reply(
      `📧 *Account:* \`${text}\`\n\n🔒 *Enter Your Password:*\n\nPlease reply with your account password.\n\n🛡️ _Your password message will be permanently deleted from the chat immediately for your security._`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (state.step === 'AWAITING_PASSWORD') {
    try {
      if (ctx.chat !== undefined) {
        await ctx.api.deleteMessage(ctx.chat.id, message.message_id);
      }
    } catch {
      // Ignore deletion errors
    }

    const email = state.email ?? '';
    const statusMsg = await ctx.reply(
      '⏳ *Signing in to AUIB SIS (launching background browser)...*',
      {
        parse_mode: 'Markdown',
      },
    );

    const loginResult = await authenticator.startLogin(email, text);

    if (loginResult.status === 'SUCCESS') {
      const sessionData = {
        rawCookies: loginResult.cookies,
        ...(loginResult.rawSession !== undefined ? { rawSession: loginResult.rawSession } : {}),
      };
      await ctx.services.repositories.userSessionRepository.saveUserSession({
        userId: ctx.user.id,
        sessionData,
        encryptionKey: ctx.services.config.encryptionKey,
        ...(loginResult.expiresAt !== undefined ? { expiresAt: loginResult.expiresAt } : {}),
      });

      clearLoginState(from.id);

      await ctx.api.editMessageText(
        ctx.chat?.id ?? from.id,
        statusMsg.message_id,
        '🎉 *Login Successful!*\n\nYour AUIB SIS account has been authenticated and linked securely. Background seat monitoring is now active.',
        { parse_mode: 'Markdown' },
      );
      await forwardNewUserSchedule(ctx, sessionData, email);
      return;
    }

    if (loginResult.status === 'REQUIRES_2FA') {
      setLoginState(from.id, {
        step: 'AWAITING_2FA',
        email,
        challengeContext: loginResult.challengeContext,
        startedAt: Date.now(),
      });

      await ctx.api.editMessageText(
        ctx.chat?.id ?? from.id,
        statusMsg.message_id,
        loginResult.message,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    clearLoginState(from.id);
    await ctx.api.editMessageText(
      ctx.chat?.id ?? from.id,
      statusMsg.message_id,
      `❌ *Login Failed:* ${loginResult.error}\n\nUse \`/login\` to try again.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  try {
    if (ctx.chat !== undefined) {
      await ctx.api.deleteMessage(ctx.chat.id, message.message_id);
    }
  } catch {
    // Ignore deletion errors
  }

  const verifyingMsg = await ctx.reply('⏳ *Verifying approval / code with AUIB SIS...*', {
    parse_mode: 'Markdown',
  });

  const twoFaResult = await authenticator.submit2Fa(state.challengeContext, text);

  if (twoFaResult.status === 'SUCCESS') {
    const sessionData = {
      rawCookies: twoFaResult.cookies,
      ...(twoFaResult.rawSession !== undefined ? { rawSession: twoFaResult.rawSession } : {}),
    };
    await ctx.services.repositories.userSessionRepository.saveUserSession({
      userId: ctx.user.id,
      sessionData,
      encryptionKey: ctx.services.config.encryptionKey,
      ...(twoFaResult.expiresAt !== undefined ? { expiresAt: twoFaResult.expiresAt } : {}),
    });

    clearLoginState(from.id);
    await ctx.api.editMessageText(
      ctx.chat?.id ?? from.id,
      verifyingMsg.message_id,
      '🎉 *Login Successful!*\n\nYour AUIB SIS session is now active and authenticated. Real-time class seat monitoring has begun!',
      { parse_mode: 'Markdown' },
    );
    await forwardNewUserSchedule(ctx, sessionData, state.email ?? 'Unknown');
    return;
  }

  clearLoginState(from.id);
  const errorMsg = twoFaResult.status === 'FAILED' ? twoFaResult.error : 'Verification failed';
  await ctx.api.editMessageText(
    ctx.chat?.id ?? from.id,
    verifyingMsg.message_id,
    `❌ *2FA Verification Failed:* ${errorMsg}\n\nUse \`/login\` to try again.`,
    { parse_mode: 'Markdown' },
  );
}
