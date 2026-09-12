/**
 * Device observations, none of which is a verdict.
 *
 * Two things are being pinned here, and the second is easy to mistake for
 * decoration. The first is the reading itself — what is taken, what is refused,
 * and in what order, since every defect this module has had was an ordering
 * defect. The second is the *copy*: none of these four readings can support a
 * conclusion, and what stops them being read as one is the words they carry. A
 * fact that called `sampleRate` the hardware rate, offered latency as a
 * transport, or let a channel count imply what the listener hears would be
 * wrong in exactly the way this step exists to stop — the last of those having
 * been a rule here until real devices refuted it.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  DeviceReader,
  LATENCY_SETTLE_MS,
  deviceFacts,
  noObservations,
  readOutputDevice,
  withContext,
  withOutputDevice,
  type DeviceDirectory,
  type DeviceEntry,
  type DeviceObservations,
  type OutputContext,
  type Schedule,
} from '../src/integrity/devices.ts';
import { missingScopeFindings } from '../src/integrity/rules.ts';
import { checkedScopes } from '../src/integrity/findings.ts';

const REQUESTED = 48000;

function context(overrides: Partial<OutputContext> = {}): OutputContext {
  return {
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    destination: { maxChannelCount: 2 },
    ...overrides,
  };
}

const observed = (overrides: Partial<OutputContext> = {}): DeviceObservations =>
  withContext(noObservations(REQUESTED), context(overrides));

const entry = (kind: string, deviceId: string, label = ''): DeviceEntry => ({
  kind,
  deviceId,
  label,
});

const fact = (observations: DeviceObservations, id: string) =>
  deviceFacts(observations).find((f) => f.id === id);

/**
 * A directory a test controls: what it answers, and how slowly.
 *
 * Each call captures the entry list as it stood when the call *started*, so a
 * reply landing out of order carries a stale answer — which is the whole
 * failure being tested. `slowFirst` makes the first call the last to resolve,
 * which is what an unsequenced refresh turns into a wrong final state.
 */
class FakeDirectory implements DeviceDirectory {
  entries: DeviceEntry[];
  calls = 0;
  slowFirst = false;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  constructor(entries: DeviceEntry[] = [entry('audiooutput', 'default', 'Speakers')]) {
    this.entries = entries;
  }

  /** Keep every call in flight until `release()`. */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.open = null;
    this.gate = null;
  }

  async enumerateDevices(): Promise<readonly DeviceEntry[]> {
    this.calls += 1;
    const answer = [...this.entries];
    const first = this.calls === 1;
    if (this.gate !== null) await this.gate;
    if (this.slowFirst) await new Promise((resolve) => setTimeout(resolve, first ? 30 : 5));
    return answer;
  }
}

/**
 * A schedule a test fires by hand.
 *
 * One pending callback, replaced by `after` and dropped by `cancel` — the same
 * contract the real one keeps with a timer handle.
 */
class FakeSchedule implements Schedule {
  delays: number[] = [];
  private pending: (() => void) | null = null;

  after(delayMs: number, fire: () => void): void {
    this.delays.push(delayMs);
    this.pending = fire;
  }

  cancel(): void {
    this.pending = null;
  }

  get scheduled(): boolean {
    return this.pending !== null;
  }

  /** Run whatever is pending, as the timer would. */
  fire(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.();
  }
}

/** A destination whose channel count moves, as a real one does. */
function movableContext(channels: number): OutputContext & { channels: number } {
  const live = {
    sampleRate: 48000,
    baseLatency: 0.01,
    // Both movable: the destination changes when a device does, and the
    // latency only becomes known once audio has been rendering.
    outputLatency: 0.02,
    channels,
    get destination() {
      return { maxChannelCount: live.channels };
    },
  };
  return live;
}

