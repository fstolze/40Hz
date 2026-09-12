/**
 * Can every control actually be reached?
 *
 * This exists because the check it replaces could not answer that. The old one
 * asked whether each control's label was *in the DOM*, which is true of a
 * control clipped to two pixels inside a container that cannot scroll — and
 * that is precisely what shipped: at the 900px minimum the recipe's box was
 * 2px tall while its layers needed 1248, `main` reported 80px of scroll range,
 * and every recipe control was present, invisible and unreachable. Presence is
 * not reachability, and an assertion that cannot tell them apart is worse than
 * none because it is quoted as evidence.
 *
 *   npm run build && npm run check:layout
 *
 * Exits non-zero on the first failure, so it can gate a stage.
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCH_TIMEOUT_MS = 30_000;

/**
 * The width at which the header's two groups stop sharing a row.
 *
 * Not a guess and not a round number: the groups are sized to their real
 * min-content widths (600 + 590 + a 20px gap + 36px of padding), and sweeping
 * the window in 10px steps puts the break at 1240 and the single row at 1250.
 * The default window size in `electron/windows.ts` has to clear this, and that
 * file cannot see this one — hence the assertion below.
 */
const HEADER_SINGLE_ROW_PX = 1250;

/**
 * Every supported window size is a target, not a sample.
 *
 * 1800x1100 is not a supported size — it is the one past the top of the
 * range, included because that is where a layout with no upper bound comes
 * apart, and a check that only ever looks at sizes the design was drawn for
 * cannot see it happen.
 */
const VIEWPORTS: [string, number, number][] = [
  ['1800x1100', 1800, 1100],
  ['1440x1024', 1440, 1024],
  ['1280x840 (default)', 1280, 840],
  ['1180x840', 1180, 840],
  ['1100x800', 1100, 800],
  ['900x640', 900, 640],
];

declare global {
  interface Window {
    /** Installed by `installNaming`; see there for why it lives on the page. */
    __name(el: Element): string;
  }
}

/**
 * One way to name a control, defined on the page.
 *
 * Each assertion runs in its own `evaluate` closure, so a helper defined in
 * this file cannot be shared between them — the code is serialised, not
 * captured. Three private copies had already started drifting, which means a
 * failure reads differently depending on which check caught it. Installing
 * one function on the page fixes that; the page never navigates during a run,
 * so installing it once is enough.
 */
