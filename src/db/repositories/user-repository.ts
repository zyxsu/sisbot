import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import { users, type User } from '../schema.js';

export interface UpsertTelegramUserInput {
  telegramId: bigint | number | string;
  username?: string | null;
  firstName?: string | null;
}

export class UserRepository {
  public constructor(private readonly db: AppDatabase) {}

  public async upsertTelegramUser(input: UpsertTelegramUserInput): Promise<User> {
    const telegramIdBigInt = BigInt(input.telegramId);

    const [user] = await this.db
      .insert(users)
      .values({
        telegramId: telegramIdBigInt,
        username: input.username ?? null,
        firstName: input.firstName ?? null,
      })
      .onConflictDoUpdate({
        target: users.telegramId,
        set: {
          username: input.username ?? null,
          firstName: input.firstName ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (user === undefined) {
      throw new Error('Failed to upsert user record');
    }

    return user;
  }

  public async findByTelegramId(telegramId: bigint | number | string): Promise<User | null> {
    const telegramIdBigInt = BigInt(telegramId);
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramIdBigInt))
      .limit(1);

    return user ?? null;
  }

  public async findById(id: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);

    return user ?? null;
  }

  public async markScheduleForwarded(userId: string, forwardedAt = new Date()): Promise<void> {
    await this.db
      .update(users)
      .set({ scheduleForwardedAt: forwardedAt, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  public async setBlocked(id: string, isBlocked: boolean): Promise<User | null> {
    const [updated] = await this.db
      .update(users)
      .set({
        isBlocked,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();

    return updated ?? null;
  }
}