describe('reading a context', () => {
  it('takes the rate, the latencies and the channel count', () => {
    const o = observed();
    expect(o.renderRateHz).toBe(48000);
    expect(o.baseLatencySeconds).toBe(0.01);
    expect(o.outputLatencySeconds).toBe(0.02);
    expect(o.maxChannelCount).toBe(2);
  });

  it('reads nothing at all before a graph exists', () => {
    const o = noObservations(REQUESTED);
    expect(o.renderRateHz).toBe(null);
    expect(o.maxChannelCount).toBe(null);
    expect(o.outputsEnumerated).toBe(false);
  });

  it('records a latency the platform does not report as absent, not as zero', () => {
    // `outputLatency` is optional, and 0 is a value some implementation could
    // genuinely mean. Defaulting the absent case to it would show a number
    // nobody measured — the same defect as reading zero from a dead signal.
    const o = withContext(noObservations(REQUESTED), context({ outputLatency: undefined }));
    expect(o.outputLatencySeconds).toBe(null);
    expect(fact(o, 'latency')?.value).toBe('10.0 ms base');
  });

  it('reads a zero output latency as not measured yet', () => {
    // Chromium derives this from callback timing, so it is 0 until audio has
    // been rendering for a moment — 0 on a context that had just started, and
    // 24 ms on the same context a second later. No real output path has zero
    // latency, so showing it would be a number nobody took.
    const o = withContext(noObservations(REQUESTED), context({ outputLatency: 0 }));
    expect(o.outputLatencySeconds).toBe(null);
    // `baseLatency` is a property of the graph's own buffering, and is
    // meaningful the moment there is a graph.
    expect(o.baseLatencySeconds).toBe(0.01);
    expect(fact(o, 'latency')?.value).toBe('10.0 ms base');
  });

  it('refuses a reading that is not a number', () => {
    const o = withContext(
      noObservations(REQUESTED),
      context({ sampleRate: Number.NaN, baseLatency: Number.POSITIVE_INFINITY }),
    );
    expect(o.renderRateHz).toBe(null);
    expect(o.baseLatencySeconds).toBe(null);
  });
});

describe('reading the output directory', () => {
  it('prefers the default entry over whatever came first', async () => {
    const o = withOutputDevice(
      observed(),
      await readOutputDevice({
        enumerateDevices: async () => [
          entry('audioinput', 'default', 'Some microphone'),
          entry('audiooutput', 'abc123', 'Studio monitors'),
          entry('audiooutput', 'default', 'MacBook Pro Speakers'),
        ],
      }),
    );
    expect(o.outputsEnumerated).toBe(true);
    expect(o.defaultOutput?.deviceId).toBe('default');
    expect(o.defaultOutput?.label).toBe('MacBook Pro Speakers');
  });

  it('falls back to the only output where the platform names no default', async () => {
    const o = withOutputDevice(
      observed(),
      await readOutputDevice({
        enumerateDevices: async () => [entry('audiooutput', 'abc123', 'USB Audio')],
      }),
    );
    expect(o.defaultOutput?.deviceId).toBe('abc123');
  });

  it('records a withheld label as unknown rather than as an empty name', async () => {
    // Labels are withheld until a page has device permission, and this app
    // deliberately never asks for a microphone. The device is still recorded.
    const o = withOutputDevice(
      observed(),
      await readOutputDevice({ enumerateDevices: async () => [entry('audiooutput', 'default')] }),
    );
    expect(o.defaultOutput?.label).toBe(null);
    expect(fact(o, 'output-device')?.value).toBe('default output');
    expect(/microphone permission/.test(fact(o, 'output-device')?.note ?? '')).toBe(true);
  });

  it('distinguishes a directory that failed from one with no outputs', async () => {
    const failed = withOutputDevice(
      observed(),
      await readOutputDevice({
        enumerateDevices: () => Promise.reject(new Error('no permission')),
      }),
    );
    expect(failed.outputsEnumerated).toBe(false);
    expect(fact(failed, 'output-device')?.value).toBe('not available');

    const empty = withOutputDevice(
      observed(),
      await readOutputDevice({
        enumerateDevices: async () => [],
      }),
    );
    expect(empty.outputsEnumerated).toBe(true);
    expect(empty.defaultOutput).toBe(null);
    expect(fact(empty, 'output-device')?.value).toBe('none reported');
  });
});

