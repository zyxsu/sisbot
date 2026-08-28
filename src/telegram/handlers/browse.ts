import { InlineKeyboard } from 'grammy';
import { logger } from '../../config/logger.js';
import type { SectionState } from '../../domain/section-state.js';
import type {
  RequirementChoice,
  RequirementCourseChoice,
  RequirementTermChoice,
} from '../../peoplesoft/workflow/requirement-browser.js';
import { PeopleSoftSessionExpiredError } from '../../peoplesoft/http/peoplesoft-client.js';
import { redactSecrets } from '../../security/redact.js';
import { formatSectionCard } from '../formatters.js';
import type { BotContext } from '../types.js';

const PAGE_SIZE = 6;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface BrowseState {
  expiresAt: number;
  requirements: RequirementChoice[];
  courses: Map<number, RequirementCourseChoice[]>;
  terms: Map<string, RequirementTermChoice[]>;
  sections: Map<string, SectionState[]>;
}

const states = new Map<string, BrowseState>();

function shorten(value: string, maximum = 48): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function pageBounds(
  length: number,
  requestedPage: number,
): { page: number; start: number; end: number } {
  const lastPage = Math.max(0, Math.ceil(length / PAGE_SIZE) - 1);
  const page = Math.min(Math.max(0, requestedPage), lastPage);
  const start = page * PAGE_SIZE;
  return { page, start, end: Math.min(start + PAGE_SIZE, length) };
}

function addPager(keyboard: InlineKeyboard, prefix: string, page: number, itemCount: number): void {
  const lastPage = Math.max(0, Math.ceil(itemCount / PAGE_SIZE) - 1);
  if (lastPage === 0) return;
  if (page > 0) keyboard.text('◀️ Previous', `${prefix}:${String(page - 1)}`);
  keyboard.text(`${String(page + 1)}/${String(lastPage + 1)}`, 'browse:noop');
  if (page < lastPage) keyboard.text('Next ▶️', `${prefix}:${String(page + 1)}`);
  keyboard.row();
}

function requirementView(state: BrowseState, requestedPage: number) {
  const { page, start, end } = pageBounds(state.requirements.length, requestedPage);
  const keyboard = new InlineKeyboard();
  for (let index = start; index < end; index += 1) {
    const requirement = state.requirements[index];
    if (requirement === undefined) continue;
    keyboard
      .text(
        `${requirement.satisfied ? '✅' : '🟡'} ${shorten(requirement.label)}`,
        `browse:g:${String(index)}:0`,
      )
      .row();
  }
  addPager(keyboard, 'browse:r', page, state.requirements.length);
  keyboard.text('🔄 Refresh', 'browse:refresh');
  return {
    text: `📚 Choose any requirement group from your SIS report.\n\nPage ${String(page + 1)} of ${String(Math.max(1, Math.ceil(state.requirements.length / PAGE_SIZE)))}`,
    keyboard,
  };
}

function courseView(state: BrowseState, requirementIndex: number, requestedPage: number) {
  const requirement = state.requirements[requirementIndex];
  const courses = state.courses.get(requirementIndex) ?? [];
  const { page, start, end } = pageBounds(courses.length, requestedPage);
  const keyboard = new InlineKeyboard();
  for (let index = start; index < end; index += 1) {
    const course = courses[index];
    if (course === undefined) continue;
    keyboard
      .text(
        shorten(`${course.courseCode} — ${course.courseTitle}`, 56),
        `browse:c:${String(requirementIndex)}:${String(index)}`,
      )
      .row();
  }
  addPager(keyboard, `browse:g:${String(requirementIndex)}`, page, courses.length);
  keyboard.text('⬅️ Requirements', 'browse:r:0');
  return {
    text: `📂 ${requirement?.label ?? 'Requirement'}\n\nChoose a course (${String(courses.length)} available):`,
    keyboard,
  };
}

