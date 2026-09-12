/**
 * The global keyboard contract.
 *
 * Every case here is a way the shortcut could reach something it must not.
 * The interesting assertions are the negative ones: a transport control that
 * fires while the user is typing, or a second time because Space also
 * activated the focused button, is worse than no shortcut at all.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  globalShortcutFor,
  ownsKeystroke,
  type ShortcutKey,
  type ShortcutTarget,
} from '../src/renderer/lib/shortcuts.ts';

const SPACE: ShortcutKey = {
  key: ' ',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
};
const CMD_S: ShortcutKey = { ...SPACE, key: 's', metaKey: true };
const CTRL_S: ShortcutKey = { ...SPACE, key: 's', ctrlKey: true };

/** Focus on nothing in particular — the body, which is the normal case. */
const BODY: ShortcutTarget = { tagName: 'BODY', isContentEditable: false, role: null };
const tag = (tagName: string): ShortcutTarget => ({
  tagName,
  isContentEditable: false,
  role: null,
});
const role = (name: string): ShortcutTarget => ({
  tagName: 'DIV',
  isContentEditable: false,
  role: name,
});

describe('Space as a transport control', () => {
  it('toggles preview when nothing else wants the key', () => {
    expect(globalShortcutFor(SPACE, BODY, false)).toBe('toggle-preview');
    expect(globalShortcutFor(SPACE, null, false)).toBe('toggle-preview');
  });

  it('leaves the key to any focused control', () => {
    // The case that motivated the contract: Space on a focused duration button
    // must press that button, and must not *also* start preview.
    for (const name of ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SUMMARY', 'A']) {
      expect(globalShortcutFor(SPACE, tag(name), false)).toBe(null);
    }
  });

  it('leaves the key to anything merely behaving like a control', () => {
    // A div with role="slider" takes Space exactly as a range input does, and
    // the user cannot tell which they are focused on.
    for (const name of ['button', 'slider', 'textbox', 'combobox', 'switch', 'option', 'tab']) {
      expect(globalShortcutFor(SPACE, role(name), false)).toBe(null);
    }
  });

  it('leaves the key to an editable region', () => {
    expect(
      globalShortcutFor(SPACE, { tagName: 'DIV', isContentEditable: true, role: null }, false),
    ).toBe(null);
  });

  it('does nothing while a dialog owns interaction', () => {
    // A native dialog makes the page inert but does not change what a window
    // listener sees, so the target can look perfectly ordinary.
    expect(globalShortcutFor(SPACE, BODY, true)).toBe(null);
  });

  it('ignores a held key', () => {
    // Auto-repeat is one press, not sixty. Toggling playback at the repeat
    // rate is not a transport control.
    expect(globalShortcutFor({ ...SPACE, repeat: true }, BODY, false)).toBe(null);
  });

  it('ignores Space with any modifier', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      expect(globalShortcutFor({ ...SPACE, [modifier]: true }, BODY, false)).toBe(null);
    }
  });
});

describe('saving a preset from the keyboard', () => {
  it('answers to Command or Control and S', () => {
    expect(globalShortcutFor(CMD_S, BODY, false)).toBe('save-preset');
    expect(globalShortcutFor(CTRL_S, BODY, false)).toBe('save-preset');
    expect(globalShortcutFor({ ...CMD_S, key: 'S' }, BODY, false)).toBe('save-preset');
  });

  it('is inert as a bare letter', () => {
    // `S` is a letter. A global action on an unmodified letter would fire
    // while someone typed a preset name with the field not yet focused.
    expect(globalShortcutFor({ ...SPACE, key: 's' }, BODY, false)).toBe(null);
  });

  it('does not claim both modifiers together', () => {
    // Ctrl+Cmd+S is a screenshot modifier on macOS, and a chord this app did
    // not ask for is one it should not answer.
    expect(globalShortcutFor({ ...CMD_S, ctrlKey: true }, BODY, false)).toBe(null);
  });

  it('does not fire while the preset name is being typed', () => {
    // The name field is a text input, so the general rule already covers it —
    // asserted directly because it is the case the contract calls out.
    expect(globalShortcutFor(CMD_S, tag('INPUT'), false)).toBe(null);
  });

  it('does nothing while a dialog owns interaction', () => {
    expect(globalShortcutFor(CMD_S, BODY, true)).toBe(null);
  });

  it('ignores the chord with a further modifier', () => {
    expect(globalShortcutFor({ ...CMD_S, altKey: true }, BODY, false)).toBe(null);
    expect(globalShortcutFor({ ...CMD_S, shiftKey: true }, BODY, false)).toBe(null);
  });
});

describe('other keys', () => {
  it('are never claimed', () => {
    for (const key of ['a', 'Enter', 'Escape', 'Tab', 'ArrowLeft', 'p', 'k']) {
      expect(globalShortcutFor({ ...SPACE, key }, BODY, false)).toBe(null);
    }
  });
});

describe('deciding whether a target owns its keystroke', () => {
  it('says no for ordinary containers', () => {
    for (const name of ['BODY', 'DIV', 'SECTION', 'P', 'MAIN', 'H1']) {
      expect(ownsKeystroke(tag(name))).toBe(false);
    }
  });

  it('says no when there is no target at all', () => {
    expect(ownsKeystroke(null)).toBe(false);
  });
});
