/**
 * Amplitude-modulation envelope for the entrainment carrier.
 *
 * The source specification treats isochronic tones, raised-cosine pulses and
 * square pulses as separate paradigms. They are one Tukey-windowed pulse at
 * three points in a two-parameter space:
 *
 *   duty = 1.0, edge = 1.0  ->  sin^2(pi * phase), i.e. sinusoidal AM
 *   duty = 0.5, edge = 0.5  ->  raised-cosine isochronic (the recommended default)
 *   duty = 0.5, edge = 0.0  ->  square isochronic (maximum depth, click artifacts)
 */

/**
 * Tukey-windowed pulse occupying `duty` of the period, with cosine tapers
 * covering `edge` of the pulse width.
 *
 * @param phase Position within the modulation period, in [0, 1).
 * @param duty  Pulse width as a fraction of the period, in (0, 1].
 * @param edge  Tukey taper fraction, in [0, 1]. 0 is a hard square transition.
 * @returns Envelope value in [0, 1].
 */
export function pulseEnvelope(phase: number, duty: number, edge: number): number {
  if (phase >= duty) return 0;
  if (edge <= 0) return 1;

  const t = phase / duty; // position within the pulse, in [0, 1)
  const half = edge / 2;

  if (t < half) return 0.5 * (1 - Math.cos((Math.PI * t) / half));
  if (t > 1 - half) return 0.5 * (1 - Math.cos((Math.PI * (1 - t)) / half));
  return 1;
}

/**
 * Envelope scaled by modulation depth.
 *
 * depth = 0 leaves the carrier unmodulated (constant gain of 1); depth = 1
 * applies the full envelope, reaching zero between pulses.
 */
export function modulatorGain(phase: number, duty: number, edge: number, depth: number): number {
  return 1 - depth + depth * pulseEnvelope(phase, duty, edge);
}

/** Named points in the (duty, edge) space, for presets and UI labels. */
export const ENVELOPE_SHAPES = {
  /** Smooth sinusoidal AM. Carrier plus sidebands at fc +/- fMod. */
  sine: { duty: 1.0, edge: 1.0 },
  /** The specification's recommended isochronic pulse. */
  raisedCosine: { duty: 0.5, edge: 0.5 },
  /** Maximum contrast. Harsh, and generates broadband transients. */
  square: { duty: 0.5, edge: 0.0 },
} as const;

export type EnvelopeShapeName = keyof typeof ENVELOPE_SHAPES;
