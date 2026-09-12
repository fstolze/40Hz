/**
 * The modulation figures the scope displays, across the configurations the UI
 * actually permits.
 *
 * This exists because the readout has been wrong twice, in ways no test caught
 * and no screen showed. Both times the fault was a bin length: a bin has to be
 * far shorter than a modulation period and far longer than a carrier cycle, and
 * with carriers from 20 Hz and modulation to 200 Hz those demands cross. At an
 * 80 Hz carrier and 40 Hz modulation — one carrier cycle to half a modulation
 * period — a fully gated signal read 0.6% to 37.2%, flickering with alignment.
 *
 * So the coverage is a sweep rather than an example. It varies **carrier and
 * modulator phase independently**, because that is what the app can produce and
 * a window offset cannot: the worklet's accumulators are never reset, so a
 * parameter change during playback leaves the two at whatever relative phase
 * they had reached. Sweeping only the offset moves them together and explores a
 * narrow slice — it reported 83.0-86.2% for a case whose real range is
 * 83.0-100.0%.
 *
 * It also runs at the sample rates the OS actually hands over, since the range
 * widens with them.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { isFinitePcm, modulationReadout } from '../src/audio/analysis/readout.ts';
import { renderOffline } from '../src/audio/dsp/render-offline.ts';
import { DEFAULT_PARAMS, type EntrainmentParams } from '../src/audio/dsp/entrainment-core.ts';

const SR = 48000;
/** What the scope reads: one analyser buffer. */
const FFT_SIZE = 16384;

const params = (over: Partial<EntrainmentParams> = {}): EntrainmentParams => ({
  ...DEFAULT_PARAMS,
  ...over,
});

/**
 * A window of the entrainment signal, as Float32.
 *
 * `phases` sets where the carrier and the modulator each are when the window
 * begins — independently, as the worklet's un-reset accumulators leave them
 * after a parameter change. Passing an offset instead would advance both
 * together, which is a different and much smaller space.
 */
function capture(
  p: EntrainmentParams,
  phases: { carrier?: number; mod?: number } = {},
  rate = SR,
): Float32Array {
  const state = {
    carrierPhase: phases.carrier ?? 0,
    modPhase: phases.mod ?? 0,
    toneLoPhase: 0,
    toneHiPhase: 0,
    toneActive: false,
  };
  return Float32Array.from(renderOffline(p, rate, FFT_SIZE, 0, state).left);
}

/** The whole phase space, coarsely. */
function readingRange(p: EntrainmentParams, rate = SR): { lowest: number; highest: number } {
  let lowest = 1;
  let highest = 0;
  for (let c = 0; c < 8; c += 1) {
    for (let m = 0; m < 8; m += 1) {
      const { index } = modulationReadout(capture(p, { carrier: c / 8, mod: m / 8 }, rate), rate);
      lowest = Math.min(lowest, index);
      highest = Math.max(highest, index);
    }
  }
  return { lowest, highest };
}

