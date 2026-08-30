import type { SectionState, SectionStatus } from '../../domain/section-state.js';
import type { SectionRepository, UserSessionRepository } from '../../db/index.js';
import type { MonitoredSection, SectionSnapshot } from '../../db/schema.js';
import type { PeopleSoftAvailabilityClient } from './availability-client.js';
import { PeopleSoftSessionExpiredError } from './peoplesoft-client.js';
import type { AuibAuthenticator } from '../../auth/types.js';
import { logger } from '../../config/logger.js';
import { redactSecrets } from '../../security/redact.js';

export class SectionStatusError extends Error {
  public constructor(
    public readonly code: 'NOT_FOUND' | 'NO_SESSION' | 'MISSING_MAPPING' | 'SESSION_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'SectionStatusError';
  }
}

function normalizeStatus(status: string): SectionStatus {
  const normalized = status.trim().toUpperCase();
  if (normalized.includes('OPEN')) return 'OPEN';
  if (normalized.includes('CLOSED')) return 'CLOSED';
  if (normalized.includes('WAIT')) return 'WAITLIST';
  return 'UNKNOWN';
}

export interface SectionStatusServiceOptions {
  sectionRepository: SectionRepository;
  userSessionRepository: UserSessionRepository;
  availabilityClient: PeopleSoftAvailabilityClient;
  encryptionKey: string;
  authenticator?: AuibAuthenticator;
}

export class SectionStatusService {
  private observationHandler?: (state: SectionState) => Promise<void>;

  public constructor(private readonly options: SectionStatusServiceOptions) {}

  public setObservationHandler(handler: (state: SectionState) => Promise<void>): void {
    this.observationHandler = handler;
  }

