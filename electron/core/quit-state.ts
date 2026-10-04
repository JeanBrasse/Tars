/**
 * Whether Tars is quitting, for everything that must not start or report
 * anything once it is.
 *
 * The quit ends the terminals it holds over a grace of up to two seconds
 * (endAllTerminals in pty-manager.ts), while the API, the IPC and the bots
 * still serve. Measured on #235 (the Audit's gate): a /start 200 ms into the
 * quit spawned a CLI in no map, which nothing ended; one that ignored SIGHUP
 * held the app for ten minutes. So every spawn site asks refuseWhileQuitting
 * first, and every exit handler asks agentStatusOnExit what the exit means.
 *
 * Its own module with no imports: the spawn sites include modules that tests
 * stub pty-manager out of, and the ACP client, which pty-manager imports.
 */

let quitting = false;

export function isQuitting(): boolean {
  return quitting;
}

export function beginQuit(): void {
  quitting = true;
}

/** Throws once the quit has begun: `what` is what was about to start. */
export function refuseWhileQuitting(what: string): void {
  if (quitting) throw new Error(`Tars is quitting: no new ${what} is started.`);
}

/**
 * What a terminal's end says about its agent: completed or error, or nothing
 * once the quit has begun, since the quit ended it (the Audit's gate of #235:
 * every agent was saved `completed` at each quit, and the window told so).
 */
export function agentStatusOnExit(exitCode: number): 'completed' | 'error' | null {
  if (quitting) return null;
  return exitCode === 0 ? 'completed' : 'error';
}
