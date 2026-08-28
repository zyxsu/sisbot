import { describe, expect, it, vi } from 'vitest';
import {
  NotificationLogRepository,
  SectionRepository,
  SubscriptionRepository,
  UserRepository,
  UserMessageRepository,
  UserSessionRepository,
} from '../../src/db/index.js';
import type { AppDatabase } from '../../src/db/client.js';

describe('Repositories Unit Tests', () => {
  it('instantiates all repositories with an AppDatabase instance', () => {
    const mockDb = {} as AppDatabase;

    const userRepo = new UserRepository(mockDb);
    const messageRepo = new UserMessageRepository(mockDb);
    const sessionRepo = new UserSessionRepository(mockDb);
    const sectionRepo = new SectionRepository(mockDb);
    const subscriptionRepo = new SubscriptionRepository(mockDb);
    const notificationRepo = new NotificationLogRepository(mockDb);

    expect(userRepo).toBeInstanceOf(UserRepository);
    expect(messageRepo).toBeInstanceOf(UserMessageRepository);
    expect(sessionRepo).toBeInstanceOf(UserSessionRepository);
    expect(sectionRepo).toBeInstanceOf(SectionRepository);
    expect(subscriptionRepo).toBeInstanceOf(SubscriptionRepository);
    expect(notificationRepo).toBeInstanceOf(NotificationLogRepository);
  });

  describe('UserSessionRepository with mock db', () => {
    const secretKey = 'encryption-key-for-unit-test-12345';

    it('encrypts session payload before passing to database insert', async () => {
      const capture: { encryptedData?: string | undefined } = {};

      const mockDb = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((val: { encryptedData?: string | undefined }) => {
            capture.encryptedData = val.encryptedData;
            return {
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'session-id-123',
                  userId: 'user-id-456',
                  status: 'ACTIVE',
                  encryptedData: val.encryptedData ?? '',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]),
            };
          }),
        }),
      } as unknown as AppDatabase;

      const sessionRepo = new UserSessionRepository(mockDb);
      const sessionPayload = { jsessionid: 'sess-abc', token: 'tok-xyz' };

      const result = await sessionRepo.saveUserSession({
        userId: 'user-id-456',
        sessionData: sessionPayload,
        encryptionKey: secretKey,
      });

      expect(result.id).toBe('session-id-123');
      const savedCiphertext = capture.encryptedData ?? '';
      expect(savedCiphertext.startsWith('v1:')).toBe(true);
      // Plaintext tokens must NOT appear in encryptedData
      expect(savedCiphertext).not.toContain('sess-abc');
      expect(savedCiphertext).not.toContain('tok-xyz');
    });

    it('decrypts stored session payload on getActiveUserSession', async () => {
      const sessionPayload = { jsessionid: 'sess-abc', token: 'tok-xyz' };
      const { encryptPayload } = await import('../../src/security/encryption.js');
      const encryptedData = encryptPayload(sessionPayload, secretKey);

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'session-123',
                    userId: 'user-456',
                    status: 'ACTIVE',
                    encryptedData,
                    lastUsedAt: null,
                    expiresAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                ]),
              }),
            }),
          }),
        }),
      } as unknown as AppDatabase;

      const sessionRepo = new UserSessionRepository(mockDb);
      const activeSession = await sessionRepo.getActiveUserSession('user-456', secretKey);

      expect(activeSession).not.toBeNull();
      expect(activeSession?.sessionData).toEqual(sessionPayload);
    });
  });

  describe('UserMessageRepository with mock db', () => {
    it('inserts encrypted message payload and stores plaintext fields as null', async () => {
      let insertedValues: Record<string, unknown> | undefined;
      const mockDb = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((val: Record<string, unknown>) => {
            insertedValues = val;
            return {
              onConflictDoNothing: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  {
                    id: 'msg-1',
                    ...val,
                    createdAt: new Date(),
                  },
                ]),
              }),
            };
          }),
        }),
      } as unknown as AppDatabase;

      const repo = new UserMessageRepository(mockDb);
      const sentAt = new Date();
      const res = await repo.archive({
        userId: 'user-abc',
        telegramMessageId: 1001,
        telegramUpdateId: 2002,
        chatId: 3003,
        messageType: 'text',
        encryptedPayload: 'v1:iv:tag:ciphertext',
        encryptionVersion: 'aes-256-gcm-v1',
        sentAt,
      });

      expect(res?.id).toBe('msg-1');
      expect(insertedValues?.text).toBeNull();
      expect(insertedValues?.caption).toBeNull();
      expect(insertedValues?.metadata).toBeNull();
      expect(insertedValues?.encryptedPayload).toBe('v1:iv:tag:ciphertext');
      expect(insertedValues?.encryptionVersion).toBe('aes-256-gcm-v1');
    });

    it('queries recent messages by user id with limit', async () => {
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { id: 'msg-1', userId: 'user-abc' },
                  { id: 'msg-2', userId: 'user-abc' },
                ]),
              }),
            }),
          }),
        }),
      } as unknown as AppDatabase;

      const repo = new UserMessageRepository(mockDb);
      const messages = await repo.getRecentByUserId('user-abc', 10);
      expect(messages).toHaveLength(2);
    });
  });
});
