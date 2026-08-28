import { formatSessionStatus } from '../formatters.js';
import type { BotContext } from '../types.js';

export async function handleSession(ctx: BotContext): Promise<void> {
  const { userSessionRepository } = ctx.services.repositories;
  const encryptionKey = ctx.services.config.encryptionKey;

  const session = await userSessionRepository.getActiveUserSession(ctx.user.id, encryptionKey);

  if (session === null) {
    const msg = formatSessionStatus('NOT_SET');
    await ctx.reply(msg, { parse_mode: 'Markdown' });
    return;
  }

  const msg = formatSessionStatus(session.status, session.expiresAt);
  await ctx.reply(msg, { parse_mode: 'Markdown' });
}

export async function handleSetSession(ctx: BotContext): Promise<void> {
  const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  // Delete the incoming message containing raw cookies/credentials for safety
  try {
    if (ctx.message?.message_id !== undefined && ctx.chat !== undefined) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    }
  } catch {
    // Ignore message deletion failure if bot lacks permission
  }

  if (match.length === 0) {
    await ctx.reply(
      '⚠️ *Please provide your session cookies or token.*\n\n*Usage:*\n`/set_session <cookies>`\n\n_(Your credentials will be immediately encrypted with AES-256-GCM and stored securely)_',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const { userSessionRepository } = ctx.services.repositories;
  const encryptionKey = ctx.services.config.encryptionKey;

  let sessionPayload: unknown;
  try {
    sessionPayload = JSON.parse(match) as unknown;
  } catch {
    // Treat as raw cookie/token string if not JSON
    sessionPayload = { rawCookies: match };
  }

  await userSessionRepository.saveUserSession({
    userId: ctx.user.id,
    sessionData: sessionPayload,
    encryptionKey,
  });

  await ctx.reply(
    '🔒 *AUIB SIS Session Saved & Encrypted!*\n\nYour credentials have been securely stored using AES-256-GCM. The monitor can now check seat availability on your behalf.',
    { parse_mode: 'Markdown' },
  );
}
