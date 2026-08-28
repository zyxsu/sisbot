import { formatWatchesList } from '../formatters.js';
import type { BotContext } from '../types.js';

export async function handleWatches(ctx: BotContext): Promise<void> {
  const { subscriptionRepository } = ctx.services.repositories;
  const watches = await subscriptionRepository.getUserActiveSubscriptions(ctx.user.id);
  const message = formatWatchesList(watches);

  await ctx.reply(message, { parse_mode: 'Markdown' });
}