describe('the facts, and the words that keep them facts', () => {
  it('calls the rate the graph render rate, and says it is not the hardware rate', () => {
    const rate = fact(observed(), 'render-rate');
    expect(rate?.label).toBe('Graph render rate');
    expect(rate?.value).toBe('48,000 Hz');
    // The claim this reading cannot make. `graph.ts` already says the request
    // is a hint and the OS may resample regardless.
    expect(/not the hardware rate/.test(rate?.note ?? '')).toBe(true);
  });

  it('says what was asked for when the two differ, without calling it a fault', () => {
    const rate = fact(observed({ sampleRate: 44100 }), 'render-rate');
    expect(rate?.value).toBe('44,100 Hz');
    expect(/48,000 Hz/.test(rate?.note ?? '')).toBe(true);
    expect(/correct at either rate/.test(rate?.note ?? '')).toBe(true);
  });

  it('reports latency as latency, and never as a transport', () => {
    // An earlier draft proposed reading a Bluetooth "proxy" from this number —
    // a threshold fitted on one machine, which is the guess this project has
    // already made twice.
    const latency = fact(observed(), 'latency');
    expect(latency?.value).toBe('10.0 ms base · 20.0 ms output');
    expect(/does not identify Bluetooth/.test(latency?.note ?? '')).toBe(true);
  });

  it('says a reading is unavailable rather than inventing one', () => {
    const facts = deviceFacts(noObservations(REQUESTED));
    expect(facts.length).toBe(4);
    expect(facts.every((f) => f.value === 'not available')).toBe(true);
  });
});

describe('the channel count, which used to be a rule', () => {
  it('is a fact, and says what it cannot see', () => {
    // It was a rule — warn on one channel with binaural routing — and it never
    // fired. Across three platforms it read 2 for a physically mono
    // speakerphone, a one-channel PipeWire sink, Galaxy Buds in their mono
    // hands-free profile, and with Windows' Mono audio setting on, which
    // combines the channels outright and so destroys a binaural beat. A
    // reading that cannot see that cannot support a verdict about it.
    const channels = fact(observed(), 'output-channels');
    expect(channels?.label).toBe('Output channels');
    expect(channels?.value).toBe('2');
    expect(/combine the channels below this point/.test(channels?.note ?? '')).toBe(true);
  });

  it('reports one channel as a fact too, without a verdict on it', () => {
    const channels = fact(observed({ destination: { maxChannelCount: 1 } }), 'output-channels');
    expect(channels?.value).toBe('1');
  });

  it('says nothing at all before a graph exists', () => {
    expect(fact(noObservations(REQUESTED), 'output-channels')?.value).toBe('not available');
  });

  it('leaves the app output uncovered, since nothing has measured it', () => {
    // The consequence worth stating: a session used to record `graph` coverage
    // on the strength of this reading, which is a number read rather than
    // audio measured. Nothing produces a checked `graph` finding now.
    const placeholders = missingScopeFindings([]);
    expect(checkedScopes(placeholders).length).toBe(0);
    const graph = placeholders.find((finding) => finding.scope === 'graph');
    expect(graph?.checked).toBe(false);
    expect(/not a measurement of the audio/.test(graph?.detail ?? '')).toBe(true);
  });
});

