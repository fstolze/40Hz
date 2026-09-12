/**
 * The session coordinator.
 *
 * These are the cases `npm run dev:web` structurally cannot reach: a stop
 * overtaking a start still in flight, a crash between persisting a record and
 * clearing the checkpoint that backs it up, a wall clock jumping mid-session.
 * Extracting the machine from Electron is what makes them assertable at all.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { FakeClock, FakeExecutor, FakeScheduler, FakeStorage } from './helpers/fakes.ts';
import { SessionCoordinator, HEARTBEAT_SECONDS } from '../src/session/coordinator.ts';
import { MAX_SESSION_FINDINGS } from '../src/integrity/normalize.ts';
import { defaultConfiguration } from '../src/audio/configuration.ts';

const WALL_START = 1_700_000_000_000;

interface Harness {
  coordinator: SessionCoordinator;
  clock: FakeClock;
  scheduler: FakeScheduler;
  storage: FakeStorage;
  executor: FakeExecutor;
}

function harness(
  executor = new FakeExecutor(),
  storage = new FakeStorage(),
  clock = new FakeClock(WALL_START),
): Harness {
  const scheduler = new FakeScheduler();
  executor.startedAtWall = WALL_START;
  let n = 0;
  const coordinator = new SessionCoordinator({
    clock,
    scheduler,
    storage,
    executor,
    newId: () => `s${++n}`,
  });
  return { coordinator, clock, scheduler, storage, executor };
}

const request = (plannedSeconds = 600) => ({
  presetId: 'focus',
  configuration: defaultConfiguration(),
  plannedSeconds,
});

/** Yield enough microtask turns for the coordinator's internal awaits to settle. */
async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
    throw new Error('expected a rejection');
  } catch (e) {
    return e as Error;
  }
}

describe('starting a session', () => {
  it('reserves before asking for audio, so a crash inside leaves a trace', async () => {
    const executor = new FakeExecutor({ manualStart: true });
    const { coordinator, storage } = harness(executor);

    const pending = coordinator.startSession(request());
    await executor.reached;

    // Audio has been asked for but not confirmed. The reservation is already
    // on disk, so a crash here is recoverable rather than invisible.
    expect(storage.checkpoint?.phase).toBe('starting');

    await executor.confirmStart(WALL_START);
    await pending;
    expect(storage.checkpoint?.phase).toBe('active');
  });

  it('stamps the start from when audio actually began, not when it was asked for', async () => {
    const executor = new FakeExecutor({ manualStart: true });
    const { coordinator, clock } = harness(executor);

    const pending = coordinator.startSession(request());
    await executor.reached;
    // Resuming a suspended context takes time the caller cannot predict.
    clock.advance(1_500);
    await executor.confirmStart(WALL_START + 1_500);

    const { snapshot } = await pending;
    expect(snapshot.session?.startedAt).toBe(WALL_START + 1_500);
  });

  it('clears the reservation and writes no history when audio fails', async () => {
    const executor = new FakeExecutor({ startError: new Error('graph would not start') });
    const { coordinator, storage } = harness(executor);

    const error = await rejection(coordinator.startSession(request()));

    expect(error.message).toBe('graph would not start');
    expect(storage.checkpoint).toBe(null);
    expect(storage.records.length).toBe(0);
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });

  it('clears the reservation when the start is superseded', async () => {
    const executor = new FakeExecutor({ supersede: true });
    const { coordinator, storage } = harness(executor);
    await coordinator.startSession(request());
    expect(storage.checkpoint).toBe(null);
    expect(storage.records.length).toBe(0);
  });

  it('refuses a second session while one is running', async () => {
    const { coordinator } = harness();
    await coordinator.startSession(request());
    const error = await rejection(coordinator.startSession(request()));
    expect(error.message).toBe('session: one is already running');
  });
});

describe('preview and session cannot overlap', () => {
  it('stops preview as part of starting a session', async () => {
    const { coordinator, executor } = harness();
    await coordinator.startPreview(defaultConfiguration());
    expect(coordinator.getSnapshot().snapshot.state).toBe('previewing');

    await coordinator.startSession(request());

    expect(coordinator.getSnapshot().snapshot.state).toBe('session-active');
    expect(executor.calls.join(',')).toBe('startPreview,stop,startSession');
  });

  it('refuses preview while a session is running', async () => {
    const { coordinator } = harness();
    await coordinator.startSession(request());
    const error = await rejection(coordinator.startPreview(defaultConfiguration()));
    expect(error.message).toBe('preview: a session is running');
  });

  it('leaves preview alone when there is no session', async () => {
    const { coordinator } = harness();
    await coordinator.startPreview(defaultConfiguration());
    await coordinator.stopPreview();
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });
});

describe('a stop racing a start', () => {
  it('withdraws a start still in flight rather than waiting it out', async () => {
    const executor = new FakeExecutor({ manualStart: true });
    const { coordinator, storage } = harness(executor);

    const starting = coordinator.startSession(request());
    await executor.reached;
    const stopping = coordinator.stopSession();

    await rejection(starting);
    await stopping;

    // The user's later intent wins, and the withdrawn start left nothing.
    expect(executor.aborted).toBe(true);
    expect(storage.records.length).toBe(0);
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });
});