function termView(state: BrowseState, requirementIndex: number, courseIndex: number) {
  const course = state.courses.get(requirementIndex)?.[courseIndex];
  const terms = state.terms.get(`${String(requirementIndex)}:${String(courseIndex)}`) ?? [];
  const keyboard = new InlineKeyboard();
  terms.forEach((term, termIndex) => {
    keyboard
      .text(
        `🗓 ${term.label}`,
        `browse:t:${String(requirementIndex)}:${String(courseIndex)}:${String(termIndex)}`,
      )
      .row();
  });
  keyboard.text('⬅️ Courses', `browse:g:${String(requirementIndex)}:0`);
  return {
    text:
      terms.length === 0
        ? `ℹ️ No class terms were found for ${course?.courseCode ?? 'this course'}.`
        : `📚 ${course?.courseCode ?? 'Course'} — ${course?.courseTitle ?? ''}\n\nChoose a term:`,
    keyboard,
  };
}

function sectionView(
  state: BrowseState,
  requirementIndex: number,
  courseIndex: number,
  termIndex: number,
) {
  const key = `${String(requirementIndex)}:${String(courseIndex)}:${String(termIndex)}`;
  const sections = state.sections.get(key) ?? [];
  const course = state.courses.get(requirementIndex)?.[courseIndex];
  const keyboard = new InlineKeyboard();
  sections.forEach((section, sectionIndex) => {
    keyboard
      .text(
        shorten(`${section.component ?? 'Class'} ${section.classNumber} • ${section.status}`, 56),
        `browse:d:${String(requirementIndex)}:${String(courseIndex)}:${String(termIndex)}:${String(sectionIndex)}`,
      )
      .row();
  });
  keyboard.text('⬅️ Terms', `browse:c:${String(requirementIndex)}:${String(courseIndex)}`);
  return {
    text:
      sections.length === 0
        ? `ℹ️ No classes were found for ${course?.courseCode ?? 'this course'} in the selected term.`
        : `🏫 ${course?.courseCode ?? 'Course'} classes\n\nChoose a class to view and watch:`,
    keyboard,
  };
}

async function editView(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const options = keyboard === undefined ? {} : { reply_markup: keyboard };
  if (ctx.callbackQuery?.message !== undefined) {
    await ctx.editMessageText(text, options).catch(async () => {
      await ctx.reply(text, options);
    });
    return;
  }
  await ctx.reply(text, options);
}

async function getSessionPayload(ctx: BotContext): Promise<unknown> {
  const session = await ctx.services.repositories.userSessionRepository.getActiveUserSession(
    ctx.user.id,
    ctx.services.config.encryptionKey,
  );
  return session?.sessionData ?? null;
}

async function handleExpiredSession(ctx: BotContext, error: unknown): Promise<boolean> {
  if (!(error instanceof PeopleSoftSessionExpiredError)) return false;
  const session = await ctx.services.repositories.userSessionRepository.getActiveUserSession(
    ctx.user.id,
    ctx.services.config.encryptionKey,
  );
  if (session !== null) {
    await ctx.services.repositories.userSessionRepository.markExpired(session.id);
  }
  states.delete(ctx.user.id);
  await editView(ctx, '⚠️ Your SIS session expired. Use /login, then send /browse again.');
  return true;
}

async function loadRequirements(ctx: BotContext): Promise<BrowseState | null> {
  const browser = ctx.services.requirementBrowser;
  if (browser === undefined) {
    await editView(ctx, '⚠️ SIS requirement browsing is not enabled on this server.');
    return null;
  }
  const sessionPayload = await getSessionPayload(ctx);
  if (sessionPayload === null) {
    await editView(ctx, '⚠️ Your SIS session is not active. Use /login, then try /browse again.');
    return null;
  }
  const requirements = await browser.listRequirements(sessionPayload);
  const state: BrowseState = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    requirements,
    courses: new Map(),
    terms: new Map(),
    sections: new Map(),
  };
  states.set(ctx.user.id, state);
  return state;
}

