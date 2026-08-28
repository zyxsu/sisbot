import { parseArgs } from 'node:util';
import { loadEnvironment } from './config/env.js';
import {
  createDatabaseClient,
  UserRepository,
  UserSessionRepository,
  type DatabaseClient,
} from './db/index.js';
import { PeopleSoftAvailabilityClient } from './peoplesoft/http/index.js';
import { assertPeopleSoftLiveModeEnabled } from './peoplesoft/live-mode.js';
import { redactSecrets } from './security/redact.js';

interface SessionSource {
  payload: unknown;
  databaseClient: DatabaseClient | null;
}

function requiredOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required option --${name}`);
  }
  return value.trim();
}

async function loadAuthenticatedSession(
  telegramId: string | undefined,
  databaseUrl: string,
  encryptionKey: string | undefined,
): Promise<SessionSource> {
  const cookieFromEnvironment = process.env.PEOPLESOFT_COOKIE_HEADER?.trim();
  if (cookieFromEnvironment !== undefined && cookieFromEnvironment.length > 0) {
    return { payload: cookieFromEnvironment, databaseClient: null };
  }

  const selectedTelegramId = requiredOption(telegramId, 'telegram-id');
  const selectedEncryptionKey = requiredOption(encryptionKey, 'SESSION_ENCRYPTION_KEY');
  const databaseClient = createDatabaseClient(databaseUrl);

  try {
    const userRepository = new UserRepository(databaseClient.db);
    const sessionRepository = new UserSessionRepository(databaseClient.db);
    const user = await userRepository.findByTelegramId(selectedTelegramId);
    if (user === null) throw new Error('Telegram user was not found');

    const session = await sessionRepository.getActiveUserSession(user.id, selectedEncryptionKey);
    if (session === null) throw new Error('No active authenticated PeopleSoft session was found');

    return { payload: session.sessionData, databaseClient };
  } catch (error) {
    await databaseClient.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'telegram-id': { type: 'string' },
      'crse-id': { type: 'string' },
      offer: { type: 'string', default: '1' },
      term: { type: 'string' },
      'class-number': { type: 'string' },
      career: { type: 'string', default: 'UGRD' },
      institution: { type: 'string', default: 'AUIB' },
    },
    allowPositionals: false,
  });
  const environment = loadEnvironment();
  assertPeopleSoftLiveModeEnabled(environment);

  const session = await loadAuthenticatedSession(
    values['telegram-id'],
    environment.DATABASE_URL,
    environment.SESSION_ENCRYPTION_KEY,
  );

  try {
    const client = new PeopleSoftAvailabilityClient({
      baseUrl: environment.PEOPLESOFT_BASE_URL,
    });
    const result = await client.checkSection({
      cookiesPayload: session.payload,
      crseId: requiredOption(values['crse-id'], 'crse-id'),
      crseOfferNbr: requiredOption(values.offer, 'offer'),
      term: requiredOption(values.term, 'term'),
      classNumber: requiredOption(values['class-number'], 'class-number'),
      acadCareer: requiredOption(values.career, 'career'),
      institution: requiredOption(values.institution, 'institution'),
    });

    process.stdout.write(
      [
        `Course: ${result.courseCode} ${result.description}`,
        `Class: ${result.component} - ${result.classNumber}`,
        `Status: ${result.status}`,
        `Capacity: ${String(result.capacity)}`,
        `Enrolled: ${String(result.enrollmentTotal)}`,
        `Available: ${String(result.availableSeats)}`,
        `Waitlist: ${String(result.waitlistTotal)} / ${String(result.waitlistCapacity)}`,
      ].join('\n') + '\n',
    );
  } finally {
    await session.databaseClient?.close();
  }
}

void main().catch((error: unknown) => {
  const safeError = redactSecrets(error);
  const message =
    safeError instanceof Error ? safeError.message : 'Section availability check failed';
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
