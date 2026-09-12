/**
 * The pass that finally asks the taps for a window.
 *
 * What is asserted here is orchestration, not measurement — `measure.test.ts`
 * proves the metrics against renderers broken in specific ways, and repeating
 * that through this layer would only prove the arguments are passed in order.
 * The decisions that live here are the ones the metrics deliberately refuse to
 * make: how long a window to ask for, whether the master window may be judged
 * at all, and what to say when there is no window.
 *
 * The last of those is the one that matters most. A refused capture that
 * reported nothing would leave `graph` looking exactly as it does when every
 * check passed.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  passDelaySeconds,
  runCaptureChecks,
  windowFramesFor,
} from '../src/integrity/capture-run.ts';
import type { CaptureSource, MeasurableOutput } from '../src/integrity/capture-run.ts';
import type { CaptureOutcome } from '../src/integrity/capture-client.ts';
import { captureFramesFor } from '../src/integrity/measure.ts';
import { checkedScopes, type Finding } from '../src/integrity/findings.ts';
import { renderOffline } from '../src/audio/dsp/render-offline.ts';
import { DEFAULT_PARAMS, type EntrainmentParams } from '../src/audio/dsp/entrainment-core.ts';
import {
  NEVER_STEADY,
  isSteady,
  openSteady,
  type SteadyWindow,
} from '../src/audio/steady-window.ts';

const SR = 48000;
const params = (over: Partial<EntrainmentParams> = {}): EntrainmentParams => ({
  ...DEFAULT_PARAMS,
  ...over,
});

/** A real render of the configuration, in the shape a window carries. */
function renderedChannels(
  p: EntrainmentParams,
  frames: number,
): { left: Float32Array; right: Float32Array } {
  const rendered = renderOffline(p, SR, frames);
  return { left: Float32Array.from(rendered.left), right: Float32Array.from(rendered.right) };
}

/**
 * A tap that spans its window the way the ring does.
 *
 * The rule the schedule exists for: a request answered at T covers
 * `[T - frames / sampleRate, T]`, the most recent audio rather than the next
 * stretch. A fake that reported any other span would let a schedule that asks
 * too early look correct.
 */
class RingTap implements CaptureSource {
  private readonly clock: { now: number };

  constructor(clock: { now: number }) {
    this.clock = clock;
  }

  static at(clock: { now: number }): RingTap {
    return new RingTap(clock);
  }

  async capture(frames: number): Promise<CaptureOutcome> {
    const startedAt = this.clock.now - frames / SR;
    return {
      type: 'capture',
      id: 1,
      ok: true,
      ...renderedChannels(params(), frames),
      frames,
      epoch: 0,
      startFrame: Math.round(startedAt * SR),
      startedAt,
    };
  }
}

/**
 * A tap that answers with real audio, or refuses.
 *
 * The audio is a genuine render of the configuration, so the metrics have
 * something they can actually conclude from — this is not testing what they
 * conclude, but a pass over silence would take their "nothing to measure"
 * branch and prove nothing about the wiring.
 */
class FakeTap implements CaptureSource {
  requested: number[] = [];
  startedAt = 10;
  private readonly answer: (frames: number) => CaptureOutcome;

  constructor(answer: (frames: number) => CaptureOutcome) {
    this.answer = answer;
  }

  async capture(frames: number): Promise<CaptureOutcome> {
    this.requested.push(frames);
    return this.answer(frames);
  }

  static rendering(p: EntrainmentParams, startedAt = 10): FakeTap {
    const answer = (frames: number): CaptureOutcome => ({
      type: 'capture',
      id: 1,
      ok: true,
      ...renderedChannels(p, frames),
      frames,
      epoch: 0,
      startFrame: Math.round(startedAt * SR),
      startedAt,
    });
    const tap = new FakeTap(answer);
    tap.startedAt = startedAt;
    return tap;
  }

  static refusing(reason: string): FakeTap {
    return new FakeTap(() => ({ ok: false, reason }) as CaptureOutcome);
  }
}

function output(over: Partial<MeasurableOutput> = {}): MeasurableOutput {
  const p = params();
  return {
    sampleRate: SR,
    capacityFrames: 8 * SR,
    // Wide open: steadiness is a property under test, so the default must not
    // silently be the interesting case.
    steadyPlayback: () => ({ from: 0, until: Number.POSITIVE_INFINITY }),
    entrainment: FakeTap.rendering(p),
    master: FakeTap.rendering(p),
    ceiling: 0.8,
    ...over,
  };
}

const idsOf = (findings: readonly Finding[]): string[] => findings.map((f) => f.id);
const find = (findings: readonly Finding[], id: string): Finding | undefined =>
  findings.find((f) => f.id === id);

