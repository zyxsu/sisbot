import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseScheduledCatalog } from './catalog/catalog-parser.js';
import { loadEnvironment } from './config/env.js';
import { createDatabaseClient, SectionRepository } from './db/index.js';

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
}

async function run(): Promise<void> {
  const file = resolve(argument('file'));
  const offer = argument('offer', '1');
  const career = argument('career', 'UGRD').toUpperCase();
  const institution = argument('institution', 'AUIB').toUpperCase();
  const catalog = parseScheduledCatalog(readFileSync(file, 'utf8'));
  const dbClient = createDatabaseClient(loadEnvironment().DATABASE_URL);
  const sections = new SectionRepository(dbClient.db);
  let sectionCount = 0;

  try {
    for (const course of catalog.courses) {
      for (const catalogSection of course.sections) {
        const state = {
          term: catalog.term,
          termLabel: catalog.termLabel,
          courseCode: course.courseCode,
          courseTitle: course.title,
          crseId: course.crseId,
          crseOfferNbr: offer,
          acadCareer: career,
          institution,
          classNumber: catalogSection.classNumber,
          component: catalogSection.component,
          status: catalogSection.status,
          availableSeats: catalogSection.availableSeats,
          schedule: `${catalogSection.schedule} | Room: ${catalogSection.room}`,
          meetingDates: catalogSection.meetingDates,
          checkedAt: catalog.generatedAt,
        } as const;
        const section = await sections.upsertSection(state);
        const latest = await sections.getLatestSnapshot(section.id);
        if (latest === null || latest.checkedAt.getTime() < catalog.generatedAt.getTime()) {
          await sections.recordSnapshot(section.id, state);
        }
        sectionCount += 1;
      }
    }
  } finally {
    await dbClient.close();
  }
  console.log(
    `Imported ${String(catalog.courses.length)} courses and ${String(sectionCount)} sections for term ${catalog.term}.`,
  );
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
