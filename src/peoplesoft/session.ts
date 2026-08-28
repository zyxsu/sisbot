export type SessionOwner =
  | Readonly<{ type: 'SHARED_POOL'; id: null }>
  | Readonly<{ type: 'TELEGRAM_USER'; id: string }>
  | Readonly<{ type: 'MANUAL'; id: string | null }>
  | Readonly<{ type: 'FIXTURE'; id: null }>;

export type PeopleSoftSessionStatus = 'ACTIVE' | 'EXPIRED' | 'DISABLED';

export type SessionTask<T> = () => T | PromiseLike<T>;

/**
 * An isolated, already-authorized PeopleSoft component context.
 *
 * Authentication and transport are intentionally outside this abstraction.
 * Every stateful workflow using one session must enter through `runSerialized`.
 */
export interface PeopleSoftSession {
  readonly id: string;
  readonly owner: SessionOwner;
  readonly status: PeopleSoftSessionStatus;

  runSerialized<T>(task: SessionTask<T>): Promise<T>;
  markActive(): void;
  markExpired(): void;
  disable(): void;
  whenIdle(): Promise<void>;
}

export interface MonitoringSessionOptions {
  readonly id: string;
  readonly owner: SessionOwner;
  readonly status?: PeopleSoftSessionStatus;
}

export class PeopleSoftSessionUnavailableError extends Error {
  public constructor(
    public readonly sessionId: string,
    public readonly sessionStatus: Exclude<PeopleSoftSessionStatus, 'ACTIVE'>,
  ) {
    super(`PeopleSoft session is ${sessionStatus.toLowerCase()}`);
    this.name = 'PeopleSoftSessionUnavailableError';
  }
}

export function assertPeopleSoftSessionActive(session: PeopleSoftSession): void {
  if (session.status !== 'ACTIVE') {
    throw new PeopleSoftSessionUnavailableError(session.id, session.status);
  }
}

/**
 * Offline session primitive with a per-instance FIFO queue.
 *
 * A rejected task does not poison the queue. Separate instances do not share a
 * lock and can therefore be scheduled independently by a global rate limiter.
 */
export class MonitoringSession implements PeopleSoftSession {
  readonly id: string;
  readonly owner: SessionOwner;

  private currentStatus: PeopleSoftSessionStatus;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(options: MonitoringSessionOptions) {
    this.id = options.id;
    this.owner = Object.freeze({ ...options.owner });
    this.currentStatus = options.status ?? 'ACTIVE';
  }

  get status(): PeopleSoftSessionStatus {
    return this.currentStatus;
  }

  runSerialized<T>(task: SessionTask<T>): Promise<T> {
    const result = this.queueTail.then(() => {
      assertPeopleSoftSessionActive(this);

      return task();
    });

    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  markActive(): void {
    this.currentStatus = 'ACTIVE';
  }

  markExpired(): void {
    this.currentStatus = 'EXPIRED';
  }

  disable(): void {
    this.currentStatus = 'DISABLED';
  }

  async whenIdle(): Promise<void> {
    await this.queueTail;
  }
}
