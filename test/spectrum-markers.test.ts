/**
 * Where the spectrum's frequency markers land, at the corners that matter.
 *
 * The default configuration is the easy case and the one the design is
 * reviewed on. The interesting cases are the admitted extremes: a carrier low
 * enough that its lower sideband folds around zero, a modulation small enough
 * that all three coincide, a carrier at exactly half the modulation so two
 * components land on one frequency, and widths narrow enough that a label
 * would hang off the plot.
 *
 * The folding numbers here are measured, not derived. Rendering the production
 * engine at a 20 Hz carrier with 200 Hz modulation and probing the result puts
 * 0.290 at 180 Hz and 0.290 at 220 Hz, and nothing at 200 or 240 — so the
 * lower sideband is at |fc − fm|, and an earlier version of this module that
 * treated the difference as signed drew no rule where the strongest peak was.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  SPECTRUM_MAX_HZ,
  SPECTRUM_MIN_HZ,
  captionFor,
  formatHz,
  freqToX,
  spectrumAnnotation,
} from '../src/audio/analysis/spectrum-markers.ts';

/** A stand-in for canvas text measurement: roughly 7px per character. */
const measure = (text: string) => text.length * 7;
const WIDTH = 800;

describe('the default configuration', () => {
  const annotation = spectrumAnnotation({ carrierHz: 220, modulationHz: 40 }, WIDTH, measure);

  it('marks the two sidebands and the carrier by frequency', () => {
    expect(annotation.markers.map((m) => m.label).join(' ')).toBe('180 Hz 220 Hz 260 Hz');
  });

  it('places them left to right in frequency order', () => {
    const [low, carrier, high] = annotation.markers;
    expect(low.x < carrier.x).toBe(true);
    expect(carrier.x < high.x).toBe(true);
  });

  it('positions each rule with the same mapping the trace uses', () => {
    for (const marker of annotation.markers) {
      expect(Math.round(marker.x)).toBe(Math.round(freqToX(marker.freq, WIDTH)));
    }
  });

  it('staggers the carrier out of the sidebands’ row', () => {
    // The approved treatment: the outer two share a row and the middle one,
    // which overlaps both, drops below. Asserted as an outcome of the rules
    // rather than as a special case, so it keeps holding as spacing changes.
    const [low, carrier, high] = annotation.markers;
    expect(low.row).toBe(0);
    expect(high.row).toBe(0);
    expect(carrier.row).toBe(1);
    expect(annotation.rows).toBe(2);
  });

  it('omits nothing and groups nothing', () => {
    expect(annotation.omitted.length).toBe(0);
    expect(annotation.grouped).toBe(false);
  });

  it('states the carrier and the offset without symbolic notation', () => {
    expect(annotation.caption.includes('±40 Hz')).toBe(true);
    expect(annotation.caption.includes('220 Hz carrier')).toBe(true);
    // The notation this replaced.
    expect(annotation.caption.includes('fc')).toBe(false);
  });
});

describe('labels that would fall outside the plot', () => {
  it('never lets a label box leave the canvas', () => {
    // A carrier at the very top of the admitted range pushes its labels hard
    // against the right edge.
    const annotation = spectrumAnnotation({ carrierHz: 8000, modulationHz: 200 }, WIDTH, measure);
    for (const marker of annotation.markers) {
      const half = measure(marker.label) / 2;
      expect(marker.labelX - half >= -0.01).toBe(true);
      expect(marker.labelX + half <= WIDTH + 0.01).toBe(true);
    }
  });

  it('keeps every rule inside the plot even when the label is nudged', () => {
    const annotation = spectrumAnnotation({ carrierHz: 8000, modulationHz: 200 }, WIDTH, measure);
    for (const marker of annotation.markers) {
      expect(marker.x >= 0 && marker.x <= WIDTH).toBe(true);
    }
  });
});

describe('a lower sideband that folds around zero', () => {
  // A one-sided spectrum puts a negative-frequency component at its magnitude.
  const annotation = spectrumAnnotation({ carrierHz: 20, modulationHz: 200 }, WIDTH, measure);

  it('marks it at |fc − fm|, where the energy actually is', () => {
    expect(annotation.markers.some((m) => m.freq === 180)).toBe(true);
    expect(annotation.markers.some((m) => m.freq < 0)).toBe(false);
  });

  it('marks the upper sideband too, so both visible peaks are named', () => {
    expect(annotation.markers.map((m) => m.freq).join(',')).toBe('180,220');
  });

  it('omits only the carrier, which really is below the plotted floor', () => {
    expect(annotation.omitted.join(',')).toBe('20');
  });

  it('orders the rules by displayed frequency, not by role', () => {
    // Folding reorders them: the carrier at 20 Hz is below the lower sideband
    // at 180 Hz, so a list built in carrier-then-sideband order would place
    // labels left to right in the wrong sequence.
    const xs = annotation.markers.map((m) => m.x);
    expect(xs[0] < xs[1]).toBe(true);
  });

  it('says in the caption that the lower sideband folded, and where', () => {
    expect(annotation.caption.includes('folding to 180 Hz')).toBe(true);
    expect(annotation.caption.includes('Rules mark 180 Hz and 220 Hz')).toBe(true);
    expect(annotation.caption.includes('the 20 Hz carrier is below the plotted range')).toBe(true);
  });
});

