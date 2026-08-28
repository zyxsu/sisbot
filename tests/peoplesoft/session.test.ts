import { describe, expect, it } from 'vitest';

import {
  MonitoringSession,
  PeopleSoftSessionUnavailableError,
} from '../../src/peoplesoft/session.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function fixtureSession(id: string): MonitoringSession {
  return new MonitoringSession({
    id,
    owner: { type: 'FIXTURE', id: null },
  });
}

describe('MonitoringSession', () => {
  it('serializes stateful work submitted to the same session', async () => {
    const session = fixtureSession('fixture-a');
    const firstGate = deferred();
    const events: string[] = [];

    const first = session.runSerialized(async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 1;
    });
    const second = session.runSerialized(() => {
      events.push('second:start');
      events.push('second:end');
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not share a lock between distinct sessions', async () => {
    const sessionA = fixtureSession('fixture-a');
    const sessionB = fixtureSession('fixture-b');
    const gateA = deferred();
    const events: string[] = [];

    const taskA = sessionA.runSerialized(async () => {
      events.push('a:start');
      await gateA.promise;
      events.push('a:end');
    });
    const taskB = sessionB.runSerialized(() => {
      events.push('b:start');
      events.push('b:end');
    });

    await taskB;
    expect(events).toEqual(['a:start', 'b:start', 'b:end']);

    gateA.resolve();
    await taskA;
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('continues processing queued work after a task rejects', async () => {
    const session = fixtureSession('fixture-a');

    const failed = session.runSerialized(() => {
      throw new Error('fixture failure');
    });
    const recovered = session.runSerialized(() => 'next task completed');

    await expect(failed).rejects.toThrow('fixture failure');
    await expect(recovered).resolves.toBe('next task completed');
    await expect(session.whenIdle()).resolves.toBeUndefined();
  });

  it('tracks explicit session lifecycle status without authentication behavior', () => {
    const session = fixtureSession('fixture-a');

    expect(session.status).toBe('ACTIVE');
    session.markExpired();
    expect(session.status).toBe('EXPIRED');
    session.markActive();
    expect(session.status).toBe('ACTIVE');
    session.disable();
    expect(session.status).toBe('DISABLED');
  });

  it.each(['EXPIRED', 'DISABLED'] as const)(
    'refuses work while the session is %s',
    async (status) => {
      const session = fixtureSession('fixture-a');

      if (status === 'EXPIRED') {
        session.markExpired();
      } else {
        session.disable();
      }

      await expect(session.runSerialized(() => 'must not run')).rejects.toMatchObject({
        sessionId: 'fixture-a',
        sessionStatus: status,
      });
      await expect(session.runSerialized(() => 'must not run')).rejects.toBeInstanceOf(
        PeopleSoftSessionUnavailableError,
      );
    },
  );
});
