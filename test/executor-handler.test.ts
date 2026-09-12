/**
 * Answering executor commands.
 *
 * This is the renderer's half of the link, and it had defects two rounds
 * running while it sat in Electron-only code that nothing could exercise.
 * Extracting it is what makes these assertable: the case that matters is the
 * one where main has already let go, so nothing but this code is left to stop
 * the audio.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { createExecutorHandler, type ExecutorHost } from '../src/session/executor-handler.ts';
import type { AudioExecutor } from '../src/session/coordinator.ts';
import type { ExecutorMessage } from '../src/session/executor-link.ts';
import { defaultConfiguration } from '../src/audio/configuration.ts';

interface FakeAudioOptions {
  failStop?: boolean;
  failStart?: boolean;
  /**
   * Model the real executor: start audio, notice the cancellation, try to stop
   * it, and reject when that stop fails — leaving the graph playing while the
   * command reports a failure.
   */
  stopFailsAfterCancel?: boolean;
}

/** Tracks whether sound is playing, and how often stopping was attempted. */
function fakeAudio(options: FakeAudioOptions = {}) {
  const state = { playing: false, stopAttempts: 0, startedAt: 1_700_000_000_000 };
  const executor: AudioExecutor = {
    async startSession(_request, signal) {
      // Yields first, as a real start does — resuming a context and loading
      // worklets are both asynchronous — so a cancel has somewhere to land.
      await Promise.resolve();
      if (options.failStart === true) throw new Error('graph would not start');
      if (options.stopFailsAfterCancel === true) {
        // Audio begins, and only then is the cancellation seen.
        state.playing = true;
        if (signal.aborted) {
          state.stopAttempts += 1;
          throw new Error('cannot stop');
        }
        return state.startedAt;
      }
      if (signal.aborted) return null;
      state.playing = true;
      return state.startedAt;
    },
    async startPreview() {
      await Promise.resolve();
      if (options.failStart === true) throw new Error('graph would not start');
      state.playing = true;
    },
    async stop() {
      state.stopAttempts += 1;
      if (options.failStop === true) throw new Error('cannot stop');
      state.playing = false;
    },
  };
  return { executor, state };
}

interface FakeHostOptions {
  accept?: boolean;
  rejectAcknowledge?: boolean;
}

function fakeHost(options: FakeHostOptions = {}) {
  const errors: unknown[] = [];
  const acknowledged: { id: number; error?: string }[] = [];
  // Mutable, so one handler can be taken through a refusal and then an
  // acceptance — a fresh handler would pass even with the recovery removed.
  const state = { accept: options.accept ?? true };
  const host: ExecutorHost = {
    async acknowledge(id, _generation, _result, error) {
      acknowledged.push(error === undefined ? { id } : { id, error });
      if (options.rejectAcknowledge === true) throw new Error('ipc: gone');
      return state.accept;
    },
    reportError(error) {
      errors.push(error);
    },
  };
  return { host, errors, acknowledged, state };
}

const startSession = (id = 1): ExecutorMessage => ({
  kind: 'command',
  id,
  executor: 1,
  name: 'startSession',
  payload: {
    sessionId: 's1',
    configuration: defaultConfiguration(),
    plannedSeconds: 600,
    rampInSeconds: 3,
    rampOutSeconds: 1.5,
  },
});

const startPreview = (id = 1): ExecutorMessage => ({
  kind: 'command',
  id,
  executor: 1,
  name: 'startPreview',
  payload: defaultConfiguration(),
});

describe('an accepted command', () => {
  it('leaves the audio playing', async () => {
    const audio = fakeAudio();
    const { host } = fakeHost({ accept: true });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession());
    await handler.settled();

    expect(audio.state.playing).toBe(true);
    expect(audio.state.stopAttempts).toBe(0);
  });
});

describe('a refused acknowledgement', () => {
  it('stops a session it started', async () => {
    // Refusal is exactly the case where main timed the command out, so the
    // coordinator is not taking ownership of what was just started.
    const audio = fakeAudio();
    const { host } = fakeHost({ accept: false });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession());
    await handler.settled();

    expect(audio.state.stopAttempts).toBe(1);
    expect(audio.state.playing).toBe(false);
    expect(handler.orphaned).toBe(false);
  });

  it('stops a preview it started', async () => {
    const audio = fakeAudio();
    const { host } = fakeHost({ accept: false });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startPreview());
    await handler.settled();

    expect(audio.state.playing).toBe(false);
  });

  it('leaves nothing orphaned when the start failed outright', async () => {
    // A start that throws is stopped defensively, because there is no way to
    // tell from here whether it made sound before throwing. Stopping audio
    // that never started is a no-op, so this settles cleanly.
    const audio = fakeAudio({ failStart: true });
    const { host } = fakeHost({ accept: false });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession());
    await handler.settled();

    expect(audio.state.playing).toBe(false);
    expect(handler.orphaned).toBe(false);
  });
});