describe('a fully gated envelope', () => {
  it('reads as fully modulated wherever the carrier is well clear of the rate', () => {
    // The ordinary case, across every phase the worklet can be left in and at
    // the rates an OS actually hands over.
    for (const rate of [44100, 48000, 96000]) {
      for (const carrierHz of [220, 440, 999, 4001]) {
        for (const modulationHz of [10, 40, 137.5]) {
          if (carrierHz < modulationHz * 4) continue;
          const p = params({
            carrierHz,
            modulationHz,
            depth: 1,
            duty: 0.5,
            edge: 0.5,
            amGain: 0.3,
          });
          const { lowest } = readingRange(p, rate);
          const label = `${rate} Hz, ${carrierHz}/${modulationHz}`;
          expect(`${label}: ${lowest > 0.9}`).toBe(`${label}: true`);
        }
      }
    }
  });

  it('never collapses where the carrier is barely above the rate', () => {
    // The analytic envelope assumes a narrowband carrier and these are not, so
    // the reading is tens of percent out at worst — where the binned version
    // read 0.6% for the same signal. The error is not monotonic in the ratio,
    // so this asserts the floor rather than pretending a threshold separates
    // them.
    for (const rate of [44100, 48000, 96000]) {
      for (const carrierHz of [20, 40, 60, 80, 81, 120, 160]) {
        const p = params({ carrierHz, modulationHz: 40, depth: 1, duty: 0.5, edge: 0.5 });
        const { lowest } = readingRange(p, rate);
        // A carrier *below* the rate is the worst of them, at about 51%.
        const label = `${rate} Hz, ${carrierHz}/40`;
        expect(`${label}: ${lowest > 0.5}`).toBe(`${label}: true`);
      }
    }
  });

  it('varies with relative phase exactly as far as the module says it does', () => {
    // The documented ranges, asserted. A window offset alone reports 83.0-86.2%
    // for the first of these, which is why the sweep varies the two phases
    // independently.
    const cases = [
      { carrierHz: 80, floor: 0.82, ceiling: 1.0001 },
      { carrierHz: 81, floor: 0.87, ceiling: 1.0001 },
      { carrierHz: 220, floor: 0.97, ceiling: 1.0001 },
      // Far enough clear that phase stops mattering at all.
      { carrierHz: 124, floor: 0.999, ceiling: 1.0001 },
      { carrierHz: 999, floor: 0.999, ceiling: 1.0001 },
    ];

    for (const { carrierHz, floor, ceiling } of cases) {
      const p = params({ carrierHz, modulationHz: 40, depth: 1, duty: 0.5, edge: 0.5 });
      const { lowest, highest } = readingRange(p);
      const label = `${carrierHz}/40 read ${(lowest * 100).toFixed(1)}-${(highest * 100).toFixed(1)}%`;
      expect(`${label}: ${lowest >= floor && highest <= ceiling}`).toBe(`${label}: true`);
    }
  });

  it('can read high as well as low, which is why it is not smoothed', () => {
    // A running maximum or an average would be defensible if the estimator only
    // ever under-read. At depth 0.5 on an 80 Hz carrier it reports well above
    // the true figure, so smoothing would produce a confident wrong number.
    const trusted = modulationReadout(
      capture(params({ carrierHz: 4000, modulationHz: 40, depth: 0.5, duty: 0.5, edge: 0.5 })),
      SR,
    ).index;
    const { highest } = readingRange(
      params({ carrierHz: 80, modulationHz: 40, depth: 0.5, duty: 0.5, edge: 0.5 }),
    );
    expect(`over-reads: ${highest > trusted + 0.02}`).toBe('over-reads: true');
  });

  it('does not flicker where the carrier is clear of the rate', () => {
    // The old reading swung between 0.6% and 37.2% as its bins slid against the
    // modulation. Here the whole phase space is walked, which is a strictly
    // larger perturbation than a window offset.
    const p = params({ carrierHz: 124, modulationHz: 40, depth: 1, duty: 0.5, edge: 0.5 });
    const { lowest, highest } = readingRange(p);
    // Not perfectly identical — the window truncates to a power of two, so a
    // different offset trims a slightly different set of cycles. A few percent
    // against the old swing of thirty-seven is the distinction that matters.
    const spread = highest - lowest;
    expect(`spread ${spread.toFixed(3)}, within 0.05: ${spread < 0.05}`).toBe(
      `spread ${spread.toFixed(3)}, within 0.05: true`,
    );
    // Not the 100% the signal actually has — see the narrowband note — but
    // steady, and nowhere near the collapse to near-zero it replaced.
    expect(`lowest ${lowest.toFixed(2)} > 0.8: ${lowest > 0.8}`).toBe(
      `lowest ${lowest.toFixed(2)} > 0.8: true`,
    );
  });
});

describe('an unmodulated carrier', () => {
  it('reads as barely modulated at all', () => {
    for (const carrierHz of [80, 220, 999]) {
      const p = params({ carrierHz, depth: 0, amGain: 0.3 });
      const { index } = modulationReadout(capture(p), SR);
      expect(`${carrierHz}: ${index < 0.05}`).toBe(`${carrierHz}: true`);
    }
  });
});

