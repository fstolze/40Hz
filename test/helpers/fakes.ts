/**
 * Test doubles for the session coordinator.
 *
 * Everything it depends on is injected, so the orderings that matter — a stop
 * overtaking a start, a crash between persisting and clearing, a clock jumping
 * — are driven directly rather than waited for.
 */

import type {
  AudioExecutor,
  Checkpoint,
  Clock,
  SessionStorage,
  StartAudioRequest,
  TimerHandle,
  Scheduler,
} from '../../src/session/coordinator.ts';
import type { SessionConfiguration } from '../../src/audio/configuration.ts';
import type { SessionRecord } from '../../src/session/session.ts';

/** Wall and monotonic advance together until a test moves one of them. */
export class FakeClock implements Clock {
  private wall: number;
  private monotonic: number;

  constructor(wallStart = 1_700_000_000_000) {
    this.wall = wallStart;
    this.monotonic = 0;
  }

  wallNow(): number {
    return this.wall;
  }

  monotonicNow(): number {
    return this.monotonic;
  }

  /** Move both clocks, as real time passing does. */
  advance(ms: number): void {
    this.wall += ms;
    this.monotonic += ms;
  }

  /** Move only wall time, as an NTP correction does. */
  jumpWall(ms: number): void {
    this.wall += ms;
  }
}

interface ScheduledTimer {
  at: number;
  fire: () => void;
  handle: object;
}

/** A scheduler a test drives by hand, so nothing waits on real time. */
export class FakeScheduler implements Scheduler {
  private timers: ScheduledTimer[] = [];
  private now = 0;

  setTimer(delayMs: number, fire: () => void): TimerHandle {
    const handle = {};
    this.timers.push({ at: this.now + delayMs, fire, handle });
    return handle;
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.handle !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Fire everything due within `ms`, in order. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fire();
    }
    this.now = until;
  }
}

export interface FakeStorageOptions {
  /** Fail the next `appendHistory` this many times before succeeding. */
  failAppends?: number;
  /** Throw whenever the checkpoint is cleared, simulating a crash there. */
  failClear?: boolean;
  /** Throw when an `active` checkpoint is written. */
  failActiveWrite?: boolean;
  /** Throw when the checkpoint is read, as an unreadable file does. */
  failRead?: boolean;
}

export class FakeStorage implements SessionStorage {
  readonly records: SessionRecord[] = [];
  checkpoint: Checkpoint | null = null;
  readonly checkpointWrites: Checkpoint[] = [];
  private remainingAppendFailures: number;
  private readonly failClear: boolean;
  private readonly failActiveWrite: boolean;
  private failReadFlag: boolean;

  constructor(options: FakeStorageOptions = {}) {
    this.remainingAppendFailures = options.failAppends ?? 0;
    this.failClear = options.failClear ?? false;
    this.failActiveWrite = options.failActiveWrite ?? false;
    this.failReadFlag = options.failRead ?? false;
  }

  async appendHistory(record: SessionRecord): Promise<void> {
    if (this.remainingAppendFailures > 0) {
      this.remainingAppendFailures--;
      throw new Error('storage: append failed');
    }
    // Idempotent by id, as the real store is.
    if (this.records.some((r) => r.id === record.id)) return;
    this.records.push(record);
  }

  async readCheckpoint(): Promise<Checkpoint | null> {
    if (this.failReadFlag) throw new Error('storage: checkpoint unreadable');
    return this.checkpoint;
  }

  /** Let a transient read failure clear, so a retry can succeed. */
  healReads(): void {
    this.failReadFlag = false;
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    if (this.failActiveWrite && checkpoint.phase === 'active') {
      throw new Error('storage: checkpoint write failed');
    }
    this.checkpoint = checkpoint;
    this.checkpointWrites.push(checkpoint);
  }

  async clearCheckpoint(): Promise<void> {
    if (this.failClear) throw new Error('storage: clear failed');
    this.checkpoint = null;
  }
}

export interface FakeExecutorOptions {
  /** Hold `startPreview` open until the test releases it. */
  manualPreview?: boolean;
  /** Reject every `stop`, as an executor that has gone away does. */
  failStop?: boolean;
  /** Resolve `startSession` only when the test releases it. */
  manualStart?: boolean;
  /** Reject `startSession` with this. */
  startError?: Error;
  /** Resolve `startSession` with null, as a superseded start does. */
  supersede?: boolean;
}

export class FakeExecutor implements AudioExecutor {
  readonly calls: string[] = [];
  readonly started: StartAudioRequest[] = [];
  /** Set when a start was withdrawn through its signal. */
  aborted = false;
  startedAtWall = 0;

  /** True while the executor believes it is making sound. */
  playing = false;

  /** Whether `stop` currently refuses. */
  private stopFails: boolean;

  private readonly options: FakeExecutorOptions;
  private release: ((value: number | null) => void) | null = null;
  private releasePreview: (() => void) | null = null;
  private enteredPreview: (() => void) | null = null;
  /** Resolves once `startPreview` has been entered. */
  readonly previewReached = new Promise<void>((resolve) => {
    this.enteredPreview = resolve;
  });
  private entered: (() => void) | null = null;
  /** Resolves once `startSession` has actually been entered. */
  readonly reached = new Promise<void>((resolve) => {
    this.entered = resolve;
  });

  constructor(options: FakeExecutorOptions = {}) {
    this.options = options;
    this.stopFails = options.failStop ?? false;
  }

  async startSession(request: StartAudioRequest, signal: AbortSignal): Promise<number | null> {
    this.calls.push('startSession');
    this.started.push(request);
    this.entered?.();
    if (this.options.startError !== undefined) throw this.options.startError;
    if (this.options.supersede === true) return null;

    if (this.options.manualStart === true) {
      // Not playing until the start resolves: a withdrawn start is cancelled
      // in the renderer and never reaches the speakers.
      return new Promise<number | null>((resolve, reject) => {
        this.release = (value) => {
          if (value !== null) this.playing = true;
          resolve(value);
        };
        signal.addEventListener(
          'abort',
          () => {
            this.aborted = true;
            reject(new Error('withdrawn'));
          },
          { once: true },
        );
      });
    }
    this.playing = true;
    return this.startedAtWall;
  }

  /**
   * Let a manual start finish, as the renderer confirming audio does.
   *
   * Awaits entry first: calling it before the coordinator has reached the
   * executor would resolve nothing and hang the caller forever.
   */
  async confirmStart(atWall: number): Promise<void> {
    await this.reached;
    this.release?.(atWall);
    this.release = null;
  }

  async startPreview(_configuration: SessionConfiguration): Promise<void> {
    this.calls.push('startPreview');
    this.enteredPreview?.();
    this.playing = true;
    if (this.options.manualPreview === true) {
      await new Promise<void>((resolve) => {
        this.releasePreview = resolve;
      });
    }
  }

  async confirmPreview(): Promise<void> {
    await this.previewReached;
    this.releasePreview?.();
    this.releasePreview = null;
  }

  async stop(_fadeOutSeconds: number): Promise<void> {
    this.calls.push('stop');
    if (this.stopFails) throw new Error('executor: cannot stop');
    this.playing = false;
  }

  /** Let stopping start working again, as a renderer coming back does. */
  healStop(): void {
    this.stopFails = false;
  }
}
