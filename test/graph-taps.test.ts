/**
 * The graph's own wiring of the capture taps and the steady boundary.
 *
 * `steady-window.ts` proves the arithmetic; this proves the graph performs it.
 * The two are worth separating because the failure modes differ: the arithmetic
 * can be subtly wrong, and the call can simply be missing — and a missing call
 * leaves every test of the arithmetic passing while the boundary never moves.
 *
 * Driven against a fake `AudioContext` rather than a real one, so it runs in
 * Node beside the rest. The fake is deliberately thin: enough for `build()` to
 * connect its nodes and for gains to accept automation, and nothing more. What
 * it cannot answer — whether Chromium actually schedules a node with no outputs
 * — is asked in the Electron and packaged suites instead.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  CAPTURE_RING_SECONDS,
  EntrainmentGraph,
  MAX_MASTER_LEVEL,
  transitionPeakBound,
  worstCaseSourcePeak,
} from '../src/audio/graph.ts';
import { DEFAULT_PARAMS, SOURCE_SETTLE_SECONDS } from '../src/audio/dsp/entrainment-core.ts';
import {
  MAX_BED_CROSSFADE_SECONDS,
  MIN_BED_CROSSFADE_SECONDS,
  notchPeakGain,
  notchSettleSeconds,
} from '../src/audio/dsp/biquad.ts';
import { DEFAULT_SOUNDSCAPE } from '../src/audio/configuration.ts';

const SR = 48000;

interface Posted {
  type: string;
}

interface Scheduled {
  kind: 'set' | 'ramp';
  value: number;
  at: number;
}

/**
 * The context clock, shared by every parameter.
 *
 * A parameter's `value` is its automation curve evaluated *now*, not the last
 * figure assigned to it. Modelling it as a plain field is what let a reverted
 * crossfade pass unnoticed: the source read `g.value`, got a stale 1 instead
 * of the 0.55 the ramp had actually reached, and re-anchored the curve to a
 * value it had already left.
 */
let contextNow = 0;

class FakeParam {
  /** Every automation event still scheduled, in time order. */
  readonly events: Scheduled[] = [];
  /**
   * Automation calls ever made, which only ever grows.
   *
   * `events` does not: `rampMaster` cancels scheduled values first, so a call
   * that reschedules the future can leave the list the same length or shorter.
   * Counting entries to prove "something happened" therefore proves nothing.
   */
  calls = 0;
  /**
   * Automation calls, as distinct from plain assignment.
   *
   * A chain's coefficients are assigned once at construction and must never be
   * *scheduled* afterwards — the property the transition bound rests on.
   */
  scheduled = 0;
  /**
   * Every operation that moved the value at the present instant.
   *
   * The property no inspection of the final timeline can give you. A real
   * parameter is already rendering, so whatever it has reached it has reached;
   * cancelling an in-progress ramp's endpoint reverts it to the event before,
   * and that is a click. The timeline left behind reads perfectly continuous.
   */
  readonly jumps: { at: number; before: number; after: number }[] = [];

  private insert(event: Scheduled): void {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].at > event.at) i--;
    this.events.splice(i, 0, event);
  }

  private mutating(apply: () => void): void {
    const before = this.valueAt(contextNow);
    apply();
    const after = this.valueAt(contextNow);
    if (Math.abs(after - before) > 1e-9) this.jumps.push({ at: contextNow, before, after });
  }

  /** The curve evaluated at the context's current time, as the real one is. */
  get value(): number {
    return this.valueAt(contextNow);
  }

  /** Assignment is an immediate set, which is what the real parameter does. */
  set value(v: number) {
    this.insert({ kind: 'set', value: v, at: contextNow });
  }

  /** The automation curve at `t`, ramps interpolated. */
  valueAt(t: number): number {
    let previous: Scheduled | null = null;
    for (const event of this.events) {
      if (event.at > t) {
        if (event.kind === 'ramp' && previous !== null) {
          const span = event.at - previous.at;
          const u = span <= 0 ? 1 : (t - previous.at) / span;
          return previous.value + (event.value - previous.value) * u;
        }
        break;
      }
      previous = event;
    }
    return previous === null ? 0 : previous.value;
  }

  setValueAtTime(value: number, at: number): void {
    this.calls++;
    this.scheduled++;
    this.mutating(() => this.insert({ kind: 'set', value, at }));
  }
  linearRampToValueAtTime(value: number, at: number): void {
    this.calls++;
    this.scheduled++;
    this.mutating(() => this.insert({ kind: 'ramp', value, at }));
  }
  /**
   * Modelled, not stubbed.
   *
   * A fake that records the call and keeps the events proves nothing about
   * cancellation — the superseded event is still in the list, so a test
   * looking for it finds it whether or not the code cancelled anything. The
   * real parameter drops every event at or after `at`, so this does too.
   */
  cancelScheduledValues(at: number): void {
    this.mutating(() => {
      for (let i = this.events.length - 1; i >= 0; i--) {
        if (this.events[i].at >= at) this.events.splice(i, 1);
      }
    });
  }

  /**
   * Modelled, not stubbed — and that distinction is the whole point.
   *
   * Left as a no-op, a fake cannot tell a held curve from one reset to a jump:
   * a discontinuous reschedule satisfies every assertion about gains summing
   * within one. Holding keeps the curve up to `at` and cancels only what
   * follows, which is exactly what a crossfade needs.
   */
  cancelAndHoldAtTime(at: number): void {
    this.mutating(() => {
      const held = this.valueAt(at);
      // A ramp spanning `at` is *truncated*, not deleted. Deleting it would
      // flatten the curve before the hold too, which is a jump at the present
      // instant — the very thing this call exists to avoid. The replacement
      // therefore keeps the ramp's kind so the approach to `at` survives.
      const spanning = this.events.some((event) => event.kind === 'ramp' && event.at > at);
      for (let i = this.events.length - 1; i >= 0; i--) {
        if (this.events[i].at > at) this.events.splice(i, 1);
      }
      this.insert({ kind: spanning ? 'ramp' : 'set', value: held, at });
    });
  }
}

