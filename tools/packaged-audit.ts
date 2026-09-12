/**
 * Does the shipped bundle behave like the product?
 *
 * `e2e/packaged-smoke.test.ts` proves the five things that fail *silently* when
 * packaging goes wrong — the renderer, the font file, the worklets, the capture
 * worklet, and login-item registration. That is the right size for a gate.
 *
 * The release audit asks a wider question: does the packaged shape
 * still navigate, theme, open its dialogs, play, record a session, keep what it
 * saved across a restart, and do all of it without a console error. Those are
 * covered against `out/` by the Electron suite, and the risk here is not the
 * logic but the shape — an asset that resolves under `file://` from a directory
 * and not from inside an asar, a font that falls back silently, an icon that
 * renders as an empty box.
 *
 * So this is an audit tool rather than a gate: it runs the real binary from
 * `dist/`, reports every check as a line, and exits non-zero if any fails.
 *
 *   npm run dist:dir && node tools/packaged-audit.ts
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LAUNCH_TIMEOUT_MS = 60_000;

function packagedBinary(): string {
  if (process.platform === 'darwin') {
    const bundle = readdirSync('dist').find((entry) => entry.startsWith('mac'));
    if (bundle === undefined) throw new Error('no dist/mac* — run `npm run dist:dir` first');
    return join('dist', bundle, '40 Hz.app', 'Contents', 'MacOS', '40 Hz');
  }
  if (process.platform === 'win32') return join('dist', 'win-unpacked', '40 Hz.exe');
  return join('dist', 'linux-unpacked', 'fortyhz');
}

let failures = 0;
let checks = 0;

function report(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${detail === '' ? '' : `   ${detail}`}`);
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

/** Everything the renderer said, and everything it failed to fetch. */
interface Watch {
  console: string[];
  failed: string[];
}

