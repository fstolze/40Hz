<script lang="ts" generics="T extends string">
  interface Option {
    value: T;
    label: string;
    title?: string;
  }

  interface Props {
    label?: string;
    options: Option[];
    value: T;
    disabled?: boolean;
    onchange: (value: T) => void;
  }

  let { label, options, value, disabled = false, onchange }: Props = $props();
</script>

<div class="group" class:disabled>
  {#if label}<span class="label">{label}</span>{/if}
  <div class="segments" role="group" aria-label={label ?? 'options'}>
    {#each options as option (option.value)}
      <button
        type="button"
        class:active={option.value === value}
        title={option.title}
        {disabled}
        aria-pressed={option.value === value}
        onclick={() => onchange(option.value)}
      >
        {option.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* Part by part, for the reason in Slider: the label has to stay readable. */
  .group.disabled .label {
    color: var(--text-disabled);
  }

  .group.disabled .segments {
    background: var(--bg-soft);
    border-color: var(--border);
  }

  .label {
    color: var(--text-dim);
    font-size: 13px;
  }

  .segments {
    display: flex;
    gap: 0;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2px;
  }

  /* 36px tall, because the visible segment and the hit region are the same
     box here — there is no larger invisible target behind it to rely on. */
  button {
    flex: 1;
    min-height: 36px;
    border: none;
    background: transparent;
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    color: var(--text-dim);
    white-space: nowrap;
  }

  button:hover:not(:disabled) {
    background: var(--bg-raised);
    color: var(--text);
  }

  /* The layer's accent, or the signal family outside one. See RecipeLayer. */
  button.active {
    background: var(--layer-accent-strong, var(--signal-strong));
    color: var(--layer-on-accent, var(--on-signal));
  }

  button.active:hover:not(:disabled) {
    background: var(--layer-accent-strong, var(--signal-strong));
  }

  button:disabled {
    background: transparent;
    border: none;
    color: var(--text-disabled);
  }

  /* The selected segment still reads as selected while the group is disabled,
     so turning a layer off does not also lose which mode it was in. */
  button.active:disabled {
    background: var(--bg-raised);
    color: var(--text-disabled);
  }
</style>
