/**
 * The capture tap's own behaviour, rather than the metrics computed from it.
 *
 * Feeding known buffers to `measureEnvelope` largely repeats tests that
 * already exist. What has never been exercised is the path that gets the
 * samples there: a ring that wraps, an epoch that has to discard audio from
 * before a configuration change, replies that must be matched to the request
 * that asked for them, and buffers that are transferred rather than copied.
 * Every one of those can be wrong in a way that still produces a plausible
 * number at the far end, which is the dangerous kind of wrong for a subsystem
 * whose whole job is to be believed.
 */

import { describe, it, expect } from './helpers/expect.ts';
import type { CaptureReply, CaptureWindow } from '../src/audio/worklets/capture-processor.ts';

const SR = 48000;
const QUANTUM = 128;

interface Posted {
  data: CaptureReply;
  transfer?: unknown[];
}

interface PortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown, transfer?: unknown[]): void;
  posted: Posted[];
}

interface ProcessorLike {
  port: PortLike;
  process(inputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new (options?: unknown) => ProcessorLike;

const registry = new Map<string, ProcessorCtor>();

class MockAudioWorkletProcessor {
  port: PortLike = {
    onmessage: null,
    posted: [],
    postMessage(data: unknown, transfer?: unknown[]) {
      this.posted.push({ data: data as CaptureReply, transfer });
    },
  };
}

const scope = globalThis as unknown as Record<string, unknown>;
scope.AudioWorkletProcessor = MockAudioWorkletProcessor;
scope.registerProcessor = (name: string, ctor: ProcessorCtor) => registry.set(name, ctor);
scope.sampleRate = SR;
scope.currentTime = 0;
scope.currentFrame = 0;

await import('../src/audio/worklets/capture-processor.ts');

/** A processor whose ring holds exactly `capacity` frames, for wrap tests. */
function create(capacity: number, maxPending?: number): ProcessorLike {
  const Ctor = registry.get('capture-processor');
  if (!Ctor) throw new Error('capture-processor was never registered');
  scope.currentFrame = 0;
  return new Ctor({
    processorOptions: {
      seconds: capacity / SR,
      ...(maxPending === undefined ? {} : { maxPending }),
    },
  });
}

function send(processor: ProcessorLike, message: unknown): void {
  processor.port.onmessage?.({ data: message });
}

/**
 * Feed `frames` samples, in render quanta, from a generator per channel.
 *
 * Quantum-sized calls rather than one big buffer, because that is how the node
 * is actually driven and because a ring that only works when written in one go
 * is a ring that does not work.
 */
function feed(
  processor: ProcessorLike,
  frames: number,
  left: (i: number) => number,
  right: (i: number) => number = (i) => -left(i),
): void {
  let written = 0;
  while (written < frames) {
    const n = Math.min(QUANTUM, frames - written);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      l[i] = left(written + i);
      r[i] = right(written + i);
    }
    processor.process([[l, r]]);
    scope.currentFrame = (scope.currentFrame as number) + n;
    written += n;
  }
}

const replies = (processor: ProcessorLike): CaptureReply[] =>
  processor.port.posted.map((p) => p.data);

const windows = (processor: ProcessorLike): CaptureWindow[] =>
  replies(processor).filter((r): r is CaptureWindow => r.ok);

describe('what the ring hands back', () => {
  it('keeps the channels apart, neither summed nor swapped', () => {
    // The failure this guards against is silent: a summed pair still measures
    // as a plausible envelope, and interaural correlation — the one metric
    // that could detect a collapsed binaural pair — would read 1.0 for every
    // signal ever captured.
    const processor = create(1024);
    // Asked for before any audio arrives, so the window is exactly the four
    // frames fed next and nothing has to be reasoned about the ring's state.
    send(processor, { type: 'capture', id: 7, frames: 4 });
    feed(
      processor,
      4,
      (i) => i + 1,
      (i) => -(i + 1),
    );

    const [window] = windows(processor);
    expect(window.left[0]).toBe(1);
    expect(window.left[3]).toBe(4);
    expect(window.right[0]).toBe(-1);
    expect(window.right[3]).toBe(-4);
  });

  it('returns a wrapped window in the order it was played', () => {
    // The window spans the end of the buffer and its start, so a naive copy
    // returns it rotated — samples in the wrong order, which reads as a
    // discontinuity the graph never produced.
    // 1128 frames into a 512-frame ring leaves the newest 256 straddling the
    // wrap: they start at 360 and run off the end into the buffer's head.
    const processor = create(512);
    feed(processor, 1128, (i) => i);
    send(processor, { type: 'capture', id: 1, frames: 256 });

    const [window] = windows(processor);
    expect(window.frames).toBe(256);
    for (let i = 0; i < 256; i += 1) {
      expect(window.left[i]).toBe(1128 - 256 + i);
    }
  });

  it('says when the window began, on the context clock', () => {
    // Carried so the caller can reject a window that overlapped a ramp or a
    // fade rather than reporting the attenuation as a fault.
    const processor = create(4096);
    scope.currentFrame = 4800;
    feed(processor, 512, (i) => i);
    send(processor, { type: 'capture', id: 2, frames: 256 });

    const [window] = windows(processor);
    const expectedStart = 4800 + (512 - 256);
    expect(window.startFrame).toBe(expectedStart);
    expect(window.startedAt).toBeCloseTo(expectedStart / SR, 6);
  });

  it('duplicates a mono upstream rather than leaving a channel silent', () => {
    const processor = create(1024);
    const mono = new Float32Array(QUANTUM);
    mono.fill(0.5);
    for (let i = 0; i < 4; i += 1) processor.process([[mono]]);
    send(processor, { type: 'capture', id: 3, frames: 64 });
    processor.process([[mono]]);

    const [window] = windows(processor);
    expect(window.left[0]).toBe(0.5);
    expect(window.right[0]).toBe(0.5);
  });
});

describe('epochs', () => {
  it('will not answer until a whole window has accumulated since the epoch', () => {
    // The point of the whole mechanism: a window that straddles a
    // configuration change would be compared against settings that were not in
    // force when most of it was played.
    const processor = create(4096);
    feed(processor, 2048, () => 1);
    send(processor, { type: 'epoch' });
    send(processor, { type: 'capture', id: 4, frames: 512 });

    feed(processor, 256, () => 2);
    expect(windows(processor).length).toBe(0);

    feed(processor, 256, () => 2);
    expect(windows(processor).length).toBe(1);
  });

  it('hands back none of the audio from before the epoch', () => {
    const processor = create(4096);
    feed(processor, 2048, () => 1);
    send(processor, { type: 'epoch' });
    send(processor, { type: 'capture', id: 5, frames: 512 });
    feed(processor, 512, () => 2);

    const [window] = windows(processor);
    for (let i = 0; i < window.frames; i += 1) expect(window.left[i]).toBe(2);
  });

  it('refuses a request that was asked under the configuration just replaced', () => {
    // The bug this mechanism exists to prevent, arriving by the back door: the
    // ring is emptied, the new configuration fills it, and the request issued
    // for the old one is answered with the new audio — under the id the caller
    // matches to the old fingerprint. A confident wrong answer.
    const processor = create(4096);
    send(processor, { type: 'capture', id: 42, frames: 512 });
    feed(processor, 256, () => 1);

    send(processor, { type: 'epoch' });
    feed(processor, 1024, () => 2);

    expect(windows(processor).length).toBe(0);
    const [reply] = replies(processor);
    expect(reply.id).toBe(42);
    expect(reply.ok === false && reply.reason).toBe('epoch-changed');
  });

  it('does not let repeated edits fill the queue with dead requests', () => {
    // Two pending at a time is the cap here; without clearing on epoch, three
    // configuration changes would leave three corpses in the queue and the
    // live request would be refused for being one too many.
    const processor = create(4096, 2);
    for (let i = 0; i < 3; i += 1) {
      send(processor, { type: 'capture', id: i, frames: 2048 });
      send(processor, { type: 'epoch' });
    }

    send(processor, { type: 'capture', id: 99, frames: 256 });
    feed(processor, 256, () => 1);

    const [window] = windows(processor);
    expect(window.id).toBe(99);
  });

  it('stamps each window with the epoch it belongs to', () => {
    const processor = create(4096);
    send(processor, { type: 'capture', id: 1, frames: 128 });
    feed(processor, 128, () => 1);
    send(processor, { type: 'epoch' });
    send(processor, { type: 'capture', id: 2, frames: 128 });
    feed(processor, 128, () => 2);

    expect(
      windows(processor)
        .map((w) => w.epoch)
        .join(','),
    ).toBe('0,1');
  });

  it('restarts the clock as well as the buffer', () => {
    const processor = create(4096);
    scope.currentFrame = 0;
    feed(processor, 1024, () => 1);
    send(processor, { type: 'epoch' });
    const epochAt = scope.currentFrame as number;

    send(processor, { type: 'capture', id: 6, frames: 256 });
    feed(processor, 256, () => 2);

    const [window] = windows(processor);
    // The first sample after the epoch, not the first since construction.
    expect(window.startFrame).toBe(epochAt);
  });
});

describe('requests', () => {
  it('answers each one with the id that asked', () => {
    // Several can be outstanding at once, and a reply that cannot be matched
    // to its question is worse than no reply.
    const processor = create(4096);
    send(processor, { type: 'capture', id: 11, frames: 256 });
    send(processor, { type: 'capture', id: 22, frames: 512 });
    feed(processor, 1024, (i) => i);

    const ids = windows(processor).map((w) => w.id);
    expect(ids.join(',')).toBe('11,22');
  });

  it('answers at once when the window is already in the ring', () => {
    // No further `process` call. Waiting for the next quantum would shift the
    // window past the one asked for, and would lose it entirely to a stop or an
    // epoch arriving in the gap — with the audio sitting in the ring all along.
    const processor = create(4096);
    feed(processor, 1024, (i) => i);

    send(processor, { type: 'capture', id: 77, frames: 256 });

    const [window] = windows(processor);
    expect(window.id).toBe(77);
    expect(window.frames).toBe(256);
    expect(window.left[255]).toBe(1023);
  });

  it('survives a stop that lands right after the request', () => {
    const processor = create(4096);
    feed(processor, 1024, () => 1);
    send(processor, { type: 'capture', id: 78, frames: 256 });
    send(processor, { type: 'stop' });

    expect(windows(processor).length).toBe(1);
    expect(windows(processor)[0].id).toBe(78);
  });

  it('serves overlapping requests of different lengths', () => {
    const processor = create(4096);
    send(processor, { type: 'capture', id: 1, frames: 256 });
    send(processor, { type: 'capture', id: 2, frames: 1024 });

    feed(processor, 256, (i) => i);
    expect(windows(processor).length).toBe(1);
    expect(windows(processor)[0].id).toBe(1);

    feed(processor, 768, (i) => 256 + i);
    expect(windows(processor).length).toBe(2);
    expect(windows(processor)[1].id).toBe(2);
    expect(windows(processor)[1].frames).toBe(1024);
  });

  it('transfers the buffers instead of copying them', () => {
    // The audio thread has no business allocating a second copy of every
    // window, and these are the only references to them.
    const processor = create(4096);
    send(processor, { type: 'capture', id: 9, frames: 128 });
    feed(processor, 128, (i) => i);

    const [posted] = processor.port.posted;
    const window = posted.data as CaptureWindow;
    expect(posted.transfer?.length).toBe(2);
    expect(posted.transfer?.[0]).toBe(window.left.buffer);
    expect(posted.transfer?.[1]).toBe(window.right.buffer);
  });

  it('refuses a window longer than the ring instead of waiting forever', () => {
    // No amount of audio would satisfy it, so queuing it would leave a request
    // pending for the rest of the session.
    const processor = create(512);
    send(processor, { type: 'capture', id: 8, frames: 4096 });

    const [reply] = replies(processor);
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.reason).toBe('window-too-long');
  });

  it('refuses a nonsensical length', () => {
    const processor = create(512);
    send(processor, { type: 'capture', id: 10, frames: 0 });
    const [reply] = replies(processor);
    expect(reply.ok === false && reply.reason).toBe('window-invalid');
  });

  it('stops queuing once too many are waiting', () => {
    // A caller that asks faster than the audio arrives must not be able to
    // grow this list without bound on the audio thread.
    const processor = create(4096, 2);
    send(processor, { type: 'capture', id: 1, frames: 2048 });
    send(processor, { type: 'capture', id: 2, frames: 2048 });
    send(processor, { type: 'capture', id: 3, frames: 2048 });

    const [reply] = replies(processor);
    expect(reply.id).toBe(3);
    expect(reply.ok === false && reply.reason).toBe('too-many-pending');
  });

  it('keeps running with nothing connected, and records nothing', () => {
    const processor = create(1024);
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);

    send(processor, { type: 'capture', id: 12, frames: 64 });
    processor.process([[]]);
    expect(windows(processor).length).toBe(0);
  });

