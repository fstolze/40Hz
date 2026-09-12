<script lang="ts">
  import Slider from './Slider.svelte';
  import Segmented from './Segmented.svelte';
  import { engine } from '../lib/engine.svelte.ts';
  import type { NoiseColor } from '../../audio/dsp/noise.ts';
  import { hz, gainToDb } from '../lib/format.ts';

  const scape = $derived(engine.soundscape);
  const params = $derived(engine.params);

  const colorOptions = [
    { value: 'pink' as const, label: 'Pink', title: '−3 dB/octave — matches the ear’s response' },
    { value: 'brown' as const, label: 'Brown', title: '−6 dB/octave — darker, less hiss' },
    {
      value: 'white' as const,
      label: 'White',
      title: 'Flat — bright and fatiguing over long sessions',
    },
  ];

  /** Ratio of the tone's gain to the bed's gain, in dB — gains, not heard levels. */
  const snrDb = $derived.by(() => {
    const signal = Math.max(params.amGain, params.twoToneGain);
    if (signal <= 0.0001 || scape.gain <= 0.0001) return null;
    return 20 * Math.log10(signal / scape.gain);
  });
</script>

<Segmented
  label="Colour"
  options={colorOptions}
  value={scape.color}
  onchange={(v: NoiseColor) => engine.setSoundscape({ color: v })}
/>

<Slider
  label="Soundscape level"
  value={scape.gain}
  min={0}
  max={0.8}
  step={0.005}
  display={gainToDb(scape.gain)}
  onchange={(v) => engine.setSoundscape({ gain: v })}
/>

<Slider
  label="Notch depth"
  value={scape.notchDepthDb}
  min={0}
  max={18}
  step={0.5}
  display={`−${scape.notchDepthDb.toFixed(1)} dB`}
  hint={`Cut at ${hz(params.carrierHz - params.modulationHz)}, ${hz(params.carrierHz)} and ${hz(params.carrierHz + params.modulationHz)}.`}
  onchange={(v) => engine.setSoundscape({ notchDepthDb: v })}
/>

<Slider
  label="Notch Q"
  value={scape.notchQ}
  min={1}
  max={20}
  step={0.5}
  display={scape.notchQ.toFixed(1)}
  hint="Higher Q carves narrower slots and leaves more of the bed intact."
  onchange={(v) => engine.setSoundscape({ notchQ: v })}
/>

{#if snrDb !== null}
  <div class="snr">
    <span>Tone/bed gain ratio</span>
    <strong class="mono" class:masked={snrDb < -6}>
      {snrDb > 0 ? '+' : ''}{snrDb.toFixed(1)} dB
    </strong>
  </div>
  {#if snrDb < -6}
    <p class="hint">Below the bed — the tone should be hard to notice consciously.</p>
  {/if}
{/if}

<style>
  .snr {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 8px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 12px;
    color: var(--text-dim);
  }

  .snr strong {
    font-size: 13px;
    color: var(--text);
  }

  .snr strong.masked {
    color: var(--soundscape);
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-faint);
    line-height: 1.4;
  }
</style>
