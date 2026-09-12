<script lang="ts">
  import Slider from './Slider.svelte';
  import Segmented from './Segmented.svelte';
  import Tuner from './Tuner.svelte';
  import { engine } from '../lib/engine.svelte.ts';
  import { ENVELOPE_SHAPES, type EnvelopeShapeName } from '../../audio/dsp/envelope.ts';
  import { noteName, hz, gainToDb, percent, ms } from '../lib/format.ts';
  import {
    CARRIER_TRACK_MAX,
    CARRIER_TRACK_MIN,
    CARRIER_TRACK_STEP,
    carrierHzFromTrack,
    carrierTrackFromHz,
    clampCarrierHz,
  } from '../../audio/tuning.ts';

  const params = $derived(engine.params);

  /** Which named shape the current duty/edge corresponds to, if any. */
  const activeShape = $derived.by((): EnvelopeShapeName | 'custom' => {
    for (const [name, shape] of Object.entries(ENVELOPE_SHAPES)) {
      if (Math.abs(shape.duty - params.duty) < 1e-6 && Math.abs(shape.edge - params.edge) < 1e-6) {
        return name as EnvelopeShapeName;
      }
    }
    return 'custom';
  });

  const shapeOptions = [
    {
      value: 'sine' as const,
      label: 'Sine',
      title: 'Sinusoidal AM — smoothest, carrier plus two sidebands',
    },
    {
      value: 'raisedCosine' as const,
      label: 'Raised cos',
      title: 'Tapered isochronic pulse — the recommended default',
    },
    {
      value: 'square' as const,
      label: 'Square',
      title: 'Hard gating — maximum depth, harsh, wide sidebands',
    },
  ];

  const periodMs = $derived(1000 / params.modulationHz);
  const pulseMs = $derived(periodMs * params.duty);
  /** Taper covers `edge` of the pulse, split between its two ends. */
  const taperMs = $derived((pulseMs * params.edge) / 2);

  function applyShape(name: EnvelopeShapeName) {
    engine.setParams(ENVELOPE_SHAPES[name]);
  }
</script>

<!--
  Two tracks above 1360px, one below.

  Entrainment carries seven controls against three and four in the other two
  layers, so as a single column it set the height of the whole recipe and left
  its own column half empty at the widest windows. The tuner is the piece that
  moves: it is a self-contained instrument rather than another parameter row,
  and it reads as one beside the parameters instead of interrupting them.

  DOM order is the visual order in both layouts — the parameters, then the
  tuner — so the tab order does not change with the window width, and nobody
  gets a focus ring that jumps backwards up the panel. That is the reason the
  tuner sits after the track here rather than next to Carrier: an `order` or a
  grid-placement trick would have put the two orders out of step at exactly one
  width, which is the kind of thing only a keyboard user discovers.
-->
<div class="entrainment">
  <div class="track">
    <Slider
      label="Modulation"
      value={params.modulationHz}
      min={20}
      max={60}
      step={0.5}
      display={hz(params.modulationHz, 1)}
      hint={params.modulationHz === 40
        ? 'Period 25 ms. Gamma band.'
        : `Period ${periodMs.toFixed(1)} ms. 40 Hz is the researched gamma target.`}
      onchange={(v) => engine.setParams({ modulationHz: v })}
    />

    <Slider
      label="Carrier"
      value={params.carrierHz}
      min={CARRIER_TRACK_MIN}
      max={CARRIER_TRACK_MAX}
      step={CARRIER_TRACK_STEP}
      scale={{ toTrack: carrierTrackFromHz, fromTrack: carrierHzFromTrack }}
      display={`${hz(params.carrierHz, 1)} · ${noteName(params.carrierHz)}`}
      hint={`Sidebands at ${hz(params.carrierHz - params.modulationHz)} and ${hz(params.carrierHz + params.modulationHz)}.`}
      onchange={(v) => engine.setParams({ carrierHz: clampCarrierHz(v) })}
    />

    <div class="shape">
      <Segmented
        label="Envelope shape"
        options={shapeOptions}
        value={activeShape === 'custom' ? ('' as never) : activeShape}
        onchange={applyShape}
      />
      {#if activeShape === 'custom'}
        <span class="custom-tag">custom</span>
      {/if}
    </div>

    <Slider
      label="Duty"
      value={params.duty}
      min={0.05}
      max={1}
      display={`${percent(params.duty)} · ${ms(pulseMs)}`}
      hint="Fraction of each period the pulse occupies."
      onchange={(v) => engine.setParams({ duty: v })}
    />

    <Slider
      label="Edge"
      value={params.edge}
      min={0}
      max={1}
      display={params.edge === 0 ? 'square' : `${percent(params.edge)} · ${ms(taperMs)}`}
      hint={params.edge === 0
        ? 'Hard transition. Generates broadband transients heard as clicks.'
        : 'Cosine taper as a fraction of the pulse width.'}
      onchange={(v) => engine.setParams({ edge: v })}
    />

    <Slider
      label="Depth"
      value={params.depth}
      min={0}
      max={1}
      display={percent(params.depth)}
      hint={params.depth === 0 ? 'Unmodulated — no entrainment.' : undefined}
      onchange={(v) => engine.setParams({ depth: v })}
    />

    <Slider
      label="Entrainment level"
      value={params.amGain}
      min={0}
      max={0.6}
      step={0.005}
      display={gainToDb(params.amGain)}
      onchange={(v) => engine.setParams({ amGain: v })}
    />
  </div>

  <div class="tuner-slot">
    <Tuner value={params.carrierHz} onchange={(v) => engine.setParams({ carrierHz: v })} />
  </div>
</div>

<style>
  /* One track by default. The narrow widths need no query and no override. */
  .entrainment {
    display: grid;
    gap: 12px;
  }

  .track {
    display: grid;
    gap: 12px;
    min-width: 0;
  }

  /*
   * 1360px, not 1080px.
   *
   * The recipe goes to three columns at 1080, which leaves Entrainment about
   * 470px — enough for one track and not for two. Measured at 1440 the column
   * is ~578px, so a bounded tuner and a track that still fits a slider label
   * and its value on one line both have room. Below this the two tracks stack
   * in the same order they are read in.
   */
  @media (min-width: 1360px) {
    .entrainment {
      grid-template-columns: minmax(0, 1fr) 186px;
      align-items: start;
      gap: 12px 14px;
    }
  }

  /* Bounded, so a wider window gives the room to the parameters rather than
     stretching a meter that gains nothing from the width. */
  .tuner-slot {
    min-width: 0;
  }

  .shape {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  .shape :global(.group) {
    flex: 1;
  }

  .custom-tag {
    font-size: 11px;
    color: var(--warn);
    padding-bottom: 7px;
    white-space: nowrap;
  }
</style>
