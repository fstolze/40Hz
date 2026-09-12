<script lang="ts">
  import Slider from './Slider.svelte';
  import Segmented from './Segmented.svelte';
  import { engine } from '../lib/engine.svelte.ts';
  import type { TwoToneMode } from '../../audio/dsp/entrainment-core.ts';
  import { hz, gainToDb } from '../lib/format.ts';
  import { STEREO_REMEDY } from '../../integrity/rules.ts';

  const params = $derived(engine.params);
  const off = $derived(params.twoToneMode === 'off');

  /**
   * The beat rate as copy.
   *
   * From the control rather than from the app's name: modulation is a slider,
   * and the note below claimed 40 Hz whatever it was set to.
   */
  const beatRate = $derived(hz(params.modulationHz));

  // Only dichotic routing puts one tone in each ear. Under diotic both tones
  // reach both ears, so naming them Left and Right would describe a signal the
  // engine is not producing.
  const toneLabels = $derived(
    params.twoToneMode === 'dichotic' ? ['Left', 'Right'] : ['Lower', 'Upper'],
  );

  const modeOptions = [
    { value: 'off' as const, label: 'Off', title: 'Two-tone path disabled' },
    {
      value: 'dichotic' as const,
      label: 'Binaural',
      title: 'One tone per ear — the beat is computed in the brainstem',
    },
    {
      value: 'diotic' as const,
      label: 'Monaural',
      title: 'Both tones to both ears — the beat is physically in the signal',
    },
  ];
</script>

<Segmented
  label="Routing"
  options={modeOptions}
  value={params.twoToneMode}
  onchange={(v: TwoToneMode) => engine.setParams({ twoToneMode: v })}
/>

<!--
  Derived, not adjustable: these are consequences of the carrier and the
  modulation, and a slider here would be a second way to set them.

  Shown while Off as well, for the same reason the level below is disabled
  rather than hidden. Hiding them made Off a structurally different layer:
  the block changed height as routing changed, so every control under it
  moved, and the user could not see what the two tones would be before
  committing to turning the layer on. They are still true while Off — the
  carrier and the modulation are set — so the honest treatment is to show
  them and say they are silent.
-->
<dl class="tones" class:silent={off}>
  <div>
    <dt>{toneLabels[0]}</dt>
    <dd class="mono">{hz(params.carrierHz)}</dd>
  </div>
  <div>
    <dt>{toneLabels[1]}</dt>
    <dd class="mono">{hz(params.carrierHz + params.modulationHz)}</dd>
  </div>
</dl>

<!--
  Present while Off, and disabled rather than hidden.

  Routing is the only thing that decides whether this layer sounds, so there is
  no separate enable switch to disagree with it. The level stays readable so
  the user can see what it will be when they turn the layer back on, and its
  value is never reset behind their back.
-->
<Slider
  label="Two-tone level"
  value={params.twoToneGain}
  min={0}
  max={0.6}
  step={0.005}
  disabled={off}
  display={gainToDb(params.twoToneGain)}
  hint={off ? 'Routing is Off, so this layer is silent.' : undefined}
  onchange={(v) => engine.setParams({ twoToneGain: v })}
/>

<!--
  The guidance comes after the controls, deliberately.

  It used to sit between Routing and everything else, so choosing Binaural
  pushed the tone readouts and the level down the panel — the message was
  unmissable and the controls it applied to were not. Now the controls keep
  their place and the requirement sits beneath them, in one line that is always
  readable, with the full production explanation behind a native disclosure.

  Informational, not a warning: headphones are a playback condition, not a
  hazard, and spending the warning colour here makes a real warning mean less.
-->
{#if params.twoToneMode === 'dichotic'}
  <div class="guidance">
    <p class="lead">
      <strong>Headphones required.</strong> Binaural is the weaker path — roughly 3 dB of effective depth
      against up to 50 dB for the pulse.
    </p>
    <details>
      <summary>Why?</summary>
      <p>
        The {beatRate} modulation exists nowhere in the acoustic signal — it is computed from the interaural
        phase difference. Over speakers, or through anything that combines the channels, the tones sum
        into an ordinary monaural beat instead, and nothing here can tell that it happened. {STEREO_REMEDY}
      </p>
    </details>
  </div>
{:else if params.twoToneMode === 'diotic'}
  <div class="guidance">
    <p class="lead">
      Both tones reach each ear, so the beat is present in the waveform. Works on speakers.
    </p>
  </div>
{/if}

<style>
  .guidance {
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
    background: var(--signal-soft);
    border: 1px solid var(--signal-strong);
    border-radius: var(--radius);
    padding: 8px 10px;
  }

  .guidance .lead {
    margin: 0;
  }

  .guidance strong {
    color: var(--signal);
  }

  /* Native, so it is keyboard operable and expandable without any script. */
  /*
   * A standalone control on its own line, so it takes the same 36px floor as
   * every other control in the recipe — in both directions. Centred rather
   * than padded at the top so the text stays where it reads.
   *
   * `min-height` alone was not that floor: "Why?" is about 29px wide and
   * `width: max-content` sized the box to it exactly, so the target measured
   * 29×36 while this comment claimed 36. `min-width` extends the box to the
   * right of the text rather than around it, because the content is laid out
   * from the start of the flex line — so the label stays exactly where it was
   * and only the reachable area grows. A longer label would still win, since
   * `max-content` is the larger of the two.
   */
  .guidance summary {
    display: flex;
    align-items: center;
    min-height: 36px;
    min-width: 36px;
    cursor: pointer;
    color: var(--signal);
    width: max-content;
    border-radius: 4px;
  }

  .guidance details p {
    margin: 6px 0 0;
  }

  .tones {
    display: flex;
    gap: 8px;
    margin: 0;
  }

  .tones > div {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 10px;
  }

  /*
   * Silent, not unreadable.
   *
   * Disabled values must remain readable: this recedes to say the tones are
   * not sounding, and stops well short of the greying-out that would make the
   * figures hard to read. Only the surface changes; the ink keeps its normal
   * contrast.
   */
  .tones.silent > div {
    background: transparent;
    border-style: dashed;
  }

  dt {
    font-size: 11px;
    color: var(--text-faint);
  }

  dd {
    margin: 0;
    font-size: 13px;
  }
</style>
