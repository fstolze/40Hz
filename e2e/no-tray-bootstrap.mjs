/** Keep the shared Linux suite independent of the developer's desktop tray. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const profile = mkdtempSync(join(tmpdir(), 'fortyhz-e2e-'));
process.env.FORTYHZ_E2E_USERDATA = profile;
const bin = join(profile, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'gdbus'),
  `#!/usr/bin/env node
if (process.argv[2] === 'monitor') {
  console.log('Monitoring the test tray host');
  setInterval(() => {}, 60000);
} else {
  console.log("({'IsStatusNotifierHostRegistered': <false>, 'RegisteredStatusNotifierItems': <@as []>},)");
}
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
await import('./bootstrap.mjs');
