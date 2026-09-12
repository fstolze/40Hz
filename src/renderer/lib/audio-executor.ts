/**
 * The audio side of a session, in the renderer that owns the graph.
 *
 * Shared by both wirings. Under Electron the main process drives this over the
 * executor link, and under `dev:web` the in-process coordinator calls it
 * directly — the same code either way, which is the point of the coordinator
 * living outside `electron/`.
 */

import type { AudioExecutor, StartAudioRequest } from '../../session/coordinator.ts';
import type { SessionConfiguration } from '../../audio/configuration.ts';
import { engine } from './engine.svelte.ts';

export function engineExecutor(): AudioExecutor {
  return {
    async startSession(request: StartAudioRequest, signal: AbortSignal): Promise<number | null> {
      // Withdrawn before we got here — the coordinator changed its mind while
      // the command was in flight, so make no sound at all.
      if (signal.aborted) return null;

      engine.applyConfiguration(request.configuration);
      const startedAt = await engine.startSession({
        plannedSeconds: request.plannedSeconds,
        rampInSeconds: request.rampInSeconds,
        rampOutSeconds: request.rampOutSeconds,
      });

      if (startedAt !== null && signal.aborted) {
        // Withdrawn while the graph was starting. It is playing now, so it has
        // to be stopped rather than left for a session that no longer exists.
        await engine.stop(request.rampOutSeconds);
        return null;
      }
      return startedAt;
    },

    async startPreview(configuration: SessionConfiguration): Promise<void> {
      engine.applyConfiguration(configuration);
      await engine.start();
    },

    async stop(fadeOutSeconds: number): Promise<void> {
      await engine.stop(fadeOutSeconds);
    },
  };
}
