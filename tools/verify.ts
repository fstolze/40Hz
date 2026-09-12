/**
 * Layer 1 verification report.
 *
 * Renders the engine offline and prints what the analysis actually measures,
 * rather than only asserting it. This is the same measurement code that will
 * later run against loopback-captured output (Layer 3) — a divergence between
 * the two columns is what localises a fault to the user's audio path rather
 * than to the DSP.
 *
 *   node tools/verify.ts
 */

import { DEFAULT_PARAMS, type EntrainmentParams } from '../src/audio/dsp/entrainment-core.ts';
import { ENVELOPE_SHAPES } from '../src/audio/dsp/envelope.ts';
import { renderOffline } from '../src/audio/dsp/render-offline.ts';
import { amplitudeAt } from '../src/audio/analysis/fft.ts';
import {
  measureEnvelope,
  interauralCorrelation,
  toMono,
  peakLevel,
} from '../src/audio/analysis/metrics.ts';

const SR = 48000;
const MOD = 40;
const CARRIER = 220;
const QUANTUM = 128;

function base(overrides: Partial<EntrainmentParams> = {}): EntrainmentParams {
  return { ...DEFAULT_PARAMS, modulationHz: MOD, carrierHz: CARRIER, ...overrides };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

console.log(`\n40 Hz engine — offline verification`);
console.log(`sample rate ${SR} Hz   carrier ${CARRIER} Hz   modulation ${MOD} Hz`);
console.log(`period = ${SR / MOD} samples   render quantum = ${QUANTUM} samples\n`);

// --- AM path, across the shape continuum -----------------------------------

console.log('AM path — envelope measured from 4 s of audio');
console.log(
  pad('  shape', 18) +
    padLeft('duty', 6) +
    padLeft('edge', 6) +
    padLeft('env Hz', 10) +
    padLeft('index', 8) +
    padLeft('depth dB', 10),
);
for (const [name, shape] of Object.entries(ENVELOPE_SHAPES)) {
  const { left } = renderOffline(base({ ...shape, depth: 1, amGain: 0.5 }), SR, SR * 4, QUANTUM);
  const m = measureEnvelope(left, SR);
  console.log(
    pad('  ' + name, 18) +
      padLeft(shape.duty.toFixed(2), 6) +
      padLeft(shape.edge.toFixed(2), 6) +
      padLeft(m.frequencyHz.toFixed(3), 10) +
      padLeft(m.index.toFixed(4), 8) +
      padLeft(m.depthDb.toFixed(1), 10),
  );
}

// --- Spectrum of the smooth end --------------------------------------------

const amGain = 0.5;
const { left: sineAm } = renderOffline(base({ ...ENVELOPE_SHAPES.sine, depth: 1, amGain }), SR, SR);
console.log('\nAM path spectrum (sine shape, exact-bin DFT over 1 s)');
for (const f of [CARRIER - 2 * MOD, CARRIER - MOD, CARRIER, CARRIER + MOD, CARRIER + 2 * MOD]) {
  const a = amplitudeAt(sineAm, SR, f);
  const label =
    f === CARRIER ? 'carrier' : `fc ${f > CARRIER ? '+' : '-'} ${Math.abs(f - CARRIER)}`;
  console.log(pad(`  ${f} Hz`, 14) + pad(label, 12) + padLeft(a.toExponential(3), 14));
}

// --- Two-tone path ---------------------------------------------------------

console.log('\nTwo-tone path — the routing flag is the only difference');
for (const mode of ['dichotic', 'diotic'] as const) {
  const p = base({ amGain: 0, twoToneGain: 0.5, twoToneMode: mode });
  const { left, right } = renderOffline(p, SR, SR * 4, QUANTUM);
  const perEar = measureEnvelope(left, SR);
  const combined = measureEnvelope(toMono(left, right), SR);
  const label = mode === 'dichotic' ? 'dichotic (binaural)' : 'diotic (monaural)';
  console.log(`  ${label}`);
  console.log(`    interaural correlation   ${interauralCorrelation(left, right).toFixed(6)}`);
  console.log(`    peak level               ${peakLevel(left).toFixed(4)}`);
  console.log(
    `    envelope in one ear      ${perEar.frequencyHz.toFixed(2)} Hz, index ${perEar.index.toFixed(4)}`,
  );
  console.log(
    `    envelope once combined   ${combined.frequencyHz.toFixed(2)} Hz, index ${combined.index.toFixed(4)}`,
  );
}

// --- Phase integrity -------------------------------------------------------

console.log('\nPhase accumulator');
const single = renderOffline(base({ amGain: 0.5 }), SR, SR);
const chunked = renderOffline(base({ amGain: 0.5 }), SR, SR, QUANTUM);
let maxDiff = 0;
for (let i = 0; i < single.left.length; i++) {
  maxDiff = Math.max(maxDiff, Math.abs(single.left[i] - chunked.left[i]));
}
console.log(`  single-shot vs ${QUANTUM}-frame chunks   max sample difference ${maxDiff}`);

const rate = 44100;
const frames = Math.round(599.37 * rate);
const long = renderOffline(base({ amGain: 0.5 }), rate, 0, QUANTUM);
{
  // Advance the state without retaining audio.
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  const { render } = await import('../src/audio/dsp/entrainment-core.ts');
  const p = base({ amGain: 0.5 });
  let done = 0;
  while (done < frames) {
    const n = Math.min(QUANTUM, frames - done);
    render(p, long.state, rate, l, r, n);
    done += n;
  }
  const expected = ((frames * MOD) % rate) / rate;
  const d = Math.abs(long.state.modPhase - expected) % 1;
  const err = Math.min(d, 1 - d);
  console.log(
    `  ${(frames / rate / 60).toFixed(1)} min at ${rate} Hz (period ${rate / MOD} samples)`,
  );
  console.log(
    `    phase error ${err.toExponential(3)} cycles ` +
      `(${((err / MOD) * 1e12).toFixed(2)} ps of timing drift)`,
  );
}

console.log('');
