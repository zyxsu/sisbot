import { describe, expect, it } from 'vitest';

import {
  assertPeopleSoftLiveModeEnabled,
  PeopleSoftLiveModeDisabledError,
} from '../../src/peoplesoft/live-mode.js';

describe('assertPeopleSoftLiveModeEnabled', () => {
  it('refuses live PeopleSoft work by default', () => {
    expect(() => assertPeopleSoftLiveModeEnabled({ PEOPLESOFT_LIVE_ENABLED: false })).toThrow(
      PeopleSoftLiveModeDisabledError,
    );
  });

  it('allows a future live transport only after explicit opt-in', () => {
    expect(() => assertPeopleSoftLiveModeEnabled({ PEOPLESOFT_LIVE_ENABLED: true })).not.toThrow();
  });
});
