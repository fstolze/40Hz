/**
 * Answering executor commands, and cleaning up when the answer is not taken.
 *
 * Extracted from the renderer's IPC wiring so it can be tested. Everything it
 * needs is passed in — the audio executor, a way to acknowledge, a way to
 * surface a failure nobody is waiting on — so none of this needs Electron.
 *
 * The rule it enforces is the coordinator's, applied at the only level that
 * can still act once main has let go: audio is never disowned until silence is
 * confirmed. If a command's acknowledgement is refused, or cannot be delivered
 * at all, whatever it started has to be stopped — and if that stop fails, the
 * sound is still out there, so no further audio may be started over it.
 */

import type { AudioExecutor, StartAudioRequest } from './coordinator.ts';
import type { ExecutorMessage } from './executor-link.ts';
import type { SessionConfiguration } from '../audio/configuration.ts';

export interface ExecutorHost {
  /** Resolves false when the coordinator will not take what was started. */
  acknowledge(id: number, generation: number, result: unknown, error?: string): Promise<boolean>;
  /** Surfaces a failure no caller is waiting on. */
  reportError(error: unknown): void;
}

/** Matches the graph's own stop ramp, for audio nothing owns any more. */
export const DISOWN_FADE_SECONDS = 1.5;

export interface ExecutorHandler {
  handle(message: ExecutorMessage): void;
  /** Resolves once every command accepted so far has finished. For tests. */
  settled(): Promise<void>;
  /** True while audio is playing that nothing is tracking. */
  readonly orphaned: boolean;
}

export function createExecutorHandler(
  executor: AudioExecutor,
  host: ExecutorHost,
): ExecutorHandler {
  const running = new Map<number, AbortController>();
  const cancelledEarly = new Set<number>();
  const inFlight = new Set<Promise<void>>();
  let orphanedAudio = false;

  async function disown(): Promise<boolean> {
    try {
      await executor.stop(DISOWN_FADE_SECONDS);
      orphanedAudio = false;
      return true;
    } catch (error) {
      // Not success. Nothing else can surface this — no caller is waiting, and
      // main has already rolled back its ownership.
      orphanedAudio = true;
      host.reportError(error);
      return false;
    }
  }

  async function run(message: Extract<ExecutorMessage, { kind: 'command' }>): Promise<void> {
    const { id, executor: generation, name, payload } = message;
    const controller = new AbortController();
    if (cancelledEarly.delete(id)) controller.abort();
    running.set(id, controller);

    let startedAudio = false;
    let result: unknown = null;
    let failure: string | null = null;

    try {
      if (orphanedAudio && name !== 'stop') {
        // Audio from an earlier command is still unaccounted for. Clear it
        // before making more, and refuse if it will not clear.
        if (!(await disown())) throw new Error('executor: earlier audio could not be stopped');
      }

      if (name === 'startSession') {
        result = await executor.startSession(payload as StartAudioRequest, controller.signal);
        startedAudio = result !== null;
      } else if (name === 'startPreview') {
        await executor.startPreview(payload as SessionConfiguration);
        startedAudio = true;
        if (controller.signal.aborted) {
          // Cancelled while starting — most likely the command timed out, so
          // main has given up and nothing owns this audio.
          startedAudio = !(await disown());
        }
      } else if (name === 'stop') {
        await executor.stop((payload as { fadeOutSeconds: number }).fadeOutSeconds);
        orphanedAudio = false;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);

      // A start that threw may still have made sound before it did. The
      // executor starts audio, then observes a cancellation, then tries to
      // stop — and a failure in that stop rejects the whole command, so
      // nothing above ever set `startedAudio` even though the graph is
      // playing. There is no way to tell the two apart from here, so both are
      // treated as possibly live: stopping audio that never started is a
      // no-op, while assuming none started leaves it running behind the fence.
      if (name === 'startSession' || name === 'startPreview') await disown();
    }

    // Acknowledging is its own step. Done inside the block above, a rejected
    // acknowledgement landed in the catch and was retried rather than
    // compensated: the audio stayed, and the second rejection went unhandled.
    let accepted: boolean;
    try {
      accepted =
        failure === null
          ? await host.acknowledge(id, generation, result)
          : await host.acknowledge(id, generation, null, failure);
    } catch {
      // Not delivered at all, which main will treat as no answer.
      accepted = false;
    }

    if (!accepted && startedAudio) await disown();
    running.delete(id);
  }

  return {
    handle(message) {
      if (message.kind === 'cancel') {
        // Aborted directly rather than noted for a poll to notice: a poll can
        // miss a command that completes between the cancel and the next tick.
        const controller = running.get(message.id);
        if (controller === undefined) cancelledEarly.add(message.id);
        else controller.abort();
        return;
      }
      const task = run(message).finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    get orphaned() {
      return orphanedAudio;
    },
  };
}
