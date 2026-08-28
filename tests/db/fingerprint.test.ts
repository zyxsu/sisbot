import { describe, expect, it } from 'vitest';
import { NotificationLogRepository } from '../../src/db/repositories/notification-log-repository.js';

describe('NotificationLogRepository.buildFingerprint', () => {
  const userId = 'user-uuid-123';
  const sectionId = 'section-uuid-456';

  it('produces identical fingerprints for identical transition events within same time bucket', () => {
    const fp1 = NotificationLogRepository.buildFingerprint(
      userId,
      sectionId,
      {
        fromStatus: 'CLOSED',
        toStatus: 'OPEN',
        fromSeats: 0,
        toSeats: 5,
      },
      1,
    );

    const fp2 = NotificationLogRepository.buildFingerprint(
      userId,
      sectionId,
      {
        fromStatus: 'CLOSED',
        toStatus: 'OPEN',
        fromSeats: 0,
        toSeats: 5,
      },
      1,
    );

    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64); // SHA-256 hex string
  });

  it('produces different fingerprints for different users', () => {
    const fp1 = NotificationLogRepository.buildFingerprint(
      'user-1',
      sectionId,
      { fromStatus: 'CLOSED', toStatus: 'OPEN' },
      1,
    );

    const fp2 = NotificationLogRepository.buildFingerprint(
      'user-2',
      sectionId,
      { fromStatus: 'CLOSED', toStatus: 'OPEN' },
      1,
    );

    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprints for different seat count transitions', () => {
    const fp1 = NotificationLogRepository.buildFingerprint(
      userId,
      sectionId,
      { fromStatus: 'OPEN', toStatus: 'OPEN', fromSeats: 2, toSeats: 5 },
      1,
    );

    const fp2 = NotificationLogRepository.buildFingerprint(
      userId,
      sectionId,
      { fromStatus: 'OPEN', toStatus: 'OPEN', fromSeats: 2, toSeats: 8 },
      1,
    );

    expect(fp1).not.toBe(fp2);
  });
});