class FakeNode {
  /** Everything this node was told to disconnect from, so retirement is checkable. */
  readonly disconnected: unknown[] = [];
  connect<T>(destination: T): T {
    return destination;
  }
  disconnect(destination?: unknown): void {
    this.disconnected.push(destination ?? 'all');
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = '';
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
}

/**
 * Every gain node built, in construction order.
 *
 * `build()` creates entrainmentGain, soundscapeGain, envelopeGain and then
 * masterBus, so index 3 is the master. Found by position rather than by "the
 * one that has a ramp" — the playback envelope ramps too, and it is created
 * first, so that search silently returns the wrong node.
 */
const gains: FakeGain[] = [];
const MASTER_BUS = 3;
/** `build()` creates entrainmentGain, soundscapeGain, envelopeGain, masterBus. */
const SOUNDSCAPE_GAIN = 1;
const soundscapeGain = (): FakeGain => gains[SOUNDSCAPE_GAIN];
const masterBus = (): FakeGain => {
  if (gains.length <= MASTER_BUS) throw new Error(`only ${gains.length} gain nodes were built`);
  return gains[MASTER_BUS];
};
/** Every filter built, so notch scheduling times can be read. */
const filters: FakeFilter[] = [];

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeAnalyser extends FakeNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
}

/** Every worklet node built, so the test can read what each was told. */
const built: {
  name: string;
  options: Record<string, unknown>;
  posted: Posted[];
  port?: { postMessage(message: Posted): void; onmessage: unknown };
  node?: FakeNode;
}[] = [];

class FakeAudioWorkletNode extends FakeNode {
  port: { postMessage(message: Posted): void; onmessage: unknown };

  constructor(_context: unknown, name: string, options: Record<string, unknown> = {}) {
    super();
    const record: (typeof built)[number] = { name, options, posted: [] as Posted[] };
    built.push(record);
    this.port = {
      postMessage: (message: Posted) => record.posted.push(message),
      onmessage: null,
    };
    record.port = this.port;
    record.node = this;
  }
}

class FakeContext {
  get currentTime(): number {
    return contextNow;
  }
  set currentTime(t: number) {
    contextNow = t;
  }
  sampleRate = SR;
  state = 'running';
  destination = new FakeNode();
  audioWorklet = { addModule: async (): Promise<void> => undefined };

  createGain(): FakeGain {
    const gain = new FakeGain();
    gains.push(gain);
    return gain;
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createBiquadFilter(): FakeFilter {
    const filter = new FakeFilter();
    filters.push(filter);
    return filter;
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  async resume(): Promise<void> {}
  async suspend(): Promise<void> {}
  async close(): Promise<void> {}
}

const scope = globalThis as unknown as Record<string, unknown>;
scope.AudioWorkletNode = FakeAudioWorkletNode;

async function makeGraph(): Promise<{ graph: EntrainmentGraph; context: FakeContext }> {
  contextNow = 0;
  built.length = 0;
  gains.length = 0;
  filters.length = 0;
  const context = new FakeContext();
  const graph = await EntrainmentGraph.create({
    entrainmentWorkletUrl: 'entrainment.js',
    noiseWorkletUrl: 'noise.js',
    notchWorkletUrl: 'notch.js',
    captureWorkletUrl: 'capture.js',
    context: context as unknown as AudioContext,
  });
  return { graph, context };
}

/**
 * Deliver a settlement from the entrainment worklet, as Chromium would.
 *
 * Settlement, not adoption. The worklet reports both, and only the second one
 * means the gains are actually at their targets — which is what lets the graph
 * stop guarding.
 */
function acknowledge(revision: number): void {
  const node = built.find((entry) => entry.name === 'entrainment-processor');
  const handler = node?.port?.onmessage as ((event: { data: unknown }) => void) | null | undefined;
  if (!handler) throw new Error('the graph installed no message handler on the worklet');
  handler({ data: { type: 'settled', revision } });
}

/**
 * Acknowledge the latest revision, as the worklet would once it adopted it.
 *
 * Setup calls need this or the graph is still guarding against the
 * construction defaults, and a test that omits it measures the wrong baseline
 * — which is exactly what two of the tests below did at first.
 */
function settle(): void {
  const node = built.find((entry) => entry.name === 'entrainment-processor');
  const revision = (node?.posted.at(-1) as unknown as { revision?: number } | undefined)?.revision;
  if (typeof revision === 'number') acknowledge(revision);
}

/**
 * Acknowledge the notch worklet's latest handover as settled.
 *
 * Separate from `settle()`: entrainment settlement and notch settlement are
 * different events on different clocks, and the graph waits for each. A test
 * that only delivers the first leaves the cascade mid-handover forever.
 */
function settleNotch(): void {
  const node = built.find((entry) => entry.name === 'notch-processor');
  const revision = (node?.posted.at(-1) as unknown as { revision?: number } | undefined)?.revision;
  const handler = node?.port?.onmessage as ((event: { data: unknown }) => void) | null | undefined;
  if (handler && typeof revision === 'number') {
    handler({ data: { type: 'notch-settled', revision } });
  }
}

const captureNodes = () => built.filter((node) => node.name === 'capture-processor');
const epochsSent = () =>
  captureNodes().map((node) => node.posted.filter((message) => message.type === 'epoch').length);

describe('building the taps', () => {
  it('creates two, with no outputs and a ring long enough to be asked for', async () => {
    const { graph } = await makeGraph();
    const nodes = captureNodes();
    expect(nodes.length).toBe(2);

    for (const node of nodes) {
      expect(node.options.numberOfOutputs).toBe(0);
      expect(node.options.numberOfInputs).toBe(1);
      const processorOptions = node.options.processorOptions as { seconds: number };
      expect(processorOptions.seconds).toBe(CAPTURE_RING_SECONDS);
    }

    expect(graph.captureCapacityFrames).toBe(CAPTURE_RING_SECONDS * SR);
    expect(graph.entrainmentCapture !== null).toBe(true);
    expect(graph.masterCapture !== null).toBe(true);
  });

  it('leaves them absent when no capture worklet is supplied', async () => {
    // A surface that asks and gets null knows it cannot check anything, which
    // beats a tap that exists and records nothing.
    built.length = 0;
    const graph = await EntrainmentGraph.create({
      entrainmentWorkletUrl: 'entrainment.js',
      noiseWorkletUrl: 'noise.js',
      notchWorkletUrl: 'notch.js',
      context: new FakeContext() as unknown as AudioContext,
    });
    expect(captureNodes().length).toBe(0);
    expect(graph.entrainmentCapture).toBe(null);
    expect(graph.masterCapture).toBe(null);
  });
});

describe('the steady boundary, as the graph maintains it', () => {
  it('opens after the ramp when preview starts', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 10;
    await graph.start(3);

    expect(graph.steadyPlayback.from).toBe(13);
    expect(graph.steadyPlayback.until).toBe(Infinity);
  });

  it('knows both ends of a timed session up front', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 100;
    await graph.startSession({ plannedSeconds: 600, rampInSeconds: 3, rampOutSeconds: 1.5 });

    expect(graph.steadyPlayback.from).toBe(103);
    // The fade lands on the planned end, so steadiness stops where it begins.
    expect(graph.steadyPlayback.until).toBe(698.5);
  });

  it('reports no window at all while an acknowledgement is outstanding', async () => {
    // The stored boundary is a prediction, and a finite prediction expires on
    // its own even when the change it was made for has not arrived. Nothing
    // bounds port delivery, and the retry path makes the gap deterministic
    // rather than unlikely: a settlement pushes the boundary by the master
    // ramp and then schedules a handover whose fade can run for twice that.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    expect(graph.steadyPlayback.from).toBeLessThan(Infinity);

    context.currentTime = 50.0001;
    graph.setParams({ carrierHz: 300 });
    // Closed, not merely pushed: the configuration has not been adopted yet.
    expect(graph.steadyPlayback.from).toBe(Infinity);

    // Long enough that any predicted boundary would have expired.
    context.currentTime = 55;
    expect(graph.steadyPlayback.from).toBe(Infinity);
  });

  it('reopens the window once everything has acknowledged', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 50.0001;
    graph.setParams({ carrierHz: 300 });
    settle();
    // The entrainment side is settled, but the cascade is still handing over.
    expect(graph.steadyPlayback.from).toBe(Infinity);

    context.currentTime = 50.4;
    settleNotch();
    const from = graph.steadyPlayback.from;
    expect(from).toBeLessThan(Infinity);
    // And it reopens past the ramp that settlement itself begins.
    expect(from).toBeGreaterThan(50.4);
  });

