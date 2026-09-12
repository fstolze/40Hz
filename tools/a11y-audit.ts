/**
 * The accessibility audit, performed by operating the product.
 *
 * `tools/check-layout.ts` already answers reachability and geometry — every
 * recipe control tabbable and at least 36px tall, no trapped scroll, header
 * wrapping where intended — at six widths in both themes. This asks the
 * questions that one deliberately does not: what the page *says* it is, where
 * focus goes when a dialog opens and closes, whether the keyboard contract
 * survives being typed at, and whether the product still works magnified and
 * with motion turned off.
 *
 * Written as an interaction audit rather than a source review because source
 * coverage is insufficient: `src/renderer/lib/shortcuts.ts` is a pure function
 * with sixteen unit tests and they all pass whether or not anything calls it.
 *
 *   npm run build && node tools/a11y-audit.ts
 */

import { _electron as electron, type Page } from 'playwright';
import { join } from 'node:path';

const REPO = process.cwd();
const LAUNCH_TIMEOUT_MS = 60_000;

let failures = 0;
let checks = 0;

function report(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `   ${detail}`}`);
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Where the keyboard is, in a form that reads in a report. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return 'body';
    const name =
      el.getAttribute('aria-label') ??
      (el.textContent ?? '').trim().slice(0, 30) ??
      el.getAttribute('id') ??
      '';
    return `${el.tagName.toLowerCase()}${name === '' ? '' : `[${name}]`}`;
  });
}

/** Whether the transport is offering to start or to stop. */
async function transport(page: Page): Promise<'preview' | 'stop'> {
  return (await page.getByRole('button', { name: /^Preview/ }).count()) > 0 ? 'preview' : 'stop';
}

const app = await electron.launch({
  args: [join(REPO, 'e2e/bootstrap.mjs')],
  cwd: REPO,
  timeout: LAUNCH_TIMEOUT_MS,
});
await app.firstWindow();
const page = await until('the Studio window', async () => {
  const found = app.windows().find((w) => w.url().endsWith('index.html'));
  return found ?? null;
});
await page.waitForLoadState('domcontentloaded');

const size = async (w: number, h: number) => {
  await app.evaluate(
    ({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()
        .find((b) => b.webContents.getURL().endsWith('index.html'))
        ?.setContentSize(width, height);
    },
    [w, h],
  );
  await until(`the window at ${w}`, async () =>
    (await page.evaluate(() => window.innerWidth)) === w ? true : null,
  );
};

try {
  await size(1440, 1024);
  console.log('\n40 Hz — accessibility audit\n');

  console.log('landmarks and document structure');
  const structure = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
      level: Number(h.tagName.slice(1)),
      text: (h.textContent ?? '').trim().slice(0, 40),
    }));
    return {
      main: document.querySelectorAll('main').length,
      nav: Array.from(document.querySelectorAll('nav')).map(
        (n) => n.getAttribute('aria-label') ?? '(unlabelled)',
      ),
      headings,
      current: Array.from(document.querySelectorAll('[aria-current]')).map(
        (e) => `${(e.textContent ?? '').trim()}=${e.getAttribute('aria-current')}`,
      ),
      live: Array.from(document.querySelectorAll('[aria-live], [role=status], [role=alert]'))
        .length,
    };
  });
  report(structure.main === 1, 'exactly one main landmark', `${structure.main}`);
  report(
    structure.nav.length >= 1,
    'the destinations are a labelled nav',
    structure.nav.join(', '),
  );
  report(
    structure.headings.filter((h) => h.level === 1).length === 1,
    'exactly one h1',
    structure.headings
      .filter((h) => h.level === 1)
      .map((h) => h.text)
      .join(''),
  );
  // No skipped levels: an h4 under an h2 leaves a screen-reader's outline with
  // a hole in it, and nothing on screen says so.
  let skips = '';
  for (let i = 1; i < structure.headings.length; i += 1) {
    const jump = structure.headings[i].level - structure.headings[i - 1].level;
    if (jump > 1) skips += `${structure.headings[i - 1].text}→${structure.headings[i].text} `;
  }
  report(skips === '', 'the heading outline skips no level', skips);
  report(
    structure.current.length === 1,
    'the active destination is aria-current',
    structure.current.join(', '),
  );
  report(structure.live > 0, 'the page has a status region', `${structure.live}`);

  console.log('\nnames, values and descriptions');
  const naming = await page.evaluate(() => {
    const accessibleName = (el: Element): string => {
      const label = el.getAttribute('aria-label');
      if (label !== null && label.trim() !== '') return label.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by !== null) {
        const text = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (text !== '') return text;
      }
      if (el.id !== '') {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forLabel !== null) return (forLabel.textContent ?? '').trim();
      }
      const wrapping = el.closest('label');
      if (wrapping !== null) return (wrapping.textContent ?? '').trim();
      const title = el.getAttribute('title');
      if (title !== null && title.trim() !== '') return title.trim();
      return (el.textContent ?? '').trim();
    };

    const controls = Array.from(
      document.querySelectorAll('button, input, select, textarea, [role=slider], [role=button]'),
    );
    const unnamed = controls
      .filter((c) => accessibleName(c) === '')
      .map((c) => c.outerHTML.slice(0, 90));

    // An icon-only button is one whose only child is an svg: its text content
    // is empty, so it lives or dies by aria-label.
    const iconOnly = controls.filter(
      (c) => (c.textContent ?? '').trim() === '' && c.querySelector('svg') !== null,
    );
    const iconUnnamed = iconOnly.filter((c) => accessibleName(c) === '').length;

    // aria-describedby must point at something that exists, or it is silence.
    const dangling = Array.from(document.querySelectorAll('[aria-describedby]'))
      .flatMap((el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/))
      .filter((id) => id !== '' && document.getElementById(id) === null);

    const ranges = Array.from(document.querySelectorAll('input[type=range]')).map((r) => ({
      name: accessibleName(r),
      value: (r as HTMLInputElement).value,
      text: r.getAttribute('aria-valuetext'),
    }));

    return {
      total: controls.length,
      unnamed,
      iconOnly: iconOnly.length,
      iconUnnamed,
      dangling,
      ranges,
      unnamedRanges: ranges.filter((r) => r.name === '').length,
    };
  });
  report(
    naming.unnamed.length === 0,
    `all ${naming.total} controls have an accessible name`,
    naming.unnamed.join(' | '),
  );
  report(naming.iconUnnamed === 0, `all ${naming.iconOnly} icon-only actions are named`);
  report(
    naming.dangling.length === 0,
    'every aria-describedby resolves',
    naming.dangling.join(', '),
  );
  report(naming.unnamedRanges === 0, `all ${naming.ranges.length} ranges carry a name and a value`);
  /*
   * A range announces itself from its own number, which is not always the
   * value. Carrier's track is cents, so without `aria-valuetext` it says
   * "-1200" for 220 Hz — and the levels said "0.5" while displaying "-6.0 dB"
   * long before any of them was scaled. These were collected here and never
   * asserted on.
   */
  const mute = naming.ranges.filter((r) => (r.text ?? '').trim() === '');
  report(
    mute.length === 0,
    `all ${naming.ranges.length} ranges announce their readout, not their number`,
    mute.map((r) => r.name).join(', '),
  );

  console.log('\nfocus visibility, both themes');
  for (const theme of ['dark', 'light'] as const) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('group', { name: 'Colour scheme' })
      .getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light' })
      .click();
    await until(`the ${theme} theme`, async () =>
      (await page.evaluate(() => document.documentElement.dataset.theme)) === theme ? true : null,
    );
    await page.getByRole('button', { name: 'Close' }).click();
    await until('the dialog to close', async () =>
      (await page.locator('dialog[open]').count()) === 0 ? true : null,
    );

    /*
     * Tabbed to, not focused programmatically.
     *
     * `:focus-visible` is a heuristic about *how* focus arrived: an
     * `element.focus()` call from script does not satisfy it, so a probe that
     * focuses that way reads the resting style twice and calls the ring
     * missing. Pressing Tab is both the honest test and the only one that can
     * fail for the right reason.
     */
    const resting = await page.evaluate(() => {
      const button = document.querySelector('nav button');
      if (button === null) return null;
      const st = getComputedStyle(button);
      return `${st.outlineStyle} ${st.outlineWidth} ${st.outlineColor} ${st.boxShadow}`;
    });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      const st = getComputedStyle(el);
      return {
        style: `${st.outlineStyle} ${st.outlineWidth} ${st.outlineColor} ${st.boxShadow}`,
        visible: el.matches(':focus-visible'),
        tag: el.tagName.toLowerCase(),
      };
    });
    report(
      active !== null && active.visible && active.style !== resting,
      `focus is visibly indicated in ${theme}`,
      active === null ? 'nothing focused' : `${active.tag}: ${active.style}`,
    );
  }

  console.log('\nkeyboard traversal of the whole shell');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const ring: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Tab');
    ring.push(await focused(page));
  }
  const distinct = new Set(ring);
  report(
    distinct.size > 15,
    'tabbing reaches many distinct controls',
    `${distinct.size} of 60 presses`,
  );
  report(!ring.slice(3).every((r) => r === ring[3]), 'the keyboard is not trapped on one control');
  const reachedNav = ring.some((r) => /History|Studio/.test(r));
  const reachedTransport = ring.some((r) => /Preview|Stop/.test(r));
  const reachedSettings = ring.some((r) => /Settings/.test(r));
  report(
    reachedNav && reachedTransport && reachedSettings,
    'the header destinations, transport and Settings are all reachable',
  );

  console.log('\nfocus return from dialogs');
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await settingsButton.focus();
  await page.keyboard.press('Enter');
  await until('the Settings dialog', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  const insideDialog = await page.evaluate(
    () => document.querySelector('dialog[open]')?.contains(document.activeElement) ?? false,
  );
  report(insideDialog, 'opening a dialog moves focus into it', await focused(page));
  await page.keyboard.press('Escape');
  await until('the dialog to close', async () =>
    (await page.locator('dialog[open]').count()) === 0 ? true : null,
  );
  report(
    /Settings/.test(await focused(page)),
    'Escape returns focus to the invoker',
    await focused(page),
  );

  const integrity = page.locator('.integrity');
  await integrity.focus();
  await page.keyboard.press('Enter');
  await until('the integrity dialog', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  await page.keyboard.press('Escape');
  await until('it to close', async () =>
    (await page.locator('dialog[open]').count()) === 0 ? true : null,
  );
  report(
    /integrity|Currently checked|Checks/i.test(await focused(page)),
    'the integrity row gets its focus back',
    await focused(page),
  );

  console.log('\nthe shortcut contract, typed at the running product');
  /*
   * Make sure the window is actually receiving keys before blaming the product.
   *
   * One run in six failed every keyboard check at once — Space did not start
   * Preview *and* Space on a focused button did not activate it, and the second
   * of those is Chromium's own behaviour, not this app's. Nothing had ignored a
   * shortcut; no key event had arrived, because the window did not hold the
   * keyboard after the previous Electron instances shut down. A probe that
   * reports that as six product defects is worse than no probe, so delivery is
   * established first and a failure here is named for what it is.
   */
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((b) =>
      b.webContents.getURL().endsWith('index.html'),
    );
    win?.show();
    win?.focus();
  });
  await page.waitForTimeout(300);
  const keysArrive = await (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Tab');
      const moved = await page.evaluate(
        () => document.activeElement !== null && document.activeElement !== document.body,
      );
      if (moved) return true;
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((b) => b.webContents.getURL().endsWith('index.html'))
          ?.focus();
      });
      await page.waitForTimeout(500);
    }
    return false;
  })();
  report(keysArrive, 'the window is receiving keystrokes at all');
  if (!keysArrive) {
    throw new Error(
      'keystrokes are not reaching the window — this is the harness, not the product; ' +
        'nothing below would mean anything, so the shortcut contract was not tested',
    );
  }
  const settle = async () => page.waitForTimeout(500);
  /*
   * Preview does not stop the instant it is asked: the envelope fades over
   * roughly 1.7 s and the transport keeps saying "Stop" until the coordinator
   * reports it idle. A fixed sleep samples inside that fade and reads the
   * wrong answer — an earlier version of this audit reported four product
   * defects that were all this one probe mistake.
   */
  const awaitTransport = async (want: 'preview' | 'stop') => {
    /*
     * Generous, and it reports how long it actually took.
     *
     * The first Preview of a launch builds the audio graph and loads the
     * worklets, which on a loaded machine is seconds rather than milliseconds —
     * a 6 s window failed roughly one run in three, and a probe that flakes is
     * worse than no probe, because the next person cannot tell a slow start
     * from a real defect. The elapsed time is printed so that question is
     * answerable from the output rather than guessed at.
     */
    const began = Date.now();
    try {
      await until(
        `the transport to say ${want}`,
        async () => ((await transport(page)) === want ? true : null),
        20_000,
      );
      lastWait = Date.now() - began;
      return true;
    } catch {
      lastWait = Date.now() - began;
      return false;
    }
  };
  let lastWait = 0;

  // Space with nothing focused toggles preview.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const before = await transport(page);
  await page.keyboard.press(' ');
  const started = await awaitTransport('stop');
  report(
    before === 'preview' && started,
    'Space starts Preview when nothing owns the key',
    `${lastWait} ms to start`,
  );
  await page.keyboard.press(' ');
  const stopped = await awaitTransport('preview');
  report(stopped, 'Space stops it again, once the fade completes', `${lastWait} ms to stop`);

  /*
   * Space on a focused button operates that button, and only that button.
   *
   * Both halves are asserted rather than one, because the two ways this breaks
   * look nothing alike: a global handler that fires *as well* leaves the
   * transport running, and one that fires *instead* suppresses the button's own
   * activation so the navigation never happens. Reported rather than awaited —
   * an exception here would abort the rest of the contract, and it is the half
   * that fails which says what went wrong.
   */
  const historyButton = page.getByRole('button', { name: 'History', exact: true });
  await historyButton.focus();
  await page.keyboard.press(' ');
  const navBegan = Date.now();
  const navigated = await until(
    'the History view',
    async () => ((await page.locator('.history-view').count()) > 0 ? true : null),
    20_000,
  ).catch(() => false);
  report(
    navigated === true,
    'Space on a focused button activates that button',
    `${Date.now() - navBegan} ms to navigate`,
  );
  report(
    (await transport(page)) === 'preview',
    'Space on a focused button does not also start Preview',
  );
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  await until('Studio', async () => ((await page.locator('.recipe').count()) > 0 ? true : null));

  // Space on a range adjusts the range, not the transport.
  const carrier = page.getByRole('slider', { name: /Carrier/ }).first();
  await carrier.focus();
  await page.keyboard.press(' ');
  await settle();
  report((await transport(page)) === 'preview', 'Space on a slider leaves the transport alone');

  // Space while a dialog owns interaction.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await until('the dialog', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  await page.keyboard.press(' ');
  await settle();
  report((await transport(page)) === 'preview', 'Space does nothing while a dialog is open');
  await page.keyboard.press('Escape');
  await until('it to close', async () =>
    (await page.locator('dialog[open]').count()) === 0 ? true : null,
  );

  // Bare S is inert.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('s');
  await settle();
  report(
    (await page.locator('dialog[open]').count()) === 0 && (await transport(page)) === 'preview',
    'bare S does nothing at all',
  );

  // Cmd/Ctrl+S opens the save flow, and does not re-fire while typing a name.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+s`);
  const namingField = await until('the naming field', async () =>
    (await page.getByLabel('Preset name', { exact: true }).count()) > 0 ? true : null,
  ).catch(() => false);
  report(namingField === true, 'Cmd/Ctrl+S opens the preset save flow');
  if (namingField === true) {
    const field = page.getByLabel('Preset name', { exact: true });
    report(
      await field.evaluate((el) => el === document.activeElement),
      'the naming field has the keyboard',
    );
    await page.keyboard.type('Audit');
    await page.keyboard.press(`${modifier}+s`);
    await settle();
    report(
      (await field.inputValue()) === 'Audit' && (await field.count()) === 1,
      'Cmd/Ctrl+S while typing a name does not re-enter the flow',
    );
    await page.keyboard.press('Escape');
    await settle();
  }

  console.log('\n200% zoom at the canonical width');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((b) => b.webContents.getURL().endsWith('index.html'))
      ?.webContents.setZoomFactor(2);
  });
  await page.waitForTimeout(600);
  const zoomed = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    layers: document.querySelectorAll('.recipe .layer').length,
    transport: document.querySelector('.transport button') !== null,
  }));
  report(zoomed.overflow <= 1, 'no horizontal overflow at 200%', `${zoomed.overflow}px`);
  report(zoomed.layers === 3, 'all three recipe layers still render at 200%');
  // Reachability is the real question: scrolled-to is fine, clipped-away is not.
  const reachableZoomed = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('.recipe input, .recipe button'));
    const scroller = document.querySelector('.workspace') ?? document.scrollingElement;
    return controls.filter((c) => {
      const r = c.getBoundingClientRect();
      const s = scroller?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
      return r.width === 0 || r.right < s.left - 1 || r.left > s.right + 1;
    }).length;
  });
  report(reachableZoomed === 0, 'no recipe control is clipped horizontally at 200%');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((b) => b.webContents.getURL().endsWith('index.html'))
      ?.webContents.setZoomFactor(1);
  });
  await page.waitForTimeout(400);

  console.log('\nreduced motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  const motion = await page.evaluate(() => {
    const durations = Array.from(document.querySelectorAll('button, .layer, .badge, dialog'))
      .map((el) => getComputedStyle(el))
      .flatMap((s) => [s.transitionDuration, s.animationDuration])
      .flatMap((v) => v.split(',').map((p) => parseFloat(p.trim())))
      .filter((n) => Number.isFinite(n));
    return {
      longest: durations.length === 0 ? 0 : Math.max(...durations),
      honoured: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });
  report(motion.honoured, 'the renderer sees the reduced-motion preference');
  report(
    motion.longest <= 0.06,
    'nonessential transitions are suppressed',
    `longest ${motion.longest}s`,
  );
  // Truthful state must survive: the transport still says what it would do.
  report((await transport(page)) === 'preview', 'state text is still truthful with motion off');
  await page.emulateMedia({ reducedMotion: null });

  // Leave nothing playing.
  if ((await transport(page)) === 'stop') {
    await page.getByRole('button', { name: /^Stop/ }).click();
    await settle();
  }
} finally {
  await app.close().catch(() => undefined);
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
