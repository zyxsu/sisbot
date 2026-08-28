import { and, desc, eq, or } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import {
  monitoredSections,
  sectionSnapshots,
  subscriptions,
  users,
  type MonitoredSection,
  type SectionSnapshot,
  type Subscription,
  type User,
} from '../schema.js';

export interface UserSubscriptionDetail {
  subscription: Subscription;
  section: MonitoredSection;
  latestSnapshot: SectionSnapshot | null;
}

export class SubscriptionRepository {
  public constructor(private readonly db: AppDatabase) {}

  public async subscribe(
    userId: string,
    sectionId: string,
    baseline?: { status?: string; availableSeats?: number | null },
  ): Promise<Subscription> {
    const [sub] = await this.db
      .insert(subscriptions)
      .values({
        userId,
        sectionId,
        isActive: true,
        baselineStatus: baseline?.status ?? null,
        baselineAvailableSeats: baseline?.availableSeats ?? null,
      })
      .onConflictDoUpdate({
        target: [subscriptions.userId, subscriptions.sectionId],
        set: {
          isActive: true,
          baselineStatus: baseline?.status ?? null,
          baselineAvailableSeats: baseline?.availableSeats ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (sub === undefined) {
      throw new Error('Failed to subscribe user to section');
    }

    return sub;
  }

  public async unsubscribe(userId: string, sectionId: string): Promise<Subscription | null> {
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.sectionId, sectionId)))
      .returning();

    return updated ?? null;
  }

  public async unsubscribeByClassNumber(
    userId: string,
    term: string,
    classNumber: string,
  ): Promise<Subscription | null> {
    const [section] = await this.db
      .select()
      .from(monitoredSections)
      .where(
        and(
          eq(monitoredSections.term, term.trim()),
          eq(monitoredSections.classNumber, classNumber.trim()),
        ),
      )
      .limit(1);

    if (section === undefined) {
      return null;
    }

    return this.unsubscribe(userId, section.id);
  }

  public async getUserActiveSubscriptions(userId: string): Promise<UserSubscriptionDetail[]> {
    const rows = await this.db
      .select({
        subscription: subscriptions,
        section: monitoredSections,
      })
      .from(subscriptions)
      .innerJoin(monitoredSections, eq(subscriptions.sectionId, monitoredSections.id))
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.isActive, true)));

    const results: UserSubscriptionDetail[] = [];

    for (const row of rows) {
      // Fetch latest snapshot for each active section
      const [latest] = await this.db
        .select()
        .from(sectionSnapshots)
        .where(eq(sectionSnapshots.sectionId, row.section.id))
        .orderBy(desc(sectionSnapshots.checkedAt))
        .limit(1);

      results.push({
        subscription: row.subscription,
        section: row.section,
        latestSnapshot: latest ?? null,
      });
    }

    return results;
  }

  public async getSubscriptionsForUserPolling(
    userId: string,
  ): Promise<{ subscription: Subscription; section: MonitoredSection }[]> {
    return this.db
      .select({
        subscription: subscriptions,
        section: monitoredSections,
      })
      .from(subscriptions)
      .innerJoin(monitoredSections, eq(subscriptions.sectionId, monitoredSections.id))
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.isActive, true)));
  }

  public async getActiveSubscribersForSection(
    sectionId: string,
  ): Promise<{ user: User; subscription: Subscription }[]> {
    return this.db
      .select({
        user: users,
        subscription: subscriptions,
      })
      .from(subscriptions)
      .innerJoin(users, eq(subscriptions.userId, users.id))
      .where(
        and(
          eq(subscriptions.sectionId, sectionId),
          eq(subscriptions.isActive, true),
          eq(users.isBlocked, false),
        ),
      );
  }

  public async getActiveSubscribersForSectionOrCourse(
    section: Pick<MonitoredSection, 'id' | 'term' | 'courseCode'>,
  ): Promise<{ user: User; subscription: Subscription }[]> {
    const rows = await this.db
      .select({
        user: users,
        subscription: subscriptions,
      })
      .from(subscriptions)
      .innerJoin(users, eq(subscriptions.userId, users.id))
      .innerJoin(monitoredSections, eq(subscriptions.sectionId, monitoredSections.id))
      .where(
        and(
          eq(subscriptions.isActive, true),
          eq(users.isBlocked, false),
          or(
            eq(subscriptions.sectionId, section.id),
            and(
              eq(monitoredSections.term, section.term),
              eq(monitoredSections.courseCode, section.courseCode),
              eq(monitoredSections.classNumber, 'PENDING'),
            ),
          ),
        ),
      );

    return [...new Map(rows.map((row) => [row.user.id, row])).values()];
  }

  public async getActiveUserIdsWithSubscriptions(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({
        userId: subscriptions.userId,
      })
      .from(subscriptions)
      .innerJoin(users, eq(subscriptions.userId, users.id))
      .where(and(eq(subscriptions.isActive, true), eq(users.isBlocked, false)));

    return rows.map((r) => r.userId);
  }
}
