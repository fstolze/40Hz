/**
 * The authoritative session machine.
 *
 * Lives here rather than under `electron/` on purpose. It is instantiated
 * twice — in the main process against the disk store and an IPC audio proxy,
 * and under `dev:web` against `localStorage` and the local engine — and
 * building it inside Electron would have produced two subtly different session
 * machines instead of one with two wirings.
 *
 * Everything it depends on is injected: both clocks, the timers, the storage,
 * and the executor that actually makes sound. Nothing here imports Electron or
 * Web Audio, so the orderings that matter are tested directly rather than
 * reached through a window.
 */

import {
  beginSession,
  completeSession,
  endMs,
  fadeStartMs,
  snapshotActiveSession,
  snapshotRecord,
  type ActiveSession,
  type CompletionReason,
  type SessionRecord,
} from './session.ts';
import { SessionHub, type Published, type Subscriber } from './session-hub.ts';
import {
  checkedScopes,
  mergeFindings,
  recordedStatus,
  type Finding,
} from '../integrity/findings.ts';
import { MAX_SESSION_FINDINGS, normalizeFindings } from '../integrity/normalize.ts';
import { Serial } from '../lib/serial.ts';
import { snapshotConfiguration, type SessionConfiguration } from '../audio/configuration.ts';

/**
 * Two clocks, deliberately.
 *
 * Wall time is what a record means — a session happened at a moment on the
 * user's calendar. Elapsed runtime is measured monotonically instead, so an
 * NTP correction or a manual clock change cannot stretch or shrink a session
 * that is already running, or desynchronise the countdown from the audio.
 */
export interface Clock {
  /** Epoch milliseconds, for anything that gets persisted. */
  wallNow(): number;
  /** Monotonic milliseconds, for elapsed time and timers. */
  monotonicNow(): number;
}

export type TimerHandle = number | object;

export interface Scheduler {
  setTimer(delayMs: number, fire: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/** A session that was interrupted before it could be finalized. */
export type Checkpoint =
  | {
      /**
       * Reserved, but audio was never confirmed.
       *
       * Written before the executor is asked to make sound, so a crash inside
       * the start transaction leaves a trace. Recovery discards it without
       * writing history — nothing was heard, so there is nothing honest to
       * record.
       */
      phase: 'starting';
      id: string;
      presetId: string;
      reservedAtWall: number;
    }
  | {
      phase: 'active';
      session: ActiveSession;
      /**
       * Elapsed runtime at the last heartbeat, from the monotonic clock.
       *
       * Recovery uses this directly. Deriving it as `lastHeartbeat - startedAt`
       * would fold any system clock adjustment straight into the recorded
       * duration.
       */
      elapsedSecondsAtHeartbeat: number;
      configuration: SessionConfiguration;
      edited: boolean;
    };

export interface SessionStorage {
  /** Must be idempotent by record id: recovery re-appends what it cannot know landed. */
  appendHistory(record: SessionRecord): Promise<void>;
  readCheckpoint(): Promise<Checkpoint | null>;
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
  clearCheckpoint(): Promise<void>;
}

export interface StartAudioRequest {
  sessionId: string;
  configuration: SessionConfiguration;
  plannedSeconds: number;
  rampInSeconds: number;
  rampOutSeconds: number;
}

export interface AudioExecutor {
  /**
   * Begin a timed session, resolving with the wall-clock instant at which
   * audio actually started, or null if the request was superseded.
   *
   * The whole envelope is scheduled by the executor at this point. The
   * coordinator's own timers only advance state; they never decide when sound
   * changes.
   */
  startSession(request: StartAudioRequest, signal: AbortSignal): Promise<number | null>;
  startPreview(configuration: SessionConfiguration): Promise<void>;
  stop(fadeOutSeconds: number): Promise<void>;
}

export const ARBITER_STATES = ['idle', 'previewing', 'session-active', 'session-ending'] as const;

/**
 * What the audio is doing.
 *
 * Preview and Session are different product actions over one audio path:
 * Preview is untimed and unrecorded, a session is neither. They cannot
 * overlap, so this is where that is enforced.
 */
export type ArbiterState = (typeof ARBITER_STATES)[number];

export interface SessionSnapshot {
  state: ArbiterState;
  /**
   * The running session, or null.
   *
   * Carries the facts a subscriber needs — start instant, planned duration,
   * ramps — rather than derived time. Elapsed and remaining are computed
   * locally by whoever is displaying them, from `session.ts`, so state is
   * published on change rather than streamed at one hertz.
   */
  session: ActiveSession | null;
  edited: boolean;
  /**
   * Elapsed runtime at the moment this was published, from the monotonic
   * clock.
   *
   * The coordinator measures elapsed time monotonically so a clock correction
   * cannot desynchronise it from the audio envelope. A display that derived
   * its own elapsed from wall time would throw that away and jump while the
   * audio carried on — so it is published, and the display advances it with a
   * monotonic delta of its own.
   */
  elapsedSeconds: number;
}

export const DEFAULT_RAMP_IN_SECONDS = 3;
export const DEFAULT_RAMP_OUT_SECONDS = 1.5;
/** Bounded so lost time is bounded, without writing to disk every second. */
export const HEARTBEAT_SECONDS = 20;

export interface InterruptOptions {
  /** Session-clock instant the session actually ended. */
  at?: number;
  /**
   * True when the executor is known to be gone — a renderer replaced, lost, or
   * navigated away. False for a suspend or a command timeout, where the graph
   * may well still exist and still be playing.
   */
  executorGone?: boolean;
  /**
   * True when this interruption itself ended the audio, so now is a real
   * boundary — a machine suspending does; a command timing out does not.
   */
  boundaryConfirmed?: boolean;
}

export interface StartSessionRequest {
  presetId: string;
  configuration: SessionConfiguration;
  plannedSeconds: number;
  rampInSeconds?: number;
  rampOutSeconds?: number;
  scheduledFor?: number;
}

export interface CoordinatorDeps {
  clock: Clock;
  scheduler: Scheduler;
  storage: SessionStorage;
  executor: AudioExecutor;
  /** Ids for new sessions. Injected so tests are deterministic. */
  newId: () => string;
  /** Reports a failure from timer-driven work, which no caller can await. */
  onError?: (error: unknown) => void;
}

const IDLE: SessionSnapshot = { state: 'idle', session: null, edited: false, elapsedSeconds: 0 };

/** Detached, so no reader or subscriber can reach another's copy. */
function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    session: snapshot.session === null ? null : snapshotActiveSession(snapshot.session),
  };
}