describe('finishing', () => {
  it('records a natural completion at the planned duration', async () => {
    const { coordinator, scheduler, clock, storage } = harness();
    await coordinator.startSession(request(600));

    clock.advance(600_000);
    scheduler.advance(600_000);
    await flush();

    expect(storage.records.length).toBe(1);
    expect(storage.records[0].completionReason).toBe('completed');
    expect(storage.records[0].actualSeconds).toBe(600);
    expect(storage.checkpoint).toBe(null);
  });

  it('records a user stop at what was actually heard', async () => {
    const { coordinator, clock, storage } = harness();
    await coordinator.startSession(request(600));

    clock.advance(120_000);
    await coordinator.stopSession();

    expect(storage.records[0].completionReason).toBe('stopped');
    expect(storage.records[0].actualSeconds).toBe(120);
  });

  it('records an interruption at the instant given, not when the news arrived', async () => {
    // Counting time asleep as listening would corrupt the log.
    const { coordinator, clock, storage } = harness();
    await coordinator.startSession(request(600));
    const suspendedAt = clock.wallNow() + 60_000;

    clock.advance(600_000);
    await coordinator.interrupt({ at: suspendedAt });

    expect(storage.records[0].completionReason).toBe('interrupted');
    expect(storage.records[0].actualSeconds).toBe(60);
  });

  it('publishes session-ending before it publishes idle', async () => {
    const { coordinator, clock } = harness();
    const seen: string[] = [];
    coordinator.subscribe((u) => seen.push(u.snapshot.state));
    await coordinator.startSession(request(600));
    clock.advance(60_000);
    await coordinator.stopSession();
    expect(seen.join(',')).toBe('session-active,session-ending,idle');
  });
});

describe('durability', () => {
  it('keeps the checkpoint when the record cannot be persisted', async () => {
    // The checkpoint is the record's only other copy: clearing it here would
    // lose the session outright.
    const storage = new FakeStorage({ failAppends: 1 });
    const { coordinator } = harness(new FakeExecutor(), storage);
    await coordinator.startSession(request(600));

    await rejection(coordinator.stopSession());

    expect(storage.records.length).toBe(0);
    expect(storage.checkpoint?.phase).toBe('active');
  });

  it('finishes the job on the next start, from the surviving checkpoint', async () => {
    const storage = new FakeStorage({ failAppends: 1 });
    const first = harness(new FakeExecutor(), storage);
    await first.coordinator.startSession(request(600));
    first.clock.advance(90_000);
    await rejection(first.coordinator.stopSession());

    const second = harness(new FakeExecutor(), storage);
    await second.coordinator.recover();

    expect(storage.records.length).toBe(1);
    expect(storage.records[0].completionReason).toBe('interrupted');
    expect(storage.checkpoint).toBe(null);
  });

  it('does not duplicate a record when the clear failed after the append', async () => {
    // A crash between persisting and clearing re-appends the same id, which
    // the store deduplicates.
    const storage = new FakeStorage({ failClear: true });
    const { coordinator, clock } = harness(new FakeExecutor(), storage);
    await coordinator.startSession(request(600));
    clock.advance(60_000);
    await rejection(coordinator.stopSession());
    expect(storage.records.length).toBe(1);

    const next = harness(new FakeExecutor(), storage);
    await rejection(next.coordinator.recover());
    expect(storage.records.length).toBe(1);
  });
});

describe('recovery', () => {
  it('discards a reservation that never became audio', async () => {
    const storage = new FakeStorage();
    storage.checkpoint = {
      phase: 'starting',
      id: 's1',
      presetId: 'focus',
      reservedAtWall: WALL_START,
    };
    const { coordinator } = harness(new FakeExecutor(), storage);

    await coordinator.recover();

    // Nothing was heard, so there is nothing honest to record.
    expect(storage.records.length).toBe(0);
    expect(storage.checkpoint).toBe(null);
  });

  it('finalizes at the last heartbeat, not at now', async () => {
    const storage = new FakeStorage();
    const first = harness(new FakeExecutor(), storage);
    await first.coordinator.startSession(request(3600));

    first.clock.advance(HEARTBEAT_SECONDS * 1000);
    first.scheduler.advance(HEARTBEAT_SECONDS * 1000);
    await flush();

    // The app is gone for an hour, then restarts. Only the time it was
    // actually running may be counted.
    const second = harness(new FakeExecutor(), storage, new FakeClock(WALL_START + 3_600_000));
    await second.coordinator.recover();

    expect(storage.records[0].actualSeconds).toBeCloseTo(HEARTBEAT_SECONDS, 3);
    expect(storage.records[0].completionReason).toBe('interrupted');
  });

  it('does nothing without a checkpoint', async () => {
    const { coordinator, storage } = harness();
    await coordinator.recover();
    expect(storage.records.length).toBe(0);
  });
});

describe('the clock', () => {
  it('measures elapsed time monotonically, so a wall-clock jump does not move it', async () => {
    const { coordinator, clock, storage } = harness();
    await coordinator.startSession(request(600));

    clock.advance(60_000);
    // An NTP correction drags wall time back an hour mid-session.
    clock.jumpWall(-3_600_000);
    await coordinator.stopSession();

    expect(storage.records[0].actualSeconds).toBe(60);
  });
});