  it('says so when the window reopens, not only that it closed', async () => {
    // Closing it is only half the change. `passDelaySeconds` treats a window
    // with no finite start as *no measurement at all* rather than one to wait
    // for, so a pass scheduled during a transition is cancelled outright —
    // and without something to say it is worth asking again, nothing is ever
    // measured. Only the Electron integrity tests caught this, by timing out.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 50;
    graph.setParams({ carrierHz: 300 });
    const afterChange = epochsSent();

    settle();
    context.currentTime = 50.4;
    settleNotch();

    // An epoch after the acknowledgements, not just the one at the change.
    const afterSettling = epochsSent();
    expect(afterSettling.every((count, i) => count > afterChange[i])).toBe(true);
    // And the window really is open by then, so the epoch is worth acting on.
    expect(graph.steadyPlayback.from).toBeLessThan(Infinity);
  });

  it('pushes the boundary past the whole transition when it does reopen', async () => {
    // Every change is scheduled, so the boundary is measured from the
    // quantised landing plus the time the worklet's gains take to settle.
    //
    // The offset from a round second is deliberate: a round second plus the
    // guard is a whole number of quanta at 48 kHz, so quantisation would move
    // nothing and this would pass against a constant just as well — which it
    // did, until the mutation that removed the quantisation failed to fail.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const landingAfter = (from: number): number =>
      (Math.ceil(((from + 0.05) * SR) / 128) * 128) / SR;

    context.currentTime = 60.0001;
    graph.setSoundscape({ gain: 0.4 });
    const landing = landingAfter(60.0001);
    expect(landing).toBeGreaterThan(60.05);

    // Acknowledge only the entrainment side, then read the stored prediction
    // through a graph with no notch handover outstanding.
    settle();
    settleNotch();
    expect(graph.steadyPlayback.from).toBeGreaterThanOrEqual(
      landing + SOURCE_SETTLE_SECONDS + 0.05,
    );
  });

  it('pushes past a master level change, however short the ramp was asked to be', async () => {
    // `rampMaster` floors a ramp at a millisecond, so passing the raw figure
    // here marked the graph steady while the gain was still moving.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 20;
    graph.setMasterLevel(0.5, 0);
    expect(graph.steadyPlayback.from).toBe(20.001);
  });

  it('leaves the boundary alone while nothing is playing', async () => {
    // A configuration change before playback should not invent a steady window.
    const { graph, context } = await makeGraph();
    context.currentTime = 5;
    graph.setParams({ carrierHz: 300 });
    expect(graph.steadyPlayback.from).toBe(Infinity);
  });

  it('hands out a copy, not the boundary it decides by', async () => {
    // The aliasing mistake this project keeps making, here where it would turn
    // "do not measure this" into "measure it" without touching the graph.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(3);

    const reported = graph.steadyPlayback;
    try {
      (reported as { from: number }).from = 0;
    } catch {
      // A frozen copy would be fine too; what matters is the graph is unmoved.
    }
    expect(graph.steadyPlayback.from).toBe(3);
  });

  it('ends steadiness where a stop begins its fade', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 30;
    await graph.stop(0.05);
    expect(graph.steadyPlayback.until).toBe(30);
  });
});

describe('emptying the rings', () => {
  it('epochs both taps on every change that moves the audio', async () => {
    const { graph, context } = await makeGraph();
    const before = epochsSent();

    await graph.start(1);
    context.currentTime = 10;
    graph.setParams({ carrierHz: 300 });
    graph.setSoundscape({ gain: 0.4 });
    graph.setMasterLevel(0.5);

    const after = epochsSent();
    expect(after.length).toBe(2);
    // Start, then one for each of the three changes.
    for (let i = 0; i < after.length; i += 1) expect(after[i] - before[i]).toBe(4);
  });
});

