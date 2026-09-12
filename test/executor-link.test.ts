/**
 * The command link between the coordinator and whichever renderer owns audio.
 *
 * Every case here is a way the naive version strands the coordinator: no
 * executor and the command hangs, a wedged renderer and it hangs, a reload and
 * it waits on a process that no longer exists, or a late reply resolves a
 * command that had already given up.
 */

import { describe, it, expect } from './helpers/expect.ts';
import type { ExecutorCommand as ExecutorCommandMessage } from '../src/session/executor-link.ts';
import {
  ExecutorAbortedError,
  ExecutorLink,
  ExecutorReplacedError,
  ExecutorTimeoutError,
  ExecutorUnavailableError,
  type ExecutorMessage,
} from '../src/session/executor-link.ts';

/** A link with a registered, ready executor that records what it is sent. */
function readyLink(): { link: ExecutorLink; sent: ExecutorMessage[]; generation: number } {
  const link = new ExecutorLink();
  const sent: ExecutorMessage[] = [];
  const generation = link.register((message) => sent.push(message));
  link.markReady(generation);
  return { link, sent, generation };
}

/** Only the commands, for tests that do not care about cancellations. */
function commands(sent: readonly ExecutorMessage[]): ExecutorCommandMessage[] {
  return sent.filter((m): m is ExecutorCommandMessage => m.kind === 'command');
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    return error as Error;
  }
}

describe('registration', () => {
  it('refuses commands before an executor registers', async () => {
    const link = new ExecutorLink();
    expect(link.available).toBe(false);
    const error = await rejection(link.send('start'));
    expect(error instanceof ExecutorUnavailableError).toBe(true);
  });

  it('refuses commands while the executor is registered but not ready', async () => {
    const link = new ExecutorLink();
    link.register(() => {});
    expect(link.available).toBe(false);
    const error = await rejection(link.send('start'));
    expect(error instanceof ExecutorUnavailableError).toBe(true);
  });

  it('accepts commands once ready', async () => {
    const { link, sent } = readyLink();
    expect(link.available).toBe(true);
    // Settled here rather than left hanging: an unacknowledged command would
    // reject on its timeout after the test had finished.
    const promise = link.send('start', { plannedSeconds: 600 }, { timeoutMs: 5 });
    expect(sent.length).toBe(1);
    expect(commands(sent)[0].name).toBe('start');
    await rejection(promise);
  });

  it('ignores a readiness signal from a stale generation', () => {
    const link = new ExecutorLink();
    const first = link.register(() => {});
    link.register(() => {});
    expect(link.markReady(first)).toBe(false);
    expect(link.available).toBe(false);
  });
});

describe('correlation', () => {
  it('gives every command a distinct id', async () => {
    const { link, sent } = readyLink();
    const a = link.send('a', null, { timeoutMs: 5 });
    const b = link.send('b', null, { timeoutMs: 5 });
    expect(commands(sent)[0].id === commands(sent)[1].id).toBe(false);
    await Promise.all([rejection(a), rejection(b)]);
  });

  it('resolves the command the acknowledgement names, not the next one', async () => {
    const { link, sent, generation } = readyLink();
    const first = link.send('a');
    const second = link.send('b');

    // Answered out of order, as a renderer doing real work would.
    link.acknowledge(commands(sent)[1].id, generation, 'second result');
    link.acknowledge(commands(sent)[0].id, generation, 'first result');

    expect(await first).toBe('first result');
    expect(await second).toBe('second result');
  });

  it('rejects when the executor reports a failure', async () => {
    const { link, sent, generation } = readyLink();
    const promise = link.send('start');
    link.acknowledge(commands(sent)[0].id, generation, null, 'graph would not start');
    const error = await rejection(promise);
    expect(error.message).toBe('graph would not start');
  });

  it('ignores an acknowledgement for an unknown command', () => {
    const { link, generation } = readyLink();
    expect(link.acknowledge(999, generation, null)).toBe(false);
  });

  it('ignores a duplicate acknowledgement', async () => {
    const { link, sent, generation } = readyLink();
    const promise = link.send('a');
    expect(link.acknowledge(commands(sent)[0].id, generation, 'ok')).toBe(true);
    expect(link.acknowledge(commands(sent)[0].id, generation, 'again')).toBe(false);
    expect(await promise).toBe('ok');
  });

  it('ignores an acknowledgement from a replaced executor', async () => {
    const { link, sent, generation } = readyLink();
    const promise = link.send('a');
    const next = link.register(() => {});
    link.markReady(next);
    // The old renderer answers late, after a reload has already replaced it.
    expect(link.acknowledge(commands(sent)[0].id, generation, 'stale')).toBe(false);
    const error = await rejection(promise);
    expect(error instanceof ExecutorReplacedError).toBe(true);
  });
});