  public async refreshByClassNumber(
    userId: string,
    term: string,
    classNumber: string,
  ): Promise<{ section: MonitoredSection; snapshot: SectionSnapshot }> {
    const existing = await this.options.sectionRepository.findByClassNumber(term, classNumber);
    if (existing === null) {
      throw new SectionStatusError('NOT_FOUND', `Class ${classNumber} is not in the catalog`);
    }
    if (existing.crseId === null || existing.crseOfferNbr === null) {
      throw new SectionStatusError('MISSING_MAPPING', `Class ${classNumber} has no course mapping`);
    }
    const previousSnapshot = await this.options.sectionRepository.getLatestSnapshot(existing.id);

    let session = await this.options.userSessionRepository.getActiveUserSession(
      userId,
      this.options.encryptionKey,
    );
    if (session === null) {
      throw new SectionStatusError('NO_SESSION', 'Log in before requesting live SIS status');
    }

    try {
      const result = await this.options.availabilityClient.checkSection({
        cookiesPayload: session.sessionData,
        crseId: existing.crseId,
        crseOfferNbr: existing.crseOfferNbr,
        term,
        classNumber,
        acadCareer: existing.acadCareer ?? 'UGRD',
        institution: existing.institution ?? 'AUIB',
      });
      const checkedAt = new Date();
      const courseTitle = result.description || existing.courseTitle;
      const component = result.component || existing.component;
      const state = {
        term: existing.term,
        ...(existing.termLabel !== null ? { termLabel: existing.termLabel } : {}),
        courseCode: result.courseCode || existing.courseCode,
        ...(courseTitle !== null && courseTitle !== '' ? { courseTitle } : {}),
        crseId: existing.crseId,
        crseOfferNbr: existing.crseOfferNbr,
        acadCareer: existing.acadCareer ?? 'UGRD',
        institution: existing.institution ?? 'AUIB',
        classNumber: result.classNumber || existing.classNumber,
        ...(component !== null && component !== '' ? { component } : {}),
        status: normalizeStatus(result.status),
        availableSeats: result.availableSeats,
        ...((result.schedule ?? previousSnapshot?.schedule) !== undefined &&
        (result.schedule ?? previousSnapshot?.schedule) !== null
          ? { schedule: (result.schedule ?? previousSnapshot?.schedule)! }
          : {}),
        ...((result.meetingDates ?? previousSnapshot?.meetingDates) !== undefined &&
        (result.meetingDates ?? previousSnapshot?.meetingDates) !== null
          ? { meetingDates: (result.meetingDates ?? previousSnapshot?.meetingDates)! }
          : {}),
        ...((result.sessionName ?? previousSnapshot?.sessionName) !== undefined &&
        (result.sessionName ?? previousSnapshot?.sessionName) !== null
          ? { sessionName: (result.sessionName ?? previousSnapshot?.sessionName)! }
          : {}),
        checkedAt,
      };
      const section = await this.options.sectionRepository.upsertSection(state);
      const snapshot = await this.options.sectionRepository.recordSnapshot(section.id, state);
      await this.options.userSessionRepository.updateLastUsed(session.id);
      if (this.observationHandler !== undefined) {
        await this.observationHandler(state).catch((err: unknown) => {
          logger.warn({ err: redactSecrets(err) }, 'Error in onSectionObserved callback');
        });
      }
      return { section, snapshot };
    } catch (error) {
      if (error instanceof PeopleSoftSessionExpiredError) {
        // Attempt silent background auto-refresh via Microsoft KMSI
        const sessionDataObj =
          typeof session.sessionData === 'object' && session.sessionData !== null
            ? (session.sessionData as Record<string, unknown>)
            : null;
        const savedStorageState = sessionDataObj?.storageState;

        if (this.options.authenticator?.refreshSession !== undefined && savedStorageState !== undefined) {
          try {
            const refreshed = await this.options.authenticator.refreshSession(savedStorageState);
            if (refreshed !== null && refreshed.cookies.length > 0) {
              const updatedSessionData = {
                rawCookies: refreshed.cookies,
                ...(refreshed.storageState !== undefined
                  ? { storageState: refreshed.storageState }
                  : { storageState: savedStorageState }),
                ...(sessionDataObj?.rawSession !== undefined
                  ? { rawSession: sessionDataObj.rawSession }
                  : {}),
              };

              await this.options.userSessionRepository.saveUserSession({
                userId,
                sessionData: updatedSessionData,
                encryptionKey: this.options.encryptionKey,
                ...(refreshed.expiresAt !== undefined ? { expiresAt: refreshed.expiresAt } : {}),
              });

              // Retry checkSection with refreshed cookies
              const retryResult = await this.options.availabilityClient.checkSection({
                cookiesPayload: updatedSessionData,
                crseId: existing.crseId,
                crseOfferNbr: existing.crseOfferNbr,
                term,
                classNumber,
                acadCareer: existing.acadCareer ?? 'UGRD',
                institution: existing.institution ?? 'AUIB',
              });

              const checkedAt = new Date();
              const courseTitle = retryResult.description || existing.courseTitle;
              const component = retryResult.component || existing.component;
              const state = {
                term: existing.term,
                ...(existing.termLabel !== null ? { termLabel: existing.termLabel } : {}),
                courseCode: retryResult.courseCode || existing.courseCode,
                ...(courseTitle !== null && courseTitle !== '' ? { courseTitle } : {}),
                crseId: existing.crseId,
                crseOfferNbr: existing.crseOfferNbr,
                acadCareer: existing.acadCareer ?? 'UGRD',
                institution: existing.institution ?? 'AUIB',
                classNumber: retryResult.classNumber || existing.classNumber,
                ...(component !== null && component !== '' ? { component } : {}),
                status: normalizeStatus(retryResult.status),
                availableSeats: retryResult.availableSeats,
                ...((retryResult.schedule ?? previousSnapshot?.schedule) !== undefined &&
                (retryResult.schedule ?? previousSnapshot?.schedule) !== null
                  ? { schedule: (retryResult.schedule ?? previousSnapshot?.schedule)! }
                  : {}),
                ...((retryResult.meetingDates ?? previousSnapshot?.meetingDates) !== undefined &&
                (retryResult.meetingDates ?? previousSnapshot?.meetingDates) !== null
                  ? { meetingDates: (retryResult.meetingDates ?? previousSnapshot?.meetingDates)! }
                  : {}),
                ...((retryResult.sessionName ?? previousSnapshot?.sessionName) !== undefined &&
                (retryResult.sessionName ?? previousSnapshot?.sessionName) !== null
                  ? { sessionName: (retryResult.sessionName ?? previousSnapshot?.sessionName)! }
                  : {}),
                checkedAt,
              };
              const section = await this.options.sectionRepository.upsertSection(state);
              const snapshot = await this.options.sectionRepository.recordSnapshot(section.id, state);
              if (this.observationHandler !== undefined) {
                await this.observationHandler(state).catch((err: unknown) => {
                  logger.warn({ err: redactSecrets(err) }, 'Error in onSectionObserved callback');
                });
              }
              return { section, snapshot };
            }
          } catch {
            // Fall through to markExpired if refresh fails
          }
        }

        await this.options.userSessionRepository.markExpired(session.id);
        throw new SectionStatusError('SESSION_EXPIRED', 'Your SIS session expired; use /login');
      }
      throw error;
    }
  }
}
