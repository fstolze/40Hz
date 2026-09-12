<script lang="ts" module>
  /*
   * One id per dialog instance.
   *
   * Derived from a counter rather than from the title, for the reason the
   * sliders were: two dialogs whose titles happened to match would render the
   * same id, and `aria-labelledby` would resolve to whichever came first.
   */
  let counter = 0;
  function nextId(): number {
    counter += 1;
    return counter;
  }
</script>

<script lang="ts">
  /**
   * A modal over Studio.
   *
   * Settings and history are not mixer controls, and the control column is
   * already the reason this window needs a minimum height. Putting them in a
   * dialog keeps them out of a layout that was tuned to fit without scrolling.
   *
   * `<dialog>` rather than a hand-rolled overlay: the browser supplies the top
   * layer, the backdrop, focus containment, and Escape, none of which are
   * worth reimplementing badly.
   */
  import X from 'phosphor-svelte/lib/X';
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    open: boolean;
    onclose: () => void;
    children: Snippet;
  }

  let { title, open, onclose, children }: Props = $props();

  /**
   * The dialog's programmatic name.
   *
   * The heading was visible and the accessibility tree still exposed an
   * unnamed `dialog`: a heading inside a dialog is content, not a label, and
   * nothing connects the two unless it is said. Every consumer of this
   * component gets the name from here rather than each remembering to pass one.
   */
  const titleId = `dialog-title-${nextId()}`;
  let element = $state<HTMLDialogElement | null>(null);

  /**
   * Who opened this, so focus can go back there.
   *
   * The browser restores focus itself when a modal is closed through
   * `close()`, but only if the element is still in the top layer when it
   * happens — and this dialog is removed from the DOM by its own `open` prop
   * the moment the parent handler runs. Remembering the invoker costs nothing
   * and makes the outcome independent of that ordering.
   */
  let invoker: HTMLElement | null = null;

  // Opened on mount rather than in response to a prop, because the element
  // only exists while it should be showing. An effect that toggles a
  // long-lived `<dialog>` has to keep the element's own `open` state and the
  // prop in step, and when they drifted the result was a dialog stuck in the
  // top layer with an empty body — visible, unclosable, and rendering nothing.
  $effect(() => {
    invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();

    return () => {
      // Only when the browser did not already do it. After a native close the
      // invoker usually has focus back before this runs; after an unmount that
      // outran the restoration, focus is sitting on `<body>` and a keyboard
      // user has lost their place entirely.
      if (document.activeElement === document.body) invoker?.focus();
      invoker = null;
    };
  });

  /**
   * Close through the element, never by calling the parent handler directly.
   *
   * Calling `onclose` straight from the button unmounts the `<dialog>` without
   * its native close lifecycle ever running — no `close` event, and no focus
   * restoration. That is exactly what this did, and it is why Escape returned
   * focus to the Settings button while the visible Close button dropped it on
   * `<body>`: Escape goes through `cancel` → `close`, and the button did not.
   */
  function requestClose() {
    if (element?.open) element.close();
    else onclose();
  }

  /**
   * Close from the outside, through the same path the Close button uses.
   *
   * Exported because a consumer's own Cancel button had the very defect the
   * note above describes: setting `open` to false unmounts the `<dialog>`
   * without the native close ever running, so the invoker never gets its focus
   * back. Anything that dismisses this dialog has to come through here.
   */
  export function close() {
    requestClose();
  }
</script>

{#if open}
  <dialog bind:this={element} {onclose} aria-labelledby={titleId}>
    <header>
      <h2 id={titleId}>{title}</h2>
      <!--
        A drawn icon, not the multiplication sign.

        Product icons use Phosphor throughout, with no emoji, text glyph, CSS
        drawing, or ad hoc SVG standing in for one; this was the last glyph
        in the product: `×` is punctuation that happens to look like a cross,
        so it took the text stack's metrics and its own line box rather than an
        icon's, which is also how it ended up 24×18.
      -->
      <button class="close" onclick={requestClose} aria-label="Close">
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    <div class="body">
      {@render children()}
    </div>
  </dialog>
{/if}

<style>
  dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-panel);
    color: var(--text);
    box-shadow: var(--shadow-modal);
    overflow: hidden;
    /* The dialog is in the top layer, so it does not inherit the page's flex
       column and has to lay itself out. */
    display: flex;
    flex-direction: column;
  }

  dialog::backdrop {
    background: var(--overlay);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  /*
   * A real hit region, for the same reason D-13 gave the recipe one.
   *
   * It measured 24×18 as a glyph, which is under the 36px this product holds
   * every other control to — and it is the control someone reaches for when
   * they want out of a modal. The icon stays 16px; the button around it is
   * what grew, and it is square so the target is not a letterbox.
   */
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    /* Zero, explicitly: the global `button` rule's horizontal padding was
       squeezing the 16px icon into a 12px content box, so the icon rendered
       narrower than it is tall. The 36px box is the padding now. */
    padding: 0;
    /* The header's padding already spaces the title from the edge; pulling the
       button back by that much keeps the icon optically where the glyph was
       rather than pushing the header wider. */
    margin: -8px -8px -8px 0;
    border: none;
    background: none;
    color: var(--text-faint);
  }

  .close:hover {
    background: none;
    color: var(--text);
  }

  .body {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
  }
</style>
