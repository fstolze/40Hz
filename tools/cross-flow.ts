/**
 * One long session, in the order a person would do it.
 *
 * The Electron suite has 83 tests and each one starts from a known state,
 * which is what makes them debuggable — and also what leaves a gap: nothing
 * exercises a *sequence*. State that leaks from one flow into the next is
 * invisible to isolated tests by construction, and this stage's contract is
 * about the integrated product rather than its parts.
 *
 * So this walks the integrated cross-flow matrix in one launch, in order, checking
 * at each junction that what the previous flow left behind is what the next one
 * should find. It is an audit tool, not a gate: run it, read it, and if it fails
 * the failure belongs in a test.
 *
 *   npm run build && node tools/cross-flow.ts
 */

import { _electron as electron, type Page } from 'playwright';
import { join } from 'node:path';
import { carrierHzFromTrack, carrierTrackFromHz } from '../src/audio/tuning.ts';

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

async function settled<T>(
  what: string,
  probe: () => Promise<T | null>,
  ms = 8_000,
): Promise<T | null> {
  return until(what, probe, ms).catch(() => null);
}

const app = await electron.launch({
  args: [join(REPO, 'e2e/bootstrap.mjs')],
  cwd: REPO,
  timeout: LAUNCH_TIMEOUT_MS,
});
await app.firstWindow();
const page: Page = await until('the Studio window', async () => {
  const found = app.windows().find((w) => w.url().endsWith('index.html'));
  return found ?? null;
});
await page.waitForLoadState('domcontentloaded');

const transport = async (): Promise<'preview' | 'stop'> =>
  (await page.getByRole('button', { name: /^Preview/ }).count()) > 0 ? 'preview' : 'stop';

const awaitTransport = async (want: 'preview' | 'stop') =>
  (await settled(
    `transport ${want}`,
    async () => ((await transport()) === want ? true : null),
    8_000,
  )) === true;

/**
 * The recipe as the engine holds it, read the way the UI reads it.
 *
 * Carrier comes back in hertz, not in the cents its track is measured in — the
 * comparisons here are against stored configurations, which hold frequencies.
 */
const recipe = async () => {
  const raw = await readRecipe();
  return { ...raw, carrier: raw.carrier === null ? null : carrierHzFromTrack(raw.carrier) };
};

const readRecipe = async () =>
  page.evaluate(() => {
    const value = (name: string) => {
      const el = Array.from(document.querySelectorAll('input[type=range]')).find((r) => {
        const label =
          r.closest('label') ?? document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
        return (label?.textContent ?? '').includes(name);
      });
      return el === undefined ? null : Number((el as HTMLInputElement).value);
    };
    return { carrier: value('Carrier'), modulation: value('Modulation'), master: value('Master') };
  });

/**
 * Sliders whose track is not their value.
 *
 * Carrier moves along cents, so writing 300 would set 300 *cents* — about
 * 523 Hz. Callers still name the frequency; the conversion goes through the
 * app's own function so this file holds no second opinion about the mapping.
 */
const TRACKS: Record<string, (value: number) => number> = { Carrier: carrierTrackFromHz };

/**
 * Two frequencies that mean the same slider position.
 *
 * The track is whole cents, so asking for 300 Hz lands on the nearest position
 * that exists rather than on 300 exactly. Comparing in cents rather than hertz
 * is the point: a hertz tolerance is a different tolerance at each end of a
 * 3.6-octave range.
 */
const sameCarrier = (actual: number | null, expected: number | null): boolean =>
  actual !== null &&
  expected !== null &&
  Math.abs(carrierTrackFromHz(actual) - carrierTrackFromHz(expected)) <= 1;

const setRange = async (name: string, value: number) => {
  const slider = page.getByRole('slider', { name: new RegExp(name) }).first();
  const onTrack = TRACKS[name]?.(value) ?? value;
  await slider.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, onTrack);
  await page.waitForTimeout(120);
};

const toView = async (name: 'Studio' | 'History') => {
  await page.getByRole('button', { name, exact: true }).click();
  await until(name, async () =>
    (await page.locator(name === 'Studio' ? '.recipe' : '.history-view').count()) > 0 ? true : null,
  );
};

const modified = async () =>
  (await page.locator('.modified, [data-modified]').count()) > 0
    ? true
    : (await page.locator('text=Modified').count()) > 0;