describe('edits during a session', () => {
  it('records where the session ended as well as where it began', async () => {
    const { coordinator, clock, storage } = harness();
    await coordinator.startSession(request(600));

    const edited = { ...defaultConfiguration(), masterLevel: 0.42 };
    coordinator.reportConfiguration(edited);
    clock.advance(60_000);
    await coordinator.stopSession();

    const record = storage.records[0];
    expect(record.edited).toBe(true);
    expect(record.finalConfiguration.masterLevel).toBe(0.42);
    expect(record.initialConfiguration.masterLevel).toBe(0.7);
  });

  it('ignores a report when nothing is running', () => {
    const { coordinator } = harness();
    coordinator.reportConfiguration(defaultConfiguration());
    expect(coordinator.getSnapshot().snapshot.edited).toBe(false);
  });
});

describe('subscribers', () => {
  it('gives one attaching mid-session the running state', async () => {
    const { coordinator } = harness();
    await coordinator.startSession(request(600));

    const { initial } = coordinator.subscribe(() => {});

    expect(initial.snapshot.state).toBe('session-active');
    expect(initial.snapshot.session?.presetId).toBe('focus');
    expect(initial.revision > 0).toBe(true);
  });

  it('publishes facts rather than a ticking clock', async () => {
    // Elapsed and remaining are derived by whoever displays them, so state is
    // published on change rather than streamed every second.
    const { coordinator, clock, scheduler } = harness();
    let updates = 0;
    coordinator.subscribe(() => updates++);
    await coordinator.startSession(request(600));
    const afterStart = updates;

    clock.advance(120_000);
    scheduler.advance(120_000);
    await flush();

    expect(updates).toBe(afterStart);
  });
});

describe('audio never outlives its owner', () => {
  it('stops preview audio when the start was superseded', async () => {
    // The published state and the audio must agree. Returning early here
    // would leave sound playing with a state of idle and nothing to stop it.
    const executor = new FakeExecutor({ manualPreview: true });
    const { coordinator } = harness(executor);

    const previewing = coordinator.startPreview(defaultConfiguration());
    await executor.previewReached;
    const stopping = coordinator.stopPreview();
    await executor.confirmPreview();
    await previewing;
    await stopping;

    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(executor.playing).toBe(false);
  });

  it('stops session audio when a stop lands before the start completes', async () => {
    const executor = new FakeExecutor({ manualStart: true });
    const { coordinator, storage } = harness(executor);

    const starting = coordinator.startSession(request());
    await executor.reached;
    const stopping = coordinator.stopSession();
    await rejection(starting);
    await stopping;

    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(executor.playing).toBe(false);
    expect(storage.checkpoint).toBe(null);
    expect(storage.records.length).toBe(0);
  });

  it('stops the audio it just started when the checkpoint cannot be written', async () => {
    // Sound is already playing and nothing owns it yet. Rejecting while
    // half-committed would leave it running and unrecorded.
    const executor = new FakeExecutor();
    const storage = new FakeStorage({ failActiveWrite: true });
    const { coordinator } = harness(executor, storage);

    await rejection(coordinator.startSession(request()));

    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(executor.playing).toBe(false);
    expect(storage.checkpoint).toBe(null);
    expect(storage.records.length).toBe(0);
  });

  it('settles the graph when a session ends naturally', async () => {
    // The envelope reached silence on the audio clock, but the context is
    // still running until something suspends it.
    const { coordinator, executor, clock, scheduler } = harness();
    await coordinator.startSession(request(600));
    clock.advance(600_000);
    scheduler.advance(600_000);
    await flush();

    expect(executor.calls.includes('stop')).toBe(true);
    expect(executor.playing).toBe(false);
  });
});

describe('an unsettled previous run', () => {
  it('refuses to start rather than overwrite the checkpoint', async () => {
    // That checkpoint may be the unfinished session's only record.
    const storage = new FakeStorage({ failRead: true });
    const { coordinator } = harness(new FakeExecutor(), storage);

    await rejection(coordinator.recover());
    expect(coordinator.isUnsettled).toBe(true);

    const error = await rejection(coordinator.startSession(request()));
    expect(error.message.startsWith('session: the previous run is unsettled')).toBe(true);
    expect(storage.checkpoint).toBe(null);
  });

  it('still allows preview, which writes nothing', async () => {
    const storage = new FakeStorage({ failRead: true });
    const { coordinator } = harness(new FakeExecutor(), storage);
    await rejection(coordinator.recover());
    await coordinator.startPreview(defaultConfiguration());
    expect(coordinator.getSnapshot().snapshot.state).toBe('previewing');
  });

  it('is settled when recovery simply finds nothing', async () => {
    const { coordinator } = harness();
    await coordinator.recover();
    expect(coordinator.isUnsettled).toBe(false);
  });
});

