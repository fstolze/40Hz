<script lang="ts">
  /**
   * The global shell: identity, destinations, the preset workflow, playback,
   * and Settings.
   *
   * Everything here describes the whole recipe or the whole app. Nothing that
   * belongs to one sound layer may move in, because a control sitting beside
   * Master reads as global whether or not it is.
   *
   * Two documented groups, in this order of responsibility: identity and
   * navigation with the preset workflow, then playback with the output
   * readouts and Settings. They sit on one line when there is room and wrap as
   * whole groups when there is not — never mid-group, and never by dropping an
   * action. The previous header was a single non-wrapping row, which is how
   * "Stop session" came to overlap Delete at the 900px minimum.
   */
  import GearSix from 'phosphor-svelte/lib/GearSix';
  import PresetBar from './PresetBar.svelte';
  import Transport from './Transport.svelte';
  import type { View } from '../lib/view.ts';

  interface Props {
    view: View;
    /**
     * When the current recipe came from a History record, and still matches it.
     *
     * Recall is a state change the user did not watch happen — they were in
     * History and arrived in Studio — so it has to say so rather than leave
     * them to infer it from values that look different. The shell withdraws
     * this the moment the recipe stops matching what was recalled, so it can
     * never describe a recipe that has since been edited.
     */
    recalled?: string | null;
    onnavigate: (view: View) => void;
    onsettings: () => void;
    selectedPresetId: string;
  }

  let {
    view,
    recalled = null,
    onnavigate,
    onsettings,
    selectedPresetId = $bindable(),
  }: Props = $props();

  /**
   * The selected preset's description, given its own line.
   *
   * It belongs to the preset, so `PresetBar` owns the text; where it goes is
   * this component's problem. Rendered inside the picker's group it made that
   * group two rows tall against every other control's one, and centring then
   * left the header on three different baselines. As a full-width flex item it
   * always takes its own line — whether the groups above it are on one row or
   * two — and the control rows stay aligned.
   */
  let presetDescription = $state('');

  /**
   * Whether the recipe has diverged from the selected preset.
   *
   * Derived in `PresetBar` from the engine and the preset; rendered here, on
   * the description's line rather than beside the picker. That placement is
   * measured, not aesthetic: the header's identity group has a 600px
   * min-content width and the single row survives to 1250px, 30px under the
   * 1280 the window opens at. A badge beside the picker costs about 78px and
   * would put the threshold past the default, so the header would open wrapped
   * again. This line is already full width and costs nothing.
   */
  let presetModified = $state(false);

  /*
   * The shortcuts run the components' own actions, not copies of them.
   *
   * Space and Cmd/Ctrl+S must do exactly what the button and the Save action
   * do — including their `busy` guards and their error handling. Calling
   * `sessionClient` or the preset store again from a key handler would be a
   * second transport and a second save path, and the two would disagree the
   * moment one of them was mid-flight.
   */
  let presets = $state<{ beginSave: () => void } | null>(null);
  let transport = $state<{ toggle: () => Promise<void> } | null>(null);

  export function togglePreview(): void {
    void transport?.toggle();
  }

  export function beginPresetSave(): void {
    presets?.beginSave();
  }

  const DESTINATIONS: { id: View; label: string }[] = [
    { id: 'studio', label: 'Studio' },
    { id: 'history', label: 'History' },
  ];
</script>

