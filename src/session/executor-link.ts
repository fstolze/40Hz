/**
 * The request/acknowledgement link to whichever renderer owns the audio.
 *
 * The graph lives in Studio, because Studio's scope and spectrum read the
 * analyser directly at frame rate and moving audio out would put ~60 FFT
 * frames a second on the wire. So the coordinator, which is authoritative,
 * drives audio by asking Studio to do it — and every property that makes that
 * safe lives here rather than in the coordinator:
 *
 * - an executor must **register** before commands go anywhere, and a command
 *   sent with none registered fails immediately rather than hanging;
 * - each command carries a **correlation id**, so an acknowledgement is
 *   matched to its request rather than to whatever arrived next;
 * - commands **time out**, because a renderer that is wedged never replies at
 *   all, and a coordinator waiting forever would strand the session;
 * - **replacement** — a reload gives a new executor — fails everything still
 *   in flight, since the renderer that was going to answer no longer exists.
 *
 * No Electron here: the transport is a function, so the ordering and failure
 * behaviour are tested directly.
 */

export interface ExecutorCommand {
  kind: 'command';
  id: number;
  /** Which executor generation this was addressed to. */
  executor: number;
  name: string;
  payload: unknown;
}

/**
 * Tells the executor to abandon a command it may still be working on.
 *
 * Giving up locally is not enough. A slow `start` that is still running in the
 * renderer would otherwise schedule audio after the coordinator had already
 * rolled the session back, leaving playback nothing is tracking.
 */
export interface ExecutorCancel {
  kind: 'cancel';
  /** The command being abandoned. */
  id: number;
  executor: number;
}

export type ExecutorMessage = ExecutorCommand | ExecutorCancel;

/** Sends a message to the current executor. Throwing means it never left. */
export type ExecutorTransport = (message: ExecutorMessage) => void;

export interface SendOptions {
  timeoutMs?: number;
  /**
   * Withdraw a command that is still in flight.
   *
   * A timeout is the wrong tool for a decision already made. When a stop
   * arrives while a start is still running, the coordinator has to take the
   * start back *now* — waiting out the timeout would leave the renderer free
   * to schedule audio in the meantime, and racing another command against it
   * only makes the ordering harder to reason about.
   */
  signal?: AbortSignal;
}

export class ExecutorUnavailableError extends Error {}
export class ExecutorTimeoutError extends Error {}
export class ExecutorReplacedError extends Error {}
export class ExecutorAbortedError extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  executor: number;
  /** Clears the timeout and any abort listener. */
  cleanup: () => void;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

export class ExecutorLink {
  private transport: ExecutorTransport | null = null;
  private executorGeneration = 0;
  private ready = false;
  private nextCommandId = 1;
  private readonly pending = new Map<number, Pending>();
  private configurationHandler: ((configuration: unknown) => void) | null = null;
  private integrityHandler:
    ((sessionId: string, report: unknown) => Promise<boolean> | boolean) | null = null;
  private lostHandler: ((reason: string) => void) | null = null;

  /**
   * Attach an executor, replacing any current one.
   *
   * Anything still in flight is failed rather than left waiting: the renderer
   * that was going to answer is gone.
   */
  register(transport: ExecutorTransport): number {
    // A replacement means the previous renderer is gone — a reload, most
    // likely — and with it the audio graph. Anything that was playing is no
    // longer playing, so whoever owns the session has to hear about it.
    if (this.transport !== null) this.lostHandler?.('replaced');
    this.failAllPending(new ExecutorReplacedError('executor was replaced'));
    this.transport = transport;
    this.ready = false;
    return ++this.executorGeneration;
  }

  /** Mark the current executor able to take commands. */
  markReady(generation: number): boolean {
    if (generation !== this.executorGeneration) return false;
    this.ready = true;
    return true;
  }

  /** Detach the current executor, failing anything outstanding. */
  unregister(): void {
    if (this.transport !== null) this.lostHandler?.('gone');
    this.failAllPending(new ExecutorUnavailableError('executor went away'));
    this.transport = null;
    this.ready = false;
  }

  get available(): boolean {
    return this.transport !== null && this.ready;
  }

  get generation(): number {
    return this.executorGeneration;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /** Send a command and wait for its acknowledgement. */
  send(name: string, payload: unknown = null, options: SendOptions = {}): Promise<unknown> {
    const transport = this.transport;
    if (transport === null || !this.ready) {
      // Fail now rather than queueing: a caller that cannot reach audio needs
      // to know immediately, not after a timeout.
      return Promise.reject(new ExecutorUnavailableError(`no executor for "${name}"`));
    }

    const { signal } = options;
    if (signal?.aborted === true) {
      return Promise.reject(new ExecutorAbortedError(`"${name}" was withdrawn before it was sent`));
    }

    const id = this.nextCommandId++;
    const executor = this.executorGeneration;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abandon(id);
        // Tell the executor to stop, not just ourselves: it may still be
        // mid-command, and finishing would act on a decision already undone.
        this.sendCancel(id, executor);
        reject(new ExecutorTimeoutError(`"${name}" was not acknowledged in ${timeoutMs} ms`));
        // A renderer that does not answer is not driving audio any more, so
        // whoever owns the session has to hear about it — the same as if the
        // window had gone.
        if (executor === this.executorGeneration) this.lostHandler?.('unresponsive');
      }, timeoutMs);