describe('timeouts', () => {
  it('gives up on a renderer that never answers', async () => {
    const { link } = readyLink();
    const error = await rejection(link.send('start', null, { timeoutMs: 5 }));
    expect(error instanceof ExecutorTimeoutError).toBe(true);
    expect(link.inFlight).toBe(0);
  });

  it('ignores a reply that arrives after giving up', async () => {
    const { link, sent, generation } = readyLink();
    await rejection(link.send('start', null, { timeoutMs: 5 }));
    expect(link.acknowledge(commands(sent)[0].id, generation, 'too late')).toBe(false);
  });

  it('does not time out a command that was answered', async () => {
    const { link, sent, generation } = readyLink();
    const promise = link.send('a', null, { timeoutMs: 5 });
    link.acknowledge(commands(sent)[0].id, generation, 'done');
    expect(await promise).toBe('done');
    await new Promise((r) => setTimeout(r, 15));
    expect(link.inFlight).toBe(0);
  });
});

describe('replacement and loss', () => {
  it('fails everything in flight when the executor is replaced', async () => {
    const { link } = readyLink();
    const a = link.send('a');
    const b = link.send('b');
    link.register(() => {});
    expect((await rejection(a)) instanceof ExecutorReplacedError).toBe(true);
    expect((await rejection(b)) instanceof ExecutorReplacedError).toBe(true);
    expect(link.inFlight).toBe(0);
  });

  it('fails everything in flight when the executor goes away', async () => {
    const { link } = readyLink();
    const promise = link.send('a');
    link.unregister();
    expect((await rejection(promise)) instanceof ExecutorUnavailableError).toBe(true);
    expect(link.available).toBe(false);
  });

  it('reports a transport that throws rather than waiting on it', async () => {
    const link = new ExecutorLink();
    const generation = link.register(() => {
      throw new Error('window is gone');
    });
    link.markReady(generation);
    const error = await rejection(link.send('a'));
    expect(error.message).toBe('window is gone');
    expect(link.inFlight).toBe(0);
  });
});

describe('cancellation', () => {
  it('tells the executor to stop when a command times out', async () => {
    const { link, sent } = readyLink();
    await rejection(link.send('start', null, { timeoutMs: 5 }));
    // Giving up locally is not enough: a slow start still running in the
    // renderer would schedule audio after the session had been rolled back.
    const cancels = sent.filter((m) => m.kind === 'cancel');
    expect(cancels.length).toBe(1);
    expect(cancels[0].id).toBe(commands(sent)[0].id);
  });

  it('tells the executor to stop when the link is torn down', async () => {
    const { link, sent } = readyLink();
    const promise = link.send('start');
    link.unregister();
    await rejection(promise);
    expect(sent.filter((m) => m.kind === 'cancel').length).toBe(1);
  });

  it('cancels through the executor that holds the command, not its replacement', async () => {
    const { link, sent } = readyLink();
    const promise = link.send('start');

    const replacement: ExecutorMessage[] = [];
    const next = link.register((m) => replacement.push(m));
    link.markReady(next);
    await rejection(promise);

    // The outgoing executor is the one still working on it. The replacement
    // never saw the command, and the cancel carries the old generation so a
    // reloaded page can tell it is not addressed to it.
    const cancels = sent.filter((m) => m.kind === 'cancel');
    expect(cancels.length).toBe(1);
    expect(cancels[0].executor).toBe(1);
    expect(replacement.length).toBe(0);
  });

  it('does not cancel a command that was acknowledged', async () => {
    const { link, sent, generation } = readyLink();
    const promise = link.send('a', null, { timeoutMs: 50 });
    link.acknowledge(commands(sent)[0].id, generation, 'done');
    await promise;
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.filter((m) => m.kind === 'cancel').length).toBe(0);
  });
});

describe('configuration reports', () => {
  it('forwards an edit made in the executor', () => {
    const { link, generation } = readyLink();
    const seen: unknown[] = [];
    link.onConfiguration((c) => seen.push(c));
    expect(link.reportConfiguration(generation, { masterLevel: 0.42 })).toBe(true);
    expect(seen.length).toBe(1);
    expect((seen[0] as { masterLevel: number }).masterLevel).toBe(0.42);
  });

  it('ignores a report from a superseded executor', () => {
    // The same window can re-register after a reload. A report still in
    // flight from the previous instance must not overwrite the configuration
    // the current one established — that is what gets recorded as final.
    const { link, generation } = readyLink();
    const seen: unknown[] = [];
    link.onConfiguration((c) => seen.push(c));
    const next = link.register(() => {});
    link.markReady(next);

    expect(link.reportConfiguration(generation, { masterLevel: 0.1 })).toBe(false);
    expect(seen.length).toBe(0);
    expect(link.reportConfiguration(next, { masterLevel: 0.9 })).toBe(true);
    expect(seen.length).toBe(1);
  });

  it('is harmless with nothing listening', () => {
    const { link, generation } = readyLink();
    link.reportConfiguration(generation, { masterLevel: 0.42 });
    link.onConfiguration(null);
    link.reportConfiguration(generation, { masterLevel: 0.5 });
    expect(link.available).toBe(true);
  });
});

