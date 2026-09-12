/**
 * A model of the notch chain, and a bound on what it can do to a peak.
 *
 * `worstCaseSourcePeak` in `graph.ts` sums the bed's gain as though the bed
 * arrived at the master bus untouched. It does not: it passes through three
 * peaking filters first, and "the notches only cut" is a statement about
 * *magnitude response*, not about peak amplitude. A cut biquad still rings,
 * and a ringing filter can raise an individual sample above its input.
 *
 * That gap is not new with file beds — it applies to the procedural noise bed
 * in the shipped build — which is why the correction here is unconditional.
 *
 * What is computed is the L1 norm of the cascade's impulse response, which is
 * the worst-case peak gain of a fixed, zero-state LTI filter for any input
 * bounded by one. That identity is exact. **The computed value is not a
 * certified upper bound**, and the difference matters enough to state plainly:
 *
 * - The sum is truncated. The remaining tail is *estimated* geometrically from
 *   the largest pole magnitude, which is not a proof — cascaded modes can beat,
 *   and repeated or near-repeated poles introduce polynomial factors that a
 *   plain geometric envelope does not cover.
 * - A parameter sweep says nothing about the values between its grid points.
 *
 * So the result carries an explicit `BOUND_MARGIN` and is described as
 * **empirical with a measured margin**, which is what it is. The margin was
 * sized by measurement, not chosen: extending the window eightfold across the
 * whole admitted space changes the sum by at most 9.0e-8 relative (worst case
 * 96 kHz, -12 dB, Q 1, fc 1000, mod 0.5). One percent exceeds that by a factor
 * of about 1e5.
 *
 * A third gap is not closed here at all: this is a model of Chromium's
 * `BiquadFilterNode`, not that node. The equivalence is established by an
 * Electron test measuring the real one. Calling this "the real chain" is how
 * that gap gets assumed away.
 *
 * Written in erasable TypeScript only, so it runs under Node's native type
 * stripping without a build.
 */

/** One biquad section, already normalised by a0. */
export interface BiquadSection {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Peaking-EQ coefficients, matching the Web Audio specification.
 *
 * The specification defines `peaking` by the Audio EQ Cookbook formulae, so
 * this is a transcription rather than a design choice — any deviation here is
 * a bug in the model, and the Electron measurement is what would catch it.
 */
export function peakingSection(
  frequencyHz: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): BiquadSection {
  const a = Math.pow(10, gainDb / 40);
  // The node clamps its own frequency to the Nyquist limit; mirroring that
  // here keeps the model defined where the sweep reaches the top of the range
  // at a low sample rate.
  const nyquist = sampleRate / 2;
  const f = Math.min(Math.max(frequencyHz, 0), nyquist * 0.999);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(q, 1e-6));

  const b0 = 1 + alpha * a;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * a;
  const a0 = 1 + alpha / a;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / a;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Magnitude of the larger pole.
 *
 * This is what sets how slowly the impulse response decays, and therefore how
 * much of it a truncated sum leaves out.
 */
export function poleRadius(section: BiquadSection): number {
  const { a1, a2 } = section;
  const discriminant = a1 * a1 - 4 * a2;
  if (discriminant < 0) {
    // Complex conjugate pair: both have magnitude sqrt(a2).
    return Math.sqrt(Math.abs(a2));
  }
  const root = Math.sqrt(discriminant);
  return Math.max(Math.abs((-a1 + root) / 2), Math.abs((-a1 - root) / 2));
}

/** Run one section over a buffer in place, from zero state. */
function filterInPlace(section: BiquadSection, signal: Float64Array): void {
  const { b0, b1, b2, a1, a2 } = section;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    signal[i] = y0;
  }
}

/**
 * Safety margin applied to every computed bound.
 *
 * See the module comment: the truncation remainder is estimated rather than
 * certified, and a grid sweep does not cover the gaps between its points. One
 * percent is five orders of magnitude more than the largest tail contribution
 * measurable across the admitted parameter space, and it costs under 0.09 dB.
 */
export const BOUND_MARGIN = 1.01;

