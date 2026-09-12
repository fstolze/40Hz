<script lang="ts">
  /**
   * One layer of the sound recipe.
   *
   * Replaces the generic `Panel` card for these three. The difference is not
   * decoration: three separately elevated cards read as three unrelated tools,
   * and the whole point of the recipe is that they are one sound with three
   * contributions. So a layer is a column inside a shared surface, separated by
   * a rule rather than by its own border, and numbered so the order in which
   * they stack is the order in which they combine.
   *
   * The heading is an `h3` under the recipe's `h2`. That is the real
   * relationship, and it is what a screen reader uses to move between them.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    index: number;
    title: string;
    subtitle: string;
    accent: 'signal' | 'soundscape';
    children: Snippet;
  }

  let { index, title, subtitle, accent, children }: Props = $props();
</script>

<section class="layer" data-accent={accent}>
  <header>
    <span class="index" aria-hidden="true">{index}</span>
    <div>
      <h3>{title}</h3>
      <p>{subtitle}</p>
    </div>
  </header>
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .layer {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding: 14px 16px;
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  /*
   * The number carries the order, and the accent carries which family the
   * layer belongs to — teal for the entrainment path, violet for the bed.
   * Hidden from assistive technology because the heading order already says
   * it, and "1 Entrainment" read aloud is worse than "Entrainment".
   */
  .index {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--signal-strong);
    color: var(--signal);
    background: var(--signal-soft);
  }

  /*
   * The layer publishes its accent; the shared controls consume it.
   *
   * Segmented and Slider are used by all three layers, so neither can name a
   * colour. Publishing three inherited custom properties here lets the layer
   * decide, keeps the fallback at the signal family for anything outside a
   * layer, and avoids threading a prop through two components that have no
   * other reason to know which layer they are in.
   */
  .layer[data-accent='soundscape'] {
    --layer-accent: var(--soundscape);
    --layer-accent-strong: var(--soundscape-strong);
    --layer-on-accent: var(--on-soundscape);
  }

  .layer[data-accent='soundscape'] .index {
    border-color: var(--soundscape);
    color: var(--soundscape);
    background: var(--soundscape-soft);
  }

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  header p {
    margin: 3px 0 0;
    font-size: 11px;
    color: var(--text-faint);
    line-height: 1.45;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
</style>