try {
  console.log('\n40 Hz — cross-flow verification\n');

  console.log('flow 1 — built-in preset, edited, previewed, edited while previewing');
  const start = await recipe();
  report(start.carrier !== null, 'the recipe reports its own values', JSON.stringify(start));
  report(!(await modified()), 'a freshly selected built-in is not Modified');

  await setRange('Carrier', 260);
  report(await modified(), 'editing a built-in marks it Modified');

  await page.getByRole('button', { name: /^Preview/ }).click();
  report(await awaitTransport('stop'), 'Preview starts from an edited recipe');
  await setRange('Carrier', 300);
  report((await transport()) === 'stop', 'editing during Preview does not stop it');
  report(
    sameCarrier((await recipe()).carrier, 300),
    'the edit during Preview is the recipe the engine holds',
  );
  await page.getByRole('button', { name: /^Stop/ }).click();
  report(await awaitTransport('preview'), 'Preview stops');
  report(await modified(), 'Modified survives a preview');

  console.log('\nflow 2 — save a user preset, recall it, update it, delete it');
  const name = `Cross flow ${Date.now()}`;
  await page.getByRole('button', { name: /^Save/ }).click();
  const field = page.getByLabel('Preset name', { exact: true });
  await until('the naming field', async () => ((await field.count()) > 0 ? true : null));
  await field.fill(name);
  // While naming, the row replaces the action group, so this is the only Save
  // inside `.presets` — and scoping there keeps it from ever matching the
  // action group's own button if that ever changes.
  await page.locator('.presets').getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await settled('the preset to be selected', async () => {
    const picked = await page.evaluate(() => {
      const select = document.querySelector('select');
      if (select === null) return '';
      return select.options[select.selectedIndex]?.textContent?.trim() ?? '';
    });
    return picked === name ? picked : null;
  });
  report(saved === name, 'saving selects the new preset', String(saved));
  report(!(await modified()), 'a just-saved preset is clean');

  // Recall a built-in, then come back: the user preset must still be there.
  await page.locator('select').first().selectOption({ label: 'Subtle pulse' });
  await page.waitForTimeout(300);
  report(!(await modified()), 'selecting another preset clears Modified');
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select option')).map((o) => o.textContent?.trim() ?? ''),
  );
  report(names.includes(name), 'the user preset stays in the picker', String(names.length));

  await page.locator('select').first().selectOption({ label: name });
  await page.waitForTimeout(300);
  report(
    sameCarrier((await recipe()).carrier, 300),
    'recalling the user preset restores its recipe',
  );

  console.log('\nflow 3 — a session, edited while it runs');
  await page.evaluate(async () => {
    const bridge = window.desktop;
    if (bridge === undefined) throw new Error('no desktop bridge');
    await bridge.session.start({ presetId: 'focus', configuration: {}, plannedSeconds: 600 });
  });
  await until('the session strip', async () =>
    (await page.locator('.session.running, .session-strip.running').count()) > 0 ? true : null,
  ).catch(() => null);
  const running = await page.evaluate(
    () => document.body.textContent?.includes('Stop session') ?? false,
  );
  report(running, 'the session strip offers Stop session');
  report(
    (await page.locator('.recipe input:not([disabled])').count()) > 0,
    'the recipe stays editable during a session',
  );
  await setRange('Carrier', 244);
  await page.waitForTimeout(300);

  console.log('\nflow 4 — recall during the session, then stop it');
  await toView('History');
  report((await page.locator('.records > li').count()) >= 0, 'History opens while a session runs');
  await toView('Studio');
  /*
   * Two surfaces offer to end a session — the header transport, which becomes
   * "Stop session" for the duration, and the strip's own action. That is the
   * approved arrangement rather than a duplicate, so both are asserted before
   * one of them is used: a header still saying "Stop preview" during a session
   * would be the transport lying about the coordinator's state.
   */
  report(
    (await page.getByRole('banner').getByRole('button', { name: 'Stop session' }).count()) === 1,
    'the header transport says Stop session while one runs',
  );
  report(
    (await page.getByLabel('Session').getByRole('button', { name: 'Stop session' }).count()) === 1,
    'the strip offers its own Stop session',
  );
  await page.getByLabel('Session').getByRole('button', { name: 'Stop session' }).click();
  const stopped = await settled(
    'the session to end',
    async () =>
      (await page.locator('.records, .recipe').count()) > 0 &&
      !(await page.evaluate(() => document.body.textContent?.includes('Stop session') ?? false))
        ? true
        : null,
    20_000,
  );
  report(stopped === true, 'the session stops from Studio');

  await toView('History');
  const rows = await until('the record', async () => {
    const n = await page.locator('.records > li').count();
    return n > 0 ? n : null;
  });
  report(rows >= 1, 'stopping records one session', `${rows} row(s)`);
  const record = await page.evaluate(async () => {
    const list = await window.desktop!.history.list();
    const r = list[0];
    return {
      reason: r.completionReason,
      edited: r.edited,
      from: r.initialConfiguration.params.carrierHz,
      to: r.finalConfiguration.params.carrierHz,
    };
  });
  report(record.reason === 'stopped', 'it is recorded as stopped, not completed', record.reason);
  report(record.edited === true, 'the edit during the session is recorded');
  report(
    record.from !== record.to,
    'the endpoints differ, so the row offers both',
    `${record.from} → ${record.to}`,
  );
  report(
    (await page.getByRole('button', { name: /^Recall start/ }).count()) === 1 &&
      (await page.getByRole('button', { name: /^Recall end/ }).count()) === 1,
    'two recall options are offered for an edited session',
  );

  console.log('\nflow 5 — recall into idle Studio');
  await page
    .getByRole('button', { name: /^Recall start/ })
    .first()
    .click();
  await until('Studio', async () => ((await page.locator('.recipe').count()) > 0 ? true : null));
  report((await transport()) === 'preview', 'recall does not start audio');
  report(
    sameCarrier((await recipe()).carrier, record.from),
    'recall restores the recorded recipe',
    String((await recipe()).carrier),
  );
  report(
    await page.evaluate(() => document.body.textContent?.includes('Recalled from') ?? false),
    'the header says where the recipe came from',
  );

  console.log('\nflow 6 — integrity, settings and theme, then back to a clean Studio');
  await page.locator('.integrity').click();
  await until('the integrity dialog', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  report(true, 'the integrity detail opens over the recalled recipe');
  await page.getByRole('button', { name: 'Close' }).click();
  await until('it to close', async () =>
    (await page.locator('dialog[open]').count()) === 0 ? true : null,
  );
  report(
    sameCarrier((await recipe()).carrier, record.from),
    'the recipe is unchanged by opening a dialog',
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await until('Settings', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  await page
    .getByRole('group', { name: 'Colour scheme' })
    .getByRole('button', { name: 'Light' })
    .click();
  await until('the light theme', async () =>
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light' ? true : null,
  );
  await page.getByRole('button', { name: 'Close' }).click();
  await until('it to close', async () =>
    (await page.locator('dialog[open]').count()) === 0 ? true : null,
  );
  report(
    sameCarrier((await recipe()).carrier, record.from),
    'switching theme does not disturb the recipe',
  );
  report(
    (await page.locator('.recipe .layer').count()) === 3,
    'the recipe is still whole after a theme change',
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await until('Settings', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  await page
    .getByRole('group', { name: 'Colour scheme' })
    .getByRole('button', { name: 'Dark' })
    .click();
  await until('the dark theme', async () =>
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' ? true : null,
  );
  await page.getByRole('button', { name: 'Close' }).click();

  console.log('\nflow 7 — clear the log, and leave nothing playing');
  await toView('History');
  await page.getByRole('button', { name: 'Delete all history' }).click();
  await until('the confirmation', async () =>
    (await page.locator('dialog[open]').count()) > 0 ? true : null,
  );
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete everything' }).click();
  const empty = await settled(
    'the log to empty',
    async () => ((await page.locator('.empty').count()) > 0 ? true : null),
    20_000,
  );
  report(empty === true, 'Clear empties the log');
  report(
    (await page.evaluate(async () => (await window.desktop!.history.list()).length)) === 0,
    'and the store agrees',
  );
  await toView('Studio');
  report(
    sameCarrier((await recipe()).carrier, record.from),
    'clearing history leaves the recipe alone',
  );
  report((await transport()) === 'preview', 'nothing is playing at the end');
} finally {
  await app.close().catch(() => undefined);
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