describe('asking for a window', () => {
  it('takes the length the configuration needs', async () => {
    const entrainment = FakeTap.rendering(params());
    const master = FakeTap.rendering(params());
    await runCaptureChecks(output({ entrainment, master }), params());

    const needed = captureFramesFor(params(), SR);
    expect(entrainment.requested.join(',')).toBe(String(needed));
    // Both taps are asked for the same stretch, and asked together.
    expect(master.requested.join(',')).toBe(String(needed));
  });

  it('grows the window for a slower modulation', () => {
    // Continuity wants eight modulation periods, so a slow rate needs more
    // audio — sixteen seconds at 0.5 Hz, against a fifth of a second at 40.
    const fast = windowFramesFor(params({ modulationHz: 40 }), output({ capacityFrames: 1e9 }));
    const slow = windowFramesFor(params({ modulationHz: 2 }), output({ capacityFrames: 1e9 }));
    expect(slow > fast).toBe(true);
  });

  it('never asks for more than the ring holds', async () => {
    // A request longer than the ring is refused outright rather than answered
    // short, so capping is what lets the metrics degrade honestly instead.
    const entrainment = FakeTap.rendering(params());
    const capacityFrames = 4096;
    await runCaptureChecks(
      output({ entrainment, capacityFrames, master: FakeTap.rendering(params()) }),
      params({ modulationHz: 0.5 }),
    );
    expect(entrainment.requested[0]).toBe(capacityFrames);
  });
});

describe('a pass over real windows', () => {
  it('measures both taps and covers the scope', async () => {
    const findings = await runCaptureChecks(output(), params());

    // The point of the whole exercise: `graph` is covered because audio was
    // measured, not because a device property was read.
    expect(checkedScopes(findings).join(',')).toBe('graph');
    expect(findings.every((f) => f.scope === 'graph')).toBe(true);

    // Findings from each tap, named so a reader can tell which is which.
    expect(idsOf(findings).some((id) => id.startsWith('graph-envelope'))).toBe(true);
    expect(idsOf(findings).some((id) => id.startsWith('graph-master'))).toBe(true);
  });

  it('says nothing about the master tap when the window overlapped a ramp', async () => {
    // The tap sits after the playback envelope, so a fade attenuates it
    // legitimately. Measuring across one reports the envelope as a fault.
    const master = FakeTap.rendering(params(), 0.5);
    const findings = await runCaptureChecks(
      // Steady only from 3 s: the window starts inside the ramp-in.
      output({ master, steadyPlayback: () => openSteady(0, 3) }),
      params(),
    );

    const window = find(findings, 'graph-master-window');
    expect(window?.checked).toBe(false);
    expect(/overlapped a ramp/.test(window?.detail ?? '')).toBe(true);
    // No verdict about the master tap was reached from that window.
    expect(idsOf(findings).includes('graph-master-signal')).toBe(false);
    expect(idsOf(findings).includes('graph-master-headroom')).toBe(false);
    // And the entrainment tap is unaffected: it is upstream of that gain.
    expect(idsOf(findings).some((id) => id.startsWith('graph-envelope'))).toBe(true);
  });

  it('reads steadiness after the window arrives, not before', async () => {
    // A fade beginning while a window is being recorded is exactly the case
    // this exists for. Asking before the request would accept it.
    let steady: SteadyWindow = { from: 0, until: Number.POSITIVE_INFINITY };
    const master = new FakeTap((frames): CaptureOutcome => {
      // The stop lands while the tap is answering.
      steady = { from: 0, until: 11 };
      return {
        type: 'capture',
        id: 1,
        ok: true,
        ...renderedChannels(params(), frames),
        frames,
        epoch: 0,
        startFrame: 10 * SR,
        startedAt: 10,
      };
    });

    const findings = await runCaptureChecks(
      output({ master, steadyPlayback: () => steady }),
      params(),
    );
    expect(find(findings, 'graph-master-window')?.checked).toBe(false);
  });
});

