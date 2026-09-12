/**
 * Which global shortcut, if any, a keystroke should trigger.
 *
 * Pure, and deliberately not a DOM listener: the whole difficulty here is
 * *when not to act*, and that is a decision about the focused element rather
 * than about the key. Expressed as a function over a described target, every
 * case that matters can be tested in Node — including the ones that are
 * awkward to reach by hand, like a keystroke arriving while a native dialog
 * owns interaction.
 *
 * The contract, from the approved design:
 *
 * - Space toggles preview, but only when focus is outside every interactive or
 *   editable element and no dialog is open. Space on a focused button must
 *   operate that button and nothing else — a duration button that also started
 *   preview would be two actions from one press.
 * - Command or Control + S opens the preset save flow, under the same
 *   constraints, and never while the preset name is being typed.
 * - Bare `S` does nothing at all. It is a letter, and letters belong to
 *   whatever is focused.
 *
 * Reconciled with what already owns keys in this app: the Electron menu keeps
 * only `appMenu`, `editMenu` and Window on macOS — Cmd+Q/H/Z/X/C/V/A/M/W, none
 * of which this touches — and the global hotkey is CommandOrControl+Shift+F.
 * Neither Space nor Cmd/Ctrl+S is spoken for. Both still need their default
 * suppressed when handled: Space scrolls the page, and Cmd/Ctrl+S in a browser
 * offers to save it.
 */

export type GlobalShortcut = 'toggle-preview' | 'save-preset';

/** The parts of the focused element that decide whether a key is ours. */
export interface ShortcutTarget {
  /** Uppercase, as `Element.tagName` reports it. */
  tagName: string;
  isContentEditable: boolean;
  /** An explicit ARIA role, when the element carries one. */
  role: string | null;
}

/** The parts of a keyboard event the contract is expressed in. */
export interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

/**
 * Elements that consume keys themselves.
 *
 * `SUMMARY` and `OPTION` are here because both take Space natively — a
 * disclosure toggles and an option selects — and `A` because a link activates
 * on Enter and must not become a transport control when it happens to be
 * focused. Media elements own their own transport keys.
 */
const INTERACTIVE_TAGS = new Set([
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'OPTION',
  'SUMMARY',
  'A',
  'AUDIO',
  'VIDEO',
  'EMBED',
  'OBJECT',
  'IFRAME',
]);

/**
 * Roles that make an ordinary element behave like a control.
 *
 * A `div` with `role="slider"` takes arrow keys and Space exactly as an
 * `input[type=range]` does, and the user has no way to tell the two apart.
 * Checking the role as well as the tag is what stops the contract depending on
 * how a control happens to be built.
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'link',
  'treeitem',
]);

/** True when the focused element should keep the keystroke for itself. */
export function ownsKeystroke(target: ShortcutTarget | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable) return true;
  if (INTERACTIVE_TAGS.has(target.tagName)) return true;
  return target.role !== null && INTERACTIVE_ROLES.has(target.role);
}

/**
 * The shortcut a keystroke should trigger, or null to leave it alone.
 *
 * `dialogOpen` is passed rather than inferred because a native `<dialog>`
 * makes the rest of the document inert but does not change what
 * `document.activeElement` reports to a listener on `window` — so a keystroke
 * aimed at a dialog can still arrive here with a perfectly ordinary target.
 */
export function globalShortcutFor(
  key: ShortcutKey,
  target: ShortcutTarget | null,
  dialogOpen: boolean,
): GlobalShortcut | null {
  // Nothing global while a modal owns interaction. Escape and Tab are the
  // dialog's own, and everything else belongs to whatever it contains.
  if (dialogOpen) return null;
  if (ownsKeystroke(target)) return null;

  // Auto-repeat is a held key, not a second press. Toggling playback sixty
  // times a second because a key was leaned on is not a transport control.
  if (key.repeat) return null;

  if (key.key === ' ' || key.key === 'Spacebar') {
    if (key.metaKey || key.ctrlKey || key.altKey || key.shiftKey) return null;
    return 'toggle-preview';
  }

  if (key.key.toLowerCase() === 's') {
    // Exactly one of the two, so Ctrl+Cmd+S — which is a system screenshot
    // modifier on macOS — is not claimed here.
    const oneModifier = key.metaKey !== key.ctrlKey;
    if (!oneModifier || key.altKey || key.shiftKey) return null;
    return 'save-preset';
  }

  return null;
}

/** Describe a DOM event target for `globalShortcutFor`. */
export function describeTarget(target: EventTarget | null): ShortcutTarget | null {
  if (target === null || !(target instanceof Element)) return null;
  return {
    tagName: target.tagName,
    isContentEditable: target instanceof HTMLElement && target.isContentEditable,
    role: target.getAttribute('role'),
  };
}
