/**
 * The session interface the UI talks to, and its Electron wiring.
 *
 * Split out from `session-client.ts` because the Session popover needs this
 * and nothing else: that module also builds the browser-side coordinator and
 * registers the audio executor, which would drag the whole Web Audio engine
 * into a window whose job is to show a countdown and two buttons. Worse than
 * the size, it would give a second window an audio graph — and only Studio may
 * hold one.
 */

import type { SessionSnapshot, StartSessionRequest } from '../../session/coordinator.ts';
import type { Published } from '../../session/session-hub.ts';
import type { SessionConfiguration } from '../../audio/configuration.ts';
import type { SessionRecord } from '../../session/session.ts';
import type { Finding } from '../../integrity/findings.ts';
import { fanOut, type Unsubscribe } from './fan-out.ts';

export interface SessionClient {
  /**
   * Watch session state, receiving the current snapshot immediately — never as
   * a separate read, which would leave a window in which a change passes
   * unseen. Returns the function that stops watching.
   */
  subscribe(onChange: (update: Published<SessionSnapshot>) => void): Unsubscribe;
  start(request: StartSessionRequest): Promise<unknown>;
  stop(): Promise<unknown>;
  preview(configuration: SessionConfiguration): Promise<unknown>;
  /** Note an edit made while a session is running. */
  reportConfiguration(configuration: SessionConfiguration): void;
  /**
   * Report what the integrity checks measured, against the session they
   * measured, and answer whether it was recorded.
   *
   * The id is named rather than assumed: by the time a window has accumulated
   * and analysed, the session it was measuring may have ended, and a report
   * folded into whatever is running now would be about audio it never heard.
   *
   * The answer is carried back rather than dropped, because the two outcomes
   * are different work for the caller. `false` means nothing was recorded —
   * a superseded executor, a session already written, or a window with no way
   * to report at all — and a producer that assumed otherwise would report once
   * into nothing and move on. A rejection means it could not be delivered,
   * which is not the same as being refused.
   */
  reportIntegrity(sessionId: string, findings: readonly Finding[]): Promise<boolean>;
  history(): Promise<SessionRecord[]>;
}

/** What only Studio can do: the two reports that need the executor generation. */
export interface ExecutorReports {
  reportConfiguration: (configuration: SessionConfiguration) => void;
  reportIntegrity: (sessionId: string, findings: readonly Finding[]) => Promise<boolean>;
}

/**
 * Talk to the coordinator in the main process.
 *
 * The two reports are injected because only Studio can make them — both
 * require the executor generation, which only the window holding the audio
 * graph has. The popover passes no-ops, which is the truth: it has no controls
 * to edit and no graph to measure.
 */
export function desktopSessionClient(
  bridge: NonNullable<Window['desktop']>,
  reports: ExecutorReports,
  history: () => Promise<SessionRecord[]>,
): SessionClient {
  return {
    subscribe: fanOut(
      (onChange) =>
        bridge.session.subscribe((update) => {
          onChange(update as Published<SessionSnapshot>);
        }) as Promise<Published<SessionSnapshot>>,
    ),
    start: (request) => bridge.session.start(request),
    stop: () => bridge.session.stop(null),
    preview: (configuration) => bridge.session.preview(configuration),
    reportConfiguration: reports.reportConfiguration,
    reportIntegrity: reports.reportIntegrity,
    history,
  };
}