describe('published snapshots', () => {
  it('cannot be mutated through', async () => {
    // Electron IPC clones these, but the browser coordinator is in-process.
    const { coordinator } = harness();
    await coordinator.startSession(request(600));

    const published = coordinator.getSnapshot().snapshot;
    published.session!.plannedSeconds = 1;
    published.session!.initialConfiguration.masterLevel = 0.01;

    const again = coordinator.getSnapshot().snapshot;
    expect(again.session?.plannedSeconds).toBe(600);
    expect(again.session?.initialConfiguration.masterLevel).toBe(0.7);
  });
});

describe('when the compensating stop also fails', () => {
  it('keeps the reservation rather than losing the only trace of live audio', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const storage = new FakeStorage({ failActiveWrite: true });
    const { coordinator } = harness(executor, storage);

    await rejection(coordinator.startSession(request()));

    // Audio could not be stopped, so clearing the checkpoint too would leave
    // sound running that nothing anywhere records.
    expect(executor.playing).toBe(true);
    // Still the reservation: the active write is what failed.
    expect(storage.checkpoint?.phase).toBe('starting');
    expect(coordinator.isUnsettled).toBe(true);
  });
});

describe('interrupting', () => {
  it('records the instant it was called, not when the queue reached it', async () => {
    // A machine suspending is the case this exists for: work queued ahead
    // could otherwise delay it across the sleep and fold that into the record.
    const executor = new FakeExecutor({ manualPreview: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));
    clock.advance(60_000);

    // A suspend really does end the audio, so it asserts its boundary.
    const interrupting = coordinator.interrupt({ boundaryConfirmed: true });
    // An hour of sleep passes before the queue gets to it.
    clock.advance(3_600_000);
    await interrupting;

    expect(storage.records[0].actualSeconds).toBe(60);
  });

  it('tries to silence the graph', async () => {
    const { coordinator, executor, clock } = harness();
    await coordinator.startSession(request(600));
    clock.advance(60_000);
    await coordinator.interrupt();
    expect(executor.playing).toBe(false);
  });

  it('still writes the record when the executor cannot be reached', async () => {
    // Usually the executor is already gone — that is why this was called.
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));
    clock.advance(60_000);

    // Known gone: the renderer was replaced or lost, so proceeding is safe.
    await coordinator.interrupt({ executorGone: true });

    expect(storage.records.length).toBe(1);
    expect(storage.records[0].completionReason).toBe('interrupted');
    expect(storage.checkpoint).toBe(null);
  });
});

describe('a graph that will not settle', () => {
  it('does not cost the completed session its record', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const errors: unknown[] = [];
    const scheduler = new FakeScheduler();
    const storage = new FakeStorage();
    const clock = new FakeClock(WALL_START);
    executor.startedAtWall = WALL_START;
    const coordinator = new SessionCoordinator({
      clock,
      scheduler,
      storage,
      executor,
      newId: () => 's1',
      onError: (e) => errors.push(e),
    });

    await coordinator.startSession(request(600));
    clock.advance(600_000);
    scheduler.advance(600_000);
    await flush();

    // The session genuinely ended; a suspend that did not take must not lose
    // it. The failure is reported rather than swallowed.
    expect(storage.records.length).toBe(1);
    expect(storage.records[0].completionReason).toBe('completed');
    expect(storage.checkpoint).toBe(null);
    expect(errors.length).toBe(1);
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });
});

describe('recovering after a transient failure', () => {
  it('lets sessions start again once recovery succeeds', async () => {
    const storage = new FakeStorage({ failRead: true });
    const { coordinator } = harness(new FakeExecutor(), storage);

    await rejection(coordinator.recover());
    expect(coordinator.isUnsettled).toBe(true);

    storage.healReads();
    await coordinator.recover();

    // Otherwise every future start is refused until the process restarts.
    expect(coordinator.isUnsettled).toBe(false);
    await coordinator.startSession(request());
    expect(coordinator.getSnapshot().snapshot.state).toBe('session-active');
  });
});

describe('interrupting when the graph may still be playing', () => {
  it('does not publish idle over audio it could not stop', async () => {
    // A suspend or a command timeout does not prove the graph is gone.
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));
    clock.advance(60_000);

    await coordinator.interrupt();

    expect(executor.playing).toBe(true);
    expect(coordinator.getSnapshot().snapshot.state).toBe('session-ending');
    expect(storage.records.length).toBe(0);
    expect(storage.checkpoint?.phase).toBe('active');
    expect(coordinator.isUnsettled).toBe(true);
  });

  it('proceeds when the executor is known to be gone', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));
    clock.advance(60_000);

    await coordinator.interrupt({ executorGone: true });

    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(storage.records.length).toBe(1);
    expect(storage.checkpoint).toBe(null);
  });

  it('does not report a failed stop it expected', async () => {
    // The stop is attempted even when the executor is known to be gone —
    // "gone" is a report and silence is a fact — but its failure is then the
    // expected answer rather than a fault. Reporting it printed a stack trace
    // on every quit and every reload, which teaches the reader to ignore the
    // channel that exists for real background failures.
    const executor = new FakeExecutor({ failStop: true });
    const errors: unknown[] = [];
    const coordinator = new SessionCoordinator({
      clock: new FakeClock(WALL_START),
      scheduler: new FakeScheduler(),
      storage: new FakeStorage(),
      executor,
      newId: () => 's1',
      onError: (e) => errors.push(e),
    });
    executor.startedAtWall = WALL_START;

    await coordinator.startSession(request(600));
    await coordinator.interrupt({ executorGone: true });

    expect(errors.length).toBe(0);
    // Still finished, which is what makes the silence safe to keep.
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });

  it('still reports a failed stop that changes the outcome', async () => {
    // Nothing said the graph was gone, so this failure means audio may still
    // be playing — the case the channel exists for.
    const executor = new FakeExecutor({ failStop: true });
    const errors: unknown[] = [];
    const coordinator = new SessionCoordinator({
      clock: new FakeClock(WALL_START),
      scheduler: new FakeScheduler(),
      storage: new FakeStorage(),
      executor,
      newId: () => 's1',
      onError: (e) => errors.push(e),
    });
    executor.startedAtWall = WALL_START;

    await coordinator.startSession(request(600));
    await coordinator.interrupt();

    expect(errors.length).toBe(1);
    expect(coordinator.getSnapshot().snapshot.state).toBe('session-ending');
  });

  it('clears a preview left running against a graph that vanished', async () => {
    const { coordinator, executor } = harness();
    await coordinator.startPreview(defaultConfiguration());

    await coordinator.interrupt({ executorGone: true });

    // Otherwise it keeps reporting `previewing` after its graph disappeared.
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(executor.playing).toBe(false);
  });
});

