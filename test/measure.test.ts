/**
 * Turning captured audio into findings.
 *
 * The properties that matter here are the ones that decide whether a warning
 * can be believed: that a correct graph at a different volume, or caught at a
 * different point in its cycle, still passes — and that the faults this exists
 * to notice are actually noticed. A check that only passes for the exact
 * reference render would fire on every real session, and one that passes for
 * anything would never fire at all.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { measureEntrainment, measureMaster, TOLERANCE } from '../src/integrity/measure.ts';
import { renderOffline } from '../src/audio/dsp/render-offline.ts';
import { amplitudeAt } from '../src/audio/analysis/fft.ts';
import { rms } from '../src/audio/analysis/metrics.ts';
import {
  DEFAULT_PARAMS,
  createState,
  type EntrainmentParams,
} from '../src/audio/dsp/entrainment-core.ts';
import { checkedScopes, recordedStatus, type Finding } from '../src/integrity/findings.ts';
import { BUILT_IN_PRESETS, LEGACY_PRESETS } from '../src/audio/presets.ts';

const SR = 48000;
const FRAMES = SR * 2;

const params = (over: Partial<EntrainmentParams> = {}): EntrainmentParams => ({
  ...DEFAULT_PARAMS,
  ...over,
});

const capture = (p: EntrainmentParams, frames = FRAMES) => {
  const rendered = renderOffline(p, SR, frames);
  return { left: rendered.left, right: rendered.right, sampleRate: SR };
};

const scaled = (signal: Float64Array, by: number): Float64Array => {
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i += 1) out[i] = signal[i] * by;
  return out;
};

const byId = (findings: Finding[], id: string): Finding => {
  const found = findings.find((f) => f.id === id);
  if (!found) throw new Error(`no finding ${id} among ${findings.map((f) => f.id).join(', ')}`);
  return found;
};

const statuses = (findings: Finding[]): string =>
  findings
    .map((f) => f.status)
    .sort()
    .join(',');

describe('the entrainment tap against its reference', () => {
  it('passes everything when the capture is what the parameters describe', () => {
    const p = params();
    const findings = measureEntrainment(capture(p), p);
    expect(findings.length).toBe(7);
    expect(statuses(findings)).toBe('ok,ok,ok,ok,ok,ok,ok');
  });

  it('still passes at a quarter of the level', () => {
    // The property the whole comparison rests on. `entrainmentGain` sits
    // between the source and the tap, so absolute levels need not match the
    // reference at all — a check that expected them to would fire on a correct
    // graph every time the user moved a fader.
    const p = params();
    const rendered = renderOffline(p, SR, FRAMES);
    const quiet = {
      left: scaled(rendered.left, 0.25),
      right: scaled(rendered.right, 0.25),
      sampleRate: SR,
    };
    expect(statuses(measureEntrainment(quiet, p))).toBe('ok,ok,ok,ok,ok,ok,ok');
  });

  it('still passes when the window starts mid-cycle', () => {
    // A captured window begins wherever the ring happened to be; the reference
    // starts at phase zero. Every metric compared here is phase-invariant, and
    // this is what says so.
    const p = params();
    const long = renderOffline(p, SR, FRAMES + 613);
    const offset = {
      left: long.left.subarray(613),
      right: long.right.subarray(613),
      sampleRate: SR,
    };
    expect(statuses(measureEntrainment(offset, p))).toBe('ok,ok,ok,ok,ok,ok,ok');
  });

  it('stays quiet across carriers and capture offsets', () => {
    // The spectrum check compared single bins, and a component that does not
    // land on one spreads across its neighbours by an amount that depends on
    // where the captured window started — so a perfectly healthy 81 Hz carrier
    // disagreed with its own reference by double figures, purely from where the
    // ring happened to be. One offset at the forgiving default carrier was not
    // enough to catch that.
    for (const carrierHz of [47, 81, 137, 320, 999]) {
      const p = params({ carrierHz });
      const long = renderOffline(p, SR, FRAMES + 4096);

      for (const offset of [0, 17, 113, 613, 2048, 3001]) {
        // Through Float32, as a real capture arrives.
        const asCaptured = Float32Array.from(long.left.subarray(offset));
        const finding = byId(
          measureEntrainment({ left: asCaptured, right: asCaptured, sampleRate: SR }, p),
          'graph-spectrum',
        );
        const label = `${carrierHz} Hz at offset ${offset}`;
        expect(`${label}: ${finding.status}`).toBe(`${label}: ok`);
      }
    }
  });

  it('stays quiet wherever a glide left the carrier under its envelope', () => {
    // The offsets above move the window, and the carrier and envelope move with
    // it — so none of them could reach this. A glide is phase-continuous, which
    // leaves the carrier at an arbitrary alignment under the envelope once it
    // stops, and the reference always starts both at zero. Where the carrier is
    // a whole or half multiple of the rate, the folded sidebands add or cancel by
    // that alignment: switching to GENUS inspired while playing warned at 11 dB,
    // and Balanced pulse, the default, reached 15.
    const carriers = [
      ...BUILT_IN_PRESETS.map((preset) => ({ label: preset.id, p: preset.params })),
      { label: 'square at 200 Hz', p: params({ carrierHz: 200, duty: 0.1, edge: 0 }) },
    ];
    for (const { label, p } of carriers) {
      for (const alignment of [0.13, 0.3, 0.55, 0.81]) {
        const state = createState();
        state.carrierPhase = alignment;
        const long = renderOffline(p, SR, FRAMES + 613, 128, state);
        const finding = byId(
          measureEntrainment(
            {
              left: Float32Array.from(long.left.subarray(613)),
              right: Float32Array.from(long.right.subarray(613)),
              sampleRate: SR,
            },
            p,
          ),
          'graph-spectrum',
        );
        const at = `${label} at ${alignment}`;
        expect(`${at}: ${finding.status}`).toBe(`${at}: ok`);
      }
    }
  });

  it('probes the sidebands where the configuration puts them', () => {
    // Not 220 and not 40. A probe at a fixed frequency would measure empty
    // bins here and report a confident absence of sidebands that are present
    // exactly where they belong.
    const p = params({ carrierHz: 320, modulationHz: 12 });
    expect(byId(measureEntrainment(capture(p), p), 'graph-sidebands').status).toBe('ok');
  });

  it('notices an envelope that has been flattened', () => {
    // What a codec or a dynamics processor does to the thing the whole app is
    // for, and what it would sound like: fine.
    const p = params({ depth: 1 });
    const flattened = capture(params({ depth: 0.1 }));
    const findings = measureEntrainment(flattened, p);
    expect(byId(findings, 'graph-envelope-index').status).toBe('warning');
  });

  it('notices a binaural pair that has been collapsed to mono', () => {
    // The failure interaural correlation exists for. It still sounds like a
    // tone, and the 40 Hz beat the listener came for is simply not there.
    const p = params({ twoToneMode: 'dichotic', twoToneGain: 0.5, amGain: 0 });
    const rendered = renderOffline(p, SR, FRAMES);
    const summed = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) summed[i] = (rendered.left[i] + rendered.right[i]) / 2;

    const findings = measureEntrainment({ left: summed, right: summed, sampleRate: SR }, p);
    expect(byId(findings, 'graph-interaural').status).toBe('warning');
  });

  it('notices a collapsed pair even when AM is playing over it', () => {
    // The case the correlation alone accepts. With AM and two-tone together the
    // shared AM component dominates the correlation, so a completely
    // mono-downmixed capture measured as barely changed — five clean findings
    // for a signal whose binaural beat no longer exists. The side channel is
    // where the collapse actually shows.
    const p = params({ amGain: 0.5, twoToneGain: 0.1, twoToneMode: 'dichotic' });
    const rendered = renderOffline(p, SR, FRAMES);
    const summed = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) summed[i] = (rendered.left[i] + rendered.right[i]) / 2;

    const findings = measureEntrainment({ left: summed, right: summed, sampleRate: SR }, p);
    expect(byId(findings, 'graph-stereo-difference').status).toBe('warning');
  });

  it('notices a dichotic pair that has lost an ear', () => {
    // Nothing else here sees this. Two tones one per ear are orthogonal, so
    // correlation stays near zero whatever their levels, and side-to-mid stays
    // at 0 dB because halving one channel scales the sum and the difference
    // alike. Every other metric reads the left channel and finds it perfect
    // while the listener has no beat at all.
    const p = params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic' });
    const rendered = renderOffline(p, SR, FRAMES);

    for (const level of [0, 0.1, 0.5]) {
      const findings = measureEntrainment(
        { left: rendered.left, right: scaled(rendered.right, level), sampleRate: SR },
        p,
      );
      expect(byId(findings, 'graph-channel-balance').status).toBe('warning');
    }
  });

  it('leaves a healthy pair alone', () => {
    const p = params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic' });
    expect(byId(measureEntrainment(capture(p), p), 'graph-channel-balance').status).toBe('ok');
  });

  it('notices the right ear playing the wrong note', () => {
    // Everything else here asks about levels and shapes, and a tone at the
    // wrong frequency satisfies all of them: correlation, balance and
    // side-to-mid are untouched, and the left channel really is perfect. The
    // beat the listener came for is simply not 40 Hz any more.
    const p = params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic' });
    const reference = renderOffline(p, SR, FRAMES);

    // 261 rather than 260 is the subtlest of these — a 41 Hz beat — and 440 is
    // not a beat at all.
    for (const hz of [261, 280, 440]) {
      const shifted = renderOffline({ ...p, modulationHz: hz - p.carrierHz }, SR, FRAMES);
      const findings = measureEntrainment(
        { left: reference.left, right: shifted.right, sampleRate: SR },
        p,
      );
      expect(byId(findings, 'graph-spectrum').status).toBe('warning');
    }
  });

  it('notices a right-ear tone two hertz out under an AM bed', () => {
    // Four-bin bands kept the displaced energy inside its own band, so a 42 Hz
    // beat instead of 40 read 7.3 dB and passed. The earlier mixed test moved
    // the tone to 280 Hz, well outside the blind spot, and so never saw it.
    const p = params({ amGain: 0.5, twoToneGain: 0.3, twoToneMode: 'dichotic' });
    const reference = renderOffline(p, SR, FRAMES);
    const amOnly = renderOffline({ ...p, twoToneGain: 0 }, SR, FRAMES);

    const partner = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) partner[i] = reference.right[i] - amOnly.right[i];
    const level = rms(partner) * Math.SQRT2;

    for (const hz of [261, 262, 265]) {
      const wrong = new Float64Array(FRAMES);
      for (let i = 0; i < FRAMES; i += 1) {
        wrong[i] = amOnly.right[i] + level * Math.sin((2 * Math.PI * hz * i) / SR);
      }
      const findings = measureEntrainment(
        { left: reference.left, right: wrong, sampleRate: SR },
        p,
      );
      const label = `right at ${hz} Hz`;
      expect(`${label}: ${byId(findings, 'graph-spectrum').status}`).toBe(`${label}: warning`);
    }
  });

  it('notices a wrong right-ear tone under an AM bed as well', () => {
    // The mixed case, where the shared AM component is loud enough to mask the
    // two-tone partner in every level-based measure.
    //
    // Built by subtracting the AM-only render from the full one to isolate the
    // two-tone partner, then putting a tone of the same energy at the wrong
    // frequency in its place. Re-rendering with a different `modulationHz`
    // would have been simpler and would have proved nothing: that moves this
    // channel's AM rate as well, so the check could fire for a fault the test
    // was not trying to introduce.
    const p = params({ amGain: 0.5, twoToneGain: 0.1, twoToneMode: 'dichotic' });
    const reference = renderOffline(p, SR, FRAMES);
    const amOnly = renderOffline({ ...p, twoToneGain: 0 }, SR, FRAMES);

    const partner = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) partner[i] = reference.right[i] - amOnly.right[i];
    const level = rms(partner) * Math.SQRT2;

    const wrongTone = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) {
      wrongTone[i] = amOnly.right[i] + level * Math.sin((2 * Math.PI * 280 * i) / SR);
    }

    // The control: the same reconstruction with the partner back at its right
    // frequency. It has to pass, or the deviation below would be an artefact of
    // taking the channel apart rather than of the tone being wrong.
    const rightTone = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) {
      rightTone[i] =
        amOnly.right[i] + level * Math.sin((2 * Math.PI * (p.carrierHz + p.modulationHz) * i) / SR);
    }
    expect(
      byId(
        measureEntrainment({ left: reference.left, right: rightTone, sampleRate: SR }, p),
        'graph-spectrum',
      ).status,
    ).toBe('ok');

    const findings = measureEntrainment(
      { left: reference.left, right: wrongTone, sampleRate: SR },
      p,
    );
    expect(byId(findings, 'graph-spectrum').status).toBe('warning');
  });

  it('will not time an envelope too shallow to have one', () => {
    // At this depth the envelope's dominant frequency is whichever pile of
    // numerical residue happened to peak highest — a healthy capture reported
    // 220 Hz against the reference's 40 Hz and warned, with every other finding
    // passing. Through Float32 and starting mid-cycle, as a real capture does.
    const p = params({ depth: 0.0005 });
    const long = renderOffline(p, SR, FRAMES + 613);
    const asCaptured = Float32Array.from(long.left.subarray(613));

    //
    // It passes rather than reporting `unknown`: both sides agree there is no
    // envelope, and agreement is a match. An `unknown` here would be one
    // unknown among checked findings, which is exactly what the session record
    // reports — so a healthy session would have recorded `unknown`.
    const findings = measureEntrainment({ left: asCaptured, right: asCaptured, sampleRate: SR }, p);
    expect(byId(findings, 'graph-envelope-frequency').status).toBe('ok');
    expect(findings.filter((f) => f.status === 'warning').length).toBe(0);
  });

  it('cannot time a rate when only one side has an envelope', () => {
    // A real disagreement, but the depth reading beside it already says so;
    // timing the flat one would quote a frequency read off noise.
    const p = params({ depth: 1 });
    const flat = capture(params({ depth: 0 }));
    const findings = measureEntrainment(flat, p);
    const rate = byId(findings, 'graph-envelope-frequency');
    expect(rate.status).toBe('unknown');
    expect(rate.checked).toBe(true);
    expect(byId(findings, 'graph-envelope-index').status).toBe('warning');
  });

  it('records ok for every built-in preset playing correctly', () => {
    // The aggregate, not the individual findings — this is what A5 writes to
    // the session record, and a healthy session has to read `ok` with graph
    // coverage. Binaural is the preset that caught this: it has no per-ear
    // envelope by design, and calling that absence inconclusive made every
    // healthy binaural session record `unknown`.
    for (const preset of [...BUILT_IN_PRESETS, ...LEGACY_PRESETS]) {
      const findings = measureEntrainment(capture(preset.params), preset.params);
      expect(`${preset.id}: ${recordedStatus(findings)}`).toBe(`${preset.id}: ok`);
      expect(checkedScopes(findings).join(',')).toBe('graph');
    }
  });

  it('fails an entrainment capture that is not audio at all', () => {
    // Every metric below would absorb these silently rather than report them.
    const p = params();
    const rendered = renderOffline(p, SR, FRAMES);
    const broken = Float64Array.from(rendered.left);
    broken[9999] = NaN;

    const findings = measureEntrainment({ left: broken, right: rendered.right, sampleRate: SR }, p);
    expect(findings.length).toBe(1);
    expect(findings[0].status).toBe('failed');
    expect(findings[0].id).toBe('graph-entrainment-validity');
  });

  it('does not claim more than it measured when there is no envelope', () => {
    // Only one channel's envelope is measured, and a very shallow modulation
    // does have an envelope — it is simply not deep enough to time. The copy
    // said "no envelope in either ear", which is two claims the measurement
    // never made. The routing note appears only where it is true.
    const am = params({ depth: 0.0005, twoToneMode: 'off' });
    const amDetail = byId(measureEntrainment(capture(am), am), 'graph-envelope-frequency').detail;
    expect(amDetail.includes('analysed channel')).toBe(true);
    expect(amDetail.includes('dichotic')).toBe(false);

    const binaural = params({ amGain: 0, twoToneGain: 0.26, twoToneMode: 'dichotic' });
    const binauralDetail = byId(
      measureEntrainment(capture(binaural), binaural),
      'graph-envelope-frequency',
    ).detail;
    expect(binauralDetail.includes('between the ears')).toBe(true);
  });

  it('does not warn about residue far below hearing', () => {
    // Both sides absent is not a discrepancy. Comparing the logarithm of
    // nothing against the logarithm of nothing produced tens of dB of
    // "error" from arithmetic noise, which is precisely the wrong warning this
    // module says it would rather not give.
    const p = params();
    const rendered = renderOffline(p, SR, FRAMES);
    const nudged = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) nudged[i] = rendered.left[i] + (i % 2 ? 1e-9 : -1e-9);

    const findings = measureEntrainment({ left: rendered.left, right: nudged, sampleRate: SR }, p);
    expect(byId(findings, 'graph-stereo-difference').status).toBe('ok');
  });

  it('does not warn about sidebands that were never asked for', () => {
    // Depth zero: there are no sidebands to find. The capture carries a
    // deliberate 1e-6 tone where the lower sideband would be — inaudible, and
    // far under the module's own silence floor, but enough that the old
    // clamp-at-1e-9 comparison reported tens of dB of error against a
    // reference that had nothing there. Passing `capture(p)` alone would not
    // have exercised this at all: it is the very render used as the reference,
    // so both sides carried identical residue.
    const p = params({ depth: 0 });
    const rendered = renderOffline(p, SR, FRAMES);
    const withResidue = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) {
      withResidue[i] =
        rendered.left[i] + 1e-6 * Math.sin((2 * Math.PI * (p.carrierHz - p.modulationHz) * i) / SR);
    }

    const findings = measureEntrainment(
      { left: withResidue, right: withResidue, sampleRate: SR },
      p,
    );
    expect(byId(findings, 'graph-sidebands').status).toBe('ok');
  });

  it('warns when the configured carrier is simply not there', () => {
    // A graph running an entirely different carrier is affirmative evidence of
    // a fault, not an absence of evidence: the reference has one and the output
    // is not silent. Reporting it as inconclusive left three passes and a shrug.
    const p = params({ carrierHz: 220 });
    const elsewhere = capture(params({ carrierHz: 320 }));

    const finding = byId(measureEntrainment(elsewhere, p), 'graph-sidebands');
    expect(finding.status).toBe('warning');
    expect(finding.detail.includes('220')).toBe(true);
  });

  it('notices one sideband vanishing even when the average survives', () => {
    // Lower gone, upper doubled: the mean of the two is untouched, which is
    // exactly what averaging them before comparing could not see. The spectrum
    // is structurally wrong.
    const p = params({ duty: 1, edge: 1, depth: 1, amGain: 0.5 });
    const reference = renderOffline(p, SR, FRAMES);
    const upperRatio =
      amplitudeAt(reference.left, SR, p.carrierHz + p.modulationHz) /
      amplitudeAt(reference.left, SR, p.carrierHz);
    const carrier = amplitudeAt(reference.left, SR, p.carrierHz);

    const lopsided = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) {
      const t = (2 * Math.PI * i) / SR;
      lopsided[i] =
        carrier * Math.sin(t * p.carrierHz) +
        2 * upperRatio * carrier * Math.sin(t * (p.carrierHz + p.modulationHz));
    }

    const findings = measureEntrainment({ left: lopsided, right: lopsided, sampleRate: SR }, p);
    expect(byId(findings, 'graph-sidebands').status).toBe('warning');
  });

  it('notices sidebands that are missing from an otherwise plausible tone', () => {
    const p = params({ depth: 1, edge: 1, duty: 1 });
    const bare = new Float64Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) {
      bare[i] = 0.25 * Math.sin((2 * Math.PI * p.carrierHz * i) / SR);
    }
    const findings = measureEntrainment({ left: bare, right: bare, sampleRate: SR }, p);
    expect(byId(findings, 'graph-sidebands').status).toBe('warning');
  });

  it('will not call a spectrum clean that it could not have judged', () => {
    // Resolution follows window length. Eight modulation periods is the
    // shortest window this accepts, and after rounding down to a power of two
    // it gives 11.7 Hz bands — a right-ear tone one hertz out cannot show up
    // there, so `ok` would be claiming a check that could not have failed.
    const p = params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic' });
    const short = Math.ceil((8 * SR) / p.modulationHz);
    const reference = renderOffline(p, SR, short);
    const shifted = renderOffline({ ...p, modulationHz: 261 - p.carrierHz }, SR, short);

    const finding = byId(
      measureEntrainment({ left: reference.left, right: shifted.right, sampleRate: SR }, p),
      'graph-spectrum',
    );
    expect(finding.status).toBe('unknown');
    expect(finding.checked).toBe(true);
    expect(finding.detail.includes('longer capture')).toBe(true);
  });

  it('does not warn from a coarse window, however large the deviation', () => {
    // A short window does not merely miss small faults, it manufactures large
    // ones: a healthy 81 Hz carrier captured at the shortest accepted length
    // reads over 12 dB from window phase alone. Judging the deviation before
    // checking whether it could be trusted turned that into a warning about
    // correct output — so nothing is claimed at this resolution, in either
    // direction.
    const p = params({ carrierHz: 81 });
    const short = Math.ceil((8 * SR) / p.modulationHz);
    const long = renderOffline(p, SR, short + 8192);

    for (const offset of [0, 4096, 8191]) {
      const healthy = Float32Array.from(long.left.subarray(offset, offset + short));
      const finding = byId(
        measureEntrainment({ left: healthy, right: healthy, sampleRate: SR }, p),
        'graph-spectrum',
      );
      const label = `offset ${offset}`;
      expect(`${label}: ${finding.status}`).toBe(`${label}: unknown`);
    }
  });

  it('reports the reason rather than a number when it cannot measure', () => {
    const p = params();
    const short = capture(p, 1024);
    const findings = measureEntrainment(short, p);

    expect(findings.length).toBe(1);
    expect(findings[0].id).toBe('graph-window');
    expect(findings[0].status).toBe('unknown');
    // Ran and could not conclude, which coverage counts and a placeholder does
    // not — the distinction the whole model is built on.
    expect(findings[0].checked).toBe(true);
  });

  it('treats a silent entrainment path as unmeasurable, not broken', () => {
    // It can legitimately be turned down to nothing. The master tap is where a
    // silent output is worth remarking on.
    const p = params();
    const silence = {
      left: new Float64Array(FRAMES),
      right: new Float64Array(FRAMES),
      sampleRate: SR,
    };
    const findings = measureEntrainment(silence, p);
    expect(findings[0].id).toBe('graph-entrainment-signal');
    expect(findings[0].status).toBe('unknown');
  });

  it('keeps the copy specific enough to act on', () => {
    // Asserted rather than left to drift: a warning that does not say what was
    // measured against what is a warning nobody can do anything with.
    const p = params({ depth: 1 });
    const findings = measureEntrainment(capture(params({ depth: 0.1 })), p);
    const detail = byId(findings, 'graph-envelope-index').detail;
    expect(detail.includes('reference render')).toBe(true);
    expect(detail.includes('tolerance')).toBe(true);
  });
});

describe('the master tap, on bounds alone', () => {
  const tone = (peak: number): Float64Array => {
    const out = new Float64Array(SR);
    for (let i = 0; i < out.length; i += 1) out[i] = peak * Math.sin((2 * Math.PI * 220 * i) / SR);
    return out;
  };

  const master = (peak: number) => ({ left: tone(peak), right: tone(peak), sampleRate: SR });

  it('passes a signal inside the ceiling', () => {
    expect(statuses(measureMaster(master(0.5), { ceiling: 0.8, modulationHz: 40 }))).toBe('ok,ok');
  });

  it('reports silence at the master bus', () => {
    const findings = measureMaster(
      { left: new Float64Array(SR), right: new Float64Array(SR), sampleRate: SR },
      { ceiling: 0.8, modulationHz: 40 },
    );
    expect(byId(findings, 'graph-master-signal').status).toBe('warning');
  });

  it('reports a peak past the ceiling the graph guarantees', () => {
    const findings = measureMaster(master(0.9), { ceiling: 0.8, modulationHz: 40 });
    expect(byId(findings, 'graph-master-headroom').status).toBe('warning');
  });

  it('calls full scale a failure rather than a warning', () => {
    // Clipping is audible. Passing the app's own ceiling is a broken promise
    // that may still sound fine, so the two are not the same finding.
    const findings = measureMaster(master(1), { ceiling: 0.8, modulationHz: 40 });
    expect(byId(findings, 'graph-master-headroom').status).toBe('failed');
  });

  it('does not call one click a working output', () => {
    // The same peak drove both findings, so two seconds of silence with a
    // single impulse in it passed as healthy: a graph that emitted one click
    // and died, declared fine. Plain RMS does not separate them either — that
    // impulse still averages above the silence floor.
    const click = new Float64Array(SR * 2);
    click[1000] = 0.5;

    const findings = measureMaster(
      { left: click, right: click, sampleRate: SR },
      { ceiling: 0.8, modulationHz: 40 },
    );
    expect(byId(findings, 'graph-master-signal').status).toBe('warning');
    // Headroom still reads the peak, and 0.5 is genuinely within the ceiling.
    expect(byId(findings, 'graph-master-headroom').status).toBe('ok');
  });

  it('accepts a deeply gated envelope at any rate or sample rate', () => {
    // The counterpart risk, and the one a fixed block length got wrong. A 1024
    // frame block is 21 ms at 48 kHz but 11 ms at 96 kHz, while the engine
    // permits rates down to 0.5 Hz and duty cycles down to 2% — so correct
    // output was silent for far longer than a block and reported itself
    // intermittent. Deriving the block from the rate is what fixes it, and
    // these are the corners of what the UI allows.
    // The carrier belongs in this sweep. Leaving it at the helper's default
    // hid a legal configuration that warned about itself: at a 20 Hz carrier a
    // 2% duty pulse is a fraction of one cycle, so how loud it comes out
    // depends on where the carrier was, and some pulses are near-silent.
    for (const rate of [22050, 32000, 44100, 48000, 96000]) {
      for (const [modulationHz, carrierHz, duty, edge] of [
        [40, 220, 0.5, 0],
        [20, 220, 0.02, 0],
        [40, 220, 0.02, 0],
        [200, 220, 0.02, 0],
        // Tapered edges carry far less energy per block than square ones at the
        // same duty, which a level-based activity measure got wrong: this exact
        // configuration reported 83-90% activity and warned about itself.
        [48.5, 220, 0.05, 1],
        [40, 220, 0.02, 1],
        [200, 220, 0.02, 1],
        [17.3, 220, 0.03, 0.7],
        // Carriers at both ends, including the pulse-shorter-than-a-cycle case.
        [175, 20, 0.02, 0.95],
        [97, 47, 0.02, 1],
        [147.5, 4001, 0.02, 0.95],
        [48.5, 4001, 0.02, 0.95],
        // Few samples per carrier cycle: at 32 kHz an 8 kHz carrier has four,
        // half of them at zero crossings. Counting loud samples read that as
        // 80% activity and warned about a correct render.
        [40.01, 8000, 0.02, 1],
        [137.813, 7350, 0.02, 1],
        [53.5, 8000, 0.02, 1],
      ] as const) {
        const p = params({ modulationHz, carrierHz, duty, edge, depth: 1, amGain: 0.5 });
        const rendered = renderOffline(p, rate, rate * 2);
        const findings = measureMaster(
          { left: rendered.left, right: rendered.right, sampleRate: rate },
          { ceiling: 0.8, modulationHz: p.modulationHz },
        );
        // Correct output passes, everywhere. Asking whether a block contains
        // anything at all leaves no configuration near the threshold, so this
        // can assert `ok` rather than merely "not a warning".
        const label = `${rate} Hz, ${modulationHz}/${carrierHz} Hz at ${duty * 100}% duty, edge ${edge}`;
        expect(`${label}: ${byId(findings, 'graph-master-signal').status}`).toBe(`${label}: ok`);
      }
    }
  });

  it('declines to judge continuity when the window cannot show it', () => {
    // At 0.5 Hz a period is two seconds. A window holding a couple of them
    // carries no evidence of repetition, so a correct 2% duty cycle and a dead
    // graph look identical — and saying so is better than picking one.
    const p = params({ modulationHz: 0.5, duty: 0.02, edge: 0, depth: 1, amGain: 0.5 });
    const rendered = renderOffline(p, SR, SR * 2);
    const finding = byId(
      measureMaster(
        { left: rendered.left, right: rendered.right, sampleRate: SR },
        { ceiling: 0.8, modulationHz: p.modulationHz },
      ),
      'graph-master-signal',
    );
    // Inconclusive, not clean. A status of `ok` beside a detail admitting it
    // cannot tell is the one contradiction this model exists to prevent — and
    // the caller can avoid it entirely by sizing the window from the rate.
    expect(finding.status).toBe('unknown');
    expect(finding.checked).toBe(true);
    expect(finding.detail.includes('too short')).toBe(true);
  });

  it('notices a graph that played and then died', () => {
    // Half was far too generous: the block straddling the cutoff still counts
    // as active, so stopping 48% of the way through scored 50% and passed a
    // check whose entire purpose is to show the output kept going.
    const p = params({ amGain: 0.5 });
    const rendered = renderOffline(p, SR, SR * 2);

    for (const survived of [0.48, 0.75, 0.9]) {
      const dies = Float64Array.from(rendered.left);
      dies.fill(0, Math.floor(dies.length * survived));
      const findings = measureMaster(
        { left: dies, right: dies, sampleRate: SR },
        { ceiling: 0.8, modulationHz: 40 },
      );
      const label = `stopped at ${survived * 100}%`;
      expect(`${label}: ${byId(findings, 'graph-master-signal').status}`).toBe(`${label}: warning`);
    }
  });

  it('treats an unmodulated carrier as the continuous path it is', () => {
    // At depth 0 the carrier never stops, so the output is a steady tone
    // however sparse the duty cycle looks on paper. Judging only the two-tone
    // path made these unjudgeable — and a graph that died halfway through one
    // of them unreportable, which is the whole point of the check.
    const p = params({ modulationHz: 60, carrierHz: 80, duty: 0.05, depth: 0, amGain: 0.5 });
    const rendered = renderOffline(p, SR, SR * 2);

    expect(
      byId(
        measureMaster(
          { left: rendered.left, right: rendered.right, sampleRate: SR },
          { ceiling: 0.8, modulationHz: p.modulationHz },
        ),
        'graph-master-signal',
      ).status,
    ).toBe('ok');

    const dies = Float64Array.from(rendered.left);
    dies.fill(0, Math.floor(dies.length * 0.48));
    expect(
      byId(
        measureMaster(
          { left: dies, right: dies, sampleRate: SR },
          { ceiling: 0.8, modulationHz: p.modulationHz },
        ),
        'graph-master-signal',
      ).status,
    ).toBe('warning');
  });

  it('accepts every legal configuration, including the awkward ones', () => {
    // These four all warned at some point, each for a different reason, and each
    // was patched with a threshold the next one slipped under: a pulse shorter
    // than its carrier cycle, a two-tone gain retained with routing off, an
    // unmodulated carrier, and four samples per carrier cycle. Asking whether a
    // block contains anything at all answers all four at once.
    const awkward = [
      params({ modulationHz: 175, carrierHz: 20, duty: 0.02, edge: 0.95, amGain: 0.5 }),
      params({ modulationHz: 175, carrierHz: 20, duty: 0.02, amGain: 0.5, twoToneGain: 0.5 }),
      params({ modulationHz: 60, carrierHz: 80, duty: 0.05, depth: 0, amGain: 0.5 }),
      params({ modulationHz: 40.01, carrierHz: 8000, duty: 0.02, edge: 1, amGain: 0.5 }),
    ];

    for (const [rate, p] of awkward.flatMap((p) =>
      [22050, 32000, 44100].map((rate) => [rate, p] as const),
    )) {
      const rendered = renderOffline(p, rate, rate * 2);
      const status = byId(
        measureMaster(
          { left: rendered.left, right: rendered.right, sampleRate: rate },
          { ceiling: 0.8, modulationHz: p.modulationHz },
        ),
        'graph-master-signal',
      ).status;
      const label = `${p.modulationHz}/${p.carrierHz} Hz depth ${p.depth} @${rate}`;
      expect(`${label}: ${status}`).toBe(`${label}: ok`);
    }
  });

  it('accepts a click train, which is the limit of this check', () => {
    // Pinned rather than hidden. A single impulse per block reaches the peak
    // just as a pulse does, so this passes — and that is not a threshold that
    // could be tightened: at 40 Hz and 2% duty a legal pulse is exactly 24
    // samples, so a burst of the same length is the same signal. Only how many
    // arrive per period tells them apart, which needs pulse cadence measured
    // through an envelope — a different check from this one.
    //
    // Every attempt to catch it here warned about correct output instead.
    const blockFrames = Math.ceil((2 * SR) / 40);
    const clicks = new Float64Array(SR * 2);
    for (let i = 0; i < clicks.length; i += blockFrames) clicks[i] = 0.5;

    expect(
      byId(
        measureMaster(
          { left: clicks, right: clicks, sampleRate: SR },
          { ceiling: 0.8, modulationHz: 40 },
        ),
        'graph-master-signal',
      ).status,
    ).toBe('ok');
  });

  it('fails a channel that is not audio at all', () => {
    // Comparisons with NaN are false, so `peakLevel` walks straight past them:
    // a dead channel of NaN beside a healthy one measured as the healthy one's
    // peak and passed both bounds. A clean report for output that is not a
    // signal.
    const dead = new Float64Array(SR).fill(NaN);
    const findings = measureMaster(
      { left: dead, right: tone(0.5), sampleRate: SR },
      { ceiling: 0.8, modulationHz: 40 },
    );
    expect(findings.length).toBe(1);
    expect(byId(findings, 'graph-master-validity').status).toBe('failed');
  });

  it('fails on a single bad sample', () => {
    const nearlyFine = tone(0.5);
    nearlyFine[12345] = Infinity;
    const findings = measureMaster(
      { left: tone(0.5), right: nearlyFine, sampleRate: SR },
      { ceiling: 0.8, modulationHz: 40 },
    );
    expect(byId(findings, 'graph-master-validity').status).toBe('failed');
    expect(findings[0].detail.includes('12345')).toBe(true);
  });

  it('allows the arithmetic slack the limiter needs', () => {
    const peak = 0.8 * TOLERANCE.ceilingOvershoot * 0.999;
    expect(
      byId(measureMaster(master(peak), { ceiling: 0.8, modulationHz: 40 }), 'graph-master-headroom')
        .status,
    ).toBe('ok');
  });
});
