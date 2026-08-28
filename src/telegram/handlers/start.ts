import { formatStartMessage } from '../formatters.js';
import type { BotContext } from '../types.js';

export async function handleStart(ctx: BotContext): Promise<void> {
  const firstName = ctx.from?.first_name ?? ctx.user.firstName;
  const message = formatStartMessage(firstName);
  await ctx.reply(message, { parse_mode: 'Markdown' });
}
