/**
 * Where the spectrum's frequency markers go, and what they say.
 *
 * Pure, and separate from the component, for two reasons. The placement rules
 * — clamping to the plot, staggering labels that would collide, collapsing
 * three that cannot be separated — are the part most likely to be wrong at the
 * edges of the admitted parameter space, and they are far easier to drive into
 * those corners here than through a canvas. And the log mapping has to be
 * *one* function: markers drawn with a mapping of their own would drift from
 * the trace they are annotating, which is a lie that looks like a rounding
 * error.
 *
 * Replaces the previous `−f`, `fc`, `+f` symbols. Those required the reader to
 * know the notation, and `fc` sat on top of its own rule and rendered as
 * `f|c`. The frequencies are what the user is tuning, so the frequencies are
 * what the labels say.
 *
 * These are **spectral references**: where the carrier and its two sidebands
 * actually appear in the plotted signal. They are deliberately *not* the notch
 * targets — `notchFrequencies` floors its three at 20 Hz, so at a 20 Hz
 * carrier with 200 Hz modulation the notches sit at 20, 20 and 220 Hz while
 * the spectrum shows energy at 180 and 220. Annotating a spectrum with filter
 * targets would label lines that are not the lines being drawn.
 */

/**
 * The plotted range.
 *
 * Not the admitted range: `sanitizeParams` allows carriers from 20 Hz to
 * 8 kHz and modulation to 200 Hz, so components reach from 0 Hz to 8.2 kHz.
 * This is the window the trace is drawn in, and a component outside it has no
 * position here — see `omitted`.
 */
export const SPECTRUM_MIN_HZ = 40;
export const SPECTRUM_MAX_HZ = 16000;

/** The one log mapping, shared by the trace, the axis and the markers. */
export function freqToX(
  freq: number,
  width: number,
  minHz = SPECTRUM_MIN_HZ,
  maxHz = SPECTRUM_MAX_HZ,
): number {
  const lo = Math.log10(minHz);
  const hi = Math.log10(maxHz);
  return ((Math.log10(freq) - lo) / (hi - lo)) * width;
}

export interface MarkerParams {
  carrierHz: number;
  modulationHz: number;
}

export type MarkerRole = 'carrier' | 'sideband';

export interface SpectrumMarker {
  /** The frequency this marks, after sanitization. */
  freq: number;
  label: string;
  role: MarkerRole;
  /** Where the rule is drawn. Always inside the plot. */
  x: number;
  /** Centre of the label, clamped so its box stays inside the plot. */
  labelX: number;
  /** Which text row it sits on. 0 is nearest the top. */
  row: number;
}

export interface SpectrumAnnotation {
  markers: SpectrumMarker[];
  /** How many label rows are in use, so the rules know where to start. */
  rows: number;
  /**
   * Frequencies that exist but cannot be drawn, because they fall outside the
   * plotted range. Reported rather than silently dropped: at a 20 Hz carrier
   * with 200 Hz modulation the lower sideband is −180 Hz, and a marker pinned
   * to the left edge would claim a spectral line that is not there.
   */
  omitted: number[];
  /** True when the three were too close to separate and were merged. */
  grouped: boolean;
  caption: string;
}

/** Whole numbers plainly; anything else to one decimal, since 0.5 is admitted. */
export function formatHz(freq: number): string {
  return Number.isInteger(freq) ? `${freq}` : freq.toFixed(1);
}

interface Component {
  freq: number;
  role: MarkerRole;
  /** True when this sideband appears at |fc − fm| because fc < fm. */
  folded: boolean;
}

/**
 * Where the carrier and its sidebands actually appear, from sanitized params.
 *
 * The lower sideband is `Math.abs(carrierHz - modulationHz)`, not the signed
 * difference. A spectrum from an `AudioContext` analyser is one-sided, so a
 * component at a negative frequency appears at its magnitude — and it is not a
 * technicality: measured on the production engine at a 20 Hz carrier with
 * 200 Hz modulation, there is as much energy at 180 Hz as at 220 Hz, and none
 * at all where the signed arithmetic would have put it. Treating the
 * difference as signed meant the chart drew a strong peak while the caption
 * said that frequency was outside the plot.
 *
 * Returned in ascending frequency, because folding can reorder them: at that
 * same configuration the carrier (20 Hz) is *below* the lower sideband
 * (180 Hz), and everything downstream — collision rows, grouping, the caption
 * — assumes left-to-right.
 */
function components(params: MarkerParams): Component[] {
  const { carrierHz, modulationHz } = params;
  const lower = Math.abs(carrierHz - modulationHz);
  const all: Component[] = [
    { freq: lower, role: 'sideband', folded: carrierHz < modulationHz },
    { freq: carrierHz, role: 'carrier', folded: false },
    { freq: carrierHz + modulationHz, role: 'sideband', folded: false },
  ];
  return all.sort((a, b) => a.freq - b.freq);
}

/**
 * Collapse components that land on the same frequency.
 *
 * Reachable whenever the carrier is exactly half the modulation — 100 Hz and
 * 200 Hz put the folded lower sideband on top of the carrier. They are one
 * line in the signal, so they are one rule here; the carrier wins the role, so
 * the rule stays solid rather than dashed.
 */
function dedupe(list: Component[]): Component[] {
  const out: Component[] = [];
  for (const entry of list) {
    const existing = out.find((o) => Math.abs(o.freq - entry.freq) < 1e-9);
    if (existing === undefined) out.push(entry);
    else if (entry.role === 'carrier') existing.role = 'carrier';
  }
  return out;
}