export class SessionCoordinator {
  private readonly deps: CoordinatorDeps;
  private readonly hub = new SessionHub<SessionSnapshot>(IDLE, cloneSnapshot);
  private readonly operations = new Serial();

  private state: ArbiterState = 'idle';
  private session: ActiveSession | null = null;
  private configuration: SessionConfiguration | null = null;
  private edited = false;

  /**
   * What the session has been told about its own integrity, merged.
   *
   * Owned here outright. An earlier design had the main process supply a
   * status through a dependency, which is two owners for one fact — and the
   * one place it was wired never provided it, so every Electron session
   * recorded `unknown` however well the checks ran.
   *
   * The aggregate is the worst *valid* observation of the session rather than
   * the most recent report: a moment of recovery does not unsee a fault the
   * listener already heard. Reset when a session takes ownership of audio, so
   * nothing carries across from the previous one.
   */
  private findings: Finding[] = [];

  /**
   * Set the instant this session's record reaches history.
   *
   * From that point the record is immutable in practice: `appendHistory` is
   * idempotent by id, so a second append with the same id is ignored and
   * nothing merged afterwards could ever reach the file. The window is real
   * rather than theoretical — `finalizeRecord` appends and *then* clears the
   * checkpoint, and a failed clear leaves the session owned with the record
   * already written, so the session-id check alone would still admit a report
   * and answer true to it.
   *
   * Reset when a session takes ownership of audio, like the aggregate itself.
   */
  private recordCommitted = false;

  /** Monotonic reading taken at the instant audio started. */
  private monotonicAtStart = 0;
  private timers: TimerHandle[] = [];

  /**
   * Bumped by every start and stop.
   *
   * Claimed before any await, so ordering follows when an operation was
   * requested rather than whichever await resolved first — the same reason the
   * audio graph does it.
   */
  private generation = 0;
  private inFlightStart: AbortController | null = null;

