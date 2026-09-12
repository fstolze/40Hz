/**
 * Playback transition ordering.
 *
 * The races these guard against are invisible in a screenshot and awkward to
 * reach through a real AudioContext, so the ordering is tested directly:
 * a start and a stop issued close together must leave playback in the state
 * the user asked for last, whichever one's internal awaits resolve first.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { TransitionQueue } from '../src/audio/transitions.ts';

/** Resolves after `turns` microtask turns, standing in for an await on the context. */
async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe('generations', () => {
  it('hands out increasing tokens', () => {
    const q = new TransitionQueue();
    expect(q.claim()).toBe(1);
    expect(q.claim()).toBe(2);
    expect(q.current).toBe(2);
  });

  it('marks an earlier token stale as soon as a later one is claimed', () => {
    const q = new TransitionQueue();
    const first = q.claim();
    expect(q.isCurrent(first)).toBe(true);
    q.claim();
    expect(q.isCurrent(first)).toBe(false);
  });
});

describe('serialization', () => {
  it('never runs two operations at once', async () => {
    const q = new TransitionQueue();
    const log: string[] = [];
    let inFlight = 0;
    let overlapped = false;

    const op = (name: string, delay: number) =>
      q.run(async () => {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        log.push(`${name}:start`);
        await turns(delay);
        log.push(`${name}:end`);
        inFlight--;
      });

    await Promise.all([op('a', 3), op('b', 1), op('c', 2)]);

    expect(overlapped).toBe(false);
    expect(log.join(',')).toBe('a:start,a:end,b:start,b:end,c:start,c:end');
  });

  it('keeps running after an operation throws', async () => {
    const q = new TransitionQueue();
    const log: string[] = [];

    const failing = q.run(async () => {
      throw new Error('boom');
    });
    // The caller still sees the failure...
    let seen = '';
    await failing.catch((e: unknown) => {
      seen = e instanceof Error ? e.message : String(e);
    });
    // ...but the queue is not wedged behind it.
    await q.run(async () => {
      log.push('after');
    });

    expect(seen).toBe('boom');
    expect(log.join(',')).toBe('after');
  });
});

describe('the races this exists to close', () => {
  it('a stop cannot suspend playback that started while it was suspending', async () => {
    const q = new TransitionQueue();
    let running = true;

    // Stop: decides to suspend, then awaits the context doing so.
    const stopGeneration = q.claim();
    const stop = q.run(async () => {
      if (!q.isCurrent(stopGeneration)) return;
      await turns(2);
      running = false;
    });

    // Start arrives while that suspend is in flight.
    const startGeneration = q.claim();
    const start = q.run(async () => {
      if (!q.isCurrent(startGeneration)) return;
      await turns(1);
      running = true;
    });

    await Promise.all([stop, start]);

    // The start ran after the suspend completed, so playback survives.
    expect(running).toBe(true);
  });

  it('a start cannot outrank a stop the user issued later', async () => {
    const q = new TransitionQueue();
    let running = false;

    // Start claims first, but its resume is slow.
    const startGeneration = q.claim();
    const start = q.run(async () => {
      if (!q.isCurrent(startGeneration)) return;
      await turns(3);
      if (!q.isCurrent(startGeneration)) return;
      running = true;
    });

    // The user then asks to stop, before the start has finished resuming.
    const stopGeneration = q.claim();
    const stop = q.run(async () => {
      if (!q.isCurrent(stopGeneration)) return;
      running = false;
    });

    await Promise.all([start, stop]);

    // The later intent wins. Claiming before awaiting is what makes this
    // hold: ordering follows the request, not whichever await resolved first.
    expect(running).toBe(false);
  });

  it('a superseded operation does no work at all', async () => {
    const q = new TransitionQueue();
    let sideEffects = 0;

    const stale = q.claim();
    q.claim(); // someone else takes over immediately

    await q.run(async () => {
      if (!q.isCurrent(stale)) return;
      sideEffects++;
    });

    expect(sideEffects).toBe(0);
  });
});
