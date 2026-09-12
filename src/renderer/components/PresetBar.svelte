<script lang="ts">
  /**
   * Preset identity, and whether the live recipe still matches it.
   *
   * There is no preset model here. `Modified` is a comparison between two
   * values the product already owns — `engine.currentConfiguration()` and the
   * selected preset's own three fields — so nothing in this file can drift
   * from the recipe it describes. A second copy of the recipe kept for display
   * would be a second answer to "what is playing", and the first time the two
   * disagreed the badge would be the one telling the truth about neither.
   */
  import { tick } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { engine } from '../lib/engine.svelte.ts';
  import { presetStore } from '../lib/stores.ts';
  import {
    BUILT_IN_PRESETS,
    DEFAULT_PRESET,
    DEFAULT_PRESET_ID,
    newPresetId,
    presetConfiguration,
    type Preset,
  } from '../../audio/presets.ts';
  import { configurationsEqual } from '../../audio/configuration.ts';
  import { failureReason } from '../lib/errors.ts';

  interface Props {
    /** Bound out so a session can record which preset it ran. */
    selectedId?: string;
    /**
     * The selected preset's description, bound out for the header to place.
     *
     * Rendered here it made this component two rows tall while every other
     * header control is one, and `align-items: center` then pushed the
     * neighbouring groups out of line with the picker — three different
     * baselines across the header. The text belongs to the preset, so it is
     * still owned here; only its *position* is the header's business.
     */
    description?: string;
    /**
     * Whether the live recipe has diverged from the selected preset.
     *
     * Bound out for the same reason as the description: the state belongs to
     * the preset and is derived here, but the header decides where it reads.
     * It is published rather than rendered here because the header's single
     * row is already full — see the note on `.presets` below.
     */
    modified?: boolean;
  }

  let {
    selectedId = $bindable(DEFAULT_PRESET_ID),
    description = $bindable(''),
    modified = $bindable(false),
  }: Props = $props();

  let userPresets = $state<Preset[]>([]);
  let naming = $state(false);
  let draftName = $state('');
  let busy = $state(false);
  let confirmingDelete = $state(false);
  /**
   * Why a delete did not happen, reported where the user is looking.
   *
   * Not through the global banner: the banner lives at the top of the app, and
   * while this confirmation is open the modal's backdrop sits over it — so the
   * message and its Dismiss button were both visible and both unreachable, and
   * the modal stayed open with nothing explaining why. A modal that can fail
   * has to be able to say so itself.
   */
  let deleteError = $state<string | null>(null);

  /** The naming field, and whatever opened it. */
  let nameInput = $state<HTMLInputElement | null>(null);
  let saveButton = $state<HTMLButtonElement | null>(null);
  let namingInvoker: HTMLElement | null = null;
  let deleteAlert = $state<HTMLElement | null>(null);
  let deleteDialog = $state<{ close: () => void } | null>(null);
  let picker = $state<HTMLSelectElement | null>(null);

  const all = $derived([...BUILT_IN_PRESETS, ...userPresets]);
  const selected = $derived(all.find((p) => p.id === selectedId) ?? null);
  const canDelete = $derived(selected !== null && selected.builtIn !== true);

  /**
   * Compare the selected preset's persisted recipe with the engine's current
   * configuration, and nothing more.
   *
   * `currentConfiguration()` spreads the engine's `$state` objects, so every
   * recipe field is read here and any one of them changing re-runs this. Master
   * is included because a preset stores and applies it: a recipe recalled after
   * the level moved is not the recipe the preset describes.
   */
  const isModified = $derived(
    selected !== null &&
      !configurationsEqual(engine.currentConfiguration(), presetConfiguration(selected)),
  );

  /*
   * Save updates a user preset in place and copies a built-in.
   *
   * Unresolved decision 2, answered: one action whose label follows the
   * selection, rather than two buttons. A second button would grow the header's
   * identity group from its measured 600px min-content to about 678, moving the
   * single-row threshold from 1250 to roughly 1328 — past the 1280 the window
   * opens at, which would reopen the wrapped header D-18 fixed. "Save as…" is
   * kept as the copy label rather than "Save a copy…" for the same reason: it
   * is the narrower string, and it is the one already in the product.
   */
  const saveLabel = $derived(selected?.builtIn === true ? 'Save as…' : 'Save');
  const saveTitle = $derived(
    selected?.builtIn === true
      ? 'Built-in presets cannot be changed. This saves a copy.'
      : `Update “${selected?.name ?? ''}” with the current recipe`,
  );
  /* Nothing to write for a clean user preset. A built-in stays available,
     because copying an unedited one is a reasonable way to start. */
  const canSave = $derived(selected !== null && (selected.builtIn === true || isModified));

  /**
   * Focus the first candidate that can actually take it.
   *
   * Calling `focus()` and moving on is not placing focus: the element may have
   * been unmounted, or may be disabled, and in both cases the call is a silent
   * no-op that leaves the keyboard on `<body>`. That is precisely what happened
   * after a successful "Save as…" — the button that opened the flow was gone,
   * and its replacement was disabled because the preset just written is by
   * definition clean, so both attempts failed and neither said so.
   *
   * Both guards are load-bearing together and neither is alone. Cancel and
   * Escape always present a stale invoker — the naming flow really does destroy
   * the button that opened it and build a new one — and either check catches
   * that, which is why removing just one leaves the tests green. Removing both
   * drops focus to `<body>` and the keyboard test fails. They are kept as two
   * cheap checks on two different failures: a node that is no longer there, and
   * a node that is there and refuses.
   */
  function focusFirst(...candidates: (HTMLElement | null)[]): void {
    for (const candidate of candidates) {
      if (candidate === null || !candidate.isConnected) continue;
      candidate.focus();
      // One test rather than a list of reasons focus can be refused. A
      // disabled button is the one that bit here, but an `inert` subtree or a
      // hidden ancestor would fail the same way and enumerating them would
      // only ever be a list of the cases already known about.
      if (document.activeElement === candidate) return;
    }
  }

  function apply(id: string) {
    selectedId = id;
    const preset = all.find((p) => p.id === id);
    if (preset) engine.applyPreset(preset);
  }

  /**
   * Write, then confirm the store actually holds it.
   *
   * The stage's stop condition is "no apparent success without durable store
   * confirmation", and an upsert that resolves is not that: it says the call
   * returned, not that the list now contains the preset. So the answer is read
   * back and compared by value — the same comparison Modified uses — and only
   * then does the UI treat the save as done.
   */
  async function persist(preset: Preset): Promise<boolean> {
    try {
      const list = await presetStore.upsert(preset);
      const stored = list.find((p) => p.id === preset.id);
      if (
        stored === undefined ||
        !configurationsEqual(presetConfiguration(stored), presetConfiguration(preset))
      ) {
        engine.reportError(`“${preset.name}” was not saved. The stored presets did not change.`);
        return false;
      }
      userPresets = list;
      return true;
    } catch (error) {
      engine.reportError(`“${preset.name}” was not saved. ${failureReason(error)}`);
      return false;
    }
  }

  /**
   * Exported so Cmd/Ctrl+S opens this same flow.
   *
   * The shortcut must not build its own save: the branch below is the rule,
   * and a second path would have to reproduce it and then drift from it.
   */
  export async function beginSave() {
    if (busy || selected === null) return;
    if (selected.builtIn !== true) {
      // A user preset keeps its identity: same id, same name, new recipe.
      if (!isModified) return;
      busy = true;
      try {
        if (
          await persist({
            ...selected,
            params: { ...engine.params },
            soundscape: { ...engine.soundscape },
            masterLevel: engine.masterLevel,
          })
        ) {
          /*
           * The same handoff the copy path needs, for the same reason.
           *
           * This branch never opens the naming flow, so focus is still on the
           * Save button that was pressed — and a successful update disables it,
           * because the preset it just wrote is now clean. Moving focus first
           * is what keeps the keyboard off `<body>`.
           */
          await tick();
          focusFirst(picker, saveButton);
        }
      } finally {
        busy = false;
      }
      return;
    }
    draftName = `${selected.name} (edited)`;
    /*
     * Remember what opened this, and take the focus.
     *
     * Rendering the field is not the same as handing it the keyboard: focus
     * stayed on `<body>`, so typing went nowhere and the Escape handler on the
     * input — the only way out — never fired. Both entry points are covered
     * because both come through here, which is why the shortcut calls this
     * function rather than building its own flow.
     *
     * The seeded name is selected rather than merely present, so typing
     * replaces "Focus (edited)" instead of appending to it.
     */
    namingInvoker = document.activeElement as HTMLElement | null;
    naming = true;
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  /**
   * Leave the naming flow, and put the focus somewhere it can live.
   *
   * Abandoning returns it to whatever opened the flow, which is what a user
   * expects from Cancel and Escape. Succeeding cannot: saving replaces the
   * action group and the new Save button is disabled, so the picker takes it —
   * and the picker is the honest landing place anyway, because which preset is
   * selected is exactly what the save just changed.
   *
   * Every route ends at the picker if the preferred target cannot hold focus.
   * It is the one control in this group that is always present and never
   * disabled.
   */
  async function closeNaming(land: 'invoker' | 'picker' = 'invoker') {
    naming = false;
    const invoker = namingInvoker;
    namingInvoker = null;
    await tick();
    if (land === 'picker') focusFirst(picker, saveButton);
    else focusFirst(invoker === document.body ? null : invoker, saveButton, picker);
  }

  async function commitSave() {
    const name = draftName.trim();
    if (!name || busy) return;
    const preset: Preset = {
      id: newPresetId(),
      name,
      description: 'Saved from Studio.',
      params: { ...engine.params },
      soundscape: { ...engine.soundscape },
      masterLevel: engine.masterLevel,
      builtIn: false,
    };
    busy = true;
    try {
      if (await persist(preset)) {
        selectedId = preset.id;
        await closeNaming('picker');
      }
    } finally {
      busy = false;
    }
  }

  /**
   * Delete the selected user preset, then stand somewhere defined.
   *
   * Selection moves to Focus, and the audible recipe is deliberately *not*
   * reapplied: deletion must leave a defined surviving identity without changing
   * the sound a second time. So what was playing keeps playing, and it reads as
   * Modified against Focus — which is exactly what it is.
   */
  async function performDelete() {
    if (!canDelete || selected === null || busy) return;
    busy = true;
    deleteError = null;
    try {
      const name = selected.name;
      const id = selected.id;
      const list = await presetStore.remove(id);
      if (list.some((p) => p.id === id)) {
        await failDelete(`“${name}” was not deleted. It is still in the stored presets.`);
        return;
      }
      userPresets = list;
      selectedId = DEFAULT_PRESET_ID;
      /*
       * Closed through the dialog, then focus placed deliberately.
       *
       * `confirmingDelete = false` on its own unmounts the `<dialog>` without
       * the native close running, which is the defect that once left the
       * Settings dialog's own Close button dropping focus on `<body>`. And the
       * invoker cannot take it back here anyway: Delete is disabled the moment
       * selection falls back to a built-in. The picker is the honest landing
       * place, because which preset is selected is exactly what just changed.
       */
      deleteDialog?.close();
      await tick();
      focusFirst(picker);
    } catch (error) {
      await failDelete(`“${selected.name}” was not deleted. ${failureReason(error)}`);
    } finally {
      busy = false;
    }
  }

  /**
   * Report a failed delete inside the dialog, and move focus to it.
   *
   * The dialog stays open on purpose: the preset is still there, the target is
   * still named on screen, and cancelling or retrying are both one key away.
   * Focus moves to the message because the button that was pressed is disabled
   * while the attempt runs, and a disabled control drops the focus it held —
   * which is how focus ended up on `<body>` with an unreachable banner behind
   * a backdrop.
   */
  async function failDelete(message: string): Promise<void> {
    deleteError = message;
    await tick();
    deleteAlert?.focus();
  }

  /*
   * Publish the description and the modified state for the header to render.
   *
   * Written only when they actually change: an effect that assigns on every
   * run would re-trigger on its own write, which is the `effect_update_depth`
   * trap this repo has hit before.
   */
  $effect(() => {
    const next = selected?.description ?? '';
    if (next !== description) description = next;
  });

  $effect(() => {
    if (isModified !== modified) modified = isModified;
  });

  /**
   * Subscribed, not listed once.
   *
   * The store's own contract is that a subscriber receives the current value
   * immediately and every later change, and both windows can be showing while
   * one of them saves. A single `list()` answers once and then goes stale, so
   * a preset saved elsewhere would be missing from this picker until a reload —
   * and Modified would be comparing against a preset that no longer exists.
   */
  $effect(() => {
    engine.applyPreset(DEFAULT_PRESET);
    return presetStore.subscribe((saved) => {
      userPresets = saved;
    });
  });
</script>

<div class="presets">
  {#if naming}
    <input
      bind:this={nameInput}
      type="text"
      bind:value={draftName}
      placeholder="Preset name"
      aria-label="Preset name"
      onkeydown={(e) => {
        if (e.key === 'Enter') commitSave();
        if (e.key === 'Escape') closeNaming();
      }}
    />
    <button onclick={commitSave} disabled={!draftName.trim() || busy}>Save</button>
    <button onclick={() => closeNaming()}>Cancel</button>
  {:else}
    <select
      bind:this={picker}
      aria-label="Preset"
      aria-describedby={description ? 'preset-description' : undefined}
      value={selectedId}
      onchange={(e) => apply(e.currentTarget.value)}
    >
      <optgroup label="Built in">
        {#each BUILT_IN_PRESETS as preset (preset.id)}
          <option value={preset.id}>{preset.name}</option>
        {/each}
      </optgroup>
      {#if userPresets.length > 0}
        <optgroup label="Saved">
          {#each userPresets as preset (preset.id)}
            <option value={preset.id}>{preset.name}</option>
          {/each}
        </optgroup>
      {/if}
    </select>
    <button bind:this={saveButton} onclick={beginSave} disabled={!canSave || busy} title={saveTitle}
      >{saveLabel}</button
    >
    <button
      onclick={() => {
        deleteError = null;
        confirmingDelete = true;
      }}
      disabled={!canDelete || busy}
      title={canDelete ? `Delete “${selected?.name ?? ''}”` : 'Built-in presets cannot be deleted'}
    >
      Delete
    </button>
  {/if}
</div>

<!--
  The confirmation names its target, and cancelling changes nothing.

  A native `<dialog>` rather than a platform message box: this app runs in the
  browser as well as in Electron and the two must behave the same, and
  `Dialog.svelte` already supplies the modal's focus trap, Escape handling and
  return of focus to whatever opened it.
-->
<Dialog
  bind:this={deleteDialog}
  title="Delete preset"
  open={confirmingDelete}
  onclose={() => {
    confirmingDelete = false;
    deleteError = null;
  }}
>
  <p class="confirm">
    Delete <strong>{selected?.name ?? ''}</strong>? This cannot be undone.
  </p>
  {#if deleteError}
    <!-- `tabindex="-1"` so focus can be moved here without making it a tab
         stop; `role="alert"` so it is announced without waiting for focus. -->
    <p class="delete-error" role="alert" tabindex="-1" bind:this={deleteAlert}>{deleteError}</p>
  {/if}
  <div class="confirm-actions">
    <button onclick={() => deleteDialog?.close()} disabled={busy}>Cancel</button>
    <button class="danger" onclick={performDelete} disabled={busy}>Delete preset</button>
  </div>
</Dialog>

<style>
  .presets {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  /*
   * The picker takes the spare width up to a point, and the actions keep
   * their hit target. Capped because a preset name is a short string: letting
   * it run the width of a 1440px window makes the header look empty rather
   * than generous, and the responsive contract asks for a sensible maximum
   * rather than "fills the window".
   *
   * `text-overflow` on a `<select>` is what truncates a long saved name: the
   * control keeps its width and the name ellipsizes inside it, rather than the
   * picker growing until it pushes Save and Delete off the row.
   */
  select {
    min-width: 150px;
    max-width: 420px;
    flex: 1 1 auto;
    height: 42px;
    text-overflow: ellipsis;
  }

  input[type='text'] {
    min-width: 150px;
    max-width: 420px;
    flex: 1 1 auto;
    height: 42px;
  }

  .presets button {
    height: 42px;
    flex: none;
    white-space: nowrap;
  }

  .confirm {
    margin: 0 0 16px;
    max-width: 46ch;
  }

  .confirm strong {
    /* The name, not the sentence, is what the reader has to check. */
    color: var(--text);
  }

  .delete-error {
    margin: 0 0 16px;
    padding: 10px 12px;
    max-width: 46ch;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--danger-surface);
    color: var(--text);
    font-size: 13px;
  }

  .delete-error:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-actions button {
    min-height: 36px;
  }

  .confirm-actions .danger {
    color: var(--on-danger);
    background: var(--danger);
    border-color: var(--danger);
  }
</style>
