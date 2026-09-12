/**
 * The side of the capture tap that is not the audio thread.
 *
 * Driven against the *real* processor rather than a stub of it, through a pair
 * of fake ports wired to each other. A mock of the worklet would let both sides
 * agree on a protocol neither actually implements — and the interesting cases
 * here are precisely where the two disagree: a request refused because its
 * epoch ended, a reply arriving after this side gave up, a window that only
 * exists once enough audio has been fed.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { CaptureTap, type CapturePort } from '../src/integrity/capture-client.ts';
import { captureFramesFor } from '../src/integrity/measure.ts';
import { DEFAULT_PARAMS, type EntrainmentParams } from '../src/audio/dsp/entrainment-core.ts';

const SR = 48000;
const QUANTUM = 128;

interface ProcessorLike {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(d: unknown): void };
  process(inputs: Float32Array[][]): boolean;
}

const registry = new Map<string, new (options?: unknown) => ProcessorLike>();

class MockAudioWorkletProcessor {
  port = { onmessage: null, postMessage() {} };
}

const scope = globalThis as unknown as Record<string, unknown>;
scope.AudioWorkletProcessor = MockAudioWorkletProcessor;
scope.registerProcessor = (name: string, ctor: new (options?: unknown) => ProcessorLike) =>
  registry.set(name, ctor);
scope.sampleRate = SR;
scope.currentTime = 0;
scope.currentFrame = 0;

await import('../src/audio/worklets/capture-processor.ts');

/**
 * A tap and a client joined by two ports, as the real pair is joined by the
 * worklet boundary.
 *
 * **Delivery is deferred in both directions, deliberately.** An earlier version
 * of this helper delivered synchronously and claimed the ordering was
 * equivalent. It is not, and the difference is the whole point: a real reply is
 * posted from the audio thread and arrives later, so it can still be in flight
 * when the configuration changes underneath it. Synchronous delivery makes that
 * window vanish, and with it the bug that lived in it.
 *
 * `settle()` runs the queued deliveries, so a test can say when it wants the
 * messages to land.
 */
