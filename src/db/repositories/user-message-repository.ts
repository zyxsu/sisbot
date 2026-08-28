import { desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import { userMessages, type UserMessage } from '../schema.js';

export interface ArchiveUserMessageInput {
  userId: string;
  telegramMessageId: bigint | number | string;
  telegramUpdateId: bigint | number | string;
  chatId: bigint | number | string;
  messageType: string;
  encryptedPayload: string;
  encryptionVersion: 'aes-256-gcm-v1';
  sentAt: Date;
}

export class UserMessageRepository {
  public constructor(private readonly db: AppDatabase) {}

  public async archive(input: ArchiveUserMessageInput): Promise<UserMessage | null> {
    const [message] = await this.db
      .insert(userMessages)
      .values({
        userId: input.userId,
        telegramMessageId: BigInt(input.telegramMessageId),
        telegramUpdateId: BigInt(input.telegramUpdateId),
        chatId: BigInt(input.chatId),
        messageType: input.messageType,
        text: null,
        caption: null,
        metadata: null,
        encryptedPayload: input.encryptedPayload,
        encryptionVersion: input.encryptionVersion,
        sentAt: input.sentAt,
      })
      .onConflictDoNothing({
        target: [userMessages.chatId, userMessages.telegramMessageId],
      })
      .returning();
    return message ?? null;
  }

  public async getRecentByUserId(userId: string, limit = 50): Promise<UserMessage[]> {
    return this.db
      .select()
      .from(userMessages)
      .where(eq(userMessages.userId, userId))
      .orderBy(desc(userMessages.sentAt))
      .limit(limit);
  }
}
