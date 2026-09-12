<script lang="ts">
  /**
   * The shell, and the only place that decides which workspace is showing.
   *
   * Studio and History are views of one window, not routes and not separate
   * renderers. Studio holds the audio graph, so its panels stay mounted while
   * History is showing — switching destination must not stop preview, end a
   * session, rebuild the graph, or reset the recipe, and unmounting the panels
   * that own those subscriptions is the easiest way to do all four by
   * accident. History is hidden with `hidden`, not destroyed.
   */
  import SessionStrip from './components/SessionStrip.svelte';
  import SoundRecipe from './components/SoundRecipe.svelte';
  import Scope from './components/Scope.svelte';
  import Spectrum from './components/Spectrum.svelte';
  import Dialog from './components/Dialog.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import HistoryPanel from './components/HistoryPanel.svelte';
  import IntegrityPanel from './components/IntegrityPanel.svelte';
  import AppHeader from './components/AppHeader.svelte';
  import IntegrityRow from './components/IntegrityRow.svelte';
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import Info from 'phosphor-svelte/lib/Info';
  import { engine } from './lib/engine.svelte.ts';
  import { DEFAULT_PRESET_ID } from '../audio/presets.ts';
  import {
    configurationsEqual,
    snapshotConfiguration,
    type SessionConfiguration,
  } from '../audio/configuration.ts';
  import type { RecallOption } from './lib/history-view.ts';
  import type { SessionRecord } from '../session/session.ts';
  import { describeTarget, globalShortcutFor } from './lib/shortcuts.ts';
  import type { View } from './lib/view.ts';

  const status = $derived(engine.status);
  // Which preset a session records as its source.
  let selectedPresetId = $state(DEFAULT_PRESET_ID);

  let view = $state<View>('studio');

  /**
   * Where the current recipe came from, when it came from History.
   *
   * A note about provenance, not a second copy of the recipe: it holds the
   * snapshot that was recalled purely so the note can be *withdrawn* the moment
   * the live recipe stops matching it. Shown only while they are still equal,
   * so it cannot outlive its own truth — the first edit clears it without
   * anything having to remember to.
   */
  let recalled = $state<{ configuration: SessionConfiguration; from: string } | null>(null);

  /** What just happened, for anything that cannot see the workspace change. */
  let announcement = $state('');

  /*
   * Choosing a preset is a new provenance, so the note goes.
   *
   * Equality alone is not enough here: recalling a record whose recipe happens
   * to be Focus and then *selecting* Focus leaves the recipe untouched, so the
   * note would survive an action that plainly replaced where the recipe came
   * from. Tracked rather than derived because the trigger is the selection
   * changing, not its value.
   */
  let lastSelectedPreset: string | null = null;
  $effect(() => {
    // Read inside the effect so the dependency is tracked, and seeded on the
    // first run rather than from an initialiser — reading `$state` at the top
    // level captures only its starting value, which Svelte warns about because
    // it is almost always a mistake.
    const current = selectedPresetId;
    if (lastSelectedPreset === null) {
      lastSelectedPreset = current;
      return;
    }
    if (current !== lastSelectedPreset) {
      lastSelectedPreset = current;
      recalled = null;
    }
  });

  const stillRecalled = $derived(
    recalled !== null && configurationsEqual(engine.currentConfiguration(), recalled.configuration),
  );

  /**
   * Apply a historical recipe and show it.
   *
   * Configuration only, through the same `applyConfiguration` ordinary editing
   * uses — so the recalled values take the setters' idempotence, transition
   * handling and headroom guarantees rather than a private route around them.
   *
   * What it deliberately does not touch: preview, any running session, the
   * session's duration or elapsed time, appearance, settings, and the selected
   * preset. Selection especially — the record keeps the id it ran, but that
   * preset may since have been edited or deleted, so adopting it would claim an
   * identity nothing has checked. The configuration comparison answers the
   * identity question correctly here with no help from History.
   */
  function recall(option: RecallOption, record: SessionRecord) {
    engine.applyConfiguration(option.configuration);
    const from = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(record.startedAt));
    recalled = { configuration: snapshotConfiguration(option.configuration), from };
    view = 'studio';
    // Said, not only shown. The view changes underneath the user and the note
    // that explains it is a badge on a line they were not looking at.
    announcement = `${option.label} from ${from}. Studio now holds that recipe; nothing is playing.`;
  }

  /**
   * Dialog children mount only while open.
   *
   * A `<dialog>` keeps its children in the DOM whether or not it is showing,
   * so a panel rendered unconditionally loads its data once at app start and
   * is stale every time it is opened afterwards. Rendering the element only
   * while open also lets each panel simply load in an effect.
   */
  let dialog = $state<'settings' | 'integrity' | null>(null);

  let header = $state<{ togglePreview: () => void; beginPresetSave: () => void } | null>(null);

  /** The single scroll owner, retained so the continuation control can drive it. */
  let scrollport: HTMLElement | null = null;
  let moreStudioBelow = $state(false);

  /**
   * Keep the continuation cue honest as the window, recipe and session change.
   *
   * Watching only the scrollport's own box is not enough: enabling Two-tone,
   * showing an advisory or changing a recipe can grow its contents without
   * changing its visible height. Observe both workspaces as well as the owner,
   * and batch reads to the next frame so a resize does not measure halfway
   * through layout.
   */
  function trackStudioOverflow(node: HTMLElement) {
    scrollport = node;
    let frame = 0;
    const measure = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        moreStudioBelow = node.scrollTop + node.clientHeight < node.scrollHeight - 2;
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.querySelectorAll('.workspace').forEach((workspace) => observer.observe(workspace));
    node.addEventListener('scroll', measure, { passive: true });
    measure();

    return {
      destroy() {
        if (frame !== 0) cancelAnimationFrame(frame);
        observer.disconnect();
        node.removeEventListener('scroll', measure);
        if (scrollport === node) scrollport = null;
      },
    };
  }

  /** Reveal the start of the recipe and leave keyboard focus at that landmark. */
  function revealRecipe() {
    const heading = document.getElementById('sound-recipe-heading');
    if (scrollport === null || heading === null) return;
    const top =
      heading.getBoundingClientRect().top -
      scrollport.getBoundingClientRect().top +
      scrollport.scrollTop -
      12;
    heading.focus({ preventScroll: true });
    scrollport.scrollTo({
      top: Math.max(0, top),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  /**
   * The scoped global shortcuts.
   *
   * The decision of whether a keystroke is ours lives in `shortcuts.ts`, which
   * is pure and tested; this only supplies the context it cannot see — whether
   * a modal owns interaction — and runs the resulting action through the
   * components' own handlers.
   *
   * `preventDefault` matters for both: Space scrolls the workspace, and
   * Cmd/Ctrl+S offers to save the page in a browser.
   */
  function onKeyDown(event: KeyboardEvent) {
    const shortcut = globalShortcutFor(event, describeTarget(event.target), dialog !== null);
    if (shortcut === null) return;
    event.preventDefault();
    if (shortcut === 'toggle-preview') header?.togglePreview();
    else header?.beginPresetSave();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<AppHeader
  {view}
  recalled={stillRecalled && recalled !== null ? recalled.from : null}
  onnavigate={(next) => (view = next)}
  onsettings={() => (dialog = 'settings')}
  bind:selectedPresetId
  bind:this={header}
/>

<IntegrityRow onopen={() => (dialog = 'integrity')} />

<!--
  Mounted only when there is something to say. A banner slot reserved against
  the possibility of a message is empty space on every ordinary run.
-->
{#if status.error}
  <div class="banner error">
    <span>{status.error}</span>
    <button onclick={() => engine.dismissError()}>Dismiss</button>
  </div>
{/if}

{#if status.sampleRateWarning}
  <div class="banner warn">
    <span>{status.sampleRateWarning}</span>
  </div>
{/if}

<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

<div class="main-shell">
  <main class:history={view === 'history'} use:trackStudioOverflow>
    <!-- Kept mounted while History shows. See the note at the top of this file. -->
    <div class="workspace" hidden={view !== 'studio'}>
      <!--
      The two live charts, paired and first.
      
      Above the controls rather than beside them: they describe the output of
      whatever the controls are set to, and reading them as a consequence of
      the recipe is easier when they are not competing with it for the same
      horizontal band. Two equal columns, so neither is the small one.
    -->
      <div class="visual-grid">
        <Scope />
        <Spectrum />
      </div>

      <!-- Grouped rather than listed flat so the stack can split into two tracks
         when the window is wide enough. Entrainment is the tallest panel, so it
         takes one track alone and the two shorter panels share the other. -->
      <!--
      Between the charts and the recipe, because that is what it operates on:
      a session runs the configured recipe, so it reads as the thing that
      turns the recipe below into the output above.
    -->
      <SessionStrip presetId={selectedPresetId} />

      <!-- The three layers as one recipe. See SoundRecipe.svelte. -->
      <SoundRecipe />
    </div>

    {#if view === 'history'}
      <!-- The heading belongs to the panel: it is the one element on this view
         that survives every deletion, so it is where focus lands when a row or
         the whole log has just been removed. -->
      <div class="workspace history-view">
        <HistoryPanel onrecall={recall} />
      </div>
    {/if}
  </main>

  {#if view === 'studio' && moreStudioBelow}
    <div class="scroll-continuation">
      <button class="scroll-cue" onclick={revealRecipe} aria-controls="sound-recipe">
        More recipe controls below
        <CaretDown size={14} weight="bold" aria-hidden="true" />
      </button>
    </div>
  {/if}
</div>

<footer>
  <Info size={14} aria-hidden="true" />
  <span>
    A focus and concentration tool. Not a medical device, and not intended to diagnose, treat, or
    prevent any condition.
  </span>
</footer>

<Dialog title="Settings" open={dialog === 'settings'} onclose={() => (dialog = null)}>
  <SettingsPanel />
</Dialog>

<Dialog title="Signal integrity" open={dialog === 'integrity'} onclose={() => (dialog = null)}>
  <IntegrityPanel />
</Dialog>

<style>
  /* See the note in HistoryPanel: this scoped copy avoids a global style change. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .banner {
    padding: 8px 18px;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }

  .banner.error {
    background: var(--danger-surface);
    color: var(--danger);
    border-bottom: 1px solid var(--danger);
  }

  .banner.warn {
    background: var(--warn-surface);
    color: var(--warn);
    border-bottom: 1px solid var(--warn);
  }

  /*
   * The one vertical scroll owner.
   *
   * Previously each column scrolled independently above 1060px, which meant
   * two scrollbars and a workspace where reaching a control depended on which
   * half the pointer was over. With the charts on top the page is simply tall,
   * and one scroll is the honest way to move through it.
   */
  /*
   * A block, not a flex column.
   *
   * This was `display: flex` with `flex: 1` here and `min-height: 0` on
   * `.workspace`, and that pair is what hid the recipe. A flex item normally
   * refuses to shrink below its min-content height; `min-height: 0` waives
   * that floor, and `flex: 1` (basis `0`) then asks the workspace to fit the
   * window rather than its contents. So the workspace shrank instead of
   * overflowing, and a scroll container whose content never overflows has
   * nothing to scroll. Measured at the four supported widths: the recipe box
   * came out 425, 194, 154 and 2px tall against layers needing 656, 671, 671
   * and 1248 — at the 900px minimum every one of its 25 controls was in the
   * DOM, focusable, and unreachable with a pointer.
   *
   * Normal flow is what a scroll container wants: children take their
   * intrinsic height, the content overflows, and the overflow is scrollable.
   * `tools/check-layout.ts` asserts all of that at every supported width.
   */
  .main-shell {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  main {
    flex: 1 1 auto;
    min-height: 0;
    display: block;
    overflow-y: auto;
  }

  /*
   * A visible promise that Studio continues.
   *
   * This is a sibling of the scrollport rather than an overlay inside it, so
   * it never paints over the Session status or a control brought into view by
   * keyboard focus. The native overlay scrollbar remains useful once a person
   * starts scrolling; this control owns the invitation before that happens.
   */
  .scroll-continuation {
    flex: none;
    display: flex;
    justify-content: center;
    padding: 4px 16px 6px;
    border-top: 1px solid var(--border);
    background: linear-gradient(to bottom, var(--bg), var(--bg-deep));
  }

  .scroll-cue {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 13px 0 15px;
    border-color: var(--signal-strong);
    background: var(--signal-soft);
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
  }

  .scroll-cue :global(svg) {
    flex: none;
    color: var(--signal);
  }

  /* Grid rather than flex for the same reason, and with no `min-height: 0`:
     auto rows are content-sized, and `align-content: start` keeps them from
     stretching to fill a taller window. */
  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 12px;
    padding: 12px 16px;
    /*
     * A measure, not a window.
     *
     * Nothing here reads better for being wider: past about 1600px the
     * recipe columns grow slack, the sliders become long throws for small
     * changes, and the eye has to travel the full width of a large display
     * to get from a label to its value. Measured at 1800x1100 the recipe
     * came out 1768px across. The cap is above every supported window size,
     * so it changes nothing at 1440 and below — it only stops the layout
     * from dissolving on a display the design was never drawn for.
     */
    max-width: 1600px;
    width: 100%;
    margin-inline: auto;
  }

  .workspace[hidden] {
    display: none;
  }

  /*
   * Wider than the 900px it was as a dialog's contents.
   *
   * A record now carries its time, its preset, three state badges, a recipe
   * summary, its durations and up to three actions. At 900 the actions wrapped
   * under the detail on every row at every window size, which reads as a list
   * of paragraphs rather than a table. 1100 is where the two-column row holds
   * at the canonical width without the line length becoming a page-wide crawl.
   */
  .history-view {
    display: block;
    max-width: 1100px;
    width: 100%;
  }

  /*
   * Two equal columns, and they stay two.
   *
   * The responsive contract asks for height to compress before width here:
   * a spectrum narrower than about 400px loses its decade labels, and at the
   * 900px minimum each column is still ~430px. So the height shrinks with the
   * window and the column count does not.
   */
  .visual-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .visual-grid > :global(*) {
    min-height: clamp(180px, 25vh, 230px);
  }

  @media (min-width: 1000px) {
    .visual-grid > :global(*) {
      min-height: clamp(190px, 25vh, 260px);
    }
  }

  @media (min-width: 1200px) {
    .visual-grid > :global(*) {
      min-height: clamp(200px, 25vh, 295px);
    }
  }

  /* The chart canvases normally keep 120px for their plots. In the shortest
     supported window that floor, plus a two-line caption, overrides the
     height-aware panel clamp and gives the empty charts space the recipe needs
     more. Eighty pixels keeps their axes and markers readable while letting
     the whole chart pair reach the 180px compact target. */
  @media (max-height: 700px) {
    .visual-grid :global(.canvas-host) {
      min-height: 80px;
    }
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 9px 18px;
    border-top: 1px solid var(--border);
    background: var(--bg-deep);
    font-size: 11px;
    color: var(--text-faint);
    flex-shrink: 0;
  }

  footer :global(svg) {
    flex: none;
  }
</style>