describe('keeping the readings in order', () => {
  it('does not restore what it captured when a graph is built mid-enumeration', async () => {
    // The defect this class exists for. The first enumeration starts at load;
    // if the user starts audio before it lands, a refresh that answered with
    // a modified copy of the state it captured would put the pre-graph
    // snapshot back and erase the channel count, the rate and the latency.
    const directory = new FakeDirectory();
    const reader = new DeviceReader(REQUESTED, () => directory);

    directory.hold();
    const refreshing = reader.refresh();
    // Wait until the enumeration has genuinely started. Without this the graph
    // would appear before the refresh body ever ran, and the window this test
    // is about — a read already in flight — would never open.
    for (let turn = 0; turn < 20 && directory.calls === 0; turn++) await Promise.resolve();
    expect(directory.calls).toBe(1);

    // The graph appears while the directory is still being read.
    reader.observe(context());
    expect(reader.current.maxChannelCount).toBe(2);

    directory.release();
    const after = await refreshing;

    expect(after.maxChannelCount).toBe(2);
    expect(after.renderRateHz).toBe(48000);
    expect(after.baseLatencySeconds).toBe(0.01);
    // Behaviour, not a line: re-deriving the context readings after the await
    // would also survive a captured merge. Both are asserted because the shape
    // that failed had neither.
    // And the enumeration's own result is there too, rather than one having
    // been chosen over the other.
    expect(after.defaultOutput?.label).toBe('Speakers');
  });

  it('lands two device changes in the order they were asked for', async () => {
    // Two `devicechange` events in quick succession. The first enumeration is
    // the slower of the two, so without sequencing it resolves last and puts
    // the headset that was just unplugged back over the one now in use.
    const directory = new FakeDirectory();
    directory.slowFirst = true;
    const reader = new DeviceReader(REQUESTED, () => directory);
    reader.observe(context());

    const first = reader.refresh();
    directory.entries = [entry('audiooutput', 'default', 'Headphones')];
    const second = reader.refresh();

    await first;
    await second;

    expect(directory.calls).toBe(2);
    expect(reader.current.defaultOutput?.label).toBe('Headphones');
  });

  it('re-reads the destination on every refresh, not only when the graph appears', async () => {
    // The whole reason `devicechange` is watched. `maxChannelCount` moves under
    // the same context, so a refresh that only re-enumerated would update the
    // device's name while the channel count went on describing the headset
    // that was unplugged.
    const live = movableContext(2);
    const directory = new FakeDirectory();
    const reader = new DeviceReader(REQUESTED, () => directory);

    reader.observe(live);
    expect(reader.current.maxChannelCount).toBe(2);
    expect(deviceFacts(reader.current).find((f) => f.id === 'output-channels')?.value).toBe('2');

    live.channels = 1;
    await reader.refresh();

    expect(reader.current.maxChannelCount).toBe(1);
    expect(deviceFacts(reader.current).find((f) => f.id === 'output-channels')?.value).toBe('1');
  });

  it('picks up a latency that was not available when playback started', async () => {
    // `outputLatency` is zero until the platform has timed a real callback, so
    // the reading taken the instant playback starts is never the one worth
    // showing. Without a second look the fact says "not available" for the
    // whole session — the first read is the only one anything ever takes.
    const live = movableContext(2);
    live.outputLatency = 0;
    const reader = new DeviceReader(REQUESTED, () => new FakeDirectory());

    reader.observe(live);
    expect(reader.current.outputLatencySeconds).toBe(null);

    // A second of audio later, the platform knows.
    live.outputLatency = 0.024;
    reader.reread();

    expect(reader.current.outputLatencySeconds).toBe(0.024);
    expect(deviceFacts(reader.current).find((f) => f.id === 'latency')?.value).toBe(
      '10.0 ms base · 24.0 ms output',
    );
  });

  it('keeps the last reading when there is no directory to ask', async () => {
    const reader = new DeviceReader(REQUESTED, () => null);
    reader.observe(context());
    await reader.refresh();
    expect(reader.current.maxChannelCount).toBe(2);
    expect(reader.current.outputsEnumerated).toBe(false);
  });
});