  /**
   * Set when something is outstanding that a new session would trample.
   *
   * Two independent conditions, held separately on purpose. A recovery
   * failure means the previous run could not be settled, so starting would
   * overwrite a checkpoint that may be its only record. An audio failure means
   * a stop failed and sound may still be playing that this coordinator cannot
   * account for.
   *
   * They must not share a slot: preview stays available during a recovery
   * failure by design, so a preview stop that then fails would overwrite the
   * recovery condition — and confirming that preview's silence would clear a
   * checkpoint problem it never touched.
   */
  private recoveryFailure: Error | null = null;
  private audioFailure: Error | null = null;

  /**
   * An interruption that could not be completed because the stop failed.
   *
   * Held until silence is confirmed, so a later stop records what actually
   * happened — an interruption at the suspend boundary — rather than a user
   * stop at whatever time the retry landed, which for a long-overdue retry
   * would be capped at the planned duration and be wrong twice over.
   */
  private pendingInterruption: { reason: CompletionReason; at?: number } | null = null;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  getSnapshot(): Published<SessionSnapshot> {
    return this.hub.current();
  }

  subscribe(subscriber: Subscriber<SessionSnapshot>): {
    initial: Published<SessionSnapshot>;
    unsubscribe: () => void;
  } {
    return this.hub.subscribe(subscriber);
  }

  subscribeUnique(
    key: string | number,
    subscriber: Subscriber<SessionSnapshot>,
  ): { initial: Published<SessionSnapshot>; unsubscribe: () => void } {
    return this.hub.subscribeUnique(key, subscriber);
  }

  unsubscribeKey(key: string | number): void {
    this.hub.unsubscribeKey(key);
  }

  /**
   * The instant to hand the pure session functions.
   *
   * Wall time anchored at the start, advanced monotonically — so the two
   * timebases agree and a clock change moves neither.
   */
  private sessionNow(): number {
    if (this.session === null) return this.deps.clock.wallNow();
    return this.session.startedAt + (this.deps.clock.monotonicNow() - this.monotonicAtStart);
  }

  private elapsedSeconds(): number {
    if (this.session === null) return 0;
    return Math.max(0, (this.sessionNow() - this.session.startedAt) / 1000);
  }

  private publish(): Published<SessionSnapshot> {
    return this.hub.publish({
      state: this.state,
      // Detached: under Electron IPC clones this, but the browser coordinator
      // is in-process and a subscriber could otherwise rewrite the canonical
      // timing or initial configuration through the published object.
      session: this.session === null ? null : snapshotActiveSession(this.session),
      edited: this.edited,
      elapsedSeconds: this.elapsedSeconds(),
    });
  }

  private clearTimers(): void {
    for (const handle of this.timers) this.deps.scheduler.clearTimer(handle);
    this.timers = [];
  }

  // --- recovery --------------------------------------------------------------

  /**
   * Settle whatever the last run left behind. Call once at startup.
   *
   * A `starting` checkpoint is discarded: audio was never confirmed, so there
   * is nothing honest to record. An `active` one is finalized as interrupted at
   * the last heartbeat rather than at now, which would count time the app was
   * not even running.
   */
  get isUnsettled(): boolean {
    return this.recoveryFailure !== null || this.audioFailure !== null;
  }

  private get unsettledReason(): string {
    return (this.recoveryFailure ?? this.audioFailure)?.message ?? 'unknown';
  }

  private markRecoveryFailure(error: unknown): Error {
    this.recoveryFailure = error instanceof Error ? error : new Error(String(error));
    return this.recoveryFailure;
  }

  private markAudioFailure(error: unknown): Error {
    this.audioFailure = error instanceof Error ? error : new Error(String(error));
    return this.audioFailure;
  }

  /** Called once audio is known to be silent. Leaves recovery alone. */
  private clearAudioFailure(): void {
    this.audioFailure = null;
  }

  /** Called once the previous run is settled. Leaves audio alone. */
  private clearRecoveryFailure(): void {
    this.recoveryFailure = null;
  }