  it('stops when told to', () => {
    const processor = create(1024);
    expect(processor.process([[new Float32Array(QUANTUM)]])).toBe(true);
    send(processor, { type: 'stop' });
    expect(processor.process([[new Float32Array(QUANTUM)]])).toBe(false);
  });

  it('settles everything waiting when playback stops', () => {
    // Nothing more will be recorded, so a request still waiting would never be
    // answered at all — and one that happens to be satisfiable must not be
    // filled from across the stop boundary, because the fade is in that audio.
    const processor = create(4096);
    send(processor, { type: 'capture', id: 1, frames: 2048 });
    feed(processor, 1024, () => 1);
    send(processor, { type: 'stop' });

    const [reply] = replies(processor);
    expect(reply.id).toBe(1);
    expect(reply.ok === false && reply.reason).toBe('stopped');
  });

  it('records nothing after the stop, however much is fed', () => {
    const processor = create(4096);
    send(processor, { type: 'capture', id: 1, frames: 256 });
    feed(processor, 128, () => 1);
    send(processor, { type: 'stop' });
    feed(processor, 4096, () => 9);

    expect(windows(processor).length).toBe(0);
  });

  it('refuses a request that arrives after the stop', () => {
    const processor = create(4096);
    send(processor, { type: 'stop' });
    send(processor, { type: 'capture', id: 5, frames: 128 });

    const [reply] = replies(processor);
    expect(reply.ok === false && reply.reason).toBe('stopped');
  });
});
