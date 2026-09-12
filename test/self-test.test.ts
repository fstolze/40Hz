/**
 * The engine self-test, and above all its ability to fail.
 *
 * A suite of checks that has only ever been run against a working engine says
 * nothing: every one of them might be asserting something trivially true. So
 * each invariant is also driven against a renderer broken in exactly the way
 * that invariant exists to catch, and the *other* findings are required to stay
 * clean — a check that fires on every fault is as useless as one that never
 * fires, because it cannot say which part is wrong.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { runSelfTest } from '../src/integrity/self-test.ts';
import { renderOffline, type OfflineRender } from '../src/audio/dsp/render-offline.ts';
import {
  render,
  type EntrainmentParams,
  type EngineState,
} from '../src/audio/dsp/entrainment-core.ts';
import { recordedStatus, checkedScopes, type Finding } from '../src/integrity/findings.ts';

const status = (findings: Finding[], id: string): string => {
  const found = findings.find((f) => f.id === id);
  if (!found) throw new Error(`no finding ${id} among ${findings.map((f) => f.id).join(', ')}`);
  return found.status;
};

const failing = (findings: Finding[]): string =>
  findings
    .filter((f) => f.status !== 'ok')
    .map((f) => f.id)
    .sort()
    .join(',');

describe('a working engine', () => {
  it('passes every check, and says so as engine-scoped findings', () => {
    const findings = runSelfTest();

    expect(failing(findings)).toBe('');
    expect(recordedStatus(findings)).toBe('ok');
    // Nothing here observes the graph or the device, so it can claim nothing
    // about them.
    expect(checkedScopes(findings).join(',')).toBe('engine');
    // All checked: this ran, it did not merely decline to look.
    expect(findings.every((f) => f.checked)).toBe(true);
  });

  it('covers each property the verification tool prints', () => {
    const ids = runSelfTest()
      .map((f) => f.id)
      .sort()
      .join(',');
    expect(ids).toBe(
      [
        'engine-chunking',
        'engine-envelope-raisedCosine',
        'engine-envelope-sine',
        'engine-envelope-square',
        'engine-phase',
        'engine-routing-dichotic',
        'engine-routing-diotic',
        'engine-spectrum',
      ].join(','),
    );
  });

  it('holds at whatever rate the device turned out to run at', () => {
    for (const sampleRate of [44100, 48000, 96000]) {
      const findings = runSelfTest({ sampleRate });
      expect(`${sampleRate}: ${failing(findings)}`).toBe(`${sampleRate}: `);
    }
  });
});

/**
 * `renderOffline`, with one property spoiled.
 *
 * The spoiler is told the chunk size, because one fault can only be expressed
 * as a difference between the chunked and single-shot renders — spoiling both
 * identically leaves them identical, which is precisely what the check is
 * looking at.
 */
function broken(
  spoil: (out: OfflineRender, params: EntrainmentParams, chunkFrames: number) => void,
): typeof renderOffline {
  return (params, sampleRate, frames, chunkFrames = 0, state?) => {
    const out = renderOffline(params, sampleRate, frames, chunkFrames, state);
    spoil(out, params, chunkFrames);
    return out;
  };
}