  async recover(): Promise<void> {
    let checkpoint: Checkpoint | null;
    try {
      checkpoint = await this.deps.storage.readCheckpoint();
    } catch (error) {
      // Unreadable is not absent. Treating it as absent would let the next
      // start overwrite a session that may still be recorded there.
      throw this.markRecoveryFailure(error);
    }
    if (checkpoint === null) {
      // Nothing outstanding: a previous failure has been resolved.
      this.clearRecoveryFailure();
      return;
    }

    if (checkpoint.phase === 'starting') {
      await this.deps.storage.clearCheckpoint();
      // Settled: a retry after a transient read failure must not leave every
      // future start refused.
      this.clearRecoveryFailure();
      return;
    }

    try {
      const endedAt = checkpoint.session.startedAt + checkpoint.elapsedSecondsAtHeartbeat * 1000;
      // No integrity: the aggregate lived in the process that died, and the
      // checkpoint does not carry it yet. `unknown` with no coverage is the
      // truthful answer for a session this build never saw run — putting one
      // in the checkpoint is 4B.
      const record = completeSession(checkpoint.session, endedAt, 'interrupted', {
        finalConfiguration: checkpoint.configuration,
        edited: checkpoint.edited,
      });
      await this.finalizeRecord(record);
    } catch (error) {
      // Anything unexpected here leaves the previous run unaccounted for, so
      // it fails closed: a start that cleared this checkpoint would take the
      // session with it.
      throw this.markRecoveryFailure(error);
    }
    // Settled, so a retry after a transient failure lets sessions start again
    // rather than refusing them until the process restarts.
    this.clearRecoveryFailure();
  }

  /**
   * Append, persist, and only then clear the checkpoint.
   *
   * A crash between the append and the clear re-appends the same id on
   * recovery, which the store deduplicates. The reverse order loses a session.
   */
  private async finalizeRecord(record: SessionRecord): Promise<void> {
    await this.deps.storage.appendHistory(snapshotRecord(record));
    // History has it. Anything merged from here cannot reach the file, so no
    // further report may be accepted for this session — including across the
    // clear below, which is the failure that opens the window.
    this.recordCommitted = true;
    await this.deps.storage.clearCheckpoint();
  }

  // --- preview ---------------------------------------------------------------

  async startPreview(configuration: SessionConfiguration): Promise<Published<SessionSnapshot>> {
    const generation = ++this.generation;
    return this.operations.run(async () => {
      if (generation !== this.generation) return this.hub.current();
      if (this.state === 'session-active' || this.state === 'session-ending') {
        throw new Error('preview: a session is running');
      }
      await this.deps.executor.startPreview(snapshotConfiguration(configuration));
      if (generation !== this.generation) {
        // Superseded while starting. The audio is already playing, so it has
        // to be stopped — returning here would leave sound with no owner and
        // a published state of idle.
        await this.deps.executor.stop(DEFAULT_RAMP_OUT_SECONDS);
        return this.hub.current();
      }
      this.state = 'previewing';
      return this.publish();
    });
  }

  async stopPreview(): Promise<Published<SessionSnapshot>> {
    const generation = ++this.generation;
    return this.operations.run(async () => {
      if (generation !== this.generation) return this.hub.current();
      if (this.state !== 'previewing') return this.hub.current();
      await this.deps.executor.stop(DEFAULT_RAMP_OUT_SECONDS);
      if (generation !== this.generation) return this.hub.current();
      this.state = 'idle';
      // Silence confirmed, so a previous stop failure no longer stands.
      this.clearAudioFailure();
      return this.publish();
    });
  }

  // --- sessions --------------------------------------------------------------

