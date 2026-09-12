<script lang="ts">
  import {
    A4_HZ,
    CARRIER_UI_MAX,
    CARRIER_UI_MIN,
    clampCarrierHz,
    isOnGrid,
    noteAndCents,
    snapToNearestNote,
    stepBySemitones,
  } from '../../audio/tuning.ts';

  interface Props {
    /** The carrier, in Hz. */
    value: number;
    /**
     * Reference pitch. A recording can be at 432 Hz or a historical pitch, and
     * the grid has to follow it or the readout is wrong about that recording.
     * Always user-set; nothing infers it.
     */
    referenceHz?: number;
    onchange: (value: number) => void;
  }

  let { value, referenceHz = A4_HZ, onchange }: Props = $props();

  const reading = $derived(noteAndCents(value, referenceHz));

  /**
   * Needle position across the meter, as a percentage.
   *
   * Cents run -50..+50 between one note and the next, so the reading maps
   * linearly onto the full width with the note itself at the centre.
   */
  const needlePercent = $derived(reading === null ? 50 : 50 + reading.cents);
  /** Rounded only for the readout; nothing decides from this. */
  const displayCents = $derived(reading === null ? 0 : Math.round(reading.cents));
  /** In tune enough to call it aligned. Cosmetic only; nothing depends on it. */
  const centred = $derived(reading !== null && Math.abs(reading.cents) <= 2);

  /**
   * The note buttons, each carrying whether its step is available.
   *
   * A step that would leave the range is *disabled*, never clamped: clamping
   * the frequency of a note lands on a different pitch class, which is the one
   * thing a note-relative control exists to prevent.
   */
  const steps = $derived(
    [
      { label: '−12', semitones: -12, title: 'Down an octave' },
      { label: '−1', semitones: -1, title: 'Down a semitone' },
      { label: '+1', semitones: 1, title: 'Up a semitone' },
      { label: '+12', semitones: 12, title: 'Up an octave' },
    ].map((step) => ({ ...step, next: stepBySemitones(value, step.semitones, referenceHz) })),
  );

  const snapped = $derived(snapToNearestNote(value, referenceHz));
  /**
   * Already on the grid, so there is nothing for Snap to do.
   *
   * From the unrounded deviation: the displayed figure rounds to whole cents,
   * so a carrier a third of a cent sharp reads "in tune" and would disable the
   * one control that would fix it.
   */
  const onGrid = $derived(isOnGrid(value, referenceHz));

  /** Direct entry is frequency-relative, so it clamps rather than refusing. */
  function commitEntry(raw: string): void {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onchange(clampCarrierHz(parsed));
  }
</script>