/**
 * Lay the markers out for a plot `width` px wide.
 *
 * `measureLabel` returns the rendered width of a label. Injected because the
 * real answer comes from a canvas and this module must stay runnable in Node —
 * and because the collision rules are exactly what wants testing at made-up
 * widths.
 */
export function spectrumAnnotation(
  params: MarkerParams,
  width: number,
  measureLabel: (text: string) => number,
): SpectrumAnnotation {
  const all = dedupe(components(params));
  const omitted: number[] = [];
  const plottable: Component[] = [];

  for (const entry of all) {
    if (isPlottable(entry.freq)) plottable.push(entry);
    else omitted.push(entry.freq);
  }

  const caption = captionFor(params);
  if (plottable.length === 0 || width <= 0) {
    return { markers: [], rows: 0, omitted, grouped: false, caption };
  }

  const placed = plottable.map((entry) => {
    const label = `${formatHz(entry.freq)} Hz`;
    return {
      ...entry,
      label,
      x: freqToX(entry.freq, width),
      halfWidth: measureLabel(label) / 2,
    };
  });

  /*
   * When they cannot be told apart, say so once.
   *
   * At an 8 kHz carrier with 0.5 Hz modulation the three lie within a fraction
   * of a pixel of each other. Three stacked labels there would be three
   * near-identical numbers stacked over one rule, which reads as a rendering
   * fault rather than as information.
   */
  const spread = placed[placed.length - 1].x - placed[0].x;
  const widest = Math.max(...placed.map((p) => p.halfWidth * 2));
  if (placed.length > 1 && spread < widest * 0.5) {
    const label = `${placed.map((p) => formatHz(p.freq)).join(' · ')} Hz`;
    const centre = (placed[0].x + placed[placed.length - 1].x) / 2;
    const half = measureLabel(label) / 2;
    return {
      markers: placed.map((p) => ({
        freq: p.freq,
        label,
        role: p.role,
        x: clamp(p.x, 0, width),
        labelX: clamp(centre, half, width - half),
        row: 0,
      })),
      rows: 1,
      omitted,
      grouped: true,
      caption,
    };
  }

  /*
   * Otherwise, the lowest row on which the label does not touch one already
   * there. Greedy and left-to-right, which reproduces the approved treatment
   * without encoding it as a special case: the two sidebands take row 0 and
   * the carrier, being between them and overlapping both, drops to row 1.
   */
  const rowsUsed: { left: number; right: number }[][] = [];
  const markers: SpectrumMarker[] = placed.map((p) => {
    const labelX = clamp(p.x, p.halfWidth, Math.max(p.halfWidth, width - p.halfWidth));
    const box = { left: labelX - p.halfWidth, right: labelX + p.halfWidth };

    let row = 0;
    for (;;) {
      const occupants = rowsUsed[row];
      if (occupants === undefined) {
        rowsUsed[row] = [box];
        break;
      }
      // A 4px breathing space, so labels that merely abut still read as two.
      if (occupants.every((other) => box.left >= other.right + 4 || box.right <= other.left - 4)) {
        occupants.push(box);
        break;
      }
      row += 1;
    }

    return {
      freq: p.freq,
      label: p.label,
      role: p.role,
      x: clamp(p.x, 0, width),
      labelX,
      row,
    };
  });

  return { markers, rows: rowsUsed.length, omitted, grouped: false, caption };
}

/**
 * What the panel says beneath the plot.
 *
 * States the relationship, then reconciles it with what is actually drawn.
 * Both halves are needed: the offset is the thing the user is tuning, and the
 * rules are the thing they can see — and at the folding and floor corners
 * those two are not the same sentence.
 */
export function captionFor(params: MarkerParams): string {
  const { carrierHz, modulationHz } = params;
  const all = dedupe(components(params));
  const drawn = all.filter((e) => isPlottable(e.freq));
  const missing = all.filter((e) => !isPlottable(e.freq));
  const folded = all.some((e) => e.folded && isPlottable(e.freq));

  let caption = 'Spectrum of the mix at the master output.';

  if (!Number.isFinite(carrierHz) || !Number.isFinite(modulationHz)) return caption;

  caption += ` Sidebands ±${formatHz(modulationHz)} Hz from the ${formatHz(carrierHz)} Hz carrier`;
  // Said explicitly, because the arithmetic a reader would do in their head
  // gives a negative number and the plot shows a positive one.
  if (folded)
    caption += `, the lower one folding to ${formatHz(Math.abs(carrierHz - modulationHz))} Hz`;
  caption += '.';

  if (missing.length === 0) return caption;
  if (drawn.length === 0) {
    return `${caption} None of them fall inside the plotted range.`;
  }
  return (
    `${caption} Rules mark ${list(drawn.map((e) => `${formatHz(e.freq)} Hz`))};` +
    ` ${list(missing.map(describeMissing))} the plotted range.`
  );
}

/** "the 20 Hz carrier is below" — role and direction, so it can be found. */
function describeMissing(entry: Component): string {
  const where = entry.freq > SPECTRUM_MAX_HZ ? 'above' : 'below';
  const what = entry.role === 'carrier' ? 'carrier' : 'sideband';
  return `the ${formatHz(entry.freq)} Hz ${what} is ${where}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Positive and inside the window.
 *
 * The `> 0` is load-bearing rather than defensive: an equal carrier and
 * modulation put the folded sideband at exactly 0 Hz, whose logarithm is
 * −Infinity, and a marker there would be drawn at negative infinity px.
 */
function isPlottable(freq: number): boolean {
  return Number.isFinite(freq) && freq > 0 && freq >= SPECTRUM_MIN_HZ && freq <= SPECTRUM_MAX_HZ;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