  /**
   * Start a timed session, as a transaction.
   *
   * The reservation is persisted *before* the executor is asked for audio,
   * because the first graph initialization is asynchronous and a crash inside
   * that window would otherwise leave no trace. The start instant comes back
   * from the executor rather than being stamped here: resuming a suspended
   * context advances the clock unpredictably, so a time taken beforehand would
   * start the countdown and the record before any sound.
   */
  async startSession(request: StartSessionRequest): Promise<Published<SessionSnapshot>> {
    const generation = ++this.generation;
    // Withdraw a start that is still in flight rather than racing it.
    this.inFlightStart?.abort();

    return this.operations.run(async () => {
      if (generation !== this.generation) return this.hub.current();
      if (this.isUnsettled) {
        // Starting would overwrite the checkpoint holding an unfinished
        // session, which may be its only record.
        throw new Error(`session: the previous run is unsettled (${this.unsettledReason})`);
      }
      if (this.state === 'session-active' || this.state === 'session-ending') {
        throw new Error('session: one is already running');
      }

      // Registered before any await, so a stop arriving during the steps below
      // can withdraw this start rather than letting it run to completion and
      // leave audio playing with a published state of idle.
      const controller = new AbortController();
      this.inFlightStart = controller;

      const superseded = (): boolean => generation !== this.generation || controller.signal.aborted;

      try {
        // Preview and a session cannot overlap, so this stops it as one step.
        if (this.state === 'previewing') {
          await this.deps.executor.stop(0.05);
          this.state = 'idle';
          this.publish();
        }
        if (superseded()) return this.hub.current();

        const id = this.deps.newId();
        const configuration = snapshotConfiguration(request.configuration);
        await this.deps.storage.writeCheckpoint({
          phase: 'starting',
          id,
          presetId: request.presetId,
          reservedAtWall: this.deps.clock.wallNow(),
        });
        if (superseded()) {
          await this.deps.storage.clearCheckpoint();
          return this.hub.current();
        }

        let startedAtWall: number | null;
        try {
          startedAtWall = await this.deps.executor.startSession(
            {
              sessionId: id,
              configuration,
              plannedSeconds: request.plannedSeconds,
              rampInSeconds: request.rampInSeconds ?? DEFAULT_RAMP_IN_SECONDS,
              rampOutSeconds: request.rampOutSeconds ?? DEFAULT_RAMP_OUT_SECONDS,
            },
            controller.signal,
          );
        } catch (error) {
          // Nothing was heard, so nothing is recorded.
          await this.deps.storage.clearCheckpoint();
          throw error;
        }

        if (startedAtWall === null) {
          await this.deps.storage.clearCheckpoint();
          return this.hub.current();
        }
        if (superseded()) {
          // Audio is running but this start no longer owns it.
          await this.deps.executor.stop(DEFAULT_RAMP_OUT_SECONDS);
          await this.deps.storage.clearCheckpoint();
          return this.hub.current();
        }

        return await this.establish(id, request, configuration, startedAtWall);
      } finally {
        if (this.inFlightStart === controller) this.inFlightStart = null;
      }
    });
  }

  /**
   * Take ownership of audio that has started.
   *
   * Split out because the failure here is the dangerous one: if the active
   * checkpoint cannot be written, sound is already playing and nothing yet
   * owns it. Rather than reject with the coordinator half-committed, the audio
   * is stopped and the reservation cleared, so the caller's failure is the
   * whole truth.
   */
  private async establish(
    id: string,
    request: StartSessionRequest,
    configuration: SessionConfiguration,
    startedAtWall: number,
  ): Promise<Published<SessionSnapshot>> {
    {
      // Anchor the monotonic reference to the instant audio began.
      this.monotonicAtStart = this.deps.clock.monotonicNow();
      this.session = beginSession({
        id,
        presetId: request.presetId,
        startedAt: startedAtWall,
        plannedSeconds: request.plannedSeconds,
        rampInSeconds: request.rampInSeconds ?? DEFAULT_RAMP_IN_SECONDS,
        rampOutSeconds: request.rampOutSeconds ?? DEFAULT_RAMP_OUT_SECONDS,
        configuration,
        ...(request.scheduledFor === undefined ? {} : { scheduledFor: request.scheduledFor }),
      });
      this.configuration = configuration;
      this.edited = false;
      // Nothing has been observed about this session yet, and nothing has been
      // written about it. This is the only place either is cleared: doing it
      // in `finish()` as well would be a second guard nothing can drive into
      // failure, and the invariant that matters is about the session starting,
      // not the one that ended.
      this.findings = [];
      this.recordCommitted = false;
      this.state = 'session-active';

      try {
        await this.writeActiveCheckpoint();
      } catch (error) {
        // The compensating stop can fail too. Whether it did decides whether
        // this coordinator may forget the session at all.
        let stopped = true;
        try {
          await this.deps.executor.stop(DEFAULT_RAMP_OUT_SECONDS);
        } catch {
          stopped = false;
        }

        if (stopped) {
          this.session = null;
          this.configuration = null;
          this.state = 'idle';
          await this.deps.storage.clearCheckpoint().catch(() => undefined);
          this.publish();
          throw error;
        }

        // Audio is still playing and could not be stopped. Dropping the
        // session here would leave nothing able to retry: the surviving
        // checkpoint is only a reservation, which recovery discards, and
        // stopSession would become a no-op against a null session. So
        // ownership is kept, in a state a later stop can act on.
        this.state = 'session-ending';
        // No boundary: the audio is still playing, and the listener goes on
        // hearing it. Recording the instant of this failure would claim a
        // session of nearly zero seconds for something still audible. The end
        // time is decided when silence is actually confirmed.
        this.notePendingInterruption('interrupted');
        this.markAudioFailure(error);
        this.publish();
        throw error;
      }

      this.scheduleSessionTimers();
      return this.publish();
    }
  }

