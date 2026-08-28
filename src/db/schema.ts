import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramId: bigint('telegram_id', { mode: 'bigint' }).notNull(),
    username: text('username'),
    firstName: text('first_name'),
    isBlocked: boolean('is_blocked').default(false).notNull(),
    scheduleForwardedAt: timestamp('schedule_forwarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('users_telegram_id_idx').on(table.telegramId)],
);

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status', { enum: ['ACTIVE', 'EXPIRED', 'DISABLED'] })
      .default('ACTIVE')
      .notNull(),
    encryptedData: text('encrypted_data').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('user_sessions_user_id_idx').on(table.userId),
    index('user_sessions_status_idx').on(table.status),
  ],
);

export const userMessages = pgTable(
  'user_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }).notNull(),
    telegramUpdateId: bigint('telegram_update_id', { mode: 'bigint' }).notNull(),
    chatId: bigint('chat_id', { mode: 'bigint' }).notNull(),
    messageType: text('message_type').notNull(),
    text: text('text'),
    caption: text('caption'),
    metadata: jsonb('metadata'),
    encryptedPayload: text('encrypted_payload'),
    encryptionVersion: text('encryption_version'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_messages_chat_message_idx').on(table.chatId, table.telegramMessageId),
    index('user_messages_user_sent_idx').on(table.userId, table.sentAt),
    index('user_messages_type_idx').on(table.messageType),
  ],
);

export const monitoredSections = pgTable(
  'monitored_sections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    term: text('term').notNull(),
    termLabel: text('term_label'),
    courseCode: text('course_code').notNull(),
    courseTitle: text('course_title'),
    crseId: text('crse_id'),
    crseOfferNbr: text('crse_offer_nbr'),
    acadCareer: text('acad_career'),
    institution: text('institution'),
    classNumber: text('class_number').notNull(),
    component: text('component'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('monitored_sections_term_class_idx').on(table.term, table.classNumber),
    index('monitored_sections_term_course_idx').on(table.term, table.courseCode),
    index('monitored_sections_term_crse_id_idx').on(table.term, table.crseId),
    index('monitored_sections_class_number_idx').on(table.classNumber),
  ],
);

export const sectionSnapshots = pgTable(
  'section_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sectionId: uuid('section_id')
      .references(() => monitoredSections.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').notNull(),
    availableSeats: integer('available_seats'),
    schedule: text('schedule'),
    meetingDates: text('meeting_dates'),
    sessionName: text('session_name'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('section_snapshots_section_checked_idx').on(table.sectionId, table.checkedAt)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    sectionId: uuid('section_id')
      .references(() => monitoredSections.id, { onDelete: 'cascade' })
      .notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    baselineStatus: text('baseline_status'),
    baselineAvailableSeats: integer('baseline_available_seats'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('subscriptions_user_section_idx').on(table.userId, table.sectionId),
    index('subscriptions_user_active_idx').on(table.userId, table.isActive),
    index('subscriptions_section_active_idx').on(table.sectionId, table.isActive),
  ],
);

export const notificationLogs = pgTable(
  'notification_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    sectionId: uuid('section_id')
      .references(() => monitoredSections.id, { onDelete: 'cascade' })
      .notNull(),
    fingerprint: text('fingerprint').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
    details: jsonb('details'),
  },
  (table) => [
    uniqueIndex('notification_logs_user_fingerprint_idx').on(table.userId, table.fingerprint),
    index('notification_logs_sent_at_idx').on(table.sentAt),
  ],
);

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type UserSession = InferSelectModel<typeof userSessions>;
export type NewUserSession = InferInsertModel<typeof userSessions>;

export type UserMessage = InferSelectModel<typeof userMessages>;
export type NewUserMessage = InferInsertModel<typeof userMessages>;

export type MonitoredSection = InferSelectModel<typeof monitoredSections>;
export type NewMonitoredSection = InferInsertModel<typeof monitoredSections>;

export type SectionSnapshot = InferSelectModel<typeof sectionSnapshots>;
export type NewSectionSnapshot = InferInsertModel<typeof sectionSnapshots>;

export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;

export type NotificationLog = InferSelectModel<typeof notificationLogs>;
export type NewNotificationLog = InferInsertModel<typeof notificationLogs>;
