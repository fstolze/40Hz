/**
 * GNOME and KDE expose org.kde.StatusNotifierWatcher on the session bus.
 * gdbus (GLib) gives us that protocol without a native Node module. If the
 * utility or bus is absent, close-to-tray stays unavailable. One persistent
 * monitor drives reads on changes; there is no timer spawning processes.
 */
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { TrayProbe } from './tray-availability.ts';

const WATCHER = 'org.kde.StatusNotifierWatcher';
const OBJECT = '/StatusNotifierWatcher';

/** A missing service is an answer; timeouts and other read failures are not. */
function missingService(error: unknown): boolean {
  return /org\.freedesktop\.DBus\.Error\.(?:ServiceUnknown|NameHasNoOwner)\b/.test(String(error));
}

function call(
  destination: string,
  path: string,
  method: string,
  ...args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gdbus',
      [
        'call',
        '--session',
        '--timeout',
        '2',
        '--dest',
        destination,
        '--object-path',
        path,
        '--method',
        method,
        ...args,
      ],
      { timeout: 2000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Parse only bus names and object paths, never evaluate the GVariant reply. */
export function registeredTrayServices(reply: string): string[] {
  if (!/'IsStatusNotifierHostRegistered': <true>/.test(reply)) return [];
  const list = /'RegisteredStatusNotifierItems': <(?:@as )?\[([^\]]*)\]>/.exec(reply)?.[1];
  if (list === undefined) return [];
  const services = [...list.matchAll(/'((?::[\d]+\.[\d]+|[a-zA-Z_][\w.-]+))(?:@?\/[\w/]*)?'/g)].map(
    (match) => match[1],
  );
  // Unexpectedly large replies fail closed rather than spawning unbounded work.
  return services.length <= 128 ? [...new Set(services)] : [];
}

export function linuxTrayProbe(pid: number): TrayProbe {
  return {
    async read() {
      let reply: string;
      try {
        reply = await call(WATCHER, OBJECT, 'org.freedesktop.DBus.Properties.GetAll', WATCHER);
      } catch (error) {
        if (missingService(error)) return false;
        throw error;
      }
      if (!/'IsStatusNotifierHostRegistered': <(?:true|false)>/.test(reply)) {
        throw new Error('Invalid tray-host reply');
      }
      const services = registeredTrayServices(reply);
      const owners = await Promise.allSettled(
        services.map(async (service) => {
          try {
            const owner = await call(
              'org.freedesktop.DBus',
              '/org/freedesktop/DBus',
              'org.freedesktop.DBus.GetConnectionUnixProcessID',
              service,
            );
            const match = /^\(uint32 (\d+),\)\s*$/.exec(owner);
            if (!match) throw new Error('Invalid tray-owner reply');
            return match[1] === String(pid);
          } catch (error) {
            if (missingService(error)) return false;
            throw error;
          }
        }),
      );
      if (owners.some((owner) => owner.status === 'fulfilled' && owner.value)) return true;
      const failure = owners.find((owner) => owner.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      return false;
    },
    watch(changed, failed) {
      const child = spawn(
        'gdbus',
        ['monitor', '--session', '--dest', WATCHER, '--object-path', OBJECT],
        { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } },
      );
      const lines = createInterface({ input: child.stdout });
      // Includes the initial owner announcement, watcher restarts, and item/host
      // registration changes. Install this before the first snapshot read.
      lines.on('line', changed);
      let closing = false;
      const reportFailure = (reason: unknown): void => {
        if (closing) return;
        closing = true;
        console.warn(
          '[main] tray monitoring stopped; tray residency is unavailable until 40 Hz restarts:',
          reason,
        );
        failed();
      };
      child.once('error', reportFailure);
      child.once('exit', (code, signal) =>
        reportFailure(new Error(`gdbus monitor exited (${signal ?? code})`)),
      );
      return () => {
        closing = true;
        lines.close();
        child.kill();
      };
    },
  };
}
