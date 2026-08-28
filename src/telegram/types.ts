import type { Context } from 'grammy';
import type {
  NotificationLogRepository,
  SectionRepository,
  SubscriptionRepository,
  User,
  UserRepository,
  UserMessageRepository,
  UserSessionRepository,
} from '../db/index.js';

export interface BotRepositories {
  userRepository: UserRepository;
  userMessageRepository: UserMessageRepository;
  userSessionRepository: UserSessionRepository;
  sectionRepository: SectionRepository;
  subscriptionRepository: SubscriptionRepository;
  notificationLogRepository: NotificationLogRepository;
}

export interface BotConfig {
  encryptionKey: string;
  defaultTerm: string;
  defaultTermLabel?: string;
}

import type { AuibAuthenticator } from '../auth/types.js';
import type { RequirementBrowser } from '../peoplesoft/workflow/requirement-browser.js';
import type { SectionStatusService } from '../peoplesoft/http/section-status-service.js';
import type { AdminScheduleForwarder } from './admin-schedule-forwarder.js';

export interface BotServices {
  repositories: BotRepositories;
  config: BotConfig;
  authenticator?: AuibAuthenticator;
  requirementBrowser?: RequirementBrowser;
  sectionStatusService?: SectionStatusService;
  adminScheduleForwarder?: AdminScheduleForwarder;
}

export interface BotContext extends Context {
  services: BotServices;
  user: User;
}

export interface TargetIdentifier {
  type: 'CLASS_NUMBER' | 'COURSE_CODE';
  value: string;
}

/**
 * Normalizes and determines whether a query is a 4-5 digit class number
 * (e.g. '1494') or a course code (e.g. 'PHA 500', 'PHA500').
 */
export function parseTargetIdentifier(rawInput: string): TargetIdentifier | null {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // If input is purely digits (typically 3-6 digits in PeopleSoft), treat as class number
  if (/^\d{3,6}$/.test(trimmed)) {
    return {
      type: 'CLASS_NUMBER',
      value: trimmed,
    };
  }

  // Match standard subject + catalog number: e.g. "PHA 500", "PHA500", "CS 101A", "ENG 102"
  const courseMatch = /^([A-Za-z]{2,10})\s*(\d{2,4}[A-Za-z]?)$/i.exec(trimmed);
  if (courseMatch?.[1] !== undefined && courseMatch[2] !== undefined) {
    return {
      type: 'COURSE_CODE',
      value: `${courseMatch[1].toUpperCase()} ${courseMatch[2].toUpperCase()}`,
    };
  }

  // Fallback: If it contains letters and numbers or dashes, normalize whitespace
  const normalized = trimmed.replace(/\s+/g, ' ').toUpperCase();
  if (/[A-Z]/.test(normalized) && /\d/.test(normalized)) {
    return {
      type: 'COURSE_CODE',
      value: normalized,
    };
  }

  return null;
}