describe('an engine that is wrong', () => {
  /** The AM path only, so a fault cannot leak into the two-tone checks. */
  const amFault = (spoil: (out: OfflineRender, params: EntrainmentParams) => void) =>
    broken((out, params) => {
      if (params.amGain > 0) spoil(out, params);
    });

  const AM_CHECKS = [
    'engine-envelope-raisedCosine',
    'engine-envelope-sine',
    'engine-envelope-square',
    'engine-spectrum',
  ].join(',');

  it('notices an envelope running at the wrong rate', () => {
    // A perfectly good pulse train, at the wrong speed.
    const wrongRate = amFault((out, params) => {
      const fixed = renderOffline(
        { ...params, modulationHz: params.modulationHz * 1.5 },
        48000,
        out.left.length,
        128,
      );
      out.left.set(fixed.left);
      out.right.set(fixed.right);
    });

    expect(failing(runSelfTest({ render: wrongRate }))).toBe(AM_CHECKS);
  });

  it('notices a carrier with no modulation on it', () => {
    const flat = amFault((out, params) => {
      for (let i = 0; i < out.left.length; i += 1) {
        const v = 0.5 * Math.sin((2 * Math.PI * params.carrierHz * i) / 48000);
        out.left[i] = v;
        out.right[i] = v;
      }
    });

    expect(failing(runSelfTest({ render: flat }))).toBe(AM_CHECKS);
  });

  it('notices modulation that is shallower than it was asked to be', () => {
    // Judging the rate alone certified this: a perfectly timed 40 Hz envelope
    // at a quarter of the commanded depth.
    const shallow = amFault((out, params) => {
      const weakened = renderOffline({ ...params, depth: 0.25 }, 48000, out.left.length, 128);
      out.left.set(weakened.left);
      out.right.set(weakened.right);
    });

    expect(failing(runSelfTest({ render: shallow }))).toBe(AM_CHECKS);
  });

  it('notices a lopsided spectrum', () => {
    // One sideband suppressed. The raised cosine survives it — its envelope is
    // broad enough in the spectrum that removing one component of the sine
    // case does not move its index far — which is why the spectrum check
    // exists separately from the envelope ones.
    const lopsided = amFault((out, params) => {
      const lower = params.carrierHz - params.modulationHz;
      for (let i = 0; i < out.left.length; i += 1) {
        const component = 0.125 * Math.sin((2 * Math.PI * lower * i) / 48000);
        out.left[i] -= component;
        out.right[i] -= component;
      }
    });

    expect(failing(runSelfTest({ render: lopsided }))).toBe(
      'engine-envelope-sine,engine-envelope-square,engine-spectrum',
    );
  });

  it('notices AM reaching only one ear', () => {
    // The AM path is diotic by specification, and every check read the left
    // channel — so correct modulation into one ear and silence into the other
    // was certified as a working engine.
    const halfDeaf = amFault((out) => out.right.fill(0));
    expect(failing(runSelfTest({ render: halfDeaf }))).toBe(AM_CHECKS);
  });

  it('notices a channel that is not a number', () => {
    // `Math.abs(NaN - x)` is NaN and every comparison with NaN is false, so a
    // channel of NaN compared as identical to a healthy one and the finding
    // said so in as many words.
    const notANumber = amFault((out) => out.right.fill(NaN));
    // Block independence reports it too, and should: it renders the AM path as
    // well, and a scan that accepts NaN is the same fault in another place.
    expect(failing(runSelfTest({ render: notANumber }))).toBe(`engine-chunking,${AM_CHECKS}`);
  });

  it('notices a dichotic pair that is not separated', () => {
    const collapsed = broken((out) => out.right.set(out.left));
    expect(failing(runSelfTest({ render: collapsed }))).toBe('engine-routing-dichotic');
  });

  it('notices dichotic output that is uncorrelated but not a pair', () => {
    // Two quadrature copies of one frequency: correlation is zero, each ear is
    // flat, and there is no 40 Hz difference for the brainstem to find.
    const quadrature = broken((out, params) => {
      if (params.twoToneMode !== 'dichotic') return;
      for (let i = 0; i < out.left.length; i += 1) {
        const phase = (2 * Math.PI * params.carrierHz * i) / 48000;
        out.left[i] = 0.5 * Math.sin(phase);
        out.right[i] = 0.5 * Math.cos(phase);
      }
    });

    expect(failing(runSelfTest({ render: quadrature }))).toBe('engine-routing-dichotic');
  });

  it('notices a dichotic pair that is lopsided', () => {
    // Correlation, crosstalk and beat frequency all survive this: the tones are
    // in the right ears at the right frequencies, one just far quieter.
    const lopsided = broken((out, params) => {
      if (params.twoToneMode !== 'dichotic') return;
      for (let i = 0; i < out.right.length; i += 1) out.right[i] *= 0.25;
    });

    expect(failing(runSelfTest({ render: lopsided }))).toBe('engine-routing-dichotic');
  });

  it('notices diotic routing that has come apart', () => {
    const split = broken((out, params) => {
      if (params.twoToneMode !== 'diotic') return;
      for (let i = 0; i < out.right.length; i += 1) out.right[i] = -out.right[i];
    });

    expect(failing(runSelfTest({ render: split }))).toBe('engine-routing-diotic');
  });

  it('notices diotic output that is correlated but has no beat', () => {
    // One carrier copied to both ears: correlation is one, the second tone is
    // missing, and nothing beats.
    const oneTone = broken((out, params) => {
      if (params.twoToneMode !== 'diotic') return;
      for (let i = 0; i < out.left.length; i += 1) {
        const v = 0.5 * Math.sin((2 * Math.PI * params.carrierHz * i) / 48000);
        out.left[i] = v;
        out.right[i] = v;
      }
    });

    expect(failing(runSelfTest({ render: oneTone }))).toBe('engine-routing-diotic');
  });

  it('notices a diotic channel that has been scaled', () => {
    // Correlation is blind to this — it stays at exactly 1 — and both tones
    // remain above any absolute floor.
    const quieter = broken((out, params) => {
      if (params.twoToneMode !== 'diotic') return;
      for (let i = 0; i < out.right.length; i += 1) out.right[i] *= 0.5;
    });

    expect(failing(runSelfTest({ render: quieter }))).toBe('engine-routing-diotic');
  });

  it('notices block dependence on every path and in both ears', () => {
    // A part in a billion, which no other check can see, so each of these
    // isolates the chunking comparison. The dichotic case perturbs the right
    // channel alone — that path does not require the ears to match, so it can
    // prove the right channel is compared at all.
    const cases: [string, (out: OfflineRender, params: EntrainmentParams) => void][] = [
      [
        'AM path',
        (out, params) => {
          if (params.amGain > 0) {
            out.left[0] += 1e-9;
            out.right[0] += 1e-9;
          }
        },
      ],
      [
        'dichotic path, right ear alone',
        (out, params) => {
          if (params.twoToneMode === 'dichotic') out.right[7] += 1e-9;
        },
      ],
      [
        'diotic path',
        (out, params) => {
          if (params.twoToneMode === 'diotic') {
            out.left[9] += 1e-9;
            out.right[9] += 1e-9;
          }
        },
      ],
    ];

    for (const [label, spoil] of cases) {
      const blockDependent = broken((out, params, chunkFrames) => {
        if (chunkFrames > 0) spoil(out, params);
      });
      expect(`${label}: ${failing(runSelfTest({ render: blockDependent }))}`).toBe(
        `${label}: engine-chunking`,
      );
    }
  });

  it('notices a chunked render that is not a number', () => {
    // Only the chunked pass, and only the combined path — so nothing but the
    // block comparison can see it. `Math.abs(a - b)` is NaN, which is never
    // greater than the running worst, so the two renders scanned as identical
    // and block independence said so.
    const notANumber = broken((out, params, chunkFrames) => {
      if (chunkFrames > 0 && params.amGain > 0 && params.twoToneGain > 0) out.right.fill(NaN);
    });

    const findings = runSelfTest({ render: notANumber });
    expect(failing(findings)).toBe('engine-chunking');
    expect(findings.find((f) => f.id === 'engine-chunking')?.detail.includes('not a number')).toBe(
      true,
    );
  });

  it('reports a check that throws as that check failing, and runs the rest', () => {
    // An engine faulty enough to throw is when a structured report matters
    // most. Evaluating the checks in one expression meant a single throw
    // produced no findings at all.
    let calls = 0;
    const throwsOnce: typeof renderOffline = (params, sampleRate, frames, chunkFrames, state) => {
      calls += 1;
      if (calls === 2) throw new Error('the engine gave up');
      return renderOffline(params, sampleRate, frames, chunkFrames, state);
    };

    const findings = runSelfTest({ render: throwsOnce });
    expect(findings.length).toBe(8);
    expect(findings.filter((f) => f.status === 'failed').length).toBe(1);
    expect(findings.find((f) => f.status === 'failed')?.detail.includes('gave up')).toBe(true);
    // Everything independent of the throw still reported.
    expect(status(findings, 'engine-phase')).toBe('ok');
  });

  it('notices a modulator whose phase wanders', () => {
    // Driven through the per-block renderer, because drift is a state
    // accumulator going astray rather than anything visible in a buffer.
    const drifting = (
      params: EntrainmentParams,
      state: EngineState,
      sampleRate: number,
      left: Float32Array,
      right: Float32Array,
      frames?: number,
    ): void => {
      render(params, state, sampleRate, left, right, frames);
      // A part per million per block: inaudible, and hours off by the end.
      state.modPhase = (state.modPhase + 1e-6) % 1;
    };

    const findings = runSelfTest({ advance: drifting });
    expect(failing(findings)).toBe('engine-phase');
    // A warning rather than a failure: slow drift is worth reporting and is not
    // a reason to distrust the rest of the engine.
    expect(status(findings, 'engine-phase')).toBe('warning');
    expect(recordedStatus(findings)).toBe('warning');
  });
});