      const onAbort = (): void => {
        this.abandon(id);
        this.sendCancel(id, executor);
        reject(new ExecutorAbortedError(`"${name}" was withdrawn`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, { resolve, reject, executor, cleanup });

      try {
        transport({ kind: 'command', id, executor, name, payload });
      } catch (error) {
        this.abandon(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Forget a command and stop it firing anything else. */
  private abandon(id: number): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    entry.cleanup();
    this.pending.delete(id);
  }

  /**
   * Deliver an acknowledgement.
   *
   * Returns false for anything unrecognised — a late reply after a timeout, a
   * duplicate, or one from an executor that has since been replaced. Such a
   * reply must not resolve a command that is no longer waiting on it.
   */
  acknowledge(id: number, executor: number, result: unknown, error?: string): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined || entry.executor !== executor) return false;
    this.abandon(id);
    if (error !== undefined) entry.reject(new Error(error));
    else entry.resolve(result);
    return true;
  }

  /**
   * Report a configuration change made in the executor.
   *
   * Studio stays editable during a session, so the coordinator needs to hear
   * about edits to mark the record `edited` and to hold the latest
   * configuration in its checkpoint — which is what survives losing the
   * renderer.
   */
  /**
   * Called when the executor is replaced or disappears.
   *
   * The graph goes with it, so a session that was running is no longer being
   * heard and must be finalized rather than left counting.
   */
  onLost(handler: ((reason: string) => void) | null): void {
    this.lostHandler = handler;
  }

  onConfiguration(handler: ((configuration: unknown) => void) | null): void {
    this.configurationHandler = handler;
  }

  /**
   * Report what the executor measured about the audio it is playing.
   *
   * The findings themselves are not inspected here — this link carries
   * messages and owns generations; what a report means is the coordinator's,
   * and it normalizes what arrives before merging any of it.
   *
   * The handler answers whether the report was actually recorded, and that
   * answer is passed back to the caller rather than replaced with a cheerful
   * one. Reporting an acceptance that did not happen is the same defect as
   * reporting durability that did not happen, one layer up.
   */
  onIntegrity(
    handler: ((sessionId: string, report: unknown) => Promise<boolean> | boolean) | null,
  ): void {
    this.integrityHandler = handler;
  }

  /**
   * Returns false for a report from a superseded executor.
   *
   * Generation-bound like everything else on this link. The same window can
   * re-register after a reload, so without the check a report still in flight
   * from the previous instance could overwrite the configuration the current
   * one has established — and that configuration is what ends up recorded as
   * the session's final state.
   */
  reportConfiguration(executor: number, configuration: unknown): boolean {
    if (executor !== this.executorGeneration) return false;
    this.configurationHandler?.(configuration);
    return true;
  }

  /**
   * Resolves with whether the report was recorded.
   *
   * False for a report from a superseded executor, for one naming no session,
   * and — from the handler — for one about a session that has already ended.
   * Generation-bound for the same reason a configuration report is: the same
   * window re-registers after a reload, and a measurement still in flight from
   * the previous instance describes audio that is no longer playing. The
   * session id travels with it because the generation cannot answer the other
   * half: a fast stop-and-start keeps the renderer and changes the session.
   *
   * Unlike a configuration report this waits for its answer, which is the
   * difference between the two. An edit is superseded by the next edit, so
   * "it was sent" is all a caller can use; a measurement is not repeated on a
   * schedule anyone controls, so a producer has to be able to tell a recorded
   * report from a refused one.
   */
  async reportIntegrity(executor: number, sessionId: unknown, report: unknown): Promise<boolean> {
    if (executor !== this.executorGeneration) return false;
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    const handler = this.integrityHandler;
    // Nothing is listening, so nothing recorded it. Answering true here would
    // be the acceptance-that-did-not-happen this returns a boolean to avoid.
    if (handler === null) return false;
    return handler(sessionId, report);
  }

  private sendCancel(id: number, executor: number): void {
    if (this.transport === null || executor !== this.executorGeneration) return;
    try {
      this.transport({ kind: 'cancel', id, executor });
    } catch {
      // The executor is already gone; nothing left to cancel.
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      entry.cleanup();
      this.sendCancel(id, entry.executor);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
