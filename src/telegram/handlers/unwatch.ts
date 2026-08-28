import { parseTargetIdentifier, type BotContext } from '../types.js';

export async function handleUnwatch(ctx: BotContext): Promise<void> {
  const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  if (match.length === 0) {
    await ctx.reply(
      '⚠️ *Please specify the Class ID or Course Code to unwatch.*\n\n*Examples:*\n• `/unwatch 1494`\n• `/unwatch PHA 500`',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const target = parseTargetIdentifier(match);
  if (target === null) {
    await ctx.reply(
      '❌ *Invalid format.*\n\nPlease provide a class ID (e.g. `1494`) or course code (e.g. `PHA 500`).',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const { sectionRepository, subscriptionRepository } = ctx.services.repositories;
  const term = ctx.services.config.defaultTerm;

  if (target.type === 'CLASS_NUMBER') {
    const section = await sectionRepository.findByClassNumber(term, target.value);
    if (section === null) {
      await ctx.reply(`ℹ️ You are not watching class ID \`${target.value}\`.`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    const unsubscribed = await subscriptionRepository.unsubscribe(ctx.user.id, section.id);
    if (unsubscribed === null) {
      await ctx.reply(`ℹ️ You are not watching class ID \`${target.value}\`.`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    await ctx.reply(`🔕 *Unsubscribed from class ID \`${target.value}\`.*`, {
      parse_mode: 'Markdown',
    });
    return;
  }

  // Target is COURSE_CODE
  const sections = await sectionRepository.findByCourseCode(term, target.value);
  if (sections.length === 0) {
    await ctx.reply(`ℹ️ No active subscriptions found for course *${target.value}*.`, {
      parse_mode: 'Markdown',
    });
    return;
  }

  let count = 0;
  for (const s of sections) {
    const res = await subscriptionRepository.unsubscribe(ctx.user.id, s.id);
    if (res !== null) {
      count++;
    }
  }

  if (count === 0) {
    await ctx.reply(`ℹ️ You were not watching any sections of course *${target.value}*.`, {
      parse_mode: 'Markdown',
    });
    return;
  }

  await ctx.reply(`🔕 *Unsubscribed from ${String(count)} section(s) of course ${target.value}.*`, {
    parse_mode: 'Markdown',
  });
}