describe('integrity reports', () => {
  it('forwards what the executor measured, against the session it measured', async () => {
    const { link, generation } = readyLink();
    const seen: { sessionId: string; report: unknown }[] = [];
    link.onIntegrity((sessionId, report) => {
      seen.push({ sessionId, report });
      return true;
    });

    expect(await link.reportIntegrity(generation, 's1', [{ id: 'envelope' }])).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0].sessionId).toBe('s1');
    expect((seen[0].report as { id: string }[])[0].id).toBe('envelope');
  });

  it('answers with whether it was recorded, not with whether it was sent', async () => {
    // The coordinator refuses a report about a session that has already been
    // written, and a producer has to be able to tell that from an acceptance.
    // Reporting one that did not happen is the same defect as reporting a
    // write that did not happen.
    const { link, generation } = readyLink();
    link.onIntegrity(() => Promise.resolve(false));
    expect(await link.reportIntegrity(generation, 's1', [])).toBe(false);
  });

  it('ignores a report from a superseded executor', async () => {
    // A measurement still in flight from the instance before a reload
    // describes audio that is no longer playing.
    const { link, generation } = readyLink();
    const seen: string[] = [];
    link.onIntegrity((sessionId) => {
      seen.push(sessionId);
      return true;
    });
    const next = link.register(() => {});
    link.markReady(next);

    expect(await link.reportIntegrity(generation, 's1', [])).toBe(false);
    expect(seen.length).toBe(0);
    expect(await link.reportIntegrity(next, 's1', [])).toBe(true);
    expect(seen.join(',')).toBe('s1');
  });

  it('refuses a report that names no session', async () => {
    // The generation says which renderer; the id says which session. A fast
    // stop-and-start keeps the first and changes the second, so a report
    // without one cannot be placed at all.
    const { link, generation } = readyLink();
    const seen: string[] = [];
    link.onIntegrity((sessionId) => {
      seen.push(sessionId);
      return true;
    });

    expect(await link.reportIntegrity(generation, '', [])).toBe(false);
    expect(await link.reportIntegrity(generation, 7, [])).toBe(false);
    expect(seen.length).toBe(0);
  });

  it('records nothing, and says so, when nothing is listening', async () => {
    const { link, generation } = readyLink();
    expect(await link.reportIntegrity(generation, 's1', [])).toBe(false);
    expect(link.available).toBe(true);
  });
});

describe('withdrawing a command', () => {
  it('takes back a command that is still in flight', async () => {
    const { link } = readyLink();
    const controller = new AbortController();
    const promise = link.send('start', null, { signal: controller.signal, timeoutMs: 5000 });

    // A stop arriving while a start is still running: the coordinator has to
    // take the start back now, not wait out its timeout.
    controller.abort();

    const error = await rejection(promise);
    expect(error instanceof ExecutorAbortedError).toBe(true);
    expect(link.inFlight).toBe(0);
  });

  it('tells the executor to abandon it', async () => {
    const { link, sent } = readyLink();
    const controller = new AbortController();
    const promise = link.send('start', null, { signal: controller.signal });
    controller.abort();
    await rejection(promise);
    const cancels = sent.filter((m) => m.kind === 'cancel');
    expect(cancels.length).toBe(1);
    expect(cancels[0].id).toBe(commands(sent)[0].id);
  });

  it('refuses a command whose signal is already aborted', async () => {
    const { link, sent } = readyLink();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(link.send('start', null, { signal: controller.signal }));
    expect(error instanceof ExecutorAbortedError).toBe(true);
    // Never sent, so there is nothing to cancel.
    expect(sent.length).toBe(0);
  });

  it('does nothing when the signal fires after the command was answered', async () => {
    const { link, sent, generation } = readyLink();
    const controller = new AbortController();
    const promise = link.send('a', null, { signal: controller.signal });
    link.acknowledge(commands(sent)[0].id, generation, 'done');
    expect(await promise).toBe('done');

    controller.abort();
    expect(sent.filter((m) => m.kind === 'cancel').length).toBe(0);
  });
});