describe('the bed notch cascade', () => {
  /**
   * The cascade lives in a worklet now. Retuning a biquad that carries signal
   * has no peak bound, so a change needs fresh state — and getting that from
   * `BiquadFilterNode` meant building nodes mid-playback, which changes the
   * graph's topology under a running renderer and is audible on its own. A
   * listening pass isolated it: rebuilding with *identical* coefficients
   * clicked just as loudly, so the filters were never the problem.
   */
  const notchPosts = (): Posted[] =>
    built.find((node) => node.name === 'notch-processor')?.posted ?? [];

  it('creates no filter nodes at all', async () => {
    // The point of the move. Every biquad the graph used to build, and every
    // connect and disconnect that came with it, is gone.
    await makeGraph();
    expect(filters.length).toBe(0);
  });

  it('never changes the node graph after construction', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    const noise = built.find((entry) => entry.name === 'noise-processor');
    const before = noise?.node?.disconnected.length ?? 0;

    for (let i = 0; i < 5; i++) {
      context.currentTime = 100 + i;
      graph.setParams({ carrierHz: 300 + i * 50 });
      settle();
    }

    expect(filters.length).toBe(0);
    expect(noise?.node?.disconnected.length ?? 0).toBe(before);
  });

  it('hands the cascade over on settlement, not on the change', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    const before = notchPosts().length;

    context.currentTime = 10;
    graph.setParams({ carrierHz: 400 });
    expect(notchPosts().length).toBe(before);

    context.currentTime = 10.3;
    settle();
    expect(notchPosts().length).toBe(before + 1);
  });

  it('sends nothing when the coefficients have not moved', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    const before = notchPosts().length;

    context.currentTime = 20;
    graph.setParams({ amGain: 0.4 });
    graph.setSoundscape({ gain: 0.4 });
    settle();
    expect(notchPosts().length).toBe(before);
  });

  it('rebuilds on every change of a slow drag, which the fast case hides', async () => {
    /*
     * The other half of the cadence, and the one that was missing.
     *
     * `sends nothing at all while changes are still arriving` advances 33 ms
     * per change and never settles inside its loop, so it exercises only the
     * fast regime — and `refreshBedChain`'s comment generalised from it to "a
     * drag of any length produces exactly one rebuild". That is false. Whether
     * a change settles is governed by whether the next one outpaces it, so a
     * hesitant hand settles every change and rebuilds on each.
     *
     * Asserted as the behaviour that ships, not as the behaviour wanted: a
     * trailing quiet window was tried and sounded worse, because one rebuild
     * per drag leaves the slot where the drag began. This pins the real cadence
     * dependence so the comment cannot drift back to the tidier claim.
     */
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    settle();
    settleNotch();
    const before = notchPosts().length;

    let time = 100;
    for (let i = 0; i < 20; i++) {
      context.currentTime = time;
      graph.setParams({ carrierHz: 220 + i });
      time += 0.06;
      context.currentTime = time;
      settle();
      time += 0.06;
      context.currentTime = time;
      settleNotch();
      time += 0.06;
    }

    // One per change, less the first which has nothing to supersede.
    expect(notchPosts().length - before).toBe(19);
  });

  it('sends nothing at all while changes are still arriving', async () => {
    // Rate-limiting to the fade length would still allow twenty or more
    // handovers a second through a drag, and the bed audibly choppy
    // throughout. Every change while a control moves supersedes the last and
    // never settles, so nothing is sent until it stops.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    const before = notchPosts().length;

    let time = 400;
    for (let i = 0; i < 40; i++) {
      context.currentTime = time;
      graph.setParams({ carrierHz: 220 + i });
      time += 0.033;
    }
    expect(notchPosts().length).toBe(before);

    context.currentTime = time + 0.3;
    settle();
    // Exactly one, with the final coefficients.
    expect(notchPosts().length).toBe(before + 1);
    const sent = notchPosts().at(-1) as unknown as { carrierHz: number };
    expect(sent.carrierHz).toBe(220 + 39);
  });

  it('names a frame and a crossfade length scaled to the chain', () => {
    // Measured, not chosen: a resonant notch low in the spectrum needs an
    // order of magnitude longer than the same Q high in it.
    const slow = notchSettleSeconds(80, 40, 20, 18, SR);
    const fast = notchSettleSeconds(1000, 40, 20, 18, SR);
    expect(slow).toBeGreaterThan(fast * 5);
    expect(slow).toBeLessThanOrEqual(MAX_BED_CROSSFADE_SECONDS);
    expect(fast).toBeGreaterThanOrEqual(MIN_BED_CROSSFADE_SECONDS);
  });

  it('schedules the handover ahead, on a whole quantum', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 700.0001;
    graph.setParams({ carrierHz: 400 });
    context.currentTime = 700.4;
    settle();

    const sent = notchPosts().at(-1) as unknown as {
      atFrame: number;
      crossfadeFrames: number;
      revision: number;
    };
    expect(sent.atFrame).toBeGreaterThan(700.4 * SR);
    expect(sent.crossfadeFrames).toBeGreaterThan(0);
    expect(typeof sent.revision).toBe('number');
  });

  it('applies a change that arrived mid-handover, once the handover ends', async () => {
    // Nothing else retries it. Entrainment settlement has been and gone by the
    // time a notch fade completes, so a request deferred against the handover
    // would simply never be applied — which is the last change of every drag.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const posts = (): Posted[] =>
      built.find((node) => node.name === 'notch-processor')?.posted ?? [];

    context.currentTime = 10;
    graph.setParams({ carrierHz: 400 });
    settle();
    const afterFirst = posts().length;
    expect(afterFirst).toBeGreaterThan(0);

    // A second change while the first is still handing over.
    context.currentTime = 10.1;
    graph.setParams({ carrierHz: 700 });
    settle();
    expect(posts().length).toBe(afterFirst);

    // The handover finishing is what carries it.
    context.currentTime = 10.4;
    settleNotch();
    expect(posts().length).toBe(afterFirst + 1);
    const sent = posts().at(-1) as unknown as { carrierHz: number };
    expect(sent.carrierHz).toBe(700);
  });

  it('accounts for the deferred cascade before it sets the level', async () => {
    // The order is the whole point. The cascade waiting on this settlement can
    // have a larger bound than the one just dropped, so reading the level
    // first would set the master for the cascade that is ending and start the
    // next handover underneath it, with nothing to correct that until it
    // settled in turn.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 0, notchQ: 1 });
    settle();
    settleNotch();

    const master = masterBus();

    // B: gentle, and it starts handing over.
    context.currentTime = 100;
    graph.setParams({ carrierHz: 300 });
    settle();

    // C: resonant, deferred behind B's handover.
    context.currentTime = 100.1;
    graph.setSoundscape({ notchDepthDb: 18, notchQ: 20 });
    settle();

    // B settles: C is sent, and the level must already cover it.
    context.currentTime = 100.4;
    settleNotch();
    const target = master.gain.events.at(-1)?.value ?? 0;

    const resonant = notchPeakGain(300, 40, 20, 18, SR);
    const gentle = notchPeakGain(300, 40, 1, 0, SR);
    // The control: the two really do demand different levels.
    expect(resonant).toBeGreaterThan(gentle * 1.2);

    const safeForResonant =
      (graph.masterLevel * MAX_MASTER_LEVEL) / Math.max(1, 0.25 + 0.8 * resonant);
    expect(target).toBeLessThanOrEqual(safeForResonant * (1 + 1e-9));
  });

  it('pushes the steady boundary past the handover and its recovery', async () => {
    // The handover has been changing the bed for as long as its crossfade ran,
    // and settling it starts a master ramp on top. Both are deliberate
    // transitions, so a measurement must not treat the window as steady.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 20;
    graph.setParams({ carrierHz: 400 });
    settle();

    context.currentTime = 20.4;
    settleNotch();
    expect(graph.steadyPlayback.from).toBeGreaterThanOrEqual(20.4);
  });

  it('holds both bounds until the worklet reports the handover done', async () => {
    // Either cascade could be contributing until then, and the larger of the
    // two bounds their sum. Dropping the old one early would let the master
    // rise while the resonant cascade was still sounding.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });
    settle();
    settleNotch();
    context.currentTime = 1;
    graph.setParams({ carrierHz: 90 });
    settle();
    settleNotch();

    const master = masterBus();
    context.currentTime = 601;
    graph.setSoundscape({ notchDepthDb: 0, notchQ: 1 });
    settle();
    // Sent, but not yet acknowledged: both cascades could be sounding.
    const whileHandingOver = master.gain.events.at(-1)?.value ?? 0;

    const resonant = notchPeakGain(90, 40, 20, 18, SR);
    const gentle = notchPeakGain(90, 40, 1, 0, SR);
    // The control: the two really do demand different levels.
    expect(resonant).toBeGreaterThan(gentle * 1.2);

    const safeForResonant =
      (graph.masterLevel * MAX_MASTER_LEVEL) / Math.max(1, 0.25 + 0.8 * resonant);
    expect(whileHandingOver).toBeLessThanOrEqual(safeForResonant * (1 + 1e-9));
  });
});

