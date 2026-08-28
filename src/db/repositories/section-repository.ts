import { and, desc, eq } from 'drizzle-orm';
import type { SectionState } from '../../domain/section-state.js';
import type { AppDatabase } from '../client.js';
import {
  monitoredSections,
  sectionSnapshots,
  type MonitoredSection,
  type SectionSnapshot,
} from '../schema.js';

export class SectionRepository {
  public constructor(private readonly db: AppDatabase) {}

  public async upsertSection(state: SectionState): Promise<MonitoredSection> {
    const [section] = await this.db
      .insert(monitoredSections)
      .values({
        term: state.term,
        termLabel: state.termLabel ?? null,
        courseCode: state.courseCode.toUpperCase().trim(),
        courseTitle: state.courseTitle ?? null,
        crseId: state.crseId ?? null,
        crseOfferNbr: state.crseOfferNbr ?? null,
        acadCareer: state.acadCareer ?? null,
        institution: state.institution ?? null,
        classNumber: state.classNumber.trim(),
        component: state.component ?? null,
      })
      .onConflictDoUpdate({
        target: [monitoredSections.term, monitoredSections.classNumber],
        set: {
          termLabel: state.termLabel ?? null,
          courseCode: state.courseCode.toUpperCase().trim(),
          courseTitle: state.courseTitle ?? null,
          crseId: state.crseId ?? null,
          crseOfferNbr: state.crseOfferNbr ?? null,
          acadCareer: state.acadCareer ?? null,
          institution: state.institution ?? null,
          component: state.component ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (section === undefined) {
      throw new Error('Failed to upsert section record');
    }

    return section;
  }

  public async findById(id: string): Promise<MonitoredSection | null> {
    const [section] = await this.db
      .select()
      .from(monitoredSections)
      .where(eq(monitoredSections.id, id))
      .limit(1);

    return section ?? null;
  }

  public async findByClassNumber(
    term: string,
    classNumber: string,
  ): Promise<MonitoredSection | null> {
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

    return section ?? null;
  }

  public async findByCourseCode(term: string, courseCode: string): Promise<MonitoredSection[]> {
    const normalizedCode = courseCode.toUpperCase().trim();
    return this.db
      .select()
      .from(monitoredSections)
      .where(
        and(
          eq(monitoredSections.term, term.trim()),
          eq(monitoredSections.courseCode, normalizedCode),
        ),
      );
  }

  public async recordSnapshot(sectionId: string, state: SectionState): Promise<SectionSnapshot> {
    const [snapshot] = await this.db
      .insert(sectionSnapshots)
      .values({
        sectionId,
        status: state.status,
        availableSeats: state.availableSeats,
        schedule: state.schedule ?? null,
        meetingDates: state.meetingDates ?? null,
        sessionName: state.sessionName ?? null,
        checkedAt: state.checkedAt,
      })
      .returning();

    if (snapshot === undefined) {
      throw new Error('Failed to record section snapshot');
    }

    return snapshot;
  }

  public async getLatestSnapshot(sectionId: string): Promise<SectionSnapshot | null> {
    const [snapshot] = await this.db
      .select()
      .from(sectionSnapshots)
      .where(eq(sectionSnapshots.sectionId, sectionId))
      .orderBy(desc(sectionSnapshots.checkedAt))
      .limit(1);

    return snapshot ?? null;
  }

  public async getLatestSnapshotForClassNumber(
    term: string,
    classNumber: string,
  ): Promise<{ section: MonitoredSection; snapshot: SectionSnapshot | null } | null> {
    const section = await this.findByClassNumber(term, classNumber);
    if (section === null) {
      return null;
    }

    const snapshot = await this.getLatestSnapshot(section.id);
    return { section, snapshot };
  }
}
