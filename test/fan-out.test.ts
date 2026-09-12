/**
 * One subscription, many listeners.
 *
 * The preload keeps a single handler slot per channel, so without this the
 * last component to subscribe in a window displaces the one before it — and
 * closing a dialog leaves its replacement installed, so the panel behind it
 * stops updating for the rest of the session.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { fanOut } from '../src/renderer/lib/fan-out.ts';

/** A fake channel: records how often it was registered, and can push. */
function channel<T>(initial: T) {
  let registrations = 0;
  let push: (value: T) => void = () => {};
  const subscribe = fanOut<T>(async (onChange) => {
    registrations += 1;
    push = onChange;
    return initial;
  });
  return {
    subscribe,
    send: (value: T) => push(value),
    get registrations() {
      return registrations;
    },
  };
}

/** Let the underlying registration promise settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('several listeners on one channel', () => {
  it('registers underneath exactly once', async () => {
    const c = channel(0);
    c.subscribe(() => {});
    c.subscribe(() => {});
    await flush();
    expect(c.registrations).toBe(1);
  });

  it('delivers to all of them, not just the last', async () => {
    // The defect this exists to prevent.
    const c = channel(0);
    const first: number[] = [];
    const second: number[] = [];
    c.subscribe((v) => first.push(v));
    c.subscribe((v) => second.push(v));
    await flush();

    c.send(7);
    expect(first.at(-1)).toBe(7);
    expect(second.at(-1)).toBe(7);
  });

  it('hands each one the current value without waiting for a change', async () => {
    const c = channel(3);
    const seen: number[] = [];
    c.subscribe((v) => seen.push(v));
    await flush();
    expect(seen[0]).toBe(3);
  });

  it('hands a late subscriber the most recent value, not the first', async () => {
    // By the time it subscribes the initial value is stale, and answering with
    // it would be worse than answering with nothing.
    const c = channel(0);
    c.subscribe(() => {});
    await flush();
    c.send(9);

    const late: number[] = [];
    c.subscribe((v) => late.push(v));
    expect(late[0]).toBe(9);
  });
});

describe('unsubscribing', () => {
  it('stops delivery to that listener alone', async () => {
    const c = channel(0);
    const kept: number[] = [];
    const dropped: number[] = [];
    c.subscribe((v) => kept.push(v));
    const stop = c.subscribe((v) => dropped.push(v));
    await flush();

    stop();
    c.send(5);
    expect(kept.at(-1)).toBe(5);
    expect(dropped.includes(5)).toBe(false);
  });

  it('survives a listener that unsubscribes while being called', async () => {
    // Shortening the set mid-iteration would skip whoever came after it.
    const c = channel(0);
    const after: number[] = [];
    let stop = () => {};
    stop = c.subscribe(() => stop());
    c.subscribe((v) => after.push(v));
    await flush();

    c.send(4);
    expect(after.at(-1)).toBe(4);
  });

  it('does not deliver to a listener that left before registration settled', async () => {
    const c = channel(1);
    const seen: number[] = [];
    const stop = c.subscribe((v) => seen.push(v));
    stop();
    await flush();
    expect(seen.length).toBe(0);
  });
});
