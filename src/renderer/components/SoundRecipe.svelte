<script lang="ts">
  /**
   * The three sound layers, as one recipe.
   *
   * This is the redesign's central claim: Entrainment, Two-tone and Soundscape
   * are not three tools that happen to sit near each other, they are three
   * contributions to one sound. So they share a surface, sit side by side where
   * there is room, and are separated by rules rather than by their own borders.
   * Nothing is behind an overflow, a drawer, or a "More" — depth is the product,
   * and hiding it would make the app look simpler at the cost of making its
   * value harder to find.
   *
   * Entrainment takes the widest column because it carries the most controls,
   * not because the other two are secondary. Both of them keep their full
   * parameter set and their own derived readouts at every width.
   *
   * The layers own their own controls and setters; this file owns only where
   * they sit. No parameter is read or written here.
   */
  import RecipeLayer from './RecipeLayer.svelte';
  import EntrainmentPanel from './EntrainmentPanel.svelte';
  import TwoTonePanel from './TwoTonePanel.svelte';
  import SoundscapePanel from './SoundscapePanel.svelte';
</script>

<section id="sound-recipe" class="recipe" aria-labelledby="sound-recipe-heading">
  <header class="recipe-head">
    <h2 id="sound-recipe-heading" tabindex="-1">Sound recipe</h2>
    <p>Three layers, mixed to one output. Presets store the whole recipe.</p>
  </header>

  <div class="layers">
    <RecipeLayer
      index={1}
      title="Entrainment"
      subtitle="Carrier multiplied by a Tukey-windowed envelope. Diotic — identical in both ears."
      accent="signal"
    >
      <EntrainmentPanel />
    </RecipeLayer>

    <RecipeLayer
      index={2}
      title="Two-tone"
      subtitle="Tones at the carrier and the carrier plus modulation. Routing alone decides binaural or monaural."
      accent="signal"
    >
      <TwoTonePanel />
    </RecipeLayer>

    <RecipeLayer
      index={3}
      title="Soundscape"
      subtitle="Synthesised bed, notched at the carrier and both sidebands to leave a spectral slot."
      accent="soundscape"
    >
      <SoundscapePanel />
    </RecipeLayer>
  </div>
</section>

<style>
  /*
   * No `overflow: hidden` here.
   *
   * It was there to clip the layer separators to the rounded corners, and it
   * was also what turned a too-short box into *clipped controls* rather than
   * visible overflow. The corners are handled by giving the header its own
   * radius instead, so a layout mistake can never again hide a control
   * silently.
   */
  .recipe {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .recipe-head {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-deep);
    border-radius: calc(var(--radius) - 1px) calc(var(--radius) - 1px) 0 0;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  h2:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
    border-radius: 2px;
  }

  .recipe-head p {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text-faint);
  }

  /*
   * Stacked by default, with the rules turning horizontal — so the narrowest
   * supported window needs no query and produces no sideways scroll. The
   * columns are additive above it.
   */
  .layers {
    display: grid;
    grid-template-columns: 1fr;
  }

  .layers > :global(.layer + .layer) {
    border-top: 1px solid var(--border);
  }

  /*
   * Three columns from the point where all three still hold their controls.
   * Entrainment is widest because it has the most to show — the ratio is the
   * one the approved composition uses — and the separators become vertical.
   */
  @media (min-width: 1080px) {
    .layers {
      grid-template-columns: 1.3fr 0.9fr 0.95fr;
    }

    .layers > :global(.layer + .layer) {
      border-top: none;
      border-left: 1px solid var(--border);
    }
  }
</style>