async function installNaming(studio: Page): Promise<void> {
  await studio.evaluate(() => {
    window.__name = (el: Element) => {
      const type = el.getAttribute('type');
      const cls = el.className.toString().split(' ')[0];
      const text =
        el.closest('.row')?.querySelector('label')?.textContent?.trim() ??
        el.getAttribute('aria-label') ??
        el.textContent?.trim().slice(0, 24) ??
        '';
      return `${el.tagName.toLowerCase()}${type ? `[${type}]` : ''}${cls ? `.${cls}` : ''} ${text}`.trim();
    };
  });
}

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}`);
    failures.push(what);
  }
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Switch the app's appearance the way a user does.
 *
 * Through Settings rather than by writing `data-theme`, because the point is
 * to check the layout the preference actually produces. Light and dark are
 * not the same layout for free: they differ in border weight and in the ink
 * that a hit test resolves to.
 */
async function applyAppearance(studio: Page, theme: 'dark' | 'light'): Promise<void> {
  await studio.getByRole('button', { name: 'Settings', exact: true }).click();
  await studio
    .getByRole('group', { name: 'Colour scheme' })
    .getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light' })
    .click();
  await until(`the ${theme} theme`, async () =>
    (await studio.evaluate(() => document.documentElement.dataset.theme)) === theme ? true : null,
  );
  await studio.getByRole('button', { name: 'Close' }).click();
  await studio.waitForTimeout(300);
}

/**
 * Tab to every recipe control, for real.
 *
 * Pointer reachability and keyboard reachability fail independently — a
 * control can be perfectly visible and skipped by the tab order, or in the
 * tab order and scrolled to somewhere the user cannot see. So this presses
 * the actual key, and records both which controls focus reached and whether
 * each one was in the viewport when it got there.
 */
async function keyboardTraversal(studio: Page): Promise<{ total: number; bad: string[] }> {
  const total = await studio.evaluate(() => {
    /*
     * Disabled controls are exempt, and only disabled ones.
     *
     * A disabled control is *correctly* outside the tab order, and in the
     * default recipe two of them are: Snap has nothing to do while the
     * carrier is already on the grid, and Two-tone level is silent while
     * routing is Off. Requiring focus on those would make the check red on
     * correct behaviour. Note that they are exempt from this assertion only —
     * the pointer pass still demands they be visible, because a disabled
     * control the user cannot see is a control whose state they cannot read.
     */
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('.recipe input, .recipe button, .recipe summary'),
    ).filter((el) => !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true');
    els.forEach((el, i) => el.setAttribute('data-kbd', String(i)));
    return els.length;
  });

  // Start above the recipe so the traversal is the one a user gets from the
  // top of the window, not from wherever the previous check left focus.
  await studio.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.querySelector('main')!.scrollTop = 0;
  });

  const inspectFocus = () =>
    studio.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const key = el?.getAttribute('data-kbd');
      if (el === null || key === null || key === undefined) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + r.height / 2),
      );
      const main = document.querySelector('main') as HTMLElement;
      const cue = document.querySelector('.scroll-cue') as HTMLElement | null;
      const mainBox = main.getBoundingClientRect();
      const cueBox = cue?.getBoundingClientRect() ?? null;
      return {
        key,
        visible:
          r.width > 0 &&
          r.height > 0 &&
          r.top >= 0 &&
          r.bottom <= window.innerHeight &&
          hit !== null &&
          (hit === el || el.contains(hit)),
        detail: `control ${Math.round(r.top)}–${Math.round(r.bottom)}, main ${Math.round(mainBox.top)}–${Math.round(mainBox.bottom)} at ${Math.round(main.scrollTop)}, cue ${cueBox === null ? 'absent' : `${Math.round(cueBox.top)}–${Math.round(cueBox.bottom)}`}, hit ${hit === null ? 'nothing' : window.__name(hit)}`,
      };
    });

  const reached = new Map<string, { visible: boolean; detail: string }>();
  for (let i = 0; i < 400 && reached.size < total; i += 1) {
    await studio.keyboard.press('Tab');
    let at = await inspectFocus();
    if (at !== null && !at.visible) {
      // Chromium can finish scrolling a newly focused descendant after the
      // key event resolves. Judge the landed focus, not that transient frame.
      await studio.waitForTimeout(50);
      at = await inspectFocus();
    }
    if (at !== null && !reached.has(at.key)) {
      reached.set(at.key, { visible: at.visible, detail: at.detail });
    }
  }

  const bad: string[] = [];
  const labels = await studio.evaluate(() =>
    Array.from(document.querySelectorAll('[data-kbd]')).map((el) => window.__name(el)),
  );
  for (let i = 0; i < total; i += 1) {
    const state = reached.get(String(i));
    if (state === undefined) bad.push(`${labels[i]} never receives focus`);
    else if (!state.visible)
      bad.push(`${labels[i]} focuses off-screen or covered (${state.detail})`);
  }
  await studio.evaluate(() =>
    document.querySelectorAll('[data-kbd]').forEach((el) => el.removeAttribute('data-kbd')),
  );
  return { total, bad };
}

/**
 * Put Two-tone into one of its routings, through the control.
 *
 * Routing is the one recipe setting that changes how much there is to lay
 * out: Binaural adds the headphones guidance and its disclosure, and that
 * disclosure is a control the default state does not render at all. Checking
 * only the state the app happens to start in would have left it unmeasured
 * while the summary said every control had been measured.
 */
async function applyRouting(studio: Page, label: 'Off' | 'Binaural'): Promise<void> {
  await studio
    .getByRole('group', { name: 'Routing' })
    .getByRole('button', { name: label, exact: true })
    .click();
  await studio.waitForTimeout(200);
}

/** The widths this project supports plus the default, for the session pass. */
const SESSION_WIDTHS: [string, number, number][] = [
  ['1440x1024', 1440, 1024],
  ['1280x840', 1280, 840],
  ['1100x800', 1100, 800],
  ['900x640', 900, 640],
];

async function resize(
  app: ElectronApplication,
  studio: Page,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()
        .find((b) => b.webContents.getURL().endsWith('index.html'))
        ?.setContentSize(w, h);
    },
    [width, height],
  );
  await until(`viewport ${width}`, async () =>
    (await studio.evaluate(() => window.innerWidth)) === width ? true : null,
  );
  await studio.waitForTimeout(350);
}

/**
 * The workspace is one column, and the analysis and the recipe both fill it.
 *
 * Written after a session was found to shatter the workspace into
 * `0px 646px 578px` — the charts collapsed to nothing, the recipe and the strip
 * standing side by side — because the Session root and its inner controls
 * shared the class `.running`, and the child's `grid-area: controls` therefore
 * landed on the root as well. It was inert while the workspace was a flex
 * container and became a defect when the workspace became a grid.
 *
 * The lesson for the assertion is that *any* stray `grid-area` on a workspace
 * child manufactures implicit columns, so the column count is the thing to
 * measure. Region widths are checked too, because a single column that some
 * child has still managed to narrow would otherwise pass.
 */
async function assertWorkspace(studio: Page, label: string, key: string): Promise<void> {
  const g = await studio.evaluate(() => {
    const ws = document.querySelector('.workspace:not([hidden])') as HTMLElement;
    /*
     * The content box, not the border box.
     *
     * The workspace carries 16px of horizontal padding, so its children
     * correctly stop 32px short of its outer width. Comparing against the outer
     * width made this assertion fail on a perfectly good layout — the first
     * version of it did exactly that at all four widths in both themes.
     */
    const pad = getComputedStyle(ws);
    const width = Math.round(
      ws.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
    );
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      return el === null ? null : Math.round(el.getBoundingClientRect().width);
    };
    const columns = getComputedStyle(ws).gridTemplateColumns.trim().split(/\s+/);
    const session = document.querySelector('.session') as HTMLElement;
    return {
      columns: columns.length,
      columnList: columns.join(' '),
      width,
      visualGrid: box('.visual-grid'),
      recipe: box('.recipe'),
      sessionDisplay: getComputedStyle(session).display,
      running: session.classList.contains('running'),
    };
  });
  check(g.columns === 1, `${label} ${key}: workspace is one column (${g.columnList})`);
  check(
    g.visualGrid === g.width,
    `${label} ${key}: analysis fills the workspace (${g.visualGrid} of ${g.width})`,
  );
  check(
    g.recipe === g.width,
    `${label} ${key}: recipe fills the workspace (${g.recipe} of ${g.width})`,
  );
  check(
    g.sessionDisplay === 'grid',
    `${label} ${key}: the strip keeps its own grid layout (${g.sessionDisplay})`,
  );
}

async function assertWorkspaceEverywhere(
  app: ElectronApplication,
  studio: Page,
  label: string,
): Promise<void> {
  for (const [key, width, height] of SESSION_WIDTHS) {
    await resize(app, studio, width, height);
    await assertWorkspace(studio, label, key);
  }
}

/**
 * Overflow has to announce itself before a person already knows to scroll.
 *
 * The recipe was pointer- and keyboard-reachable while still being absent from
 * the opening 900x640 screen, with an overlay scrollbar that did not paint
 * until the first wheel gesture. The reachability checks below cannot catch
 * that: they start by scrolling. This one stays at the top and requires the
 * continuation control whenever the Studio content is taller than its owner.
 */
async function assertInitialDiscoverability(
  studio: Page,
  label: string,
  width: number,
  height: number,
): Promise<void> {
  await studio.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelector('main')!.scrollTop = 0;
  });
  await studio.waitForTimeout(80);

  const result = await studio.evaluate(() => {
    const main = document.querySelector('main') as HTMLElement;
    const cue = document.querySelector('.scroll-cue') as HTMLElement | null;
    const footer = document.querySelector('footer') as HTMLElement;
    const target = document.getElementById('sound-recipe');
    const chart = document.querySelector('.visual-grid > *') as HTMLElement;
    const chartStyle = getComputedStyle(chart);
    const mainBox = main.getBoundingClientRect();
    const cueBox = cue?.getBoundingClientRect() ?? null;
    const footerBox = footer.getBoundingClientRect();
    return {
      overflowing: main.scrollHeight > main.clientHeight + 1,
      cueVisible: cueBox !== null && cueBox.width > 0 && cueBox.height > 0,
      cueHeight: cueBox?.height ?? 0,
      cueOutsideScrollport:
        cueBox === null || (cueBox.top >= mainBox.bottom - 1 && cueBox.bottom <= footerBox.top + 1),
      cueText: cue?.textContent?.trim() ?? '',
      cueTarget: cue?.getAttribute('aria-controls') ?? '',
      targetExists: target !== null,
      chartHeight: chart.getBoundingClientRect().height,
      chartMinHeight: parseFloat(chartStyle.minHeight),
    };
  });

  check(
    !result.overflowing || result.cueVisible,
    `${label}: overflowing Studio advertises more controls before scrolling`,
  );
  if (result.overflowing) {
    check(
      result.cueText === 'More recipe controls below',
      `${label}: the continuation cue says what is below`,
    );
    check(
      result.cueTarget === 'sound-recipe' && result.targetExists,
      `${label}: the continuation cue names a real recipe target`,
    );
    check(result.cueHeight >= 36, `${label}: the continuation cue is at least 36px tall`);
    check(
      result.cueOutsideScrollport,
      `${label}: the continuation cue does not cover scrollable content`,
    );
  }

  const [minimum, maximum] = width >= 1200 ? [200, 295] : width >= 1000 ? [190, 260] : [180, 230];
  const expectedChartFloor = Math.min(maximum, Math.max(minimum, height * 0.25));
  check(
    Math.abs(result.chartMinHeight - expectedChartFloor) <= 1,
    `${label}: charts use the height-aware floor (${Math.round(result.chartMinHeight)}px, expected ${Math.round(expectedChartFloor)}px)`,
  );
  check(
    result.chartHeight + 1 >= result.chartMinHeight && result.chartHeight <= maximum + 1,
    `${label}: chart content stays between its floor and breakpoint cap (${Math.round(result.chartHeight)}px, allowed ${Math.round(result.chartMinHeight)}–${maximum}px)`,
  );
}

/** The continuation control leads to, and focuses, the section it promises. */
async function checkContinuationNavigation(app: ElectronApplication, studio: Page): Promise<void> {
  await resize(app, studio, 900, 640);
  await studio.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelector('main')!.scrollTop = 0;
  });
  await until('the recipe continuation cue', async () =>
    (await studio.locator('.scroll-cue').count()) === 1 ? true : null,
  );
  await studio.evaluate(() =>
    (document.querySelector('.scroll-cue') as HTMLButtonElement | null)?.click(),
  );
  const moved = await until('the recipe heading to be revealed', async () => {
    const state = await studio.evaluate(() => {
      const main = document.querySelector('main') as HTMLElement;
      const heading = document.getElementById('sound-recipe-heading') as HTMLElement;
      const mainBox = main.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      return {
        scrollTop: main.scrollTop,
        focused: document.activeElement === heading,
        visible: headingBox.top >= mainBox.top && headingBox.bottom <= mainBox.bottom,
      };
    });
    return state.scrollTop > 0 && state.focused && state.visible ? state : null;
  });
  check(moved.focused, 'the continuation action focuses the Sound recipe heading');
  check(moved.visible, 'the continuation action reveals the Sound recipe heading');
}

/**
 * Every session state the workspace has to survive.
 *
 * `running` is one class for all of them — it is
 * `state === 'session-active' || state === 'session-ending'`, so ramping in,
 * stabilizing, the steady state and fading out are the same class and therefore
 * the same geometry. That is why this does not spend five real minutes reaching
 * the stabilized phase to look at a layout: one assertion while the class is
 * set covers the set, and the claim rests on the class rather than on a guess.
 */
/**
 * Text on the filled accent surfaces, measured rather than trusted.
 *
 * This is the assertion that would have caught FINAL-01. The dark selected
 * teal carried normal-size labels at 3.20:1 for three stages — on the active
 * destination and on the shape, routing and duration segments — and every gate
 * passed the whole time, because nothing measured colour. D-2 recorded the
 * number during the redesign and it still shipped, which is what an unasserted fact
 * does.
 *
 * Only the filled surfaces: those are where a label sits on an accent rather
 * than on a neutral background, and where a palette change can quietly drop
 * text below the floor. 4.5:1 throughout, because every one of these is normal
 * size — the largest is 14px.
 */
/**
 * The Session strip, with the longest text it can actually show.
 *
 * The four-part inline row gave the status track `auto`, which sizes to
 * max-content — and the status is a sentence. With a day's listening recorded
 * it reads "Listening time today under a minute", whose max-content is 715px,
 * and the track claimed that at every width from 1320 up. The controls track
 * is `minmax(0, 1fr)` and so yielded: the duration chips were squeezed from
 * 430px to 220px and then straight under the Start session button, with 45 and
 * 60 covered and unreachable.
 *
 * It needed a real recorded session to appear, which is why no capture and no
 * check had ever shown it — every one of them ran against a fresh profile
 * where the readout says "none" and the sentence is short enough to fit. So
 * this records one first.
 */
async function checkStripCrowding(app: ElectronApplication, studio: Page): Promise<void> {
  await studio.evaluate(async () => {
    const bridge = window.desktop;
    if (bridge === undefined) return;
    if ((await bridge.history.list()).length === 0) {
      await bridge.session.start({ presetId: 'focus', configuration: {}, plannedSeconds: 1 });
    }
  });
  await until('a day with listening time on it', async () =>
    (await studio.evaluate(
      () => !/Listening time today none/.test(document.body.textContent ?? ''),
    ))
      ? true
      : null,
  );

  /*
   * The widths where the four-part inline row applies — **and 1320 itself**,
   * which is not one of the supported viewports but is the breakpoint's own
   * edge and therefore the worst case. The original defect covered the 45 and
   * 60 chips at 1320 and nowhere above it: at 1440 the squeezed track still
   * measured 270px, wrong but not yet overlapping. A check that skipped the
   * boundary watched the mutation go by.
   */
  const widths: [string, number, number][] = [
    ['1320x900 (breakpoint edge)', 1320, 900],
    ...VIEWPORTS.filter(([, w]) => w >= 1320),
  ];
  for (const [key, width, height] of widths) {
    await resize(app, studio, width, height);
    const crowding = await studio.evaluate(() => {
      const strip = document.querySelector('.session');
      if (strip === null) return null;
      const box = strip.getBoundingClientRect();
      const action = document.querySelector('.action')?.getBoundingClientRect();
      const covered = Array.from(document.querySelectorAll<HTMLElement>('.durations button'))
        .filter((chip) => {
          const b = chip.getBoundingClientRect();
          return action !== undefined && b.width > 0 && b.right > action.left + 0.5;
        })
        .map((chip) => (chip.textContent ?? '').trim());
      const spilling = Array.from(strip.querySelectorAll<HTMLElement>('*'))
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && (b.right > box.right + 0.5 || b.left < box.left - 0.5);
        })
        .map((el) => el.className || el.tagName);
      return { covered, spilling };
    });
    check(crowding !== null, `${key}: the session strip is on screen`);
    if (crowding === null) continue;
    check(
      crowding.covered.length === 0,
      `${key}: no duration chip is covered by the action${crowding.covered.length ? ` — ${crowding.covered.join(', ')}` : ''}`,
    );
    check(
      crowding.spilling.length === 0,
      `${key}: nothing in the strip spills past it${crowding.spilling.length ? ` — ${crowding.spilling.slice(0, 3).join('; ')}` : ''}`,
    );
  }
}

async function checkContrast(studio: Page, theme: string): Promise<void> {
  const pairs = await studio.evaluate(() => {
    const lin = (c: number) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const rgb = (v: string) => (v.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
    const luminance = (v: string) => {
      const [r, g, b] = rgb(v);
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const found: { label: string; ratio: number; size: number }[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(
        'nav button, .segmented button, .durations button, .play',
      ),
    )) {
      const style = getComputedStyle(el);
      // Only the filled ones: an unfilled segment sits on the panel and is
      // covered by the ordinary text tokens.
      if (style.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
      if (el.getBoundingClientRect().width === 0) continue;
      found.push({
        label: (el.textContent ?? '').trim().slice(0, 18),
        ratio: Math.round(ratio(style.color, style.backgroundColor) * 100) / 100,
        size: parseFloat(style.fontSize),
      });
    }
    return found;
  });

  const failing = pairs.filter((p) => p.ratio < 4.5);
  check(pairs.length >= 3, `${theme}: found ${pairs.length} filled accent surfaces to measure`);
  check(
    failing.length === 0,
    `${theme}: every filled accent surface clears 4.5:1${
      failing.length === 0
        ? ` (lowest ${Math.min(...pairs.map((p) => p.ratio))}:1)`
        : ` — ${failing.map((f) => `"${f.label}" ${f.ratio}:1 at ${f.size}px`).join('; ')}`
    }`,
  );
}

async function checkSessionGeometry(
  app: ElectronApplication,
  studio: Page,
  theme: string,
): Promise<void> {
  console.log(`\n${theme} — workspace geometry through a session`);
  await assertWorkspaceEverywhere(app, studio, `${theme} idle`);

  const preview = studio.getByRole('banner').getByRole('button', { name: /Preview|Stop/ });
  await preview.click();
  await studio.waitForTimeout(900);
  await assertWorkspaceEverywhere(app, studio, `${theme} preview`);
  await preview.click();
  await studio.waitForTimeout(600);

  const strip = studio.getByLabel('Session');
  await strip.getByRole('button', { name: /Start session/ }).click();
  await until('the session to start', async () =>
    (await studio.evaluate(() =>
      document.querySelector('.session')?.classList.contains('running'),
    )) === true
      ? true
      : null,
  );
  await studio.waitForTimeout(1200);
  await assertWorkspaceEverywhere(app, studio, `${theme} active`);
  await assertCountdownAligned(app, studio, theme);

  // Sized *before* the stop, so the label is true. The fade is about a second
  // and a half; resizing inside it would report one width while measuring
  // another, which is the kind of quietly wrong evidence this file exists to
  // stop producing.
  await resize(app, studio, 1440, 1024);
  await strip.getByRole('button', { name: /Stop session/ }).click();
  // Inside the fade, while the state is `session-ending` and the class is still
  // set. One width only: the class is what drives the geometry, and the window
  // is too short to walk four sizes inside it.
  await studio.waitForTimeout(400);
  await assertWorkspace(studio, `${theme} ending`, '1440x1024');

  await until('the session to end', async () =>
    (await studio.evaluate(() =>
      document.querySelector('.session')?.classList.contains('running'),
    )) === false
      ? true
      : null,
  );
  await studio.waitForTimeout(600);
  await assertWorkspaceEverywhere(app, studio, `${theme} returned idle`);
}

/**
 * The countdown sits on the line it shares.
 *
 * `.timing` put the clock beside a two-line units column and aligned them on
 * `baseline`, which aligns a 30px number to the *first* of those lines — so the
 * clock floated at the top of its box with "elapsed" hanging below it, and its
 * centre sat 12.5px above the progress bar and the Stop button beside it. It
 * was reported by eye before any check here noticed, because every existing
 * assertion in this file is about boxes filling their container rather than
 * about things lining up inside one.
 *
 * Measured against the progress bar rather than the button: the bar is the
 * element the clock is genuinely in a row with, and the button is deliberately
 * bottom-aligned to a taller box, so their centres differ by design.
 */
async function assertCountdownAligned(
  app: ElectronApplication,
  studio: Page,
  theme: string,
): Promise<void> {
  /*
   * Through `resize`, not `setViewportSize`.
   *
   * Playwright's viewport override detaches the page from the window it is in,
   * so `resize` — which sets the real content size and then waits for
   * `window.innerWidth` to agree — can never see its target again. Using it
   * here left every later size in this run timing out.
   */
  for (const [width, height] of [
    [1280, 840],
    [900, 640],
  ] as const) {
    await resize(app, studio, width, height);
    const rows = await studio.evaluate(() => {
      const mid = (selector: string) => {
        const el = document.querySelector(selector);
        if (el === null) return null;
        const box = el.getBoundingClientRect();
        return Math.round(((box.top + box.bottom) / 2) * 10) / 10;
      };
      return { clock: mid('.clock'), units: mid('.units'), progress: mid('.progress') };
    });
    const { clock, units, progress } = rows;
    if (clock === null || units === null || progress === null) {
      check(false, `${theme} active ${width}x${height}: the countdown row is present`);
      continue;
    }
    check(
      Math.abs(clock - progress) <= 1,
      `${theme} active ${width}x${height}: the countdown is centred on its row ` +
        `(clock ${clock}, bar ${progress})`,
    );
    check(
      Math.abs(clock - units) <= 1,
      `${theme} active ${width}x${height}: the countdown and its units share a centre ` +
        `(clock ${clock}, units ${units})`,
    );
  }
  await resize(app, studio, 1280, 840);
}

async function run(): Promise<void> {
  const app: ElectronApplication = await electron.launch({
    args: [join(REPO, 'e2e/bootstrap.mjs')],
    cwd: REPO,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  try {
    await app.firstWindow();
    const studio: Page = await until(
      'Studio',
      async () => app.windows().find((w) => w.url().endsWith('index.html')) ?? null,
      LAUNCH_TIMEOUT_MS,
    );
    await studio.waitForLoadState('domcontentloaded');
    await installNaming(studio);

    /*
     * The size the app actually opens at, read before anything resizes it.
     *
     * Every other assertion here drives the window to a chosen width, so none
     * of them can see the default. That is exactly what went wrong: the header
     * was correct at every width the checks visited, and the app opened at one
     * they did not — 1180, seventy pixels under what its own header needs, so
     * every launch began with Preview and Master wrapped onto a second line.
     */
    const startup = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((b) =>
        b.webContents.getURL().endsWith('index.html'),
      );
      const [width, height] = win!.getContentSize();
      return { width, height };
    });
    console.log(`\nstartup ${startup.width}x${startup.height}`);
    check(
      startup.width >= HEADER_SINGLE_ROW_PX,
      `the default window (${startup.width}px) is wide enough for a single-row header (needs ${HEADER_SINGLE_ROW_PX}px)`,
    );
    check(
      await studio.evaluate(() => {
        const identity = document.querySelector('.identity')!.getBoundingClientRect();
        const global = document.querySelector('.global')!.getBoundingClientRect();
        return Math.abs(identity.top - global.top) < 2;
      }),
      'the header opens on one row, before any resize',
    );

    for (const theme of ['dark', 'light'] as const) {
      await applyAppearance(studio, theme);
      await checkContrast(studio, theme);
      await checkSessionGeometry(app, studio, theme);
      for (const routing of ['Off', 'Binaural'] as const) {
        await applyRouting(studio, routing);
        for (const [key, width, height] of VIEWPORTS) {
          await app.evaluate(
            ({ BrowserWindow }, [w, h]) => {
              BrowserWindow.getAllWindows()
                .find((b) => b.webContents.getURL().endsWith('index.html'))
                ?.setContentSize(w, h);
            },
            [width, height],
          );
          await until(`viewport ${key}`, async () =>
            (await studio.evaluate(() => window.innerWidth)) === width ? true : null,
          );
          await studio.waitForTimeout(450);
          console.log(`\n${theme} ${key} routing=${routing}`);

          await assertInitialDiscoverability(studio, `${theme} ${key}`, width, height);

          const geometry = await studio.evaluate(() => {
            const main = document.querySelector('main') as HTMLElement;
            const recipe = document.querySelector('.recipe') as HTMLElement;
            const layers = document.querySelector('.layers') as HTMLElement;
            /*
             * Layer bottoms in `main`'s *content* coordinates.
             *
             * A viewport-relative bottom is not comparable to `scrollHeight`:
             * `main` starts below the header and the integrity row, so adding
             * `scrollTop` to a client rect overshoots by exactly that offset and
             * the assertion goes red on a page that is perfectly fine.
             */
            const mainTop = main.getBoundingClientRect().top;
            const layerBottoms = Array.from(document.querySelectorAll('.recipe .layer')).map(
              (l) => l.getBoundingClientRect().bottom - mainTop + main.scrollTop,
            );
            const inRecipe = [recipe, ...Array.from(document.querySelectorAll('.recipe *'))];
            const nested = inRecipe.filter((el) => {
              const s = getComputedStyle(el);
              return /auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
            }).length;
            /*
             * Silent clippers.
             *
             * `overflow: hidden` on a box whose content does not fit is the
             * shape the defect took: the content is still laid out, still
             * focusable, still scrollable *programmatically* — and completely
             * unreachable with a pointer, because a hidden overflow paints no
             * scrollbar and does not answer the wheel. Nothing inside the recipe
             * is allowed to hide its own content this way.
             */
            const clippers = inRecipe
              .filter((el) => {
                const s = getComputedStyle(el);
                if (s.overflowY !== 'hidden') return false;
                if (el.scrollHeight <= el.clientHeight + 1 || el.clientHeight === 0) return false;
                /*
                 * Only a clipper that hides something operable is a defect.
                 *
                 * The visually-hidden idiom is a 1px box with its content clipped
                 * on purpose, and a rule that cannot tell it from the real thing
                 * fails on correct code — which is how a check stops being
                 * believed. Requiring an operable descendant states the harm
                 * itself rather than exempting a class name we happen to use.
                 */
                return el.querySelector('input, button, summary, select, textarea') !== null;
              })
              .map(
                (el) =>
                  `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} ` +
                  `(${el.clientHeight}px showing ${el.scrollHeight}px)`,
              );
            /*
             * Visible overflow — the kind nothing scrolls.
             *
             * A box whose content is too wide and whose overflow is `visible`
             * gains no scrollbar and clips nothing: it simply draws outside its
             * own border, over whatever is beside it. Every other assertion here
             * is blind to that, and it is what the bounded tuner subcolumn did on
             * its first try — the frequency field hung past the card's right edge,
             * and only a screenshot showed it.
             */
            const spills = inRecipe
              .filter((el) => {
                const box = el.getBoundingClientRect();
                if (box.width === 0) return false;
                return Array.from(el.children).some((child) => {
                  const r = child.getBoundingClientRect();
                  return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
                });
              })
              .map((el) => window.__name(el));

            return {
              spills,
              recipeHeight: recipe.getBoundingClientRect().height,
              layersHeight: layers.scrollHeight,
              scrollExtent: main.scrollHeight,
              deepestLayerBottom: Math.max(...layerBottoms),
              nestedHorizontal: nested,
              clippers,
              documentOverflow:
                document.documentElement.scrollWidth > document.documentElement.clientWidth,
            };
          });

          // 1. The container is at least as tall as what it contains.
          check(
            geometry.recipeHeight >= geometry.layersHeight,
            `recipe box (${Math.round(geometry.recipeHeight)}px) contains its layers (${geometry.layersHeight}px)`,
          );
          // 2. The scroll range reaches the bottom of the last layer.
          check(
            geometry.scrollExtent >= geometry.deepestLayerBottom - 1,
            `scroll extent (${Math.round(geometry.scrollExtent)}px) reaches the last layer (${Math.round(geometry.deepestLayerBottom)}px)`,
          );
          check(geometry.nestedHorizontal === 0, 'no nested horizontal scroller in the recipe');
          check(
            geometry.clippers.length === 0,
            `nothing in the recipe clips its own content away${geometry.clippers.length ? ` — ${geometry.clippers.join('; ')}` : ''}`,
          );
          check(!geometry.documentOverflow, 'no document-level horizontal overflow');
          check(
            geometry.spills.length === 0,
            `nothing in the recipe spills past its container${geometry.spills.length ? ` — ${geometry.spills.slice(0, 4).join('; ')}` : ''}`,
          );

          /*
           * The measure holds, and Entrainment splits where it is meant to.
           *
           * Both are design decisions that a stylesheet can lose silently: a
           * dropped `max-width` reads as 'the window is just wide', and a
           * media query that never matches reads as one long column nobody
           * questions. Asserting the width and the track count states what the
           * design actually asked for at each size.
           */
          const composition = await studio.evaluate(() => {
            const workspace = document.querySelector('.workspace:not([hidden])') as HTMLElement;
            const entrainment = document.querySelector('.entrainment') as HTMLElement;
            const identity = document.querySelector('.identity')!.getBoundingClientRect();
            const global = document.querySelector('.global')!.getBoundingClientRect();
            return {
              workspaceWidth: Math.round(workspace.getBoundingClientRect().width),
              tracks: getComputedStyle(entrainment).gridTemplateColumns.split(/\s+/).length,
              headerOneRow: Math.abs(identity.top - global.top) < 2,
            };
          });
          /*
           * The header wraps where it is meant to, and not where it is not.
           *
           * Asserted in both directions on purpose. Below the threshold the wrap
           * is the design — the alternative, which shipped once, is Preview
           * overlapping Delete. At and above it a wrapped header is a defect,
           * and that is how the app opened every launch before D-18: the
           * default window was 70px under the width its own header needed.
           */
          const wantsOneRow = width >= HEADER_SINGLE_ROW_PX;
          check(
            composition.headerOneRow === wantsOneRow,
            `header is ${wantsOneRow ? 'one row' : 'wrapped'} at ${width}px, as the ${HEADER_SINGLE_ROW_PX}px threshold requires`,
          );
          check(
            composition.workspaceWidth <= 1600,
            `workspace is capped at 1600px (measured ${composition.workspaceWidth}px)`,
          );
          const expectedTracks = width >= 1360 ? 2 : 1;
          check(
            composition.tracks === expectedTracks,
            `Entrainment lays out in ${expectedTracks} track${expectedTracks === 1 ? '' : 's'} (measured ${composition.tracks})`,
          );

          /*
           * 3. Every control can be scrolled into the unobscured viewport.
           *
           * Scrolled, then hit-tested: `elementFromPoint` at the control's own
           * centre has to come back as that control or a descendant of it. A
           * clipped control fails this even though it is in the DOM, which is the
           * whole point — and so does one hidden behind the fixed footer.
           */
          const unreachable = await studio.evaluate(() => {
            const main = document.querySelector('main') as HTMLElement;
            const controls = Array.from(
              document.querySelectorAll<HTMLElement>(
                '.recipe input, .recipe button, .recipe summary',
              ),
            );
            const bad: string[] = [];
            for (const el of controls) {
              /*
               * Scroll `main`, not the element's ancestors.
               *
               * `scrollIntoView` scrolls every scrollable ancestor, including a
               * hidden-overflow box that no user can scroll — which is how a
               * clipped control looks reachable to a test and is not reachable
               * to a person. Moving the one scroll owner the design actually
               * gives the user reproduces what the user can do, and nothing more.
               */
              const top =
                el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
              main.scrollTop = top - main.clientHeight / 2;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) {
                bad.push(`${window.__name(el)} has no box`);
                continue;
              }
              const hit = document.elementFromPoint(
                Math.round(r.left + r.width / 2),
                Math.round(r.top + r.height / 2),
              );
              /*
               * The hit has to be the control or something *inside* it.
               *
               * Accepting an ancestor too (`hit.contains(el)`) is the same
               * false-positive as the check this file replaces: a control clipped
               * out of its container paints nothing at its own centre, so the hit
               * comes back as `.workspace` or `main` — an ancestor — and a lenient
               * comparison calls that reachable. Against the real defect this
               * assertion passed on 25 of 25 unreachable controls.
               */
              if (hit === null || (hit !== el && !el.contains(hit))) {
                bad.push(
                  `${window.__name(el)} is covered by ${hit ? window.__name(hit) : 'nothing'}`,
                );
              }
            }
            return { total: controls.length, bad };
          });
          check(
            unreachable.bad.length === 0,
            `all ${unreachable.total} recipe controls reachable by pointer${unreachable.bad.length ? ` — ${unreachable.bad.slice(0, 4).join('; ')}` : ''}`,
          );

          /*
           * 4. Every control is at least 36px tall.
           *
           * Reachable is not the same as hittable. A 20px slider is visible,
           * scrollable-to and focusable, and still misses under a moving finger
           * or a trackpad; 36px is the floor both WCAG 2.2 target-size and every
           * desktop HIG land on. Measured on the control box itself, since that
           * is what the pointer actually tests against.
           *
           * **Both directions.** This measured height only, and three
           * components carried comments claiming the full 36px floor while
           * setting `min-height` alone: the binaural disclosure was 29×36 and
           * the tuner's five step buttons 28.5×36. The audit agreed with the
           * comments rather than with the pixels, which is the failure mode a
           * measurement is supposed to prevent.
           */
          const small = await studio.evaluate(() => {
            const controls = Array.from(
              document.querySelectorAll<HTMLElement>(
                '.recipe input, .recipe button, .recipe summary',
              ),
            );
            return controls
              .map((el) => {
                const box = el.getBoundingClientRect();
                return {
                  label: window.__name(el),
                  width: Math.round(box.width * 10) / 10,
                  height: Math.round(box.height * 10) / 10,
                };
              })
              .filter((c) => c.width > 0 && (c.width < 36 || c.height < 36));
          });
          check(
            small.length === 0,
            `every recipe control is at least 36px in both directions${small.length ? ` — ${small.map((c) => `${c.label} ${c.width}x${c.height}px`).join('; ')}` : ''}`,
          );

          /*
           * 4b. And the header, which this floor never reached.
           *
           * The check above is scoped to `.recipe`, so the global row was
           * measured by nothing: the two destination buttons sat at 34px beside
           * 42px neighbours for as long as they have existed, and a layout audit
           * found them rather than the gate that exists to. A convention only
           * held in the places it is checked is a convention held by accident.
           *
           * Height only, deliberately. A destination is a text button whose
           * width is its label, and the recipe rule's "both directions" exists
           * for square icon controls; requiring 36px of width here would be a
           * rule about copy length rather than about hit area.
           */
          const shortHeader = await studio.evaluate(() => {
            const controls = Array.from(
              document.querySelectorAll<HTMLElement>('header button, header input, header summary'),
            );
            return controls
              .map((el) => {
                const box = el.getBoundingClientRect();
                return {
                  label: window.__name(el),
                  width: Math.round(box.width * 10) / 10,
                  height: Math.round(box.height * 10) / 10,
                };
              })
              .filter((c) => c.width > 0 && c.height < 36);
          });
          check(
            shortHeader.length === 0,
            `every header control is at least 36px tall${shortHeader.length ? ` — ${shortHeader.map((c) => `${c.label} ${c.width}x${c.height}px`).join('; ')}` : ''}`,
          );

          // 5. And by keyboard, which can fail on its own.
          const keyboard = await keyboardTraversal(studio);
          check(
            keyboard.bad.length === 0,
            `all ${keyboard.total} recipe controls reachable by Tab${keyboard.bad.length ? ` — ${keyboard.bad.slice(0, 4).join('; ')}` : ''}`,
          );
        }
      }
    }

    /*
     * The way out of a modal is a control too.
     *
     * It was neither: a `×` — the multiplication sign, standing in for the
     * icon the contract asks for — in a box that measured 24×18, well under
     * the 36px floor every other control here is held to. Both halves are
     * checked, because fixing one without the other leaves a real defect: an
     * icon nobody can hit, or a big target with a letter in it.
     */
    await checkContinuationNavigation(app, studio);
    await checkStripCrowding(app, studio);

    await resize(app, studio, 1440, 1024);
    await studio.getByRole('button', { name: 'Settings', exact: true }).click();
    await until('the Settings dialog', async () =>
      (await studio.locator('dialog[open]').count()) > 0 ? true : null,
    );
    const close = await studio.evaluate(() => {
      const button = document.querySelector<HTMLElement>('dialog[open] .close');
      if (button === null) return null;
      const box = button.getBoundingClientRect();
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        text: (button.textContent ?? '').trim(),
        drawn:
          button.querySelector('svg')?.querySelectorAll('path, circle, rect, line').length ?? 0,
      };
    });
    check(close !== null, 'the dialog offers a close control');
    if (close !== null) {
      check(
        close.width >= 36 && close.height >= 36,
        `the dialog close is at least 36px square (${close.width}x${close.height})`,
      );
      check(close.drawn > 0 && close.text === '', 'the dialog close is a drawn icon, not a glyph');
    }
    await studio.getByRole('button', { name: 'Close' }).click();
  } finally {
    await app.close();
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} layout check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall layout checks passed');
  }
}

await run();
