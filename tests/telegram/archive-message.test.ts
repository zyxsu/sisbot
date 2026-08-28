import { describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../../src/telegram/types.js';
import {
  archiveIncomingMessage,
  archiveMessageMiddleware,
} from '../../src/telegram/middleware/archive-message.js';
import { authMiddleware } from '../../src/telegram/middleware/auth.js';
import { decryptArchivedMessage } from '../../src/security/message-encryption.js';

function context(
  input: string | Partial<BotContext['message']>,
  archive = vi.fn().mockResolvedValue(null),
  userOverrides?: Partial<BotContext['user']>,
  reply = vi.fn().mockResolvedValue({}),
): BotContext {
  const messageBase =
    typeof input === 'string'
      ? {
          message_id: 77,
          date: 1_787_920_000,
          chat: { id: 123, type: 'private' },
          from: { id: 123, is_bot: false, first_name: 'Student' },
          text: input,
        }
      : {
          message_id: 77,
          date: 1_787_920_000,
          chat: { id: 123, type: 'private' },
          from: { id: 123, is_bot: false, first_name: 'Student' },
          ...input,
        };

  return {
    update: { update_id: 555, message: {} } as BotContext['update'],
    from: { id: 123, is_bot: false, first_name: 'Student' } as BotContext['from'],
    message: messageBase as BotContext['message'],
    user: {
      id: 'user-1',
      telegramId: 123n,
      username: 'student',
      firstName: 'Student',
      isBlocked: false,
      scheduleForwardedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...userOverrides,
    },
    services: {
      config: { encryptionKey: 'test', defaultTerm: '2701' },
      repositories: {
        userRepository: {
          upsertTelegramUser: vi.fn().mockResolvedValue({
            id: 'user-1',
            telegramId: 123n,
            username: 'student',
            firstName: 'Student',
            isBlocked: userOverrides?.isBlocked ?? false,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        userMessageRepository: { archive } as never,
      } as unknown as BotContext['services']['repositories'],
    },
    reply,
  } as unknown as BotContext;
}

describe('Telegram message archive middleware', () => {
  it('archives ordinary messages before continuing', async () => {
    const archive = vi.fn().mockResolvedValue(null);
    const ctx = context('hello bot', archive);
    const next = vi.fn().mockResolvedValue(undefined);
    await archiveMessageMiddleware(ctx, next);
    const record = archive.mock.calls[0]?.[0] as
      { encryptedPayload?: string; [key: string]: unknown } | undefined;
    expect(record).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        telegramMessageId: 77,
        telegramUpdateId: 555,
        messageType: 'text',
        encryptionVersion: 'aes-256-gcm-v1',
      }),
    );
    expect(record).not.toHaveProperty('text');
    expect(record?.encryptedPayload).not.toContain('hello bot');
    expect(decryptArchivedMessage(record?.encryptedPayload ?? '', 'test')).toEqual({
      text: 'hello bot',
      caption: null,
      metadata: {},
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('encrypts passwords and manual session-cookie commands without plaintext storage', async () => {
    const passwordArchive = vi.fn().mockResolvedValue(null);
    await archiveMessageMiddleware(context('plaintext-password', passwordArchive), vi.fn());
    const passwordRecord = passwordArchive.mock.calls[0]?.[0] as
      { encryptedPayload?: string; text?: unknown } | undefined;
    expect(passwordRecord?.text).toBeUndefined();
    expect(passwordRecord?.encryptedPayload).not.toContain('plaintext-password');
    expect(decryptArchivedMessage(passwordRecord?.encryptedPayload ?? '', 'test').text).toBe(
      'plaintext-password',
    );

    const sessionArchive = vi.fn().mockResolvedValue(null);
    await archiveMessageMiddleware(
      context('/set_session JSESSIONID=secret; PS_TOKEN=secret', sessionArchive),
      vi.fn(),
    );
    const sessionRecord = sessionArchive.mock.calls[0]?.[0] as
      { encryptedPayload?: string; text?: unknown } | undefined;
    expect(sessionRecord?.text).toBeUndefined();
    expect(sessionRecord?.encryptedPayload).not.toContain('JSESSIONID');
    expect(decryptArchivedMessage(sessionRecord?.encryptedPayload ?? '', 'test').text).toBe(
      '/set_session JSESSIONID=secret; PS_TOKEN=secret',
    );
  });

  it('archives media messages such as photo arrays with caption and metadata', async () => {
    const archive = vi.fn().mockResolvedValue(null);
    const photoMessage = {
      message_id: 88,
      date: 1_787_920_010,
      chat: { id: 123, type: 'private' },
      caption: 'Look at my schedule',
      photo: [
        { file_id: 'thumb_id', file_unique_id: 'u1', width: 100, height: 100, file_size: 1000 },
        { file_id: 'large_id', file_unique_id: 'u2', width: 800, height: 600, file_size: 50000 },
      ],
    };
    const ctx = context(photoMessage as unknown as Partial<BotContext['message']>, archive);
    await archiveMessageMiddleware(ctx, vi.fn());

    expect(archive).toHaveBeenCalledTimes(1);
    const record = archive.mock.calls[0]?.[0] as {
      messageType?: string;
      encryptedPayload?: string;
    };
    expect(record.messageType).toBe('photo');
    const decrypted = decryptArchivedMessage(record.encryptedPayload ?? '', 'test');
    expect(decrypted.caption).toBe('Look at my schedule');
    expect(decrypted.metadata).toEqual(
      expect.objectContaining({
        file_id: 'large_id',
        file_unique_id: 'u2',
        width: 800,
        height: 600,
        file_size: 50000,
      }),
    );
  });

  it('archives messages even if the user is marked as blocked', async () => {
    const archive = vi.fn().mockResolvedValue(null);
    const reply = vi.fn().mockResolvedValue({});
    const ctx = context('message from blocked user', archive, { isBlocked: true }, reply);
    const next = vi.fn().mockResolvedValue(undefined);

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('Your account has been restricted'));
    expect(archive).toHaveBeenCalledTimes(1);
    const record = archive.mock.calls[0]?.[0] as { encryptedPayload?: string };
    const decrypted = decryptArchivedMessage(record.encryptedPayload ?? '', 'test');
    expect(decrypted.text).toBe('message from blocked user');
  });

  it('safely handles contexts where ctx.user is undefined', async () => {
    const archive = vi.fn().mockResolvedValue(null);
    const ctx = context('anonymous message', archive);
    // @ts-expect-error test undefined user guard
    ctx.user = undefined;

    await expect(archiveIncomingMessage(ctx)).resolves.not.toThrow();
    expect(archive).not.toHaveBeenCalled();
  });
});