describe('a rollback that could not stop the audio', () => {
  it('keeps the session so a later stop can retry', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const storage = new FakeStorage({ failActiveWrite: true });
    const { coordinator } = harness(executor, storage);

    await rejection(coordinator.startSession(request()));

    // Dropping the session would leave nothing able to retry: the surviving
    // checkpoint is only a reservation, which recovery discards.
    expect(coordinator.getSnapshot().snapshot.state).toBe('session-ending');
    expect(coordinator.getSnapshot().snapshot.session?.presetId).toBe('focus');
  });

  it('refuses preview while audio it does not own is still playing', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const storage = new FakeStorage({ failActiveWrite: true });
    const { coordinator } = harness(executor, storage);
    await rejection(coordinator.startSession(request()));

    const error = await rejection(coordinator.startPreview(defaultConfiguration()));
    expect(error.message).toBe('preview: a session is running');
  });
});

describe('recovery settles on every path', () => {
  it('clears unsettled after discarding a reservation', async () => {
    const storage = new FakeStorage({ failRead: true });
    const { coordinator } = harness(new FakeExecutor(), storage);
    await rejection(coordinator.recover());

    storage.healReads();
    storage.checkpoint = {
      phase: 'starting',
      id: 's1',
      presetId: 'focus',
      reservedAtWall: WALL_START,
    };
    await coordinator.recover();

    expect(coordinator.isUnsettled).toBe(false);
    expect(storage.checkpoint).toBe(null);
  });
});

describe('a preview stop that fails', () => {
  it('does not publish idle over audio it could not stop', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator } = harness(executor);
    await coordinator.startPreview(defaultConfiguration());

    // Uncertain loss: suspend, or a command that timed out.
    await coordinator.interrupt();

    expect(executor.playing).toBe(true);
    expect(coordinator.getSnapshot().snapshot.state).toBe('previewing');
    expect(coordinator.isUnsettled).toBe(true);
  });

  it('releases preview once a later stop confirms silence', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator } = harness(executor);
    await coordinator.startPreview(defaultConfiguration());
    await coordinator.interrupt();

    executor.healStop();
    await coordinator.stopPreview();

    expect(executor.playing).toBe(false);
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(coordinator.isUnsettled).toBe(false);
  });

  it('releases preview when the executor is known to be gone', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator } = harness(executor);
    await coordinator.startPreview(defaultConfiguration());
    await coordinator.interrupt({ executorGone: true });
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });
});

describe('a retried stop after an uncertain interruption', () => {
  it('records the interruption where it happened, not where the retry landed', async () => {
    // Suspended a minute in; the graph would not stop. An hour later a stop
    // finally works. Recording that as a user stop at the retry time would be
    // wrong twice over — wrong reason, and a duration capped at the planned
    // length rather than the minute actually heard.
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));

    clock.advance(60_000);
    await coordinator.interrupt({ boundaryConfirmed: true });
    expect(storage.records.length).toBe(0);

    clock.advance(3_600_000);
    executor.healStop();
    await coordinator.stopSession();

    expect(storage.records.length).toBe(1);
    expect(storage.records[0].completionReason).toBe('interrupted');
    expect(storage.records[0].actualSeconds).toBe(60);
  });

  it('lets another session start once the first is durably finalized', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));
    clock.advance(60_000);
    await coordinator.interrupt();
    expect(coordinator.isUnsettled).toBe(true);

    executor.healStop();
    await coordinator.stopSession();

    // History is durable and the checkpoint is gone, so the audio is
    // accounted for. Staying unsettled would refuse every future session.
    expect(coordinator.isUnsettled).toBe(false);
    expect(storage.checkpoint).toBe(null);
    await coordinator.startSession(request(600));
    expect(coordinator.getSnapshot().snapshot.state).toBe('session-active');
  });

  it('recovers a rollback that could not stop, without losing the session', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const storage = new FakeStorage({ failActiveWrite: true });
    const { coordinator } = harness(executor, storage);
    await rejection(coordinator.startSession(request(600)));

    executor.healStop();
    await coordinator.stopSession();

    expect(storage.records.length).toBe(1);
    expect(storage.records[0].completionReason).toBe('interrupted');
    expect(coordinator.isUnsettled).toBe(false);
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });
});