describe('components that land on the same frequency', () => {
  // A carrier at exactly half the modulation folds the lower sideband onto it.
  const annotation = spectrumAnnotation({ carrierHz: 100, modulationHz: 200 }, WIDTH, measure);

  it('draws one rule rather than two on top of each other', () => {
    expect(annotation.markers.map((m) => m.freq).join(',')).toBe('100,300');
  });

  it('keeps the carrier role, so the shared rule stays solid', () => {
    expect(annotation.markers[0].role).toBe('carrier');
  });
});

describe('frequencies that cannot be drawn', () => {
  it('drops a component at exactly zero rather than mapping it to −Infinity', () => {
    // Equal carrier and modulation fold the lower sideband onto 0 Hz, whose
    // logarithm has no position at all.
    const annotation = spectrumAnnotation({ carrierHz: 50, modulationHz: 50 }, WIDTH, measure);
    expect(annotation.omitted.join(',')).toBe('0');
    expect(annotation.markers.every((m) => Number.isFinite(m.x))).toBe(true);
  });

  it('omits anything below the plotted floor and names it in the caption', () => {
    // Reachable with the UI's own sliders: carrier at its floor, modulation at
    // its ceiling, putting the lower sideband at 20 Hz.
    const annotation = spectrumAnnotation({ carrierHz: 80, modulationHz: 60 }, WIDTH, measure);
    expect(annotation.markers.map((m) => m.freq).join(',')).toBe('80,140');
    expect(annotation.omitted.join(',')).toBe('20');
    expect(annotation.caption.includes('the 20 Hz sideband is below the plotted range')).toBe(true);
  });

  it('says so plainly when none of them can be drawn', () => {
    const caption = captionFor({ carrierHz: 20, modulationHz: 0.5 });
    expect(caption.includes('None of them fall inside the plotted range')).toBe(true);
  });

  it('treats a non-finite frequency as undrawable rather than crashing', () => {
    const annotation = spectrumAnnotation(
      { carrierHz: Number.NaN, modulationHz: 40 },
      WIDTH,
      measure,
    );
    expect(annotation.markers.length).toBe(0);
    expect(annotation.omitted.length).toBe(3);
  });
});

describe('markers too close to separate', () => {
  const annotation = spectrumAnnotation({ carrierHz: 8000, modulationHz: 0.5 }, WIDTH, measure);

  it('collapses them into one readable label', () => {
    // 7999.5, 8000 and 8000.5 are a fraction of a pixel apart on a log axis.
    // Three stacked near-identical numbers over one rule reads as a rendering
    // fault, so the defined treatment is to merge them.
    expect(annotation.grouped).toBe(true);
    expect(annotation.rows).toBe(1);
    expect(new Set(annotation.markers.map((m) => m.label)).size).toBe(1);
  });

  it('still names every frequency in the one label', () => {
    const label = annotation.markers[0].label;
    expect(label.includes('7999.5')).toBe(true);
    expect(label.includes('8000')).toBe(true);
    expect(label.includes('8000.5')).toBe(true);
  });

  it('keeps a rule for each of them', () => {
    expect(annotation.markers.length).toBe(3);
  });
});

describe('the shared mapping', () => {
  it('puts the range ends at the plot edges', () => {
    expect(Math.round(freqToX(SPECTRUM_MIN_HZ, WIDTH))).toBe(0);
    expect(Math.round(freqToX(SPECTRUM_MAX_HZ, WIDTH))).toBe(WIDTH);
  });

  it('is logarithmic, so equal ratios are equal distances', () => {
    // A decade is a decade wherever it sits, which is the property the axis
    // labels and the markers both depend on.
    const first = freqToX(1000, WIDTH) - freqToX(100, WIDTH);
    const second = freqToX(10000, WIDTH) - freqToX(1000, WIDTH);
    expect(Math.abs(first - second) < 0.001).toBe(true);
  });
});

describe('formatting a frequency', () => {
  it('shows whole numbers without a decimal point', () => {
    expect(formatHz(220)).toBe('220');
  });

  it('keeps one decimal for the fractional values the range admits', () => {
    // 0.5 Hz modulation is admitted, so half-hertz sidebands are reachable.
    expect(formatHz(19.5)).toBe('19.5');
  });
});

describe('a plot with no width yet', () => {
  it('produces nothing rather than dividing by zero', () => {
    // A canvas read immediately after a resize can report zero.
    const annotation = spectrumAnnotation({ carrierHz: 220, modulationHz: 40 }, 0, measure);
    expect(annotation.markers.length).toBe(0);
    expect(annotation.rows).toBe(0);
  });
});
