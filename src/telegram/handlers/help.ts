import { formatHelpMessage } from '../formatters.js';
import type { BotContext } from '../types.js';

export async function handleHelp(ctx: BotContext): Promise<void> {
  const message = formatHelpMessage();
  await ctx.reply(message, { parse_mode: 'Markdown' });
}