describe('two failures at once', () => {
  it('does not let resolving audio clear an unresolved recovery failure', async () => {
    // Preview stays available during a recovery failure by design, so these
    // two conditions genuinely coexist — and confirming a preview's silence
    // says nothing about a checkpoint that still cannot be read.
    const storage = new FakeStorage({ failRead: true });
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator } = harness(executor, storage);

    await rejection(coordinator.recover());
    await coordinator.startPreview(defaultConfiguration());
    await coordinator.interrupt();
    executor.healStop();
    await coordinator.stopPreview();

    // The checkpoint is still unreadable, so a session must still be refused.
    expect(coordinator.isUnsettled).toBe(true);
    await rejection(coordinator.startSession(request()));
    expect(storage.checkpoint).toBe(null);
  });

  it('does not let a settled recovery clear unaccounted audio', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock } = harness(executor);
    await coordinator.startSession(request(600));
    clock.advance(60_000);
    await coordinator.interrupt();
    expect(coordinator.isUnsettled).toBe(true);

    // Recovery finds nothing outstanding, which resolves nothing about audio.
    await coordinator.recover();
    expect(coordinator.isUnsettled).toBe(true);
  });
});

describe('the interruption boundary', () => {
  it('is not moved forward by repeated failed interruptions', async () => {
    // A command timeout raises another interruption every time it fires, so an
    // overwritable boundary drifts until it hits the planned-duration cap and
    // reports the whole session as heard.
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));

    clock.advance(60_000);
    await coordinator.interrupt({ boundaryConfirmed: true });
    clock.advance(3_600_000);
    await coordinator.interrupt({ boundaryConfirmed: true });

    executor.healStop();
    await coordinator.stopSession();

    expect(storage.records[0].actualSeconds).toBe(60);
    expect(storage.records[0].completionReason).toBe('interrupted');
  });

  it('is measured at silence when nothing really ended the audio', async () => {
    // A rollback leaves audio playing and the listener still hearing it.
    // Stamping the failure instant would record a session of nearly zero.
    const executor = new FakeExecutor({ failStop: true });
    const storage = new FakeStorage({ failActiveWrite: true });
    const { coordinator, clock } = harness(executor, storage);
    await rejection(coordinator.startSession(request(600)));

    clock.advance(60_000);
    executor.healStop();
    await coordinator.stopSession();

    expect(storage.records[0].completionReason).toBe('interrupted');
    expect(storage.records[0].actualSeconds).toBe(60);
  });

  it('is measured at silence after a timeout that ended nothing', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));

    clock.advance(60_000);
    // An unresponsive executor: the graph may well still be playing.
    await coordinator.interrupt();
    clock.advance(120_000);
    executor.healStop();
    await coordinator.stopSession();

    // Three minutes were audible, not one.
    expect(storage.records[0].actualSeconds).toBe(180);
    expect(storage.records[0].completionReason).toBe('interrupted');
  });

  it('still honours a real boundary that arrives after an uncertain one', async () => {
    const executor = new FakeExecutor({ failStop: true });
    const { coordinator, clock, storage } = harness(executor);
    await coordinator.startSession(request(600));

    clock.advance(60_000);
    await coordinator.interrupt();
    clock.advance(60_000);
    await coordinator.interrupt({ boundaryConfirmed: true });

    executor.healStop();
    await coordinator.stopSession();

    // The suspend at two minutes is the first real ending there was.
    expect(storage.records[0].actualSeconds).toBe(120);
  });
});

describe('the published elapsed anchor', () => {
  it('carries elapsed runtime so a display need not read the wall clock', async () => {
    const { coordinator, clock } = harness();
    await coordinator.startSession(request(600));
    expect(coordinator.getSnapshot().snapshot.elapsedSeconds).toBeCloseTo(0, 6);

    clock.advance(90_000);
    // Republished by any state change; a stop is the simplest.
    await coordinator.stopSession();
    expect(coordinator.getSnapshot().snapshot.elapsedSeconds).toBe(0);
  });

  it('is measured monotonically, so a wall-clock jump does not move it', async () => {
    const { coordinator, clock } = harness();
    await coordinator.startSession(request(600));
    clock.advance(60_000);
    clock.jumpWall(-3_600_000);

    // Any publish re-reads elapsed; an edit is the least invasive.
    coordinator.reportConfiguration(defaultConfiguration());

    expect(coordinator.getSnapshot().snapshot.elapsedSeconds).toBeCloseTo(60, 3);
  });
});

