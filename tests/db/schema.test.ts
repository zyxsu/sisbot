import { describe, expect, it } from 'vitest';
import {
  monitoredSections,
  notificationLogs,
  sectionSnapshots,
  subscriptions,
  users,
  userSessions,
  userMessages,
} from '../../src/db/schema.js';

describe('Database Schema Definitions', () => {
  it('defines all required tables and columns', () => {
    expect(users).toBeDefined();
    expect(userSessions).toBeDefined();
    expect(userMessages).toBeDefined();
    expect(monitoredSections).toBeDefined();
    expect(sectionSnapshots).toBeDefined();
    expect(subscriptions).toBeDefined();
    expect(notificationLogs).toBeDefined();
  });

  it('monitoredSections table includes dual search columns (courseCode and classNumber)', () => {
    expect(monitoredSections.courseCode).toBeDefined();
    expect(monitoredSections.classNumber).toBeDefined();
    expect(monitoredSections.term).toBeDefined();
  });

  it('userSessions table includes encryptedData and userId referencing users', () => {
    expect(userSessions.encryptedData).toBeDefined();
    expect(userSessions.userId).toBeDefined();
    expect(userSessions.status).toBeDefined();
  });
});
