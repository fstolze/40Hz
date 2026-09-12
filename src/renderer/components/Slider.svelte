<script lang="ts" module>
  let counter = 0;
  function nextId(): number {
    counter += 1;
    return counter;
  }
</script>

<script lang="ts">
  /**
   * A track that is not the value, for a control whose useful resolution is not
   * linear in what it sets.
   *
   * `min`, `max` and `step` always describe the **track** — what the input actually
   * moves along — and this says how a track position maps to and from the value
   * the caller cares about. Without one the two are the same thing, which is
   * every other slider in the product.
   */
  interface Scale {
    toTrack: (value: number) => number;
    fromTrack: (track: number) => number;
  }

  interface Props {
    label: string;
    value: number;
    /** In track units. See `Scale` — for an unscaled slider they are value units. */
    min: number;
    max: number;
    step?: number;
    /** Rendered readout; falls back to two decimals. */
    display?: string;
    scale?: Scale;
    hint?: string;
    disabled?: boolean;
    onchange: (value: number) => void;
  }

  let {
    label,
    value,
    min,
    max,
    step = 0.01,
    display,
    scale,
    hint,
    disabled = false,
    onchange,
  }: Props = $props();

  const readout = $derived(display ?? value.toFixed(2));
  /*
   * The same reading, punctuated for a voice rather than for an eye.
   *
   * Readouts that carry two facts separate them with a middle dot — "220.0 Hz
   * · A3" — which is right on screen and is not a word. What a screen reader
   * makes of it varies by reader and by verbosity setting, from a pause to
   * "dot" read aloud. A comma is unambiguous punctuation in every one of them,
   * and swapping it here rather than passing a second string keeps one source
   * of truth: the announcement cannot drift from what is on screen.
   */
  const spoken = $derived(readout.replace(/ · /g, ', '));
  const track = $derived(scale === undefined ? value : scale.toTrack(value));

  /*
   * A unique id per instance, not one derived from the label.
   *
   * Three sliders were labelled "Level" — one per sound layer — so all three
   * rendered `id="slider-Level"`. Duplicate ids mean the label points at
   * whichever came first, so two of the three had no working label at all, and
   * clicking their text focused a control in another layer. The approved
   * design also renames them, but the id must not depend on copy staying
   * unique.
   */
  const uid = `slider-${nextId()}`;
  const hintId = `${uid}-hint`;
</script>

<div class="row" class:disabled>
  <div class="head">
    <label for={uid}>{label}</label>
    <span class="value mono">{readout}</span>
  </div>
  <!--
    The readout is the accessible value, on every slider rather than only the
    scaled one.

    A range input announces itself from its own number, which for a scaled
    control is a track coordinate — "-1200 of 1422" for a carrier at 220 Hz.
    But it was never right unscaled either: the levels announced "0.5" while
    displaying "-6.0 dB", and Duty announced "0.5" for "50%". Pointing the
    announcement at the same string a sighted user reads is what stops the two
    being different answers.
  -->
  <input
    id={uid}
    aria-describedby={hint ? hintId : undefined}
    type="range"
    {min}
    {max}
    {step}
    {disabled}
    value={track}
    aria-valuetext={spoken}
    oninput={(e) => {
      const moved = Number(e.currentTarget.value);
      onchange(scale === undefined ? moved : scale.fromTrack(moved));
    }}
  />
  {#if hint}
    <!-- Linked rather than merely adjacent, so the explanation reaches a
         screen reader with the control it explains. -->
    <p class="hint" id={hintId}>{hint}</p>
  {/if}
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /*
   * Dimmed part by part, never as a group.
   *
   * A blanket opacity takes the label and the current value down with the
   * control, and a level the user cannot read is worse than one they cannot
   * move — when Two-tone routing is Off they still need to see what its level
   * is set to. Each piece gets a token that stays readable instead.
   */
  .row.disabled label,
  .row.disabled .value,
  .row.disabled .hint {
    color: var(--text-disabled);
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }

  label {
    color: var(--text-dim);
    font-size: 13px;
  }

  .value {
    font-size: 12px;
    color: var(--text);
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-faint);
    line-height: 1.4;
  }
</style>