function connect(seconds = 1, maxPending?: number, graceMs = 50) {
  const Ctor = registry.get('capture-processor');
  if (!Ctor) throw new Error('capture-processor was never registered');

  const inFlight: (() => void)[] = [];
  const clientPort: CapturePort = { postMessage() {}, onmessage: null };
  const processor = new Ctor({
    processorOptions: { seconds, ...(maxPending === undefined ? {} : { maxPending }) },
  });

  // Worklet to client.
  processor.port.postMessage = (data: unknown) => {
    inFlight.push(() => clientPort.onmessage?.({ data } as MessageEvent<unknown>));
  };
  // Client to worklet.
  clientPort.postMessage = (message: unknown) => {
    inFlight.push(() => processor.port.onmessage?.({ data: message }));
  };

  const tap = new CaptureTap(clientPort, SR, graceMs);

  /** Deliver everything queued, including anything queued by that delivery. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20 && inFlight.length > 0; i += 1) {
      const batch = inFlight.splice(0, inFlight.length);
      for (const deliver of batch) deliver();
      await Promise.resolve();
    }
  };

  const feed = (frames: number, value = 0.5): void => {
    let written = 0;
    while (written < frames) {
      const n = Math.min(QUANTUM, frames - written);
      const buffer = new Float32Array(n).fill(value);
      processor.process([[buffer, buffer]]);
      written += n;
    }
  };

  const pendingAtTap = (): number =>
    (processor as unknown as { pending: unknown[] }).pending.length;

  return { tap, feed, settle, pendingAtTap };
}

const params = (over: Partial<EntrainmentParams> = {}): EntrainmentParams => ({
  ...DEFAULT_PARAMS,
  ...over,
});

describe('asking for a window', () => {
  it('answers with the samples that were fed', async () => {
    const { tap, feed, settle } = connect();
    const pending = tap.capture(256);
    await settle();
    feed(256, 0.25);
    await settle();

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.frames).toBe(256);
    expect(outcome.left[0]).toBe(0.25);
  });

  it('matches each reply to the request that asked', async () => {
    // Both are outstanding at once and complete in different orders, which is
    // the case an id exists for.
    const { tap, feed, settle } = connect();
    const longer = tap.capture(1024);
    const shorter = tap.capture(128);
    await settle();

    feed(128);
    await settle();
    const first = await shorter;
    expect(first.ok && first.frames).toBe(128);

    feed(896);
    await settle();
    const second = await longer;
    expect(second.ok && second.frames).toBe(1024);
  });

  it('reports the tap refusing a window it can never fill', async () => {
    const { tap, settle } = connect(0.01);
    const pending = tap.capture(SR);
    await settle();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('window-too-long');
  });

  it('reports a request whose configuration was replaced', async () => {
    // Settled by the client, which refuses what it is waiting for before the
    // message even leaves; the tap then refuses its own copy, and that reply
    // arrives to no waiting request. Either way the caller learns that the
    // window it asked for belongs to a configuration that has been replaced,
    // and never receives audio the current one did not produce.
    const { tap, feed, settle } = connect();
    const pending = tap.capture(4096);
    await settle();
    feed(256);

    tap.epoch();
    await settle();
    const outcome = await pending;
    expect(!outcome.ok && outcome.reason).toBe('epoch-changed');
  });

  it('refuses a window that was already in flight when the epoch changed', async () => {
    // The race the tap alone cannot close. The window is recorded, fulfilled
    // and posted while the old configuration is still in force; the
    // configuration then changes; and only afterwards does the reply land. The
    // tap has nothing left to refuse by then, so without the client bumping its
    // own epoch this resolved as a perfectly good window of audio the
    // configuration no longer describes.
    const { tap, feed, settle } = connect();
    const pending = tap.capture(256);
    await settle();

    // Recorded and posted, but not yet delivered.
    feed(256, 0.25);
    tap.epoch();
    await settle();

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('epoch-changed');
  });

  it('withdraws a timed-out request from the tap', async () => {
    // Left queued there it still counts against the tap's own limit, so a run
    // of timeouts ends up refusing live requests — and it would still allocate
    // and transfer a whole window if the audio ever arrived.
    const { tap, settle, pendingAtTap } = connect(1, 2);

    for (let i = 0; i < 4; i += 1) {
      const abandoned = tap.capture(4096);
      await settle();
      expect(!(await abandoned).ok).toBe(true);
      await settle();
    }

    expect(pendingAtTap()).toBe(0);
  });

  it('keeps serving live requests after a run of timeouts', async () => {
    // The consequence of the above, stated as behaviour: with a queue of two
    // and four abandoned requests, an uncancelled tap refuses this one for
    // being one too many.
    const { tap, feed, settle, pendingAtTap } = connect(1, 2);

    for (let i = 0; i < 4; i += 1) {
      const abandoned = tap.capture(4096);
      await settle();
      await abandoned;
      await settle();
    }

    const live = tap.capture(128);
    await settle();
    feed(128);
    await settle();

    expect((await live).ok).toBe(true);
    expect(pendingAtTap()).toBe(0);
  });

  it('gives up when the audio stops arriving', async () => {
    // A suspended context, a node never connected, a worklet that failed to
    // load. Without this the promise is never settled and the report simply
    // never arrives, rather than saying it could not be gathered.
    const { tap, settle } = connect();
    const pending = tap.capture(64);
    await settle();
    const outcome = await pending;
    expect(!outcome.ok && outcome.reason).toBe('timeout');
  });

  it('settles everything outstanding when closed', async () => {
    // Both sides settle this: the tap refuses its queue on `stop`, and the
    // client resolves whatever is left in case that reply never arrives. Which
    // one wins depends on how the port delivers, so what matters — and what is
    // asserted — is that nothing is left pending and the reason names the stop.
    const { tap, settle } = connect();
    const pending = tap.capture(4096);
    await settle();
    tap.close();
    await settle();

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && ['stopped', 'closed'].includes(outcome.reason)).toBe(true);

    const afterwards = await tap.capture(128);
    expect(afterwards.ok).toBe(false);
    expect(!afterwards.ok && afterwards.reason).toBe('closed');
  });

  it('drops a reply that arrives after its request gave up', async () => {
    // The tap answers when it can, which may be after this side stopped
    // waiting. Nothing should throw, and no other request should be disturbed.
    const { tap, feed, settle } = connect();
    const first = tap.capture(64);
    await settle();
    const abandoned = await first;
    expect(!abandoned.ok && abandoned.reason).toBe('timeout');

    feed(256);
    await settle();
    const next = tap.capture(128);
    await settle();
    feed(128);
    await settle();
    expect((await next).ok).toBe(true);
  });
});

describe('how long a window to ask for', () => {
  it('is long enough to resolve a hertz at any sample rate', () => {
    // Bands must come under 2 Hz or a moved component cannot show — and a
    // shorter window does not merely miss it, it manufactures deviations from
    // wherever the capture started.
    for (const rate of [44100, 48000, 96000]) {
      const frames = captureFramesFor(params(), rate);
      const bandHz = (2 * rate) / frames;
      expect(`${rate}: ${bandHz <= 2}`).toBe(`${rate}: true`);
    }
  });

  it('grows with a slower modulation, not with a constant', () => {
    // Continuity needs eight modulation periods. At 0.5 Hz that is sixteen
    // seconds, and a fixed window would report `unknown` forever.
    const fast = captureFramesFor(params({ modulationHz: 40 }), SR);
    const slow = captureFramesFor(params({ modulationHz: 0.5 }), SR);
    expect(slow > fast).toBe(true);
    expect(slow / SR >= 16).toBe(true);
  });

  it('always asks for a power of two', () => {
    // The analysis truncates to one. Asking for 9,600 and having 8,192 used is
    // how a window ends up coarser than the caller believed it was.
    for (const modulationHz of [0.5, 7, 40, 137.8, 200]) {
      const frames = captureFramesFor(params({ modulationHz }), SR);
      expect(`${modulationHz}: ${Number.isInteger(Math.log2(frames))}`).toBe(
        `${modulationHz}: true`,
      );
    }
  });
});
