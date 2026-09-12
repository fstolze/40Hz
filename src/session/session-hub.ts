/**
 * Publishes session state to whoever is watching.
 *
 * The problem this exists to solve: a popover opened while a session is
 * already running has no way to learn the state from change events alone, and
 * fetching the state and then subscribing leaves a window in which a change
 * can slip through unseen.
 *
 * So subscribing *is* how the current state is obtained. `subscribe` returns
 * the snapshot and its revision together, as one step, and every later event
 * carries a strictly increasing revision — a subscriber that has somehow seen
 * a newer one can discard what arrives late or out of order.
 *
 * No Electron: the transport is a callback, so the ordering is tested here and
 * main only forwards.
 */

export interface Published<T> {
  snapshot: T;
  revision: number;
}

export type Subscriber<T> = (update: Published<T>) => void;

export class SessionHub<T> {
  private snapshot: T;
  /**
   * How to detach a snapshot before handing it out.
   *
   * Without it every reader and subscriber shares one object, so a single
   * mutation reaches all of them and the hub's own copy. Defaults to handing
   * the value through, for state that is already immutable.
   */
  private readonly clone: (value: T) => T;
  private revision = 0;
  private readonly subscribers = new Map<number, Subscriber<T>>();
  private readonly byKey = new Map<string | number, () => void>();
  private nextSubscriberId = 1;

  constructor(initial: T, clone: (value: T) => T = (v) => v) {
    this.snapshot = initial;
    this.clone = clone;
  }

  /** The state and its revision, without subscribing. */
  current(): Published<T> {
    return { snapshot: this.clone(this.snapshot), revision: this.revision };
  }

  /**
   * Watch for changes, receiving the current state as part of registering.
   *
   * Returns an unsubscribe function alongside the initial value, so there is
   * no gap between reading and listening.
   */
  subscribe(subscriber: Subscriber<T>): { initial: Published<T>; unsubscribe: () => void } {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, subscriber);
    return {
      initial: this.current(),
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  /**
   * Subscribe on behalf of `key`, replacing any subscription it already has.
   *
   * A window that subscribes twice would otherwise be represented by two
   * subscribers pointed at one renderer, so a single publish would arrive
   * there twice carrying the same revision — breaking the guarantee that a
   * subscriber can rely on revisions strictly increasing.
   */
  subscribeUnique(
    key: string | number,
    subscriber: Subscriber<T>,
  ): { initial: Published<T>; unsubscribe: () => void } {
    this.byKey.get(key)?.();
    const { initial, unsubscribe } = this.subscribe(subscriber);
    const release = (): void => {
      unsubscribe();
      if (this.byKey.get(key) === release) this.byKey.delete(key);
    };
    this.byKey.set(key, release);
    return { initial, unsubscribe: release };
  }

  /** Drop whatever subscription `key` holds, if any. */
  unsubscribeKey(key: string | number): void {
    this.byKey.get(key)?.();
  }

  /**
   * Replace the state and tell everyone.
   *
   * The revision advances on every publish, including one that happens to
   * carry an equal-looking snapshot, so revisions order events rather than
   * describing content.
   */
  publish(snapshot: T): Published<T> {
    this.snapshot = snapshot;
    this.revision++;
    // Each subscriber gets its own copy, so one mutating what it received
    // cannot reach the others or the hub.
    for (const subscriber of [...this.subscribers.values()]) {
      subscriber(this.current());
    }
    return this.current();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
