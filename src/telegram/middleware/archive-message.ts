import { logger } from '../../config/logger.js';
import { redactSecrets } from '../../security/redact.js';
import { encryptArchivedMessage } from '../../security/message-encryption.js';
import type { User } from '../../db/schema.js';
import type { BotContext } from '../types.js';

const MESSAGE_TYPE_KEYS = [
  'photo',
  'video',
  'animation',
  'audio',
  'voice',
  'document',
  'sticker',
  'video_note',
  'contact',
  'location',
  'venue',
  'poll',
  'dice',
  'invoice',
  'successful_payment',
  'web_app_data',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function safeScalarMetadata(
  message: Record<string, unknown>,
  messageType: string,
): Record<string, unknown> {
  const target = message[messageType];
  const source = Array.isArray(target) ? record(target[target.length - 1]) : record(target);
  if (source === null) return {};
  const allowedKeys = [
    'file_id',
    'file_unique_id',
    'file_name',
    'mime_type',
    'file_size',
    'duration',
    'width',
    'height',
    'title',
    'performer',
    'emoji',
    'set_name',
    'first_name',
    'last_name',
    'phone_number',
    'latitude',
    'longitude',
    'question',
    'total_voter_count',
    'value',
    'currency',
    'total_amount',
    'data',
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, redactSecrets(source[key])]),
  );
}

function detectMessageType(message: Record<string, unknown>): string {
  if (typeof message.text === 'string') return message.text.startsWith('/') ? 'command' : 'text';
  return MESSAGE_TYPE_KEYS.find((key) => message[key] !== undefined) ?? 'service';
}

export async function archiveIncomingMessage(ctx: BotContext): Promise<void> {
  const message = ctx.message;
  const user = (ctx as unknown as { user?: User }).user;
  if (message === undefined || user === undefined) {
    return;
  }

  const raw = message as unknown as Record<string, unknown>;
  const messageType = detectMessageType(raw);
  const text = typeof raw.text === 'string' ? raw.text : null;
  const caption = typeof raw.caption === 'string' ? raw.caption : null;
  const metadata = safeScalarMetadata(raw, messageType);
  if (message.reply_to_message !== undefined) {
    metadata.replyToMessageId = message.reply_to_message.message_id;
  }
  try {
    const encryptedPayload = encryptArchivedMessage(
      { text, caption, metadata },
      ctx.services.config.encryptionKey,
    );
    const updateId =
      (ctx as { update?: { update_id?: number } }).update?.update_id ?? message.message_id;
    const chatId = (message as { chat?: { id?: number } }).chat?.id ?? ctx.chat?.id ?? 0;
    const dateSeconds =
      typeof message.date === 'number' ? message.date : Math.floor(Date.now() / 1000);
    await ctx.services.repositories.userMessageRepository.archive({
      userId: user.id,
      telegramMessageId: message.message_id,
      telegramUpdateId: updateId,
      chatId,
      messageType,
      encryptedPayload,
      encryptionVersion: 'aes-256-gcm-v1',
      sentAt: new Date(dateSeconds * 1000),
    });
  } catch (error) {
    logger.error({ err: redactSecrets(error) }, 'Failed to archive incoming Telegram message');
  }
}

export async function archiveMessageMiddleware(
  ctx: BotContext,
  next: () => Promise<void>,
): Promise<void> {
  await archiveIncomingMessage(ctx);
  await next();
}