describe('the one stop control', () => {
  it('stops a preview', async () => {
    // The UI has one stop because there is one thing playing. Routing it to
    // stopSession alone left preview audio running and the state unchanged.
    const { coordinator, executor } = harness();
    await coordinator.startPreview(defaultConfiguration());

    await coordinator.stopPlayback();

    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(executor.playing).toBe(false);
  });

  it('stops a session', async () => {
    const { coordinator, clock, storage } = harness();
    await coordinator.startSession(request(600));
    clock.advance(30_000);

    await coordinator.stopPlayback();

    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
    expect(storage.records[0].completionReason).toBe('stopped');
  });

  it('is harmless when nothing is playing', async () => {
    const { coordinator } = harness();
    await coordinator.stopPlayback();
    expect(coordinator.getSnapshot().snapshot.state).toBe('idle');
  });
});

describe('integrity reports', () => {
  const finding = (id: string, scope: string, status: string): Record<string, unknown> => ({
    id,
    scope,
    status,
    checked: true,
    title: id,
    detail: `${id} detail`,
  });

  /** The id of the session that is running, from the published snapshot. */
  const runningId = (coordinator: SessionCoordinator): string =>
    coordinator.getSnapshot().snapshot.session?.id ?? '';

  it('records the worst verdict that ran, and which scopes ran at all', async () => {
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    const id = runningId(coordinator);

    expect(await coordinator.reportIntegrity(id, [finding('self-test', 'engine', 'ok')])).toBe(
      true,
    );
    expect(await coordinator.reportIntegrity(id, [finding('envelope', 'graph', 'warning')])).toBe(
      true,
    );

    await coordinator.stopSession();
    expect(storage.records[0].integrityStatus).toBe('warning');
    expect(storage.records[0].integrityCoverage.join(',')).toBe('engine,graph');
  });

  it('keeps the worst observation rather than the latest one', async () => {
    // A moment of recovery does not unsee a fault the listener already heard.
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    const id = runningId(coordinator);

    await coordinator.reportIntegrity(id, [finding('envelope', 'graph', 'warning')]);
    await coordinator.reportIntegrity(id, [finding('envelope', 'graph', 'ok')]);

    await coordinator.stopSession();
    expect(storage.records[0].integrityStatus).toBe('warning');
  });

  it('does not let an unchecked placeholder drag the record down', async () => {
    // The reason the record asks a different question from the surface: on
    // macOS the downstream scopes can never be checked, so folding them in
    // would record `unknown` for every healthy session ever run there.
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    const id = runningId(coordinator);

    await coordinator.reportIntegrity(id, [
      finding('self-test', 'engine', 'ok'),
      { id: 'loopback', scope: 'systemMix', checked: false, title: 'l', detail: 'Windows only' },
      { id: 'acoustic', scope: 'delivery', checked: false, title: 'a', detail: 'no checker' },
    ]);

    await coordinator.stopSession();
    expect(storage.records[0].integrityStatus).toBe('ok');
    expect(storage.records[0].integrityCoverage.join(',')).toBe('engine');
  });

  it('rebuilds the report rather than trusting it', async () => {
    // It arrives from a renderer and ends up in a history record. A checked
    // `delivery` finding is the claim this whole subsystem exists to refuse,
    // and the type that refuses it never sees a value that crossed IPC — so
    // both of these would otherwise record a verdict against a scope this
    // build has no checker for, from a message it could not even parse.
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    const id = runningId(coordinator);

    await coordinator.reportIntegrity(id, [
      finding('acoustic', 'delivery', 'failed'),
      finding('transport', 'bluetooth', 'failed'),
      finding('self-test', 'engine', 'ok'),
    ]);

    await coordinator.stopSession();
    expect(storage.records[0].integrityStatus).toBe('ok');
    expect(storage.records[0].integrityCoverage.join(',')).toBe('engine');
  });

  it('refuses a report naming a session that is not the one running', async () => {
    // Ownership is the whole point: a report is about the audio it measured,
    // and a stale one folded into the current session describes audio that
    // session never played.
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));

    expect(await coordinator.reportIntegrity('s-other', [finding('e', 'graph', 'failed')])).toBe(
      false,
    );

    await coordinator.stopSession();
    expect(storage.records[0].integrityStatus).toBe('unknown');
  });

  it('refuses a report when nothing is running', async () => {
    const { coordinator } = harness();
    expect(await coordinator.reportIntegrity('s1', [finding('e', 'graph', 'ok')])).toBe(false);
  });

  it('refuses an empty or unreadable report', async () => {
    const { coordinator } = harness();
    await coordinator.startSession(request(600));
    const id = runningId(coordinator);
    expect(await coordinator.reportIntegrity(id, [])).toBe(false);
    expect(await coordinator.reportIntegrity(id, 'nothing')).toBe(false);
  });

  it('starts each session with nothing observed', async () => {
    // The aggregate is per session. Carrying one across would record the
    // previous session's fault against audio that never had it.
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    await coordinator.reportIntegrity(runningId(coordinator), [
      finding('envelope', 'graph', 'failed'),
    ]);
    await coordinator.stopSession();

    await coordinator.startSession(request(600));
    await coordinator.stopSession();

    expect(storage.records[0].integrityStatus).toBe('failed');
    expect(storage.records[1].integrityStatus).toBe('unknown');
    expect(storage.records[1].integrityCoverage.length).toBe(0);
  });

  it('stops admitting new ids once the session has accumulated too many', async () => {
    // Per-message normalization bounds nothing here: each of these reports is
    // individually lawful, and only the aggregate's owner can see that they
    // add up. Without a cap the map grows without limit and is copied whole on
    // every merge.
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    const id = runningId(coordinator);

    for (let sent = 0; sent < MAX_SESSION_FINDINGS; sent += 32) {
      const batch = Array.from({ length: 32 }, (_, i) => finding(`f${sent + i}`, 'engine', 'ok'));
      expect(await coordinator.reportIntegrity(id, batch)).toBe(true);
    }

    // Full. A fresh id is refused rather than quietly dropped from a report
    // that claims to have been recorded.
    expect(await coordinator.reportIntegrity(id, [finding('extra', 'graph', 'failed')])).toBe(
      false,
    );

    // But a producer reporting its own fixed set again still works, which is
    // what a real one does for the whole length of a session.
    expect(await coordinator.reportIntegrity(id, [finding('f0', 'engine', 'failed')])).toBe(true);

    await coordinator.stopSession();
    expect(storage.records[0].integrityStatus).toBe('failed');
    // The refused finding was the only `graph` one, so its scope never
    // entered coverage either.
    expect(storage.records[0].integrityCoverage.join(',')).toBe('engine');
  });

  it('answers the record with a coverage array of its own', async () => {
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    await coordinator.reportIntegrity(runningId(coordinator), [
      finding('self-test', 'engine', 'ok'),
    ]);
    await coordinator.stopSession();

    storage.records[0].integrityCoverage.push('graph');
    await coordinator.startSession(request(600));
    await coordinator.reportIntegrity(runningId(coordinator), [
      finding('self-test', 'engine', 'ok'),
    ]);
    await coordinator.stopSession();

    expect(storage.records[1].integrityCoverage.join(',')).toBe('engine');
  });
});

