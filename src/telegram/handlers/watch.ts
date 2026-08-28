import { formatSectionCard } from '../formatters.js';
import { parseTargetIdentifier, type BotContext } from '../types.js';
import { InlineKeyboard } from 'grammy';
import { SectionStatusError } from '../../peoplesoft/http/section-status-service.js';

async function handleWatchRequest(ctx: BotContext): Promise<void> {
  const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  if (match.length === 0) {
    await ctx.reply(
      '⚠️ *Please specify a Class ID or Course Code to watch.*\n\n*Examples:*\n• `/watch 1494`\n• `/watch PHA 500`',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const target = parseTargetIdentifier(match);
  if (target === null) {
    await ctx.reply(
      '❌ *Invalid Class ID or Course Code format.*\n\nPlease use a valid class number (e.g. `1494`) or course code (e.g. `PHA 500`).',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const { sectionRepository, subscriptionRepository, userSessionRepository } =
    ctx.services.repositories;
  const term = ctx.services.config.defaultTerm;
  const termLabel = ctx.services.config.defaultTermLabel;

  // Check if the user has an active session configured
  const activeSession = await userSessionRepository.getActiveUserSession(
    ctx.user.id,
    ctx.services.config.encryptionKey,
  );

  const sessionWarning =
    activeSession === null
      ? "\n\n💡 _Tip: You haven't linked an active AUIB session yet. Configure your session with `/set_session` to enable automated background polling!_"
      : '';

  if (target.type === 'CLASS_NUMBER') {
    // 1. Find or create section record
    const refreshed =
      ctx.services.sectionStatusService !== undefined
        ? await ctx.services.sectionStatusService.refreshByClassNumber(
            ctx.user.id,
            term,
            target.value,
          )
        : null;
    const existingSection =
      refreshed?.section ?? (await sectionRepository.findByClassNumber(term, target.value));
    const section =
      existingSection ??
      (await sectionRepository.upsertSection({
        term,
        ...(termLabel !== undefined ? { termLabel } : {}),
        courseCode: 'UNKNOWN',
        classNumber: target.value,
        status: 'UNKNOWN',
        availableSeats: null,
        checkedAt: new Date(),
      }));

    const latestSnapshot =
      refreshed?.snapshot ?? (await sectionRepository.getLatestSnapshot(section.id));

    // 2. Subscribe user
    await subscriptionRepository.subscribe(ctx.user.id, section.id, {
      ...(latestSnapshot?.status !== undefined ? { status: latestSnapshot.status } : {}),
      ...(latestSnapshot?.availableSeats !== undefined
        ? { availableSeats: latestSnapshot.availableSeats }
        : {}),
    });

    const card = formatSectionCard(section, latestSnapshot);
    await ctx.reply(
      `✅ *Subscribed to class ID \`${target.value}\`!*\n\nYou will receive real-time notifications whenever seat counts or status change.\n\n${card}${sessionWarning}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Target is COURSE_CODE (e.g. 'PHA 500')
  const sections = await sectionRepository.findByCourseCode(term, target.value);
  if (sections.length === 0) {
    await ctx.reply(
      `ℹ️ No scheduled sections were found for *${target.value}* in ${termLabel ?? term}.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const section of sections) {
    keyboard
      .text(
        `${section.component ?? 'Class'} ${section.classNumber}`,
        `catalog:watch:${section.classNumber}`,
      )
      .row();
  }
  await ctx.reply(`📚 *${target.value}* — choose the section you want to watch:${sessionWarning}`, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

export async function handleWatch(ctx: BotContext): Promise<void> {
  try {
    await handleWatchRequest(ctx);
  } catch (error) {
    if (error instanceof SectionStatusError) {
      await ctx.reply(
        error.code === 'NO_SESSION' || error.code === 'SESSION_EXPIRED'
          ? '🔐 Please use /login first, then try again.'
          : `ℹ️ ${error.message}`,
      );
      return;
    }
    throw error;
  }
}

export async function handleWatchCallback(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data ?? '';
  const classNumber = /^catalog:watch:(\d{3,8})$/.exec(data)?.[1];
  if (classNumber === undefined) return;
  ctx.match = classNumber;
  await handleWatch(ctx);
}