<header class="topbar">
  <div class="group identity">
    <div class="brand">
      <h1>40 Hz</h1>
      <span class="mode">Studio</span>
    </div>

    <!--
      Two destinations, and the active one is marked with `aria-current` as
      well as with colour — status carried by colour alone is status a screen
      reader cannot report.
    -->
    <nav aria-label="Views">
      {#each DESTINATIONS as destination (destination.id)}
        <button
          class="destination"
          class:active={view === destination.id}
          aria-current={view === destination.id ? 'page' : undefined}
          onclick={() => onnavigate(destination.id)}
        >
          {destination.label}
        </button>
      {/each}
    </nav>

    <div class="presets">
      <PresetBar
        bind:this={presets}
        bind:selectedId={selectedPresetId}
        bind:description={presetDescription}
        bind:modified={presetModified}
      />
    </div>
  </div>

  <div class="group global">
    <Transport bind:this={transport} />
    <button class="settings" onclick={onsettings}>
      <GearSix size={16} aria-hidden="true" />
      Settings
    </button>
  </div>

  {#if presetDescription || presetModified || recalled !== null}
    <!-- `id` is what lets the picker point at this with `aria-describedby`:
         placed at the far left of its own line, the text would otherwise read
         as a caption for the header rather than for the preset. -->
    <p id="preset-description" class="preset-description">
      {#if recalled !== null}
        <!--
          Placed before Modified, because it explains it. A recalled recipe
          almost always differs from whatever preset is selected, so the two
          appear together and this is the one that says why.
        -->
        <span class="recalled">Recalled from {recalled}</span>
      {/if}
      {#if presetModified}
        <!--
          Stated, not merely coloured. "Modified" has to be readable as a word
          rather than inferred from a tint, and it has to be distinguishable
          from the preset's own name — which is why it sits here in the
          preset's line and not inside the picker, where it would read as part
          of the name.

          Informative rather than alarming: this is an ordinary and expected
          state, so it takes the neutral surface and normal ink rather than the
          warning colour, which is reserved for things that are wrong.
        -->
        <span class="modified">Modified</span>
      {/if}
      {presetDescription}
    </p>
  {/if}
</header>

<style>
  .topbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 20px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-deep);
    flex-shrink: 0;
  }

  /* The wrap unit. Groups break to their own line together rather than
     letting one member cross to the next row on its own. */
  .group {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  /*
   * The bases are each group's real minimum content width, not a guess.
   *
   * Flexbox decides wrapping from the basis and only *then* shrinks, so a
   * basis smaller than the content means the groups stay on one line and their
   * children overflow instead — which is how "Preview" came to sit on top of
   * "Delete" at 1180. Sized so the two only share a row when both genuinely
   * fit: 600 + 590 + the 20px gap + 36px of padding needs about 1250px.
   */
  .identity {
    flex: 1 1 600px;
  }

  .global {
    flex: 1 1 590px;
    justify-content: flex-end;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: none;
  }

  h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 500;
    letter-spacing: -0.02em;
  }

  .mode {
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.09em;
  }

  nav {
    display: flex;
    gap: 0;
    padding: 2px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    flex: none;
  }

  .destination {
    border: none;
    background: transparent;
    border-radius: 6px;
    padding: 0 16px;
    /*
     * The same 36px floor every recipe control is held to.
     *
     * These were 34, which clears WCAG 2.2's 24px target-size threshold and
     * misses the product's own convention — and the check that enforces that
     * convention is scoped to `.recipe`, so the header was never measured
     * against it. `check:layout` now covers this row too.
     */
    height: 36px;
    font-size: 13px;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .destination:hover:not(:disabled) {
    background: var(--bg-raised);
    color: var(--text);
  }

  .destination.active {
    background: var(--signal-strong);
    color: var(--on-signal);
  }

  .destination.active:hover:not(:disabled) {
    background: var(--signal-strong);
  }

  /* Absorbs the spare width, so a wide window grows the picker rather than
     the buttons. */
  .presets {
    flex: 1 1 auto;
    min-width: 0;
  }

  /*
   * Its own line, always. `flex-basis: 100%` forces the wrap rather than
   * relying on there being no room, so the description cannot end up beside a
   * control group at a width where one happens to fit.
   */
  .recalled {
    display: inline-block;
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--signal-strong);
    border-radius: 3px;
    background: var(--signal-soft);
    color: var(--signal);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    vertical-align: baseline;
  }

  .modified {
    display: inline-block;
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    background: var(--bg-raised);
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    /* Sits on the description's baseline rather than raising the line box, so
       turning Modified on does not shift the row it appears in. */
    vertical-align: baseline;
  }

  .preset-description {
    flex: 0 0 100%;
    margin: -4px 0 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .settings {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 16px;
    white-space: nowrap;
    flex: none;
  }
</style>
