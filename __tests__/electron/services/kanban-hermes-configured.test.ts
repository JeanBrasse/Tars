import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The agents' kanban writes to a Hermes someone configured, never to a guess.
 *
 * Without ~/.dorothy/hermes-connection.json, readHermesConnection() answers the
 * default, 127.0.0.1:9119, and on this machine that port is an SSH tunnel to a
 * real Hermes. A sandbox, a test home or a second Tars that has a
 * kanban-tasks.json and no connection file of its own would have moved its
 * tasks onto that board at launch, and its agents' tasks with them.
 *
 * How this can fail, written before the code:
 * 1. with no connection file, the kanban tools or the move of the local board reach the default port;
 * 2. with one, they do not reach it (the guard refuses a configured gateway).
 */

const home = os.homedir(); // a throwaway HOME, per __tests__/setup/home-isolation.ts
const file = path.join(home, '.dorothy', 'hermes-connection.json');

let hermesKanban: () => unknown;
// The routes bring half the main process with them: loaded once, with the time that takes.
beforeAll(async () => {
  ({ hermesKanban } = await import('../../../electron/services/api-routes/kanban-routes'));
}, 120_000);

beforeEach(() => fs.rmSync(file, { force: true }));

describe('the Hermes the kanban writes to', () => {
  it('is none when nobody configured one', () => {
    expect(fs.existsSync(file)).toBe(false);
    expect(hermesKanban()).toBeNull();
  });

  it('is the configured one when there is a connection file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    expect(hermesKanban()).not.toBeNull();
  });
});