  async stopSession(reason: CompletionReason = 'stopped'): Promise<Published<SessionSnapshot>> {
    const generation = ++this.generation;
    this.inFlightStart?.abort();

    return this.operations.run(async () => {
      if (generation !== this.generation) return this.hub.current();
      if (this.session === null) return this.hub.current();

      this.clearTimers();
      this.state = 'session-ending';
      this.publish();

      await this.deps.executor.stop(this.session.rampOutSeconds);
      return this.finish(reason);
    });
  }

  /**
   * Stop whatever is currently playing.
   *
   * The UI has one stop control because there is only ever one thing playing.
   * Routing that to `stopSession` alone left a preview running with the button
   * apparently doing nothing — the state stayed `previewing` and the audio
   * carried on.
   */
  async stopPlayback(reason: CompletionReason = 'stopped'): Promise<Published<SessionSnapshot>> {
    if (this.state === 'previewing') return this.stopPreview();
    return this.stopSession(reason);
  }

  /**
   * End the session for something outside the user's control.
   *
   * A lost renderer, a machine going to sleep. Recorded as interrupted, and at
   * the instant given rather than at whatever time it is when the news
   * arrives — counting sleep as listening would corrupt the log.
   */
  async interrupt(options: InterruptOptions = {}): Promise<Published<SessionSnapshot>> {
    const generation = ++this.generation;
    this.inFlightStart?.abort();
    // Taken now, not inside the queue. A machine suspending is the case this
    // exists for, and anything queued ahead could otherwise delay this across
    // the sleep and fold that time into the record.
    const executorGone = options.executorGone ?? false;
    // A boundary exists only when something really ended the audio: an
    // explicit instant, the machine suspending, or the executor being gone.
    // A command that merely timed out proves nothing — the graph may still be
    // playing, and the listener still hearing it.
    const boundary =
      options.at ??
      (this.session !== null && (options.boundaryConfirmed === true || executorGone)
        ? this.sessionNow()
        : undefined);
    const endedAt = boundary;

    return this.operations.run(async () => {
      if (generation !== this.generation) return this.hub.current();

      if (this.session === null) {
        // No timed session, but preview may still be showing as running
        // against a graph that has disappeared.
        if (this.state === 'previewing') {
          try {
            await this.deps.executor.stop(0);
          } catch (error) {
            if (!executorGone) {
              // The graph may still be playing. Publishing idle over it would
              // claim a silence nobody confirmed.
              this.deps.onError?.(error);
              this.markAudioFailure(error);
              return this.hub.current();
            }
            // Expected: the renderer holding the graph is gone, which is why
            // this is running at all. See the note below.
          }
          this.state = 'idle';
          this.clearAudioFailure();
          return this.publish();
        }
        return this.hub.current();
      }

      this.clearTimers();
      this.state = 'session-ending';
      this.publish();

      let stopped = true;
      try {
        await this.deps.executor.stop(0);
      } catch (error) {
        stopped = false;
        // Reported only when it changes the outcome. The stop is attempted
        // even with the executor known to be gone, because "gone" is a report
        // and silence is a fact — but its failure is then the expected answer,
        // not a fault. Reporting it anyway printed a stack trace on every quit
        // and every reload, which teaches the reader to ignore the channel
        // that exists for real background failures.
        if (!executorGone) this.deps.onError?.(error);
      }

      if (!stopped && !executorGone) {
        // Suspend and a command timeout do not prove the graph is gone. It may
        // still be playing, so ownership is kept and the checkpoint left in
        // place rather than publishing idle over live audio.
        //
        // The reason and the instant are held too: whatever finally confirms
        // silence must record the interruption where it happened, not a user
        // stop at the moment the retry succeeded.
        this.notePendingInterruption('interrupted', boundary);
        this.markAudioFailure(new Error('session: could not confirm the audio stopped'));
        return this.hub.current();
      }

      return this.finish('interrupted', endedAt);
    });
  }

