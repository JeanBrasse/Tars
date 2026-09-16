import * as fs from 'fs';
import { dataPath } from '../constants';

/**
 * The journal the per-agent token transition is read from.
 *
 * The transition keeps the shared token working for callers that still name
 * themselves in a header, and it ends on evidence: the day this file stops
 * growing, nobody is left on that path and the fallback can go. That evidence
 * has to be readable where it matters. The main process's console is not: an
 * app started from the Dock writes it nowhere, so a journal kept only there
 * would have made the one condition the transition waits on unobservable on
 * the machine it runs on.
 *
 * Also written: every call refused for presenting one agent's token and
 * another agent's name, which is the only place an attempt to be another agent
 * shows at all.
 *
 * One line per kind of event, agent and route for the life of the app, since
 * an MCP server polling /wait would otherwise write a line every few seconds.
 * A restart logs afresh, which is exactly when the question gets asked again.
 * Appended without waiting: a journal must never be the reason a request is
 * slow, and a write that fails is said on the console rather than thrown into
 * the request that happened to trigger it.
 */

const JOURNAL = 'identity-transition.log';
const written = new Set<string>();

export function noteIdentity(key: string, line: string): void {
  console.warn(line);
  if (written.has(key)) return;
  written.add(key);
  fs.promises
    .appendFile(dataPath(JOURNAL), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    .catch((err: Error) => console.warn(`[identity] the transition journal could not be written: ${err.message}`));
}