describe('an acknowledgement that cannot be delivered', () => {
  it('compensates rather than retrying it', async () => {
    // Sent inside the execution block, a rejected acknowledgement landed in
    // the catch and was acknowledged again — so the audio stayed and the
    // second rejection went unhandled.
    const audio = fakeAudio();
    const { host, acknowledged } = fakeHost({ rejectAcknowledge: true });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession());
    await handler.settled();

    expect(acknowledged.length).toBe(1);
    expect(audio.state.stopAttempts).toBe(1);
    expect(audio.state.playing).toBe(false);
  });
});

describe('a compensating stop that fails', () => {
  it('is not treated as success', async () => {
    const audio = fakeAudio({ failStop: true });
    const { host, errors } = fakeHost({ accept: false });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession());
    await handler.settled();

    expect(audio.state.playing).toBe(true);
    expect(handler.orphaned).toBe(true);
    // Nothing is waiting on this, so it has to be surfaced somewhere.
    expect(errors.length).toBe(1);
  });

  it('refuses to start more audio over what it could not stop', async () => {
    const audio = fakeAudio({ failStop: true });
    const { host, acknowledged } = fakeHost({ accept: false });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession(1));
    await handler.settled();
    handler.handle(startPreview(2));
    await handler.settled();

    const second = acknowledged.find((a) => a.id === 2);
    expect(second?.error).toBe('executor: earlier audio could not be stopped');
  });

  it('accepts commands again once the audio finally stops', async () => {
    // Same handler throughout: a fresh one would pass this even with the
    // orphan recovery removed entirely.
    const options = { failStop: true };
    const audio = fakeAudio(options);
    const { host, state } = fakeHost({ accept: false });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession(1));
    await handler.settled();
    expect(handler.orphaned).toBe(true);

    // The renderer recovers and the coordinator starts taking answers again.
    options.failStop = false;
    state.accept = true;
    handler.handle(startPreview(2));
    await handler.settled();

    expect(handler.orphaned).toBe(false);
    expect(audio.state.playing).toBe(true);
  });
});

describe('cancellation', () => {
  it('aborts a command that is already running', async () => {
    const audio = fakeAudio();
    const { host } = fakeHost({ accept: true });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle(startSession(7));
    handler.handle({ kind: 'cancel', id: 7, executor: 1 });
    await handler.settled();

    expect(audio.state.playing).toBe(false);
  });

  it('holds a cancel that arrives before its command', async () => {
    const audio = fakeAudio();
    const { host } = fakeHost({ accept: true });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle({ kind: 'cancel', id: 7, executor: 1 });
    handler.handle(startSession(7));
    await handler.settled();

    expect(audio.state.playing).toBe(false);
  });

  it('stops preview audio that was already started when the cancel landed', async () => {
    const audio = fakeAudio();
    const { host } = fakeHost({ accept: true });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle({ kind: 'cancel', id: 9, executor: 1 });
    handler.handle(startPreview(9));
    await handler.settled();

    expect(audio.state.playing).toBe(false);
  });
});

describe('a start that made sound and then threw', () => {
  it('is fenced, even though nothing recorded that audio began', async () => {
    // The executor starts audio, sees the cancellation, tries to stop, and
    // rejects when that fails. The command reports a failure, so nothing above
    // ever marks audio as started — while the graph is still playing.
    const audio = fakeAudio({ stopFailsAfterCancel: true, failStop: true });
    const { host, errors } = fakeHost({ accept: true });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle({ kind: 'cancel', id: 3, executor: 1 });
    handler.handle(startSession(3));
    await handler.settled();

    expect(audio.state.playing).toBe(true);
    expect(handler.orphaned).toBe(true);
    expect(errors.length).toBe(1);
  });

  it('refuses the next start while that audio is unaccounted for', async () => {
    const audio = fakeAudio({ stopFailsAfterCancel: true, failStop: true });
    const { host, acknowledged } = fakeHost({ accept: true });
    const handler = createExecutorHandler(audio.executor, host);

    handler.handle({ kind: 'cancel', id: 3, executor: 1 });
    handler.handle(startSession(3));
    await handler.settled();
    handler.handle(startPreview(4));
    await handler.settled();

    expect(acknowledged.find((a) => a.id === 4)?.error).toBe(
      'executor: earlier audio could not be stopped',
    );
  });
});