  /**
   * Remember that this session ended in an interruption.
   *
   * The first one wins. A retry is not a new ending, and every failed stop
   * would otherwise walk the boundary forward — a command timeout raises
   * another interruption each time it fires, so an overwritten boundary drifts
   * until it hits the planned-duration cap and reports the whole session.
   *
   * `at` is supplied only when something really did end the audio, such as the
   * machine suspending. Without one the end time is measured when silence is
   * confirmed, since until then the listener is still hearing it.
   */
  private notePendingInterruption(reason: CompletionReason, at?: number): void {
    if (this.pendingInterruption === null) {
      this.pendingInterruption = at === undefined ? { reason } : { reason, at };
      return;
    }
    // An established boundary is never moved; one can only be filled in.
    if (at !== undefined && this.pendingInterruption.at === undefined) {
      this.pendingInterruption.at = at;
    }
  }

  private async finish(
    reason: CompletionReason,
    atSessionTime?: number,
  ): Promise<Published<SessionSnapshot>> {
    const session = this.session;
    if (session === null) return this.hub.current();

    // An interruption that could not be completed earlier wins over whatever
    // finally managed to stop the audio: the session ended when the machine
    // suspended, not when the retry landed.
    const pending = this.pendingInterruption;
    const record = completeSession(
      session,
      pending?.at ?? atSessionTime ?? this.sessionNow(),
      pending?.reason ?? reason,
      {
        // Two questions, two answers: the worst verdict among the checks that
        // ran, and which scopes those were. Anything nobody looked at leaves
        // the status alone and stays out of the coverage.
        integrityStatus: recordedStatus(this.findings),
        integrityCoverage: checkedScopes(this.findings),
        finalConfiguration: this.configuration ?? session.initialConfiguration,
        edited: this.edited,
      },
    );

    // Persist before forgetting: if this throws, the checkpoint survives and
    // recovery will finish the job.
    await this.finalizeRecord(record);

    this.session = null;
    this.configuration = null;
    this.edited = false;
    this.pendingInterruption = null;
    this.state = 'idle';
    // History is durable and the checkpoint is gone, so whatever the audio was
    // doing is now accounted for. Leaving this set would refuse every future
    // session until the process restarted.
    this.clearAudioFailure();
    return this.publish();
  }

  // --- while running ---------------------------------------------------------

  /**
   * Note an edit made while a session is running.
   *
   * Studio stays editable by decision, so the record has to say where the
   * session ended as well as where it began. Written to the checkpoint on the
   * next heartbeat rather than immediately, which bounds how much is lost to a
   * crash without writing to disk on every slider move.
   */
  reportConfiguration(configuration: SessionConfiguration): void {
    if (this.session === null) return;
    this.configuration = snapshotConfiguration(configuration);
    this.edited = true;
    this.publish();
  }