function currentState(ctx: BotContext): BrowseState | null {
  const state = states.get(ctx.user.id);
  if (state === undefined || state.expiresAt <= Date.now()) {
    states.delete(ctx.user.id);
    return null;
  }
  state.expiresAt = Date.now() + CACHE_TTL_MS;
  return state;
}

export async function handleBrowse(ctx: BotContext): Promise<void> {
  await ctx.reply('⏳ Loading your SIS requirement groups…');
  try {
    const state = await loadRequirements(ctx);
    if (state === null) return;
    const view = requirementView(state, 0);
    await editView(ctx, view.text, view.keyboard);
  } catch (error) {
    if (await handleExpiredSession(ctx, error)) return;
    logger.warn(
      { userId: ctx.user.id, err: redactSecrets(error) },
      'Could not browse SIS requirements',
    );
    await ctx.reply('⚠️ I could not load your requirements. Use /login and try /browse again.');
  }
}

export async function handleBrowseCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('browse:')) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (data === 'browse:noop') return;

  try {
    if (data === 'browse:refresh') {
      await editView(ctx, '⏳ Refreshing your SIS requirement groups…');
      const refreshed = await loadRequirements(ctx);
      if (refreshed === null) return;
      const view = requirementView(refreshed, 0);
      await editView(ctx, view.text, view.keyboard);
      return;
    }

    const parts = data.split(':');
    const state = currentState(ctx);
    if (state === null) {
      await editView(ctx, '⌛ This browse menu expired. Send /browse to load it again.');
      return;
    }

    if (parts[1] === 'r') {
      const view = requirementView(state, Number(parts[2] ?? 0));
      await editView(ctx, view.text, view.keyboard);
      return;
    }

    const requirementIndex = Number(parts[2]);
    if (
      !Number.isSafeInteger(requirementIndex) ||
      state.requirements[requirementIndex] === undefined
    ) {
      throw new Error('Invalid requirement selection');
    }

    if (parts[1] === 'g') {
      if (!state.courses.has(requirementIndex)) {
        await editView(ctx, '⏳ Loading courses from this requirement…');
        const sessionPayload = await getSessionPayload(ctx);
        if (sessionPayload === null || ctx.services.requirementBrowser === undefined) {
          await editView(ctx, '⚠️ Your SIS session expired. Use /login and try again.');
          return;
        }
        state.courses.set(
          requirementIndex,
          await ctx.services.requirementBrowser.listCourses(
            sessionPayload,
            state.requirements[requirementIndex].label,
          ),
        );
      }
      const view = courseView(state, requirementIndex, Number(parts[3] ?? 0));
      await editView(ctx, view.text, view.keyboard);
      return;
    }

    const courseIndex = Number(parts[3]);
    const course = state.courses.get(requirementIndex)?.[courseIndex];
    if (!Number.isSafeInteger(courseIndex) || course === undefined) {
      throw new Error('Invalid course selection');
    }

    if (parts[1] === 'c') {
      const termKey = `${String(requirementIndex)}:${String(courseIndex)}`;
      if (!state.terms.has(termKey)) {
        await editView(ctx, '⏳ Loading available terms…');
        const sessionPayload = await getSessionPayload(ctx);
        if (sessionPayload === null || ctx.services.requirementBrowser === undefined) {
          await editView(ctx, '⚠️ Your SIS session expired. Use /login and try again.');
          return;
        }
        state.terms.set(
          termKey,
          await ctx.services.requirementBrowser.listCourseTerms(
            sessionPayload,
            state.requirements[requirementIndex].label,
            course.courseCode,
          ),
        );
      }
      const view = termView(state, requirementIndex, courseIndex);
      await editView(ctx, view.text, view.keyboard);
      return;
    }

    const termIndex = Number(parts[4]);
    const termKey = `${String(requirementIndex)}:${String(courseIndex)}`;
    const termChoice = state.terms.get(termKey)?.[termIndex];
    if (!Number.isSafeInteger(termIndex) || termChoice === undefined) {
      throw new Error('Invalid term selection');
    }

    if (parts[1] === 't') {
      const sectionKey = `${termKey}:${String(termIndex)}`;
      if (!state.sections.has(sectionKey)) {
        await editView(ctx, '⏳ Loading classes for this term…');
        const sessionPayload = await getSessionPayload(ctx);
        if (sessionPayload === null || ctx.services.requirementBrowser === undefined) {
          await editView(ctx, '⚠️ Your SIS session expired. Use /login and try again.');
          return;
        }
        const sections = await ctx.services.requirementBrowser.listCourseSections(
          sessionPayload,
          state.requirements[requirementIndex].label,
          course.courseCode,
          termChoice.termCode,
          termChoice.label,
        );
        state.sections.set(
          sectionKey,
          sections.map((section) => ({ ...section, courseTitle: course.courseTitle })),
        );
      }
      const view = sectionView(state, requirementIndex, courseIndex, termIndex);
      await editView(ctx, view.text, view.keyboard);
      return;
    }

    const sectionIndex = Number(parts[5]);
    const sections = state.sections.get(`${termKey}:${String(termIndex)}`) ?? [];
    const section = sections[sectionIndex];
    if (!Number.isSafeInteger(sectionIndex) || section === undefined) {
      throw new Error('Invalid class selection');
    }

    if (parts[1] === 'd') {
      const keyboard = new InlineKeyboard()
        .text(
          '👁 Watch this class',
          `browse:w:${String(requirementIndex)}:${String(courseIndex)}:${String(termIndex)}:${String(sectionIndex)}`,
        )
        .row()
        .text(
          '⬅️ Classes',
          `browse:t:${String(requirementIndex)}:${String(courseIndex)}:${String(termIndex)}`,
        );
      const syntheticSection = {
        id: 'browse-preview',
        term: section.term,
        termLabel: section.termLabel ?? null,
        courseCode: section.courseCode,
        courseTitle: section.courseTitle ?? null,
        crseId: section.crseId ?? null,
        crseOfferNbr: section.crseOfferNbr ?? null,
        acadCareer: section.acadCareer ?? null,
        institution: section.institution ?? null,
        classNumber: section.classNumber,
        component: section.component ?? null,
        createdAt: section.checkedAt,
        updatedAt: section.checkedAt,
      };
      const syntheticSnapshot = {
        id: 'browse-preview',
        sectionId: 'browse-preview',
        status: section.status,
        availableSeats: section.availableSeats,
        schedule: section.schedule ?? null,
        meetingDates: section.meetingDates ?? null,
        sessionName: section.sessionName ?? null,
        checkedAt: section.checkedAt,
        createdAt: section.checkedAt,
      };
      await editView(ctx, formatSectionCard(syntheticSection, syntheticSnapshot), keyboard);
      return;
    }

    if (parts[1] === 'w') {
      const { sectionRepository, subscriptionRepository } = ctx.services.repositories;
      const storedSection = await sectionRepository.upsertSection(section);
      const latest = await sectionRepository.getLatestSnapshot(storedSection.id);
      if (latest === null || latest.checkedAt.getTime() < section.checkedAt.getTime()) {
        await sectionRepository.recordSnapshot(storedSection.id, section);
      }
      await subscriptionRepository.subscribe(ctx.user.id, storedSection.id, {
        status: section.status,
        availableSeats: section.availableSeats,
      });
      await editView(
        ctx,
        `✅ Watching ${course.courseCode}, class ${section.classNumber}.\n\nUse /watches to view all subscriptions.`,
        new InlineKeyboard().text(
          '⬅️ Classes',
          `browse:t:${String(requirementIndex)}:${String(courseIndex)}:${String(termIndex)}`,
        ),
      );
    }
  } catch (error) {
    if (await handleExpiredSession(ctx, error)) return;
    logger.warn({ userId: ctx.user.id, err: redactSecrets(error) }, 'SIS browse action failed');
    await editView(ctx, '⚠️ I could not complete that SIS browse action. Try /browse again.');
  }
}