describe('a report arriving after the record is already written', () => {
  it('is refused, because history deduplicates by id and would never take it', async () => {
    // `finalizeRecord` appends and then clears. A clear that fails leaves the
    // record on disk *and* the session owned, so the session-id check alone
    // still passes — and the store ignores a second append with the same id,
    // so a report accepted here would never reach the file. Answering true to
    // that is the same defect as reporting a write that did not happen.
    const { coordinator, storage } = harness(
      new FakeExecutor(),
      new FakeStorage({
        failClear: true,
      }),
    );
    await coordinator.startSession(request(600));
    const id = coordinator.getSnapshot().snapshot.session?.id ?? '';

    await rejection(coordinator.stopSession());
    expect(storage.records.length).toBe(1);
    expect(storage.records[0].integrityStatus).toBe('unknown');

    const accepted = await coordinator.reportIntegrity(id, [
      {
        id: 'envelope',
        scope: 'graph',
        status: 'warning',
        checked: true,
        title: 'envelope',
        detail: 'shallow',
      },
    ]);

    expect(accepted).toBe(false);
    // And the durable record is what it was: the retry that eventually
    // succeeds re-appends the same id, which history ignores.
    expect(storage.records[0].integrityStatus).toBe('unknown');
    expect(storage.records[0].integrityCoverage.length).toBe(0);
  });
});

describe('a report landing as the session ends', () => {
  /** Reports from inside the stop, which is the only moment that races. */
  class StoppingExecutor extends FakeExecutor {
    onStop: (() => void) | null = null;

    override async stop(fadeOutSeconds: number): Promise<void> {
      this.onStop?.();
      await super.stop(fadeOutSeconds);
    }
  }

  const warning = {
    id: 'envelope',
    scope: 'graph',
    status: 'warning',
    checked: true,
    title: 'envelope',
    detail: 'shallow',
  };

  it('is included when it arrives before the stop', async () => {
    const { coordinator, storage } = harness();
    await coordinator.startSession(request(600));
    const id = coordinator.getSnapshot().snapshot.session?.id ?? '';

    // Both queued, in this order, without awaiting either: the queue is what
    // decides, not which promise a test happens to await first.
    const reported = coordinator.reportIntegrity(id, [warning]);
    const stopped = coordinator.stopSession();
    expect(await reported).toBe(true);
    await stopped;

    expect(storage.records[0].integrityStatus).toBe('warning');
    expect(storage.records[0].integrityCoverage.join(',')).toBe('graph');
  });

  it('is refused, not lost, when it arrives while the session is being finalized', async () => {
    // The race this ordering exists for: a report merged into an aggregate
    // that `finish()` has already read would vanish silently. Queued, it
    // arrives after the record is written and is refused — which the caller
    // can see, rather than being told it was recorded.
    const executor = new StoppingExecutor();
    const { coordinator, storage } = harness(executor);
    await coordinator.startSession(request(600));
    const id = coordinator.getSnapshot().snapshot.session?.id ?? '';

    let reported: Promise<boolean> | null = null;
    executor.onStop = () => {
      reported = coordinator.reportIntegrity(id, [warning]);
    };

    await coordinator.stopSession();

    expect(await reported).toBe(false);
    expect(storage.records.length).toBe(1);
    expect(storage.records[0].integrityStatus).toBe('unknown');
    expect(storage.records[0].integrityCoverage.length).toBe(0);
  });
});
