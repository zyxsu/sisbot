import { describe, expect, it } from 'vitest';

import { loadEnvironment } from '../../src/config/env.js';

describe('loadEnvironment', () => {
  it('uses conservative offline defaults', () => {
    const environment = loadEnvironment({});

    expect(environment.PEOPLESOFT_LIVE_ENABLED).toBe(false);
    expect(environment.POLL_INTERVAL_SECONDS).toBe(300);
    expect(environment.MIN_REQUEST_DELAY_MS).toBe(1000);
    expect(environment.MAX_CONCURRENT_SESSIONS).toBe(2);
  });

  it('parses an explicit false string as false', () => {
    expect(loadEnvironment({ PEOPLESOFT_LIVE_ENABLED: 'false' }).PEOPLESOFT_LIVE_ENABLED).toBe(
      false,
    );
  });

  it('rejects polling intervals below the safe minimum', () => {
    expect(() => loadEnvironment({ POLL_INTERVAL_SECONDS: '5' })).toThrow();
  });

  it('requires an encryption key before live mode can be enabled', () => {
    expect(() => loadEnvironment({ PEOPLESOFT_LIVE_ENABLED: 'true' })).toThrow(
      /SESSION_ENCRYPTION_KEY/,
    );
  });
});