describe('when there is no window to measure', () => {
  it('reports a refusal rather than staying silent about it', async () => {
    // Silence here would leave `graph` looking exactly as it does when every
    // check passed, which is the failure this whole subsystem exists to stop.
    const findings = await runCaptureChecks(
      output({ entrainment: FakeTap.refusing('timeout'), master: FakeTap.refusing('closed') }),
      params(),
    );

    expect(checkedScopes(findings).length).toBe(0);
    expect(findings.length).toBe(2);
    expect(findings.every((f) => !f.checked && f.scope === 'graph')).toBe(true);
    expect(
      /may not be rendering/.test(find(findings, 'graph-entrainment-window')?.detail ?? ''),
    ).toBe(true);
    expect(/Playback ended/.test(find(findings, 'graph-master-window')?.detail ?? '')).toBe(true);
  });

  it('explains a configuration change in its own terms', async () => {
    const findings = await runCaptureChecks(
      output({ entrainment: FakeTap.refusing('epoch-changed') }),
      params(),
    );
    expect(
      /configuration changed/.test(find(findings, 'graph-entrainment-window')?.detail ?? ''),
    ).toBe(true);
  });

  it('still measures the tap that did answer', async () => {
    const findings = await runCaptureChecks(
      output({ entrainment: FakeTap.refusing('timeout') }),
      params(),
    );
    expect(find(findings, 'graph-entrainment-window')?.checked).toBe(false);
    expect(idsOf(findings).some((id) => id.startsWith('graph-master'))).toBe(true);
    expect(checkedScopes(findings).join(',')).toBe('graph');
  });

  it('says so when the session has no taps at all', async () => {
    // A graph built without the capture worklet. Not a fault, and not a pass.
    const findings = await runCaptureChecks(output({ entrainment: null, master: null }), params());
    expect(findings.length).toBe(1);
    expect(findings[0].checked).toBe(false);
    expect(findings[0].scope).toBe('graph');
  });

  it('refuses a window recorded before anything was steady', async () => {
    // `NEVER_STEADY` is what the graph reports before playback opens. Nothing
    // can lie inside it, so nothing may be judged from it.
    const findings = await runCaptureChecks(
      output({ steadyPlayback: () => NEVER_STEADY }),
      params(),
    );
    expect(find(findings, 'graph-master-window')?.checked).toBe(false);
  });
});

describe('when a pass can first be taken', () => {
  const SECONDS = 1.4;

  it('waits a whole window past the point steadiness opens', () => {
    // A tap answers with the *most recent* frames, so a request answered at T
    // spans [T - seconds, T]. Asking as steadiness opens reaches back through
    // the whole ramp — and the steadiness check then refuses it, which is why
    // the naive schedule would never measure the master bus at all.
    const steady = openSteady(0, 3);
    // The ramp, the window itself, and a small margin past the boundary —
    // which is on the audio clock while whoever schedules the pass is working
    // from a wall clock.
    expect(passDelaySeconds(steady, 0, SECONDS)).toBeCloseTo(3 + SECONDS + 0.25, 6);
  });

  it('produces a window a real pass actually measures', async () => {
    // The property, driven rather than asserted: schedule through
    // `passDelaySeconds`, run a pass against a tap that spans its window the
    // way the ring does, and see the master findings arrive.
    const steady = openSteady(0, 3);
    const clock = { now: 0 };
    const master = RingTap.at(clock);
    const frames = windowFramesFor(params(), output({ master }));
    const seconds = frames / SR;

    const delay = passDelaySeconds(steady, clock.now, seconds);
    expect(delay === null).toBe(false);
    clock.now += delay ?? 0;

    const findings = await runCaptureChecks(
      output({ master, steadyPlayback: () => steady }),
      params(),
    );

    expect(idsOf(findings).includes('graph-master-signal')).toBe(true);
    expect(idsOf(findings).includes('graph-master-window')).toBe(false);
  });

  it('is what the naive schedule gets wrong', async () => {
    // The control, and the finding this exists for: asking the moment
    // steadiness opens reaches back through the whole ramp, so every automatic
    // pass would have come back refused. Without this the test above could
    // pass for having asked at any time at all.
    const steady = openSteady(0, 3);
    const clock = { now: steady.from };
    const master = RingTap.at(clock);

    const findings = await runCaptureChecks(
      output({ master, steadyPlayback: () => steady }),
      params(),
    );

    expect(idsOf(findings).includes('graph-master-window')).toBe(true);
    expect(idsOf(findings).includes('graph-master-signal')).toBe(false);
  });

  it('does not wait once a whole window has already played', () => {
    expect(passDelaySeconds(openSteady(0, 3), 10, SECONDS)).toBe(0);
  });

  it('refuses when the fade would arrive first', () => {
    // Steady playback shorter than a single window. The realistic case is a
    // slider moved a second before the session's fade: steadiness re-opens,
    // and no whole window can complete before it closes again.
    expect(passDelaySeconds({ from: 3, until: 4 }, 0, SECONDS)).toBe(null);
    expect(passDelaySeconds({ from: 29, until: 30 }, 0, SECONDS)).toBe(null);
  });

  it('still allows a window that ends just before the fade', () => {
    // The other side of that line, and the reason the check is on where the
    // window *ends*: audio already played is as good as any other.
    const delay = passDelaySeconds({ from: 0, until: 30 }, 29.5, SECONDS);
    expect(delay).toBe(0);
    expect(isSteady({ from: 0, until: 30 }, 29.5 - SECONDS, SECONDS)).toBe(true);
  });

  it('refuses when nothing steady is in prospect', () => {
    expect(passDelaySeconds(NEVER_STEADY, 0, SECONDS)).toBe(null);
  });
});