export interface PeakGainBound {
  /**
   * Empirical bound on output peak for any input bounded by one, margin
   * included. Not a certified upper bound — see the module comment.
   */
  bound: number;
  /** Sum of |h[n]| over the computed window. */
  truncatedSum: number;
  /** Geometric *estimate* of the remainder past the window. Not a proof. */
  tailEstimate: number;
  /** The margin applied on top of the two. */
  margin: number;
  /** Largest pole magnitude across the cascade. */
  radius: number;
  /** How many samples of impulse response were summed. */
  frames: number;
}

/**
 * The cascade's peak gain, as an empirical bound with a measured margin.
 *
 * The tail past the window is estimated by a geometric series anchored on the
 * largest magnitude near the end of it. That is an estimate, not a bound: the
 * anchoring assumes every later sample is covered by `anchor * r^k`, which the
 * pole radius alone does not establish. The window is sized from the radius so
 * the remainder is negligible to begin with — measured at under 1e-7 relative
 * across the whole space — and `BOUND_MARGIN` is what actually carries the
 * safety.
 */
export function peakGainBound(sections: readonly BiquadSection[]): PeakGainBound {
  let radius = 0;
  for (const section of sections) radius = Math.max(radius, poleRadius(section));
  // A pole on or outside the unit circle has no finite L1 norm. The cookbook
  // cannot produce one for a peaking section with positive Q, but saying so is
  // cheaper than discovering it as an infinite loop.
  if (!(radius < 1)) {
    // Fail closed. An unstable pole means no bound was established, and the
    // caller divides by this — so Infinity drives the headroom scale to zero
    // and the output to silence. Answering unity here would remove the
    // attenuation at exactly the moment nothing is known about the peak.
    return {
      bound: Infinity,
      truncatedSum: Infinity,
      tailEstimate: Infinity,
      margin: BOUND_MARGIN,
      radius,
      frames: 0,
    };
  }

  // Long enough for the remainder to be tiny: r^frames <= 1e-12, capped so a
  // very resonant section cannot ask for an unbounded allocation.
  const wanted = Math.ceil(Math.log(1e-12) / Math.log(Math.max(radius, 1e-9)));
  const frames = Math.min(Math.max(wanted, 256), 1 << 20);

  const impulse = new Float64Array(frames);
  impulse[0] = 1;
  for (const section of sections) filterInPlace(section, impulse);

  let truncatedSum = 0;
  for (let i = 0; i < frames; i++) truncatedSum += Math.abs(impulse[i]);

  // Anchor the geometric tail on the largest magnitude in the last stretch of
  // the window rather than on the final sample alone, which can land near a
  // zero crossing of a ringing response and understate the remainder.
  let anchor = 0;
  for (let i = Math.max(0, frames - 64); i < frames; i++) {
    anchor = Math.max(anchor, Math.abs(impulse[i]));
  }
  const tailEstimate = (anchor * radius) / (1 - radius);

  return {
    bound: (truncatedSum + tailEstimate) * BOUND_MARGIN,
    truncatedSum,
    tailEstimate,
    margin: BOUND_MARGIN,
    radius,
    frames,
  };
}

/**
 * The three notch frequencies the graph places, for a given configuration.
 *
 * Mirrors `updateNotchFrequencies` in `graph.ts`, including its 20 Hz floor.
 * Duplicated deliberately: this module must model what the graph *does*, and
 * importing the graph would drag a whole `AudioContext` into a pure module.
 * The two are pinned together by a test.
 */
export function notchFrequencies(carrierHz: number, modulationHz: number): number[] {
  return [carrierHz - modulationHz, carrierHz, carrierHz + modulationHz].map((f) =>
    Math.max(20, f),
  );
}

/** The chain `graph.ts` builds, as sections. */
export function notchChain(
  carrierHz: number,
  modulationHz: number,
  notchQ: number,
  notchDepthDb: number,
  sampleRate: number,
): BiquadSection[] {
  return notchFrequencies(carrierHz, modulationHz).map((f) =>
    peakingSection(f, notchQ, -Math.abs(notchDepthDb), sampleRate),
  );
}

/**
 * Cached peak-gain bound for a notch configuration.
 *
 * `refreshHeadroom` reaches this on every parameter and soundscape change, so
 * it runs while a slider is being dragged. The computation is 0.1–4 ms
 * depending on how resonant the chain is — fine once, wasteful sixty times a
 * second on the same value, hence the cache. Bounded, because a drag produces
 * a new key per pixel and an unbounded map would grow for the life of the
 * session.
 */
