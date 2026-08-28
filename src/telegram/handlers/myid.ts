import type { BotContext } from '../types.js';

export async function handleMyId(ctx: BotContext): Promise<void> {
  await ctx.reply(`Your Telegram chat ID is: \`${ctx.user.telegramId.toString()}\``, {
    parse_mode: 'Markdown',
  });
}
