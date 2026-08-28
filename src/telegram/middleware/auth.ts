import type { NextFunction } from 'grammy';
import { archiveIncomingMessage } from './archive-message.js';
import type { BotContext } from '../types.js';

export async function authMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const from = ctx.from;
  if (from === undefined) {
    await next();
    return;
  }

  const { userRepository } = ctx.services.repositories;

  const user = await userRepository.upsertTelegramUser({
    telegramId: from.id,
    username: from.username ?? null,
    firstName: from.first_name,
  });

  ctx.user = user;

  if (user.isBlocked) {
    if (ctx.message !== undefined) {
      await archiveIncomingMessage(ctx);
    }
    await ctx.reply('🚫 Your account has been restricted from using this service.');
    return;
  }

  await next();
}