<div class="tuner">
  <div class="head">
    <span class="label">Tuning</span>
    <strong class="note mono" class:centred>
      {#if reading === null}
        —
      {:else}
        {reading.name}{reading.octave}
      {/if}
    </strong>
  </div>

  <div class="meter" role="presentation">
    <div class="track"></div>
    <div class="centre"></div>
    <div class="needle" class:centred style="left: {needlePercent}%"></div>
  </div>

  <div class="cents mono" class:centred>
    {#if reading === null}
      no pitch
    {:else if displayCents === 0}
      in tune
    {:else}
      {displayCents > 0 ? '+' : ''}{displayCents}¢
    {/if}
  </div>

  <div class="controls">
    {#each steps as step (step.semitones)}
      <button
        type="button"
        class="step mono"
        title={step.next === null ? `${step.title} — outside the carrier range` : step.title}
        disabled={step.next === null}
        onclick={() => step.next !== null && onchange(step.next)}
      >
        {step.label}
      </button>
    {/each}
    <button
      type="button"
      class="step snap"
      title="Move to the nearest note in range"
      disabled={onGrid}
      onclick={() => onchange(snapped)}
    >
      Snap
    </button>
    <label class="entry">
      <span class="sr-only">Carrier frequency in hertz</span>
      <input
        class="mono"
        type="number"
        min={CARRIER_UI_MIN}
        max={CARRIER_UI_MAX}
        step="0.1"
        value={value.toFixed(1)}
        onchange={(e) => commitEntry(e.currentTarget.value)}
      />
      <span class="unit">Hz</span>
    </label>
  </div>
</div>

<style>
  .tuner {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .label {
    color: var(--text-dim);
    font-size: 13px;
  }

  .note {
    font-size: 15px;
    color: var(--text);
  }

  .note.centred {
    color: var(--signal);
  }

  .meter {
    position: relative;
    height: 14px;
  }

  .track {
    position: absolute;
    top: 6px;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--border);
    border-radius: 1px;
  }

  .centre {
    position: absolute;
    top: 0;
    left: 50%;
    width: 1px;
    height: 14px;
    background: var(--border-strong);
  }

  .needle {
    position: absolute;
    top: 1px;
    width: 2px;
    height: 12px;
    margin-left: -1px;
    background: var(--text-dim);
    border-radius: 1px;
    transition: left 80ms linear;
  }

  .needle.centred {
    background: var(--signal);
  }

  .cents {
    align-self: center;
    font-size: 11px;
    color: var(--text-faint);
  }

  .cents.centred {
    color: var(--signal);
  }

  /*
   * Wraps, because the tuner now lives in a bounded subcolumn.
   *
   * Five step buttons and a frequency field in one row needed the full width of
   * the old full-width panel; inside a 186px track the entry simply hung out
   * past the card's right edge. Visible overflow, so nothing scrolled and
   * nothing was clipped — it just spilled, which is the one kind of overflow a
   * scroll-based check cannot see. The entry claims its own row instead.
   */
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 4px;
  }

  /*
   * Same 36px floor as the segments, in both directions. These are the
   * smallest targets in the recipe and the ones most often hit in a hurry, so
   * they get it first.
   *
   * `min-height` alone was not that floor, which is the same overstatement the
   * binaural disclosure carried: `flex: 1` inside a 186px track sized these to
   * about 28.5px wide, so the comment claimed 36 and the target was 28×36.
   * `.controls` already wraps by design, so the row takes a second line here
   * rather than the buttons shrinking below the floor.
   */
  .step {
    flex: 1;
    min-width: 36px;
    min-height: 36px;
    padding: 4px 0;
    font-size: 11px;
    color: var(--text-dim);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
  }

  .step:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .step:disabled {
    color: var(--text-disabled);
    background: var(--bg-soft);
    border-color: var(--border);
    cursor: default;
  }

  .snap {
    flex: 1.2;
  }

  .entry {
    display: flex;
    flex: 1 0 100%;
    align-items: stretch;
    gap: 3px;
    padding: 0 5px;
    min-height: 36px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  /* Stretched to the box rather than centred in it: the field the user aims
     at is the whole control, so the input must actually fill it. */
  /* Stretched to the box rather than centred in it, and carrying the 36px
     floor itself: `.entry` is what the eye reads as the field, but the input
     is what the pointer tests against, and the box borders were eating two
     of the pixels. */
  .entry input {
    flex: 1;
    min-width: 52px;
    min-height: 36px;
    padding: 3px 0;
    align-self: stretch;
    font-size: 11px;
    color: var(--text);
    background: none;
    border: none;
    text-align: right;
  }

  /*
   * The ring goes on the box, not on the input.
   *
   * The input is borderless inside `.entry`, so an outline on it would draw
   * inside the box it sits in. `:focus-within` puts the same 2px ring around
   * the whole control, which is what the user sees as the field — and it is a
   * ring rather than a colour change, because colour alone is not a focus
   * indicator.
   */
  .entry:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .entry input:focus {
    outline: none;
    color: var(--signal);
  }

  .unit {
    align-self: center;
    font-size: 10px;
    color: var(--text-faint);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