function watch(page: Page): Watch {
  const w: Watch = { console: [], failed: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') w.console.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => w.console.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => w.failed.push(`${r.url()} — ${r.failure()?.errorText ?? ''}`));
  return w;
}

async function open(profile: string): Promise<{ app: ElectronApplication; page: Page; w: Watch }> {
  const app = await electron.launch({
    executablePath: packagedBinary(),
    args: [`--user-data-dir=${profile}`],
    timeout: LAUNCH_TIMEOUT_MS,
  });
  await app.firstWindow();
  const page = await until('the Studio window', async () => {
    const found = app.windows().find((win) => win.url().endsWith('index.html'));
    return found ?? null;
  });
  const w = watch(page);
  await page.waitForLoadState('domcontentloaded');
  return { app, page, w };
}

const profile = mkdtempSync(join(tmpdir(), 'fortyhz-audit-'));
console.log(`\n40 Hz — packaged audit\nbinary  ${packagedBinary()}\nprofile ${profile}\n`);

let first: Awaited<ReturnType<typeof open>> | null = null;
try {
  first = await open(profile);
  const { app, page, w } = first;

  console.log('shell and assets');
  report(page.url().endsWith('index.html'), 'the renderer loads from inside the archive');
  report(
    (await page.locator('.recipe .layer').count()) === 3,
    'the recipe renders all three layers',
  );

  /*
   * The font, twice: that the face loaded, and that something is using it.
   * `fonts.check` alone passes when a fallback answers, so the heading's own
   * resolved family is what says Inter actually arrived.
   */
  const font = await page.evaluate(() => {
    const loaded: string[] = [];
    document.fonts.forEach((f) => loaded.push(`${f.family} ${f.status}`));
    const heading = document.querySelector('h1, h2');
    return {
      loaded,
      family: heading === null ? '' : getComputedStyle(heading).fontFamily,
      ready: document.fonts.check('12px Inter'),
    };
  });
  report(font.ready, 'Inter is available to the renderer');
  report(/Inter/.test(font.family), 'headings resolve to Inter', font.family);
  report(
    font.loaded.some((f) => f.startsWith('Inter') && f.endsWith('loaded')),
    'the Inter face reports loaded',
    font.loaded.join(' | '),
  );

  // Phosphor compiles to inline SVG, so a missing icon is an empty box rather
  // than a failed request. Measure one.
  const icons = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('button svg'));
    const boxes = svgs.map((s) => {
      const r = s.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        paths: s.querySelectorAll('*').length,
      };
    });
    return { count: svgs.length, empty: boxes.filter((b) => b.w === 0 || b.paths === 0).length };
  });
  report(icons.count > 0, 'icons are present', `${icons.count} in buttons`);
  report(icons.empty === 0, 'every icon has geometry and content');

  const mono = await page.evaluate(() => {
    const el = document.querySelector('.mono');
    return el === null ? '' : getComputedStyle(el).fontFamily;
  });
  report(mono !== '' && !/Inter/.test(mono), 'dynamic numerics use the mono stack', mono);

  console.log('\nnavigation and dialogs');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await until('History', async () =>
    (await page.locator('.history-view').count()) > 0 ? true : null,
  );
  report(true, 'Studio → History navigates');
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  await until('Studio', async () => ((await page.locator('.recipe').count()) > 0 ? true : null));
  report(true, 'History → Studio navigates back');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await until('the Settings dialog', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  report(true, 'the Settings dialog opens');
  report(
    (await page.getByRole('heading', { name: 'About' }).count()) > 0,
    'About is a section of Settings',
  );

  console.log('\nappearance');
  for (const label of ['Light', 'Dark', 'System'] as const) {
    await page
      .getByRole('group', { name: 'Colour scheme' })
      .getByRole('button', { name: label })
      .click();
    const theme = await until(`the ${label} theme`, async () => {
      const t = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
      if (label === 'System') return t;
      return t === label.toLowerCase() ? t : null;
    });
    const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    report(true, `${label} applies`, `data-theme=${theme}  body=${painted}`);
  }
  // Back to dark, and leave the dialog the way a user would.
  await page
    .getByRole('group', { name: 'Colour scheme' })
    .getByRole('button', { name: 'Dark' })
    .click();
  await page.getByRole('button', { name: 'Close' }).click();
  await until('the dialog to close', async () =>
    (await page.locator('dialog[open]').count()) === 0 ? true : null,
  );
  report(true, 'the dialog closes');

  await page.locator('.integrity').click();
  await until('the integrity dialog', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  report(true, 'the integrity detail opens');
  await page.getByRole('button', { name: 'Close' }).click();
  await until('it to close', async () =>
    (await page.locator('dialog[open]').count()) === 0 ? true : null,
  );

  console.log('\naudio');
  /*
   * Read through the UI, not through the bridge.
   *
   * `session.subscribe` has one handler slot per channel — the preload assigns
   * `onSessionChanged = onChange` — so subscribing from here would replace the
   * renderer's own subscription and stop the app updating, while this tool
   * reported success. The transport's own label is the coordinator's state as
   * a user sees it, which is the better evidence anyway.
   */
  await page.getByRole('button', { name: /^Preview/ }).click();
  const playing = await until('the transport to offer Stop', async () =>
    (await page.getByRole('button', { name: /^Stop/ }).count()) > 0 ? true : null,
  );
  report(playing, 'Preview starts and the transport says so');
  await page.getByRole('button', { name: /^Stop/ }).click();
  await until('preview to stop', async () =>
    (await page.getByRole('button', { name: /^Preview/ }).count()) > 0 ? true : null,
  );
  report(true, 'Preview stops');

  console.log('\npersistence across a restart');
  const savedName = `Audit ${Date.now()}`;
  await page.evaluate(async (name) => {
    const bridge = window.desktop;
    if (bridge === undefined) throw new Error('no desktop bridge');
    await bridge.presets.upsert({
      id: `audit-${Date.now()}`,
      name,
      description: 'written by the packaged audit',
      params: {
        modulationHz: 41,
        carrierHz: 231,
        duty: 0.5,
        edge: 0.5,
        depth: 1,
        amGain: 0.3,
        twoToneGain: 0,
        twoToneMode: 'off',
      },
      soundscape: {
        source: 'noise',
        bedId: null,
        color: 'pink',
        gain: 0.3,
        notchDepthDb: 6,
        notchQ: 8,
      },
      masterLevel: 0.7,
    });
  }, savedName);
  await page.evaluate(async () => {
    const bridge = window.desktop;
    if (bridge === undefined) throw new Error('no desktop bridge');
    await bridge.session.start({ presetId: 'focus', configuration: {}, plannedSeconds: 1 });
  });
  await until('the session to be recorded', async () => {
    const n = await page.evaluate(async () => (await window.desktop!.history.list()).length);
    return n > 0 ? true : null;
  });
  report(true, 'a session is recorded');

  await app.close();
  first = null;

  const second = await open(profile);
  try {
    const kept = await second.page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      return {
        presets: (await bridge.presets.list()).map((p: { name: string }) => p.name),
        history: (await bridge.history.list()).length,
        // The applied theme rather than the stored preference: same fact, and
        // it is the one the user can see.
        theme: document.documentElement.dataset.theme ?? '',
      };
    });
    report(kept.presets.includes(savedName), 'the saved preset survives a restart');
    report(kept.history >= 1, 'the session record survives a restart', `${kept.history} record(s)`);
    report(kept.theme === 'dark', 'the appearance choice survives a restart', kept.theme);

    console.log('\nconsole and network, both launches');
    const all = [...w.console, ...second.w.console];
    const failed = [...w.failed, ...second.w.failed];
    for (const line of all) console.log(`       ${line}`);
    for (const line of failed) console.log(`       request failed: ${line}`);
    report(all.length === 0, 'no console errors or warnings');
    report(failed.length === 0, 'no failed asset requests');
  } finally {
    await second.app.close().catch(() => undefined);
  }
} finally {
  if (first !== null) await first.app.close().catch(() => undefined);
  if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
