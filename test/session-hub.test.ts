/**
 * Session state publication.
 *
 * The case that matters: a popover opened while a session is already running.
 * Change events alone cannot tell it anything, and fetching state then
 * subscribing leaves a gap in which a change can pass unseen — so subscribing
 * has to *be* how the state is obtained.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { SessionHub, type Published } from '../src/session/session-hub.ts';

interface State {
  phase: string;
}

describe('subscribing', () => {
  it('returns the current state as part of registering', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    hub.publish({ phase: 'running' });

    // A subscriber arriving mid-session learns the state from subscribing
    // itself, not from waiting for the next change.
    const { initial } = hub.subscribe(() => {});
    expect(initial.snapshot.phase).toBe('running');
    expect(initial.revision).toBe(1);
  });

  it('leaves no gap between reading and listening', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const seen: Published<State>[] = [];
    const { initial } = hub.subscribe((u) => seen.push(u));
    hub.publish({ phase: 'running' });

    // Every revision after the initial one is accounted for.
    expect(initial.revision).toBe(0);
    expect(seen.map((u) => u.revision).join(',')).toBe('1');
  });

  it('stops delivering after unsubscribing', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const seen: number[] = [];
    const { unsubscribe } = hub.subscribe((u) => seen.push(u.revision));
    hub.publish({ phase: 'a' });
    unsubscribe();
    hub.publish({ phase: 'b' });
    expect(seen.join(',')).toBe('1');
    expect(hub.subscriberCount).toBe(0);
  });

  it('serves several subscribers', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const a: number[] = [];
    const b: number[] = [];
    hub.subscribe((u) => a.push(u.revision));
    hub.subscribe((u) => b.push(u.revision));
    hub.publish({ phase: 'running' });
    expect(a.join(',')).toBe('1');
    expect(b.join(',')).toBe('1');
  });

  it('survives a subscriber unsubscribing while being notified', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const seen: string[] = [];
    const first = hub.subscribe(() => {
      seen.push('first');
      first.unsubscribe();
    });
    hub.subscribe(() => seen.push('second'));
    hub.publish({ phase: 'running' });
    expect(seen.join(',')).toBe('first,second');
  });
});

describe('revisions', () => {
  it('increase strictly, so a late event can be discarded', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const seen: number[] = [];
    hub.subscribe((u) => seen.push(u.revision));
    hub.publish({ phase: 'a' });
    hub.publish({ phase: 'b' });
    hub.publish({ phase: 'c' });
    expect(seen.join(',')).toBe('1,2,3');
  });

  it('advance even when the snapshot looks the same', () => {
    // Revisions order events; they do not describe content.
    const hub = new SessionHub<State>({ phase: 'idle' });
    hub.publish({ phase: 'idle' });
    hub.publish({ phase: 'idle' });
    expect(hub.current().revision).toBe(2);
  });

  it('match what publish reported', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const published = hub.publish({ phase: 'running' });
    expect(published.revision).toBe(hub.current().revision);
    expect(published.snapshot.phase).toBe('running');
  });
});

describe('one subscription per window', () => {
  it('replaces rather than adds when the same key subscribes again', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const seen: number[] = [];
    hub.subscribeUnique('window-1', (u) => seen.push(u.revision));
    hub.subscribeUnique('window-1', (u) => seen.push(u.revision));

    hub.publish({ phase: 'running' });

    // Two subscribers pointed at one window would deliver the same revision
    // twice, so a subscriber could no longer rely on revisions increasing.
    expect(hub.subscriberCount).toBe(1);
    expect(seen.join(',')).toBe('1');
  });

  it('keeps revisions strictly increasing across a re-subscribe', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const seen: number[] = [];
    hub.subscribeUnique('window-1', (u) => seen.push(u.revision));
    hub.publish({ phase: 'a' });
    hub.subscribeUnique('window-1', (u) => seen.push(u.revision));
    hub.publish({ phase: 'b' });
    hub.publish({ phase: 'c' });
    expect(seen.join(',')).toBe('1,2,3');
  });

  it('hands the re-subscriber the current state', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    hub.subscribeUnique('window-1', () => {});
    hub.publish({ phase: 'running' });
    const { initial } = hub.subscribeUnique('window-1', () => {});
    expect(initial.snapshot.phase).toBe('running');
    expect(initial.revision).toBe(1);
  });

  it('keeps separate windows separate', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const a: number[] = [];
    const b: number[] = [];
    hub.subscribeUnique('window-1', (u) => a.push(u.revision));
    hub.subscribeUnique('window-2', (u) => b.push(u.revision));
    hub.publish({ phase: 'running' });
    expect(hub.subscriberCount).toBe(2);
    expect(a.join(',')).toBe('1');
    expect(b.join(',')).toBe('1');
  });

  it('forgets the key once unsubscribed, so a later subscribe is fresh', () => {
    const hub = new SessionHub<State>({ phase: 'idle' });
    const seen: number[] = [];
    const { unsubscribe } = hub.subscribeUnique('window-1', () => seen.push(0));
    unsubscribe();
    expect(hub.subscriberCount).toBe(0);
    hub.subscribeUnique('window-1', (u) => seen.push(u.revision));
    hub.publish({ phase: 'running' });
    expect(hub.subscriberCount).toBe(1);
    expect(seen.join(',')).toBe('1');
  });
});
