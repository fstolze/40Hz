import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrayAvailability,
  monitorTray,
  type TrayRetryScheduler,
} from '../electron/tray-availability.ts';
import { registeredTrayServices } from '../electron/linux-tray.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Linux tray registration', () => {
  it('requires a host, accepts GNOME and KDE item paths, and deduplicates connections', () => {
    const items =
      "'RegisteredStatusNotifierItems': <[':1.57@/org/ayatana/NotificationItem/a', ':1.57@/org/ayatana/NotificationItem/b', ':1.99/StatusNotifierItem', 'org.kde.StatusNotifierItem-123-1']>";
    assert.deepEqual(
      registeredTrayServices(`({'IsStatusNotifierHostRegistered': <true>, ${items}},)`),
      [':1.57', ':1.99', 'org.kde.StatusNotifierItem-123-1'],
    );
    assert.deepEqual(
      registeredTrayServices(`({'IsStatusNotifierHostRegistered': <false>, ${items}},)`),
      [],
    );
    assert.deepEqual(
      registeredTrayServices(
        "({'IsStatusNotifierHostRegistered': <true>, 'RegisteredStatusNotifierItems': <@as []>},)",
      ),
      [],
    );
    assert.deepEqual(registeredTrayServices('garbage'), []);
  });
});

function retryClock() {
  const tasks: { task: () => void; cancelled: boolean; delay: number }[] = [];
  const scheduler: TrayRetryScheduler = {
    later(task, delay) {
      const pending = { task, delay, cancelled: false };
      tasks.push(pending);
      return () => {
        pending.cancelled = true;
      };
    },
  };
  return {
    scheduler,
    get pending() {
      return tasks.filter((task) => !task.cancelled).length;
    },
    async next() {
      const task = tasks.shift();
      assert.ok(task && !task.cancelled, 'a retry was scheduled');
      assert.ok(task.delay > 0 && task.delay <= 5000, 'retry backoff is bounded');
      task.task();
      await flush();
    },
  };
}

describe('tray availability', () => {
  it('returns the current value, announces only changes, and unsubscribes', () => {
    const state = new TrayAvailability();
    state.set(true);
    const seen: boolean[] = [];
    const subscription = state.subscribe((value) => seen.push(value));
    assert.equal(subscription.initial, true);
    assert.deepEqual(seen, []);
    state.set(true);
    state.set(false);
    state.set(false);
    subscription.unsubscribe();
    state.set(true);
    assert.deepEqual(seen, [false]);
  });

  it('tracks host loss and reappearance without polling', async () => {
    const state = new TrayAvailability();
    let registered = true;
    let changed = () => {};
    let unwatched = false;
    const stop = monitorTray(
      {
        read: async () => registered,
        watch(onChange) {
          changed = onChange;
          return () => {
            unwatched = true;
          };
        },
      },
      state,
    );
    await flush();
    assert.equal(state.current, true);
    registered = false;
    changed();
    await flush();
    assert.equal(state.current, false);
    registered = true;
    changed();
    await flush();
    assert.equal(state.current, true);
    stop();
    assert.equal(state.current, false);
    assert.equal(unwatched, true);
  });

  it('does not publish a stale successful read after a host change', async () => {
    const state = new TrayAvailability();
    const seen: boolean[] = [];
    state.subscribe((value) => seen.push(value));
    let complete!: (value: boolean) => void;
    let reads = 0;
    let changed = () => {};
    const stop = monitorTray(
      {
        read: () =>
          ++reads === 1
            ? new Promise((resolve) => {
                complete = resolve;
              })
            : Promise.resolve(false),
        watch(onChange) {
          changed = onChange;
          return () => {};
        },
      },
      state,
    );
    changed();
    complete(true);
    await flush();
    assert.equal(reads, 2);
    assert.deepEqual(seen, [false]);
    assert.equal(state.current, false);
    stop();
  });

  it('fails closed on monitor failure and ignores reads completing afterwards', async () => {
    const state = new TrayAvailability();
    let complete!: (value: boolean) => void;
    let fail = () => {};
    const stop = monitorTray(
      {
        read: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
        watch(_changed, failed) {
          fail = failed;
          return () => {};
        },
      },
      state,
    );
    fail();
    complete(true);
    await flush();
    assert.equal(state.current, false);
    stop();
  });

  it('keeps residency through a transient read failure and retries without another signal', async () => {
    const state = new TrayAvailability();
    state.set(true);
    const changes: boolean[] = [];
    state.subscribe((available) => changes.push(available));
    const clock = retryClock();
    let reads = 0;
    const stop = monitorTray(
      {
        read: async () => {
          if (++reads === 1) throw new Error('timeout');
          return true;
        },
        watch() {
          return () => {};
        },
      },
      state,
      clock.scheduler,
    );
    await flush();
    assert.equal(state.current, true);
    assert.equal(clock.pending, 1);
    await clock.next();
    assert.equal(reads, 2);
    assert.equal(state.current, true);
    assert.deepEqual(changes, []);
    stop();
  });

  it('withdraws after repeated errors and automatically restores residency when reads recover', async () => {
    const state = new TrayAvailability();
    state.set(true);
    const clock = retryClock();
    let broken = true;
    const stop = monitorTray(
      {
        read: async () => {
          if (broken) throw new Error('bus unavailable');
          return true;
        },
        watch() {
          return () => {};
        },
      },
      state,
      clock.scheduler,
    );
    await flush();
    assert.equal(state.current, true);
    await clock.next();
    assert.equal(state.current, false);
    assert.equal(clock.pending, 1);
    broken = false;
    await clock.next();
    assert.equal(state.current, true);
    assert.equal(clock.pending, 0);
    stop();
  });

  it('cancels a scheduled retry on shutdown', async () => {
    const state = new TrayAvailability();
    const clock = retryClock();
    const stop = monitorTray(
      {
        read: async () => {
          throw new Error('timeout');
        },
        watch() {
          return () => {};
        },
      },
      state,
      clock.scheduler,
    );
    await flush();
    assert.equal(clock.pending, 1);
    stop();
    assert.equal(clock.pending, 0);
  });
});
