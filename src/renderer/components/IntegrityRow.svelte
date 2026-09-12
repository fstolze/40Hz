<script lang="ts">
  /**
   * What the checks currently cover, stated in full and always visible.
   *
   * This replaces a footer link that was clamped to 46 characters and read
   * `…not checked: app outp…` at every window size the product supports — the
   * one statement of what was and was not examined, truncated everywhere.
   *
   * Quiet by design. Coverage is incomplete on every platform, because nothing
   * can check the system mix or what the headphones actually deliver, so a
   * status light would sit amber forever and teach the user to ignore it. The
   * row takes a warning colour only when a check that actually *ran* came back
   * wrong — which is the difference between "not looked at" and "looked at and
   * faulty", and the whole reason this is a sentence rather than a dot.
   */
  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
  import Warning from 'phosphor-svelte/lib/Warning';
  import { integrity } from '../lib/integrity.svelte.ts';

  interface Props {
    onopen: () => void;
  }

  let { onopen }: Props = $props();

  const coverage = $derived(integrity.summary);
</script>

<button
  class="integrity"
  class:escalated={coverage.escalated}
  onclick={onopen}
  aria-label="Signal integrity — {coverage.headline}. Open details."
>
  <!-- The icon repeats the state the text already carries, so it is hidden
       from assistive technology rather than read out twice. -->
  {#if coverage.escalated}
    <Warning size={15} weight="fill" aria-hidden="true" />
  {:else}
    <CheckCircle size={15} weight="fill" aria-hidden="true" />
  {/if}
  <span class="headline">{coverage.headline}</span>
</button>

<style>
  .integrity {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 18px;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: var(--bg-deep);
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
    flex-shrink: 0;
  }

  .integrity:hover:not(:disabled) {
    background: var(--bg-soft);
    border-color: var(--border);
    color: var(--text);
  }

  .integrity:focus-visible {
    outline-offset: -2px;
  }

  /*
   * Neutral, not green. Green would claim the scopes nothing can check are
   * fine; this states what was checked and leaves the rest to the sentence.
   */
  .integrity :global(svg) {
    color: var(--text-faint);
    flex: none;
  }

  .integrity.escalated {
    color: var(--warn);
  }

  .integrity.escalated :global(svg) {
    color: var(--warn);
  }

  /* Wraps rather than truncating: this is the only statement of coverage, and
     an ellipsis in the middle of it is what this row exists to fix. */
  .headline {
    min-width: 0;
  }
</style>
