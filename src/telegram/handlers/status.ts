import { logger } from '../../config/logger.js';
import { redactSecrets } from '../../security/redact.js';
import { formatSectionCard } from '../formatters.js';
import { parseTargetIdentifier, type BotContext } from '../types.js';
import { InlineKeyboard } from 'grammy';
import { SectionStatusError } from '../../peoplesoft/http/section-status-service.js';

async function replyWithFallback(ctx: BotContext, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.warn(
      { userId: ctx.user.id, err: redactSecrets(error) },
      'Markdown status reply failed; retrying as plain text',
    );
    await ctx.reply(text.replace(/[\\*_`]/g, ''));
  }
}

async function handleStatusRequest(ctx: BotContext): Promise<void> {
  const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  if (match.length === 0) {
    await replyWithFallback(
      ctx,
      '⚠️ *Please specify a Class ID or Course Code to check status.*\n\n*Examples:*\n• `/status 1494`\n• `/status PHA 500`',
    );
    return;
  }

  const target = parseTargetIdentifier(match);
  if (target === null) {
    await replyWithFallback(
      ctx,
      '❌ *Invalid format.*\n\nPlease provide a class ID (e.g. `1494`) or course code (e.g. `PHA 500`).',
    );
    return;
  }

  const { sectionRepository } = ctx.services.repositories;
  const term = ctx.services.config.defaultTerm;

  if (target.type === 'CLASS_NUMBER') {
    const result =
      ctx.services.sectionStatusService !== undefined
        ? await ctx.services.sectionStatusService.refreshByClassNumber(
            ctx.user.id,
            term,
            target.value,
          )
        : await sectionRepository.getLatestSnapshotForClassNumber(term, target.value);
    if (result === null) {
      await replyWithFallback(
        ctx,
        `ℹ️ No recorded observations for class ID \`${target.value}\` in term ${term}.\n\nUse \`/watch ${target.value}\` to start monitoring it!`,
      );
      return;
    }

    const card = formatSectionCard(result.section, result.snapshot);
    await replyWithFallback(ctx, card);
    return;
  }

  // Target is COURSE_CODE
  const sections = await sectionRepository.findByCourseCode(term, target.value);
  if (sections.length === 0) {
    await replyWithFallback(
      ctx,
      `ℹ️ No recorded sections found for course *${target.value}* in term ${term}.\n\nUse \`/watch ${target.value}\` to add it to your watch list.`,
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const section of sections) {
    keyboard
      .text(
        `${section.component ?? 'Class'} ${section.classNumber}`,
        `catalog:status:${section.classNumber}`,
      )
      .row();
  }
  await ctx.reply(`📚 *${target.value}* — choose a section for a live SIS check:`, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

export async function handleStatus(ctx: BotContext): Promise<void> {
  try {
    await handleStatusRequest(ctx);
  } catch (error) {
    if (error instanceof SectionStatusError) {
      const message =
        error.code === 'NO_SESSION' || error.code === 'SESSION_EXPIRED'
          ? '🔐 Please use /login first, then try the live status check again.'
          : `ℹ️ ${error.message}`;
      await ctx.reply(message);
      return;
    }
    logger.error(
      { userId: ctx.user.id, err: redactSecrets(error) },
      'Failed handling Telegram status command',
    );
    await ctx
      .reply('⚠️ I could not load the class status right now. Please try `/status 1495` again.', {
        parse_mode: 'Markdown',
      })
      .catch(() => undefined);
  }
}

export async function handleStatusCallback(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data ?? '';
  const classNumber = /^catalog:status:(\d{3,8})$/.exec(data)?.[1];
  if (classNumber === undefined) return;
  ctx.match = classNumber;
  await handleStatus(ctx);
}