  /**
   * Fold a report from whatever measured the audio into the session aggregate.
   *
   * Three things make this safe, and each one has a failure it prevents:
   *
   * - **The report is untrusted input.** It arrives from a renderer over IPC,
   *   and what it says ends up in a history record — so it is rebuilt here
   *   rather than taken as given. A checked finding in a scope nothing can
   *   check does not survive that.
   * - **It runs on the same queue as every state transition.** A report
   *   landing while `finish()` is building the record would otherwise be
   *   merged into an aggregate that has already been read, and lost. Queued,
   *   it is either merged before the record is built or refused after — never
   *   silently dropped into a session that has ended.
   * - **The session id is rechecked inside the queue**, after the wait. A
   *   check before it would pass and then be acted on against whatever session
   *   is current by the time this runs, which for a fast stop-and-start is a
   *   different one — the guard-before-an-await finding this repo keeps
   *   rediscovering.
   *
   * Owning the session is not sufficient on its own: once the record has been
   * appended, history deduplicates by id and nothing merged afterwards can
   * reach the file, so a report arriving in that window is refused rather than
   * accepted into an aggregate no one will ever read.
   *
   * The aggregate is also bounded. A report may always update an id the
   * session has already seen — which is what a real producer does, reporting
   * the same fixed set again as the session runs — but new ids stop being
   * admitted at `MAX_SESSION_FINDINGS`. Per-message normalization cannot do
   * this: a hundred conforming messages with fresh ids are individually
   * lawful and collectively unbounded, in a map that is copied whole on every
   * merge.
   *
   * Returns whether anything was merged, so a caller can tell "recorded" from
   * "arrived too late" rather than assuming the first.
   */
  async reportIntegrity(sessionId: string, report: unknown): Promise<boolean> {
    const incoming = normalizeFindings(report);
    if (incoming.length === 0) return false;
    return this.operations.run(async () => {
      if (this.session === null || this.session.id !== sessionId) return false;
      if (this.recordCommitted) return false;

      const known = new Set(this.findings.map((f) => f.id));
      const admissible: Finding[] = [];
      for (const finding of incoming) {
        if (!known.has(finding.id)) {
          if (known.size >= MAX_SESSION_FINDINGS) continue;
          known.add(finding.id);
        }
        admissible.push(finding);
      }
      // Nothing this session can still take. False rather than true: the
      // answer is whether the report was recorded, and none of it was.
      if (admissible.length === 0) return false;

      this.findings = mergeFindings(this.findings, admissible);
      return true;
    });
  }

  private async writeActiveCheckpoint(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    await this.deps.storage.writeCheckpoint({
      phase: 'active',
      session,
      elapsedSecondsAtHeartbeat: this.elapsedSeconds(),
      configuration: this.configuration ?? session.initialConfiguration,
      edited: this.edited,
    });
  }

  /**
   * State transitions only.
   *
   * The audio boundaries were scheduled by the executor on the audio clock at
   * start. These timers move the published state and eventually finalize; a
   * late one changes what the UI says, never what is heard.
   */
  private scheduleSessionTimers(): void {
    const session = this.session;
    if (session === null) return;
    const now = this.sessionNow();

    const toFade = fadeStartMs(session) - now;
    if (toFade > 0) {
      this.timers.push(
        this.deps.scheduler.setTimer(toFade, () => {
          if (this.state !== 'session-active') return;
          this.state = 'session-ending';
          this.publish();
        }),
      );
    }

    this.timers.push(
      this.deps.scheduler.setTimer(Math.max(0, endMs(session) - now), () => {
        // Nothing awaits a timer, so a rejection here would otherwise be
        // unhandled — a disk failure taking down the process.
        this.completeNaturally().catch((error: unknown) => {
          this.deps.onError?.(error);
        });
      }),
    );

    const beat = (): void => {
      if (this.session === null) return;
      this.writeActiveCheckpoint().catch((error: unknown) => {
        // A heartbeat that cannot be written is not fatal: the previous one
        // still bounds what recovery would lose.
        this.deps.onError?.(error);
      });
      this.timers.push(this.deps.scheduler.setTimer(HEARTBEAT_SECONDS * 1000, beat));
    };
    this.timers.push(this.deps.scheduler.setTimer(HEARTBEAT_SECONDS * 1000, beat));
  }

  private async completeNaturally(): Promise<void> {
    const generation = ++this.generation;
    await this.operations.run(async () => {
      if (generation !== this.generation) return;
      if (this.session === null) return;
      this.clearTimers();
      this.state = 'session-ending';
      this.publish();
      // The envelope has already reached silence on the audio clock; this
      // settles the graph and suspends the context, which nothing else does.
      // If it fails the session still ended, so the record is written anyway —
      // leaving it unwritten would lose a session over a suspend that did not
      // take.
      await this.deps.executor.stop(0).catch((error: unknown) => {
        this.deps.onError?.(error);
      });
      await this.finish('completed');
    });
  }

  dispose(): void {
    this.clearTimers();
  }
}
