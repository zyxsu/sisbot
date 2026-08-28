import type { Environment } from '../config/env.js';

export class PeopleSoftLiveModeDisabledError extends Error {
  public constructor() {
    super('Live PeopleSoft requests are disabled');
    this.name = 'PeopleSoftLiveModeDisabledError';
  }
}

/**
 * Every future live transport entry point must call this guard before issuing
 * an HTTP request. Offline fixture parsers do not need it because they never
 * perform network I/O.
 */
export function assertPeopleSoftLiveModeEnabled(
  environment: Pick<Environment, 'PEOPLESOFT_LIVE_ENABLED'>,
): void {
  if (!environment.PEOPLESOFT_LIVE_ENABLED) {
    throw new PeopleSoftLiveModeDisabledError();
  }
}