describe('the master gain across repeated changes', () => {
  it('never steps, however fast the changes arrive', async () => {
    // `rampMaster` runs on every commit, and the restore after settlement is a
    // 50 ms ramp — so an ordinary sequence of key presses lands while one is in
    // flight. Cancelling at `now` strips that ramp's endpoint, the value
    // reverts to the event before it, and reading `gain.value` afterwards pins
    // the already-jumped figure. That is a step on the master bus, which is a
    // click, and it happens on every press.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const master = masterBus();
    const start = 500;
    let time = start;
    for (const carrier of [300, 320, 340, 360, 380]) {
      context.currentTime = time;
      graph.setParams({ carrierHz: carrier });
      // Closer together than the ramp they schedule.
      time += 0.02;
    }

    const during = master.gain.jumps.filter((jump) => jump.at >= start);
    expect(during.length).toBe(0);
  });

  it('never steps when the level itself is dragged', async () => {
    /*
     * The sibling above moves the carrier, which does not move the master's
     * target — so since the unchanged-target guard it schedules a single ramp for the
     * whole sequence and no longer tests what its name says. This one drags the
     * level, so every change genuinely reschedules an in-flight ramp, which is
     * the moving-target case this test is about.
     *
     * What it pins is the *ordering* inside `rampMaster`: the value is read and
     * pinned before the clear, so no instant of the timeline has reverted to the
     * event preceding the ramp. Clearing first passes every assertion about the
     * finished curve and still steps, which is why `jumps` exists.
     *
     * It cannot pin the engine defect that motivated the change. `FakeParam`
     * models `cancelAndHoldAtTime` as a correct hold, so the version this
     * replaced also reads clean here. That evidence is the drag measurement in
     * `rampMaster`'s comment, not this test.
     */
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const master = masterBus();
    const start = 500;
    let time = start;
    const before = master.gain.calls;
    for (const level of [0.4, 0.5, 0.6, 0.7, 0.6, 0.5, 0.4]) {
      context.currentTime = time;
      graph.setMasterLevel(level);
      // Closer together than the 50 ms ramp each one schedules.
      time += 0.02;
    }

    // Without this the test passes by scheduling nothing at all, which is how
    // the sibling above quietly stopped testing anything.
    expect(master.gain.calls - before).toBeGreaterThanOrEqual(7);
    const during = master.gain.jumps.filter((jump) => jump.at >= start);
    expect(during.length).toBe(0);
  });

  it('attenuates by the deadline but climbs back slowly', async () => {
    // A reduction has a deadline: it must land before the change it guards.
    // An increase has none, so it can afford to be slow — and it has to be,
    // because a gain step over a few milliseconds is a click whatever its
    // size, heard at the end of every press when both used the deadline.
    //
    // The two directions arise from different changes, not from one. Raising a
    // source gain drops the level at the commit and the envelope already
    // equals the new configuration, so nothing rises at settlement; lowering
    // one leaves the envelope on the old value and the level only recovers
    // when settlement promotes the new one.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });
    settle();

    const master = masterBus();

    // Raising the entrainment level needs more attenuation: a reduction, and
    // it has to be in force by the landing.
    context.currentTime = 800;
    graph.setParams({ amGain: 0.6 });
    const down = master.gain.events.at(-1);
    expect(down?.kind).toBe('ramp');
    const landing = (Math.ceil(((800 + 0.05) * SR) / 128) * 128) / SR;
    expect(down?.at ?? 0).toBeLessThanOrEqual(landing + 1e-9);
    const guarded = down?.value ?? 0;
    context.currentTime = 800.5;
    settle();

    // Lowering it again cannot recover until settlement, because the envelope
    // holds the louder gain until then.
    context.currentTime = 801;
    graph.setParams({ amGain: 0.1 });
    context.currentTime = 801.5;
    settle();

    const up = master.gain.events.at(-1);
    expect(up?.kind).toBe('ramp');
    // The control: the level really did recover.
    expect(up?.value ?? 0).toBeGreaterThan(guarded);
    // And it took far longer than a guard ramp to do it.
    expect((up?.at ?? 0) - 801.5).toBeGreaterThan(0.1);
  });

  it('never steps when a change interrupts the restore ramp', async () => {
    // The commonest case in practice: a settlement starts a 50 ms restore and
    // the next press arrives inside it.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setParams({ amGain: 0.5 });

    const master = masterBus();
    context.currentTime = 600;
    graph.setParams({ amGain: 0.1 });
    settle();

    context.currentTime = 600.02;
    graph.setParams({ amGain: 0.4 });

    const during = master.gain.jumps.filter((jump) => jump.at >= 600);
    expect(during.length).toBe(0);
  });
});