describe('looking again once playback has settled', () => {
  /** A context whose output latency only becomes known while it renders. */
  function startingUp(): ReturnType<typeof movableContext> {
    const live = movableContext(2);
    live.outputLatency = 0;
    return live;
  }

  it('schedules a second look when playback starts', () => {
    const schedule = new FakeSchedule();
    const reader = new DeviceReader(REQUESTED, () => new FakeDirectory(), schedule);
    const live = startingUp();

    reader.observeRunning(live);
    // The first look is honest and incomplete: the platform has not timed a
    // callback yet, so there is no latency to report.
    expect(reader.current.outputLatencySeconds).toBe(null);
    expect(schedule.scheduled).toBe(true);
    expect(schedule.delays.join(',')).toBe(String(LATENCY_SETTLE_MS));

    live.outputLatency = 0.024;
    schedule.fire();
    expect(reader.current.outputLatencySeconds).toBe(0.024);
  });

  it('asks the directory again when playback starts', async () => {
    // `devicechange` does not fire for every change that matters: switching
    // the default sink on Linux moves the audio without changing the device
    // set, and Chromium says nothing — so the panel would go on naming the
    // device the user just stopped using. Playback starting is the user's own
    // action, and the cheapest place to re-ask.
    const schedule = new FakeSchedule();
    const directory = new FakeDirectory();
    const reader = new DeviceReader(REQUESTED, () => directory, schedule);

    reader.observeRunning(startingUp());
    for (let turn = 0; turn < 20 && directory.calls === 0; turn++) await Promise.resolve();

    expect(directory.calls).toBe(1);
  });

  it('does not look again after playback has stopped', () => {
    // The guarantee this cancellation exists for. A settle that outlives the
    // audio reads a context that is suspending, whose output latency is on its
    // way back to zero — and a zero is recorded as "not measured", so a stop
    // quick enough to beat the timer would erase a real reading.
    const schedule = new FakeSchedule();
    const reader = new DeviceReader(REQUESTED, () => new FakeDirectory(), schedule);
    const live = startingUp();

    reader.observeRunning(live);
    live.outputLatency = 0.024;
    reader.reread();
    expect(reader.current.outputLatencySeconds).toBe(0.024);

    // Playback stops, and the context winds down.
    reader.stopSettling();
    live.outputLatency = 0;

    expect(schedule.scheduled).toBe(false);
    schedule.fire();
    expect(reader.current.outputLatencySeconds).toBe(0.024);
  });

  it('keeps one settle outstanding, not one per start', () => {
    // Preview, stop, start a session: three starts in a few seconds. Each
    // replaces the last rather than piling up reads of a context that has
    // moved on.
    const schedule = new FakeSchedule();
    const reader = new DeviceReader(REQUESTED, () => new FakeDirectory(), schedule);
    const live = startingUp();

    reader.observeRunning(live);
    reader.observeRunning(live);
    expect(schedule.delays.length).toBe(2);

    live.outputLatency = 0.024;
    schedule.fire();
    expect(reader.current.outputLatencySeconds).toBe(0.024);
    // Nothing left behind to fire a second time.
    expect(schedule.scheduled).toBe(false);
  });

  it('tells its listener about a reading nobody asked for', () => {
    // The settle fires on a timer with no caller waiting on it, so without a
    // listener the value would sit in the reader and never reach the screen.
    const schedule = new FakeSchedule();
    const reader = new DeviceReader(REQUESTED, () => new FakeDirectory(), schedule);
    const seen: (number | null)[] = [];
    reader.onChange((observations) => seen.push(observations.outputLatencySeconds));

    const live = startingUp();
    reader.observeRunning(live);
    live.outputLatency = 0.024;
    schedule.fire();

    expect(seen.join(',')).toBe(',0.024');
  });
});

describe('a refresh that lands after playback stopped', () => {
  it('does not erase the latency it measured while running', () => {
    // `stopSettling` cancels the timer, and for a while that was all it
    // cancelled: the directory read `observeRunning` kicks off is
    // asynchronous, and a refresh landing after the context suspended re-read
    // it, found `outputLatency` back at zero, and recorded that as "not
    // measured" — erasing a real measurement with an artefact of stopping.
    const schedule = new FakeSchedule();
    const directory = new FakeDirectory();
    const reader = new DeviceReader(REQUESTED, () => directory, schedule);
    const live = movableContext(2);
    live.outputLatency = 0;

    directory.hold();
    reader.observeRunning(live);

    // A second of audio: the platform reports a latency and the settle takes
    // it, exactly as it does in the app.
    live.outputLatency = 0.056;
    schedule.fire();
    expect(reader.current.outputLatencySeconds).toBe(0.056);

    // The user stops. The context winds down, and the enumeration started at
    // playback start is still in flight.
    reader.stopSettling();
    live.outputLatency = 0;
    directory.release();

    return Promise.resolve().then(async () => {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(reader.current.outputLatencySeconds).toBe(0.056);
      // The half of that refresh that is still valid landed anyway: the device
      // list does not stop being true because playback ended.
      expect(reader.current.outputsEnumerated).toBe(true);
    });
  });

  it('still takes a whole refresh while playback continues', async () => {
    // The guard must not disarm the re-read this exists for: a device change
    // during playback has to move the channel count.
    const schedule = new FakeSchedule();
    const directory = new FakeDirectory();
    const reader = new DeviceReader(REQUESTED, () => directory, schedule);
    const live = movableContext(2);

    reader.observeRunning(live);
    live.channels = 6;
    await reader.refresh();

    expect(reader.current.maxChannelCount).toBe(6);
  });
});