describe('partial depth', () => {
  it('sits between the two, and rises with the commanded depth', () => {
    // Not asserted against a formula: `index = depth / (2 - depth)` holds for
    // the sine shape alone, and this has to be right for the pulse shapes too.
    const shallow = modulationReadout(capture(params({ depth: 0.25, carrierHz: 220 })), SR).index;
    const deeper = modulationReadout(capture(params({ depth: 0.75, carrierHz: 220 })), SR).index;

    expect(shallow < deeper).toBe(true);
    expect(deeper < 1.0001).toBe(true);
  });
});

describe('the bounds of the reading', () => {
  it('never leaves nought to one, however quiet the signal', () => {
    // The original fault: at quiet levels a near-silent trough went negative
    // through the byte view and the ratio ran away to 775%.
    for (const amGain of [1, 0.3, 0.05, 0.01, 0.002]) {
      const p = params({ amGain, depth: 1, carrierHz: 220 });
      const { index, depthDb } = modulationReadout(capture(p), SR);
      const label = `gain ${amGain}`;
      expect(`${label}: ${index >= 0 && index <= 1}`).toBe(`${label}: true`);
      expect(`${label}: ${depthDb >= 0 && depthDb <= 60}`).toBe(`${label}: true`);
    }
  });

  it('says a buffer too short to transform is short, not silent', () => {
    // Silence is a claim about the output; too few samples is a claim about the
    // window. Calling the second one silence is what the length check used to
    // do, and it did it to a loud tone as readily as to nothing at all.
    const empty = modulationReadout(new Float32Array(256), SR);
    expect(empty.kind).toBe('insufficient');
    expect(empty.index).toBe(0);

    const loud = Float32Array.from({ length: 256 }, (_, i) =>
      Math.sin((2 * Math.PI * 220 * i) / SR),
    );
    expect(modulationReadout(loud, SR).kind).toBe('insufficient');
  });

  it('calls a short buffer that is not audio invalid rather than short', () => {
    // The two questions are independent, and asking the cheaper one first
    // answered the other one wrong: this reported silence.
    expect(modulationReadout(new Float32Array(256).fill(NaN), SR).kind).toBe('invalid');
  });

  it('reports a buffer that is not audio as unreadable, not as silence', () => {
    // Two different things for a display to say, and collapsing them is how
    // invalid output came to be shown as a confident 0.0% — a measurement
    // nobody made. Mixed data is the case that matters: the finite samples are
    // enough to look like signal.
    const mixed = new Float32Array(FFT_SIZE);
    for (let i = 0; i < mixed.length; i += 1) {
      mixed[i] = i % 2 === 0 ? NaN : 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    expect(modulationReadout(mixed, SR).kind).toBe('invalid');

    const allBad = new Float32Array(FFT_SIZE).fill(NaN);
    expect(modulationReadout(allBad, SR).kind).toBe('invalid');

    // Infinity too, which arrives from a runaway filter rather than a dead one.
    const infinite = Float32Array.from(mixed, (v) => (Number.isNaN(v) ? Infinity : v));
    expect(modulationReadout(infinite, SR).kind).toBe('invalid');
  });

  it('tells silence apart from a real reading', () => {
    expect(modulationReadout(new Float32Array(FFT_SIZE), SR).kind).toBe('silent');
    expect(modulationReadout(capture(params()), SR).kind).toBe('reading');
  });

  it('refuses to bin a buffer that is not audio', () => {
    // What the scope asks before it draws. The binning loop starts each column
    // at `hi = -1, lo = 1` and only moves them on a true comparison, so an
    // all-NaN bin leaves those in place and traces a full-scale envelope that
    // was never played.
    expect(isFinitePcm(new Float32Array(FFT_SIZE).fill(NaN))).toBe(false);
    expect(isFinitePcm(Float32Array.from([0.1, 0.2, NaN, 0.3]))).toBe(false);
    expect(isFinitePcm(Float32Array.from([0.1, Infinity]))).toBe(false);
    expect(isFinitePcm(capture(params()))).toBe(true);
  });

  it('says nothing about silence', () => {
    const readout = modulationReadout(new Float32Array(FFT_SIZE), SR);
    expect(readout.index).toBe(0);
    expect(readout.depthDb).toBe(0);
  });
});