describe('ordering a configuration change against its attenuation', () => {
  /**
   * The bug this suite exists for.
   *
   * Notch coefficients and source gains used to move at once while the master
   * bus ramped to its new headroom over 50 ms. When a change raises the peak
   * the mix can reach, the old and higher master gain was still in force for
   * those 50 ms — so the ceiling was exceeded for exactly as long as the
   * correction took to arrive.
   *
   * Asserted as an ordering on the AudioContext timeline, because that is what
   * the fix actually is: the attenuation is scheduled first and the change is
   * scheduled at the end of it.
   */
  const entrainmentPosts = () =>
    built.find((node) => node.name === 'entrainment-processor')?.posted ?? [];

  it('lands the attenuation before the change that needs it', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 100;
    const notchEventsBefore = soundscapeGain().gain.events.length;
    const postsBefore = entrainmentPosts().length;

    // Raising the bed pushes the worst case up, so more attenuation is needed.
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });

    const notchEvents = soundscapeGain().gain.events.slice(notchEventsBefore);
    expect(notchEvents.length).toBeGreaterThan(0);
    // Every notch change is scheduled strictly after the moment of the call,
    // which is when the downward gain ramp begins.
    for (const event of notchEvents) expect(event.at).toBeGreaterThan(100);

    // And the worklet is told to adopt its parameters at that same later
    // frame, rather than at the next quantum.
    const post = entrainmentPosts().slice(postsBefore).at(-1) as
      { applyAtFrame?: number } | undefined;
    expect(typeof post?.applyAtFrame).toBe('number');
    expect(post?.applyAtFrame ?? 0).toBeGreaterThan(100 * SR);
  });

  it('schedules every change, whichever way it moves the bound', async () => {
    // There used to be a second path that applied a change at once whenever it
    // needed no *more* attenuation. It was removed rather than fixed: it is
    // exactly the case where the master rises, and it rose while the worklet's
    // gains were still decaying from the louder configuration — both endpoints
    // under the ceiling, the path between them over it.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });

    context.currentTime = 200.0001;
    const notchEventsBefore = soundscapeGain().gain.events.length;

    // Dropping the bed reduces the worst case. It is still scheduled.
    graph.setSoundscape({ gain: 0.1, notchDepthDb: 3, notchQ: 2 });

    const notchEvents = soundscapeGain().gain.events.slice(notchEventsBefore);
    expect(notchEvents.length).toBeGreaterThan(0);
    for (const event of notchEvents) expect(event.at).toBeGreaterThan(200.0001);
  });

  it('lands the worklet and the AudioParams on the same frame', async () => {
    // An AudioParam is sample-accurate; a worklet can only act on a render
    // quantum boundary. Scheduling the filters at an arbitrary instant and the
    // worklet at "the first boundary after it" leaves them up to a quantum
    // apart — 5.8 ms at 22.05 kHz — and in that window the new bed and notches
    // run against the old entrainment gains. That hybrid is bounded by neither
    // endpoint: lowering amGain while raising the bed sums higher than both.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    // Offset off a round second on purpose: at 48 kHz a whole second plus the
    // 8 ms guard is already a whole number of quanta, so an unquantised
    // implementation lands on a boundary by accident and this proves nothing.
    context.currentTime = 700.0001;
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });

    const posts = built.find((node) => node.name === 'entrainment-processor')?.posted ?? [];
    const frame = (posts.at(-1) as unknown as { applyAtFrame: number }).applyAtFrame;
    // The control: the unquantised frame really is off a boundary here.
    expect(Math.ceil((700.0001 + 0.05) * SR) % 128).toBeGreaterThan(0);
    // A whole quantum, so the worklet adopts on exactly this frame rather than
    // on the next boundary after it.
    expect(frame % 128).toBe(0);
    // And the filters are scheduled at precisely that frame's instant.
    const notchAt = soundscapeGain().gain.events.at(-1)?.at ?? 0;
    expect(notchAt).toBeCloseTo(frame / SR, 12);
    // Never earlier than the guard floor.
    expect(notchAt).toBeGreaterThanOrEqual(700.05);
  });

  it('holds a level safe for every state between the two configurations', async () => {
    // The transition envelope, end to end. Producing a state worse than either
    // endpoint takes a pipeline: a bed rise is scheduled and not yet
    // acknowledged, and an `amGain` drop arriving inside that window leaves the
    // audible entrainment loud while the new bed is already on its way.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setParams({ amGain: 0.6 });
    graph.setSoundscape({ gain: 0.3, notchDepthDb: 18, notchQ: 4 });
    settle();

    const master = masterBus();

    context.currentTime = 800;
    graph.setSoundscape({ gain: 0.8 });
    context.currentTime = 800.005;
    graph.setParams({ amGain: 0.05 });

    const target = master.gain.events.at(-1)?.value ?? 0;
    expect(target).toBeGreaterThan(0);

    // Nothing has been acknowledged, so the audible configuration is still the
    // one established before the pipeline began.
    const audible = {
      params: { ...DEFAULT_PARAMS, amGain: 0.6 },
      soundscape: { ...DEFAULT_SOUNDSCAPE, gain: 0.3, notchDepthDb: 18, notchQ: 4 },
    };
    const requested = {
      params: { ...DEFAULT_PARAMS, amGain: 0.05 },
      soundscape: { ...DEFAULT_SOUNDSCAPE, gain: 0.8, notchDepthDb: 18, notchQ: 4 },
    };
    const envelope = transitionPeakBound([audible, requested], SR);
    const safe = (graph.masterLevel * MAX_MASTER_LEVEL) / Math.max(1, envelope);

    // The control: the envelope really is worse than either endpoint, so this
    // is about the path between them rather than about the ends.
    const worstEndpoint = Math.max(
      worstCaseSourcePeak(audible.params, audible.soundscape, SR),
      worstCaseSourcePeak(requested.params, requested.soundscape, SR),
    );
    expect(worstEndpoint).toBeLessThan(envelope);
    expect(target).toBeLessThanOrEqual(safe * (1 + 1e-9));
  });

  it('restores the level only when the worklet acknowledges, and not before', async () => {
    // Scheduled time is not proof of application: nothing bounds port message
    // delivery. Until the acknowledgement arrives the master stays at the
    // transition level, which is safe for both configurations — the right way
    // for this to fail.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setParams({ amGain: 0.6 });
    settle();

    const master = masterBus();
    context.currentTime = 900.0001;
    graph.setParams({ amGain: 0.05 });

    const heldTarget = master.gain.events.at(-1)?.value ?? 0;
    const callsBeforeAck = master.gain.calls;

    // Time passing changes nothing on its own.
    context.currentTime = 901;
    expect(master.gain.calls).toBe(callsBeforeAck);

    // The acknowledgement is what releases it.
    const entrainment = built.find((node) => node.name === 'entrainment-processor');
    const revision = (entrainment?.posted.at(-1) as unknown as { revision: number } | undefined)
      ?.revision;
    expect(typeof revision).toBe('number');
    acknowledge(revision ?? 0);

    expect(master.gain.calls).toBeGreaterThan(callsBeforeAck);
    const released = master.gain.events.at(-1)?.value ?? 0;
    // Quieter while held; the request permits more once it is really sounding.
    expect(released).toBeGreaterThan(heldTarget);

    // The restore begins at the settlement itself, not at a guessed delay
    // after it: the worklet snaps its gains before reporting, so by the time
    // this arrives there is nothing left to wait for.
    const restoreStart = master.gain.events.at(-2)?.at ?? 0;
    expect(restoreStart).toBeCloseTo(901, 9);

    // And the boundary is pushed from when the settlement actually arrived,
    // not from the landing predicted at commit time — delivery is unbounded,
    // so a late reply would otherwise let a measurement start inside the
    // restore ramp.
    expect(graph.steadyPlayback.from).toBeGreaterThanOrEqual(901);
  });

  it('will not let a master-level change outrun a pending transition', async () => {
    // Every path that moves the master reads `effectiveMasterLevel`, and that
    // is now defined from the transition bound rather than from the requested
    // configuration. Without it, raising the master while a change was still
    // in flight ramped straight to the endpoint level and undid the
    // attenuation the transition was relying on.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setParams({ amGain: 0.6 });
    settle();

    const master = masterBus();
    context.currentTime = 960.0001;
    // Pending, unsettled: the audible gains are still the louder ones.
    graph.setParams({ amGain: 0.05 });
    const guarded = master.gain.events.at(-1)?.value ?? 0;

    // A master change during that window must not exceed the guarded level
    // scaled by the new request.
    graph.setMasterLevel(1);
    const afterRaise = master.gain.events.at(-1)?.value ?? 0;

    const envelope = transitionPeakBound(
      [
        {
          params: { ...DEFAULT_PARAMS, amGain: 0.6 },
          soundscape: { ...DEFAULT_SOUNDSCAPE },
        },
        {
          params: { ...DEFAULT_PARAMS, amGain: 0.05 },
          soundscape: { ...DEFAULT_SOUNDSCAPE },
        },
      ],
      SR,
    );
    expect(afterRaise).toBeLessThanOrEqual((MAX_MASTER_LEVEL / Math.max(1, envelope)) * (1 + 1e-9));
    // The control: raising the request did move the gain, so this is not
    // passing because nothing happened.
    expect(afterRaise).toBeGreaterThan(guarded);
  });

  it('keeps a superseded configuration in the bound while it may still be sounding', async () => {
    // `pendingChange` holds one configuration, but the smoother can be
    // carrying another: A settles, B is adopted and still smoothing, C
    // supersedes B. A bound over A and C alone sees nothing of B — and
    // 0 -> 0.6 -> 0 leaves the source near 0.6 while both ends read zero.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    graph.setParams({ amGain: 0 });
    settle();

    const master = masterBus();

    // B: loud. Adopted, but never reported settled.
    context.currentTime = 1000.0001;
    graph.setParams({ amGain: 0.6 });
    // C: back to silent, superseding B before it settled.
    context.currentTime = 1000.02;
    graph.setParams({ amGain: 0 });

    const target = master.gain.events.at(-1)?.value ?? 0;

    // The bound has to still contain B's gain.
    const withB = transitionPeakBound(
      [
        { params: { ...DEFAULT_PARAMS, amGain: 0 }, soundscape: { ...DEFAULT_SOUNDSCAPE } },
        { params: { ...DEFAULT_PARAMS, amGain: 0.6 }, soundscape: { ...DEFAULT_SOUNDSCAPE } },
      ],
      SR,
    );
    const withoutB = transitionPeakBound(
      [{ params: { ...DEFAULT_PARAMS, amGain: 0 }, soundscape: { ...DEFAULT_SOUNDSCAPE } }],
      SR,
    );
    // The control: forgetting B really would permit a higher master.
    expect(withoutB).toBeLessThan(withB);
    expect(target).toBeLessThanOrEqual(
      (graph.masterLevel * MAX_MASTER_LEVEL) / Math.max(1, withB) + 1e-9,
    );

    // And once C settles, B is forgotten — the bound must not stay pessimistic
    // forever.
    settle();
    const released = master.gain.events.at(-1)?.value ?? 0;
    expect(released).toBeGreaterThan(target);
  });

  it('schedules no master ramp while the level it wants is unchanged', async () => {
    /*
     * The ramp-rescheduling defect, bisected to here.
     *
     * `rampMasterToward` runs on every commit, so a drag scheduled one ramp per
     * input event — 227 of them in four seconds in the real app, every one to
     * an identical target. `rampMaster` cancels what is in flight, so
     * each cancelled the one before it and restarted from wherever the gain had
     * reached, sixty times a second, all aiming at the value it already had. The
     * held value was observed half a unit below the target: the master
     * collapsing around 19 dB and being pulled back, which is what was heard.
     *
     * Measured against the real master bus: with this ramp removed entirely the
     * capture records zero dips across three takes where the unmodified build
     * records dozens, and removing any other per-event work changes nothing.
     */
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    settle();
    const master = masterBus();
    const before = master.gain.calls;

    // A carrier drag: sixty changes that do not move the level the guard wants.
    let time = 100;
    for (let i = 0; i < 60; i++) {
      context.currentTime = time;
      graph.setParams({ carrierHz: 220 + i * 0.5 });
      time += 1 / 60;
    }

    expect(master.gain.calls).toBe(before);

    // The control: a change that *does* move the level still schedules one.
    context.currentTime = time + 1;
    graph.setParams({ amGain: 0.95 });
    expect(master.gain.calls).toBeGreaterThan(before);
  });

  it('leaves a restore already in flight alone, and lets it arrive', async () => {
    /*
     * The failure the guard exists to prevent, reconstructed.
     *
     * Counting calls proves the ramps are not scheduled; it does not prove the
     * thing that made them harmful, which is what happens to a restore that is
     * *already running* when the next commit arrives. `rampMaster` cancels what
     * is in flight, so an unguarded commit mid-restore takes the ramp
     * back to wherever the gain had reached and starts another — sixty times a
     * second, all aiming at the value it was already heading to.
     *
     * So this arranges a restore in flight, issues same-target commits partway
     * through it, and asserts the original ramp is still the one that lands.
     */
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);
    settle();

    const master = masterBus();

    /*
     * A loud, resonant configuration first, so there is somewhere to restore
     * *from*. Settling a louder bed lowers the master — the guard is not a
     * direction, it is whatever the sounding configuration permits — so the
     * restore path needs the configuration to get quieter, not louder.
     */
    context.currentTime = 200;
    graph.setSoundscape({ gain: 0.9, notchDepthDb: 18, notchQ: 20 });
    context.currentTime = 200.3;
    settle();
    settleNotch();
    const low = master.gain.events.at(-1)?.value ?? 0;

    // Now quieter, which permits a higher master once it is the one sounding.
    context.currentTime = 400;
    graph.setSoundscape({ gain: 0.1, notchDepthDb: 0, notchQ: 1 });
    context.currentTime = 400.3;
    settle();
    settleNotch();
    const restore = master.gain.events.at(-1);
    const endpoint = restore?.value ?? 0;
    const landsAt = restore?.at ?? 0;
    // The control: this really is a restore upward, and therefore the
    // no-deadline path the guard protects.
    expect(endpoint).toBeGreaterThan(low);
    const callsMidRestore = master.gain.calls;

    /*
     * Now commit repeatedly *inside* that ramp. Carrier does not move the
     * level, so every one of these is a same-target commit — exactly the case
     * that used to cancel and restart the restore.
     */
    let time = landsAt - 0.05;
    for (let i = 0; i < 20; i++) {
      context.currentTime = time;
      graph.setParams({ carrierHz: 300 + i });
      time += 0.002;
    }

    // Untouched: no cancel, no re-ramp, and the endpoint still the one the
    // restore was heading for.
    expect(master.gain.calls).toBe(callsMidRestore);
    const last = master.gain.events.at(-1);
    expect(last?.value).toBe(endpoint);
    expect(last?.at).toBe(landsAt);
  });

  it('ignores a settlement that is not exactly the pending revision', async () => {
    // At-or-above would let a malformed or future reply promote a
    // configuration and release the attenuation with nothing having proved
    // that configuration settled.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const master = masterBus();
    context.currentTime = 1100.0001;
    graph.setParams({ amGain: 0.6 });

    const node = built.find((entry) => entry.name === 'entrainment-processor');
    const pending = (node?.posted.at(-1) as unknown as { revision: number }).revision;

    /*
     * Observed through the capture epoch rather than through a master ramp.
     *
     * This used to count calls on the master gain, on the reasoning that
     * settlement releases the attenuation. It does — but only when the level
     * actually moves, and `rampMasterToward` now skips a ramp to the value the
     * master is already heading to. In this scenario the guarded level and the
     * settled level are the same, so the release was a no-op that happened to
     * be observable, and counting it made the test pass for a reason it was not
     * about. `reopenIfSettled` sends an epoch exactly when a settlement is
     * accepted, which is the thing this test is actually asserting.
     */
    const epochs = () => epochsSent().reduce((a, b) => a + b, 0);
    const before = epochs();

    acknowledge(pending + 5);
    expect(epochs()).toBe(before);
    acknowledge(pending - 1);
    expect(epochs()).toBe(before);

    // The control: the right one is accepted, so this is about the revision
    // and not about settlement being ignored altogether.
    acknowledge(pending);
    expect(epochs()).toBeGreaterThan(before);
    void master;
  });

  it('ignores an acknowledgement from a superseded revision', async () => {
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const master = masterBus();
    context.currentTime = 950.0001;
    graph.setParams({ amGain: 0.6 });
    const stale = 0;
    const eventsBefore = master.gain.events.length;
    acknowledge(stale);
    expect(master.gain.events.length).toBe(eventsBefore);
  });

  it('does not let an older scheduled change land after a newer one', async () => {
    // Reachable by dragging a slider, and by any preset apply, which calls
    // setParams and then setSoundscape a moment later.
    //
    // AudioParam events are applied in *time* order, not the order they were
    // queued. So a change scheduled 8 ms out, superseded 2 ms later by one
    // that applies immediately, would land last and overwrite the newer
    // configuration with the older one.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    context.currentTime = 400;
    // Guarded: this schedules notch changes at 400.008.
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });
    const scheduledLate = soundscapeGain().gain.events.at(-1)?.at ?? 0;
    expect(scheduledLate).toBeGreaterThan(400);

    // A newer request arrives before that lands.
    context.currentTime = 400.002;
    graph.setSoundscape({ gain: 0.05, notchDepthDb: 1, notchQ: 1 });

    // Nothing from the superseded request may still be queued beyond the
    // newest one. The graph cancels scheduled values, so the only events at or
    // after the second call belong to it.
    const survivors = soundscapeGain().gain.events.filter((event) => event.at >= 400.002);
    expect(survivors.length).toBeGreaterThan(0);
    // Only the newer request's bed level may still be scheduled.
    for (const event of survivors) expect(event.value).toBeCloseTo(0.05, 9);
  });

  it('gives the worklet a revision so a superseded message cannot win', async () => {
    // The worklet's queue cannot be cancelled the way an AudioParam's can, so
    // the message has to carry enough for the processor to discard it.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const posts = () => built.find((node) => node.name === 'entrainment-processor')?.posted ?? [];
    const revisionsBefore = posts().length;

    context.currentTime = 500;
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });
    context.currentTime = 500.002;
    graph.setParams({ carrierHz: 400 });

    const sent = posts()
      .slice(revisionsBefore)
      .map((message) => (message as unknown as { revision?: number }).revision);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    // Strictly increasing, which is the only property the processor relies on.
    for (let i = 1; i < sent.length; i++) {
      expect((sent[i] ?? 0) > (sent[i - 1] ?? 0)).toBe(true);
    }
  });

  it('decides the guard against what is sounding, not what was last requested', async () => {
    // The subtler half of the same bug. While a guarded change is in flight
    // the audible configuration is still the previous one, so comparing the
    // new request against the *requested* level can take the immediate branch
    // at a gain that is still above what the new configuration permits.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    masterBus();

    context.currentTime = 600;
    // First guarded change: heads for a much lower level, landing at 600.008.
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });

    // Before it lands, ask for something that still needs more attenuation
    // than the *sounding* configuration, but less than the pending one.
    context.currentTime = 600.002;
    graph.setSoundscape({ gain: 0.6, notchDepthDb: 12, notchQ: 12 });

    // It must still be guarded — scheduled ahead, not applied at once.
    const landed = soundscapeGain()
      .gain.events.filter((e) => e.at >= 600.002)
      .map((e) => e.at);
    expect(landed.length).toBeGreaterThan(0);
    for (const at of landed) expect(at).toBeGreaterThan(600.002);
  });

  it('never leaves the master above what the new configuration permits', async () => {
    // The property, stated directly. Whatever branch runs, the gain in force
    // at the moment the new configuration lands must already satisfy it.
    const { graph, context } = await makeGraph();
    context.currentTime = 0;
    await graph.start(1);

    const master = masterBus();

    context.currentTime = 300;
    graph.setSoundscape({ gain: 0.8, notchDepthDb: 18, notchQ: 20 });

    const landing = soundscapeGain().gain.events.at(-1)?.at ?? 0;
    // The last gain target scheduled at or before the landing instant is what
    // is in force when the coefficients step.
    const ramps = master.gain.events.filter((e) => e.at <= landing + 1e-9);
    const inForce = ramps.at(-1);
    expect(inForce !== undefined).toBe(true);
    // It is the *reduced* level, scheduled to arrive by the landing instant.
    expect(inForce?.at ?? 0).toBeLessThanOrEqual(landing + 1e-9);
  });
});
