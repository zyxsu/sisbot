import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import { notificationLogs, type NotificationLog } from '../schema.js';

export interface TransitionDetails {
  fromStatus?: string | null;
  toStatus: string;
  fromSeats?: number | null;
  toSeats?: number | null;
}

export class NotificationLogRepository {
  public constructor(private readonly db: AppDatabase) {}

  /**
   * Generates a deterministic idempotency fingerprint for a notification event.
   */
  public static buildFingerprint(
    userId: string,
    sectionId: string,
    transition: TransitionDetails,
    timeBucketHours = 1,
  ): string {
    // Bucket by hour to allow re-alerting if state flips back and forth over extended periods
    const hourBucket = String(Math.floor(Date.now() / (1000 * 60 * 60 * timeBucketHours)));
    const fromStatus = transition.fromStatus ?? 'none';
    const toStatus = transition.toStatus;
    const fromSeats =
      transition.fromSeats !== undefined && transition.fromSeats !== null
        ? String(transition.fromSeats)
        : 'none';
    const toSeats =
      transition.toSeats !== undefined && transition.toSeats !== null
        ? String(transition.toSeats)
        : 'none';
    const raw = `${userId}:${sectionId}:${fromStatus}->${toStatus}:${fromSeats}->${toSeats}:${hourBucket}`;

    return createHash('sha256').update(raw).digest('hex');
  }

  public async hasNotificationBeenSent(userId: string, fingerprint: string): Promise<boolean> {
    const [record] = await this.db
      .select({ id: notificationLogs.id })
      .from(notificationLogs)
      .where(
        and(eq(notificationLogs.userId, userId), eq(notificationLogs.fingerprint, fingerprint)),
      )
      .limit(1);

    return record !== undefined;
  }

  public async recordNotificationSent(
    userId: string,
    sectionId: string,
    fingerprint: string,
    details?: Record<string, unknown>,
  ): Promise<NotificationLog> {
    const [log] = await this.db
      .insert(notificationLogs)
      .values({
        userId,
        sectionId,
        fingerprint,
        details: details ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (log === undefined) {
      // Return existing if already inserted
      const [existing] = await this.db
        .select()
        .from(notificationLogs)
        .where(
          and(eq(notificationLogs.userId, userId), eq(notificationLogs.fingerprint, fingerprint)),
        )
        .limit(1);

      if (existing === undefined) {
        throw new Error('Failed to record or retrieve notification log');
      }

      return existing;
    }

    return log;
  }
}
