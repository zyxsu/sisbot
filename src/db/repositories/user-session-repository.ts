import { and, desc, eq } from 'drizzle-orm';
import { decryptPayload, encryptPayload } from '../../security/encryption.js';
import type { AppDatabase } from '../client.js';
import { userSessions, type UserSession } from '../schema.js';

export interface SaveUserSessionInput<T = unknown> {
  userId: string;
  sessionData: T;
  encryptionKey: string;
  expiresAt?: Date | null;
}

export interface DecryptedUserSession<T = unknown> {
  id: string;
  userId: string;
  status: 'ACTIVE' | 'EXPIRED' | 'DISABLED';
  sessionData: T;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class UserSessionRepository {
  public constructor(private readonly db: AppDatabase) {}

  public async saveUserSession<T = unknown>(input: SaveUserSessionInput<T>): Promise<UserSession> {
    const encryptedData = encryptPayload(input.sessionData, input.encryptionKey);

    // Expire any existing active sessions for this user so only one is active
    await this.db
      .update(userSessions)
      .set({
        status: 'EXPIRED',
        updatedAt: new Date(),
      })
      .where(and(eq(userSessions.userId, input.userId), eq(userSessions.status, 'ACTIVE')));

    const [session] = await this.db
      .insert(userSessions)
      .values({
        userId: input.userId,
        status: 'ACTIVE',
        encryptedData,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();

    if (session === undefined) {
      throw new Error('Failed to create user session record');
    }

    return session;
  }

  public async getActiveUserSession<T = unknown>(
    userId: string,
    encryptionKey: string,
  ): Promise<DecryptedUserSession<T> | null> {
    const [record] = await this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), eq(userSessions.status, 'ACTIVE')))
      .orderBy(desc(userSessions.createdAt))
      .limit(1);

    if (record === undefined) {
      return null;
    }

    // Check if session has expired based on expiresAt timestamp
    if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
      await this.markExpired(record.id);
      return null;
    }

    const sessionData = decryptPayload(record.encryptedData, encryptionKey) as T;

    return {
      id: record.id,
      userId: record.userId,
      status: record.status,
      sessionData,
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  public async updateLastUsed(sessionId: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userSessions.id, sessionId));
  }

  public async markExpired(sessionId: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({
        status: 'EXPIRED',
        updatedAt: new Date(),
      })
      .where(eq(userSessions.id, sessionId));
  }

  public async markDisabled(sessionId: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({
        status: 'DISABLED',
        updatedAt: new Date(),
      })
      .where(eq(userSessions.id, sessionId));
  }
}