const boundCache = new Map<string, number>();
export const BOUND_CACHE_LIMIT = 512;

/**
 * What to report when the bound is not a usable number.
 *
 * Its own function because it is a *policy*, and the policy is the part that
 * can be silently wrong. A safety ceiling that answers "1" when it could not
 * establish a bound has removed its own attenuation at exactly the moment
 * nothing is known — which is what the first version of this did.
 *
 * - Infinity is passed through. The caller divides the master gain by this, so
 *   Infinity yields silence, which is the correct answer for an unbounded peak.
 * - NaN becomes Infinity. It cannot be passed through, because every
 *   comparison with NaN is false and it would make each downstream guard
 *   permissive rather than conservative.
 * - Anything under 1 is raised to 1: a bound below unity would let the headroom
 *   scale *raise* the master, the opposite of what it exists to do.
 */
export function failClosedBound(bound: number): number {
  if (Number.isNaN(bound)) return Infinity;
  return Math.max(1, bound);
}

export function notchPeakGain(
  carrierHz: number,
  modulationHz: number,
  notchQ: number,
  notchDepthDb: number,
  sampleRate: number,
): number {
  const key = `${carrierHz}|${modulationHz}|${notchQ}|${notchDepthDb}|${sampleRate}`;
  const cached = boundCache.get(key);
  if (cached !== undefined) return cached;

  const { bound } = peakGainBound(
    notchChain(carrierHz, modulationHz, notchQ, notchDepthDb, sampleRate),
  );

  const safe = failClosedBound(bound);

  if (boundCache.size >= BOUND_CACHE_LIMIT) boundCache.clear();
  boundCache.set(key, safe);
  return safe;
}

/**
 * Shortest and longest a bed crossfade may run.
 *
 * The floor keeps a handover a fade rather than a splice even where the filter
 * settles almost immediately; the cap stops the most resonant corner of the
 * space from turning a control into a quarter-second morph.
 */
export const MIN_BED_CROSSFADE_SECONDS = 0.02;
export const MAX_BED_CROSSFADE_SECONDS = 0.25;

/**
 * Residual at which a fresh chain is treated as having caught up.
 *
 * Calibrated against measurement rather than assumed. Comparing a zero-state
 * chain against a settled one over pink noise, the point where the difference
 * falls under 1% of signal RMS is 25 ms at fc 220 / Q 8 / -6 dB and 118 ms at
 * fc 80 / Q 20 / -18 dB. A geometric estimate from the pole radius at this
 * residual gives 39 ms and 221 ms — conservative in every case measured, and
 * the floor above covers the two where it would otherwise fall slightly short.
 */
const SETTLE_RESIDUAL = 0.02;

const settleCache = new Map<string, number>();

/**
 * How long a fresh notch chain needs before it matches a settled one.
 *
 * A chain built from zero state has not yet accumulated the response that
 * carves its notch, so it initially passes what it is meant to cut. Handing
 * over faster than this leaves the slot briefly filled in — audible on every
 * change, and continuous during a drag, where the chain never settles at all.
 */
export function notchSettleSeconds(
  carrierHz: number,
  modulationHz: number,
  notchQ: number,
  notchDepthDb: number,
  sampleRate: number,
): number {
  const key = `${carrierHz}|${modulationHz}|${notchQ}|${notchDepthDb}|${sampleRate}`;
  const cached = settleCache.get(key);
  if (cached !== undefined) return cached;

  let radius = 0;
  for (const section of notchChain(carrierHz, modulationHz, notchQ, notchDepthDb, sampleRate)) {
    radius = Math.max(radius, poleRadius(section));
  }
  const frames = radius > 0 && radius < 1 ? Math.log(SETTLE_RESIDUAL) / Math.log(radius) : 0;
  const seconds = Math.min(
    MAX_BED_CROSSFADE_SECONDS,
    Math.max(MIN_BED_CROSSFADE_SECONDS, frames / sampleRate),
  );

  if (settleCache.size >= BOUND_CACHE_LIMIT) settleCache.clear();
  settleCache.set(key, seconds);
  return seconds;
}
