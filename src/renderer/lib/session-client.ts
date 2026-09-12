/**
 * Studio's session client.
 *
 * One interface, two wirings. Under Electron the coordinator lives in the main
 * process and this is an IPC client; under `dev:web` there is no main process,
 * so a coordinator is constructed in-page over `localStorage` and the local
 * engine. `SessionPanel` is identical either way, which is what keeps the
 * whole session lifecycle exercisable in a browser.
 *
 * This module also registers Studio as the audio executor, so importing it is
 * a claim on the audio graph. The popover imports `session-bridge.ts` instead.
 */

import { SessionCoordinator } from '../../session/coordinator.ts';
import { desktopSessionClient, type SessionClient } from './session-bridge.ts';
import { fanOut } from './fan-out.ts';
import { browserSessionStorage, readBrowserHistory } from './browser-session-storage.ts';
import { engineExecutor } from './audio-executor.ts';
import { createExecutorHandler } from '../../session/executor-handler.ts';
import { engine } from './engine.svelte.ts';
import { historyStore } from './stores.ts';

function desktopClient(bridge: NonNullable<Window['desktop']>): SessionClient {
  return desktopSessionClient(
    bridge,
    {
      reportConfiguration: (configuration) => {
        // Best effort: an edit that cannot be reported is not worth
        // interrupting the session over, and the next one supersedes it
        // anyway.
        void executorGeneration.then((generation) => {
          if (generation === null) return;
          void bridge.executor.reportConfiguration(generation, configuration);
        });
      },
      reportIntegrity: async (sessionId, findings) => {
        // Not best effort, unlike the edit above: main answers whether the
        // report was recorded — false for a superseded executor or a session
        // already written — and that answer belongs to the producer, which is
        // the only thing that can decide what to do about it.
        //
        // Findings cross as plain data and the coordinator rebuilds them: this
        // side is a renderer, and what reaches a history record cannot be
        // taken on trust however it was constructed here.
        const generation = await executorGeneration;
        // No registration, so nothing carried it anywhere.
        if (generation === null) return false;
        return bridge.executor.reportIntegrity(generation, sessionId, [...findings]);
      },
    },
    () => historyStore.list(),
  );
}

/**
 * Registers this window as the executor and answers its commands.
 *
 * Only Studio may do this — the main process checks the sender — and only this
 * window holds the graph, so this is where audio actually happens under
 * Electron.
 */
let executorGeneration: Promise<number | null> = Promise.resolve(null);

export function registerAsExecutor(bridge: NonNullable<Window['desktop']>): void {
  // The answering logic lives in src/session/ so it can be tested without
  // Electron; this only carries messages between it and the bridge.
  const handler = createExecutorHandler(engineExecutor(), {
    acknowledge: (id, executorGeneration, result, error) =>
      bridge.executor.acknowledge(id, executorGeneration, result, error),
    reportError: (error) => {
      engine.reportError(error);
    },
  });

  executorGeneration = bridge.executor
    .register((message) => {
      handler.handle(message);
    })
    .then(async (registered) => {
      await bridge.executor.markReady(registered);
      return registered;
    });
}

function browserClient(): SessionClient {
  const coordinator = new SessionCoordinator({
    clock: {
      wallNow: () => Date.now(),
      // Monotonic here too, so a clock correction cannot stretch a session.
      monotonicNow: () => performance.now(),
    },
    scheduler: {
      setTimer: (delayMs, fire) => setTimeout(fire, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    storage: browserSessionStorage(),
    executor: engineExecutor(),
    newId: () => `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    onError: (error: unknown) => {
      console.error('[session] background failure:', error);
    },
  });

  // Settle whatever the last page load left behind before anything new starts.
  void coordinator.recover().catch((error: unknown) => {
    console.error('[session] could not settle the previous run:', error);
  });

  return {
    subscribe: fanOut(
      async (onChange) => coordinator.subscribeUnique('renderer', onChange).initial,
    ),
    start: (request) => coordinator.startSession(request),
    stop: () => coordinator.stopPlayback('stopped'),
    preview: (configuration) => coordinator.startPreview(configuration),
    reportConfiguration: (configuration) => {
      coordinator.reportConfiguration(configuration);
    },
    reportIntegrity: (sessionId, findings) => coordinator.reportIntegrity(sessionId, [...findings]),
    history: async () => readBrowserHistory(),
  };
}

const bridge = globalThis.window?.desktop;
if (bridge) registerAsExecutor(bridge);

export const sessionClient: SessionClient = bridge ? desktopClient(bridge) : browserClient();
