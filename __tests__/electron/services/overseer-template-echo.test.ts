import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The overseer repeating its own format example instead of answering.
 *
 * The prompt shows Hermes the envelope to fill in. One turn copied the example
 * rather than filling it, which is still valid JSON, so it was accepted and
 * written to the conversation. Every turn after that was shown the placeholder
 * as something the overseer had already said, and copied it in turn: nineteen
 * consecutive turns on Noah's install, none able to recover on its own.
 *
 * So the assertions are about the two artifacts that carry the loop, not about
 * a helper returning true: what ends up in overseer.json, and what is in the
 * prompt actually handed to the gateway on the next turn.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-overseer-echo-'));

vi.mock('../../../electron/constants', () => ({
  DATA_DIR: tmp,
  API_PORT: 31415,
  dataPath: (f: string) => path.join(tmp, f),
}));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ success: false }) }));
vi.mock('../../../electron/services/hermes-config', () => ({
  usableHermesConnection: () => ({ url: 'http://gateway.test', token: 't' }),
}));

const TEMPLATE = '<what you tell Noah, plain text or light markdown>';

/** What the gateway answers on the next turn. */
let nextReply = 'the fleet is quiet';
/** Every prompt Tars actually sent, in order. */
const promptsSent: string[] = [];

vi.mock('../../../electron/services/hermes-client', () => ({
  probeHermes: async () => ({ reachable: true, authRequired: false, signedIn: true }),
  createHermesCron: async () => ({ success: true, job: { id: 'job-1' } }),
  updateHermesCron: async (_conn: unknown, _id: string, patch: { prompt?: string }) => {
    if (typeof patch?.prompt === 'string') promptsSent.push(patch.prompt);
    return { success: true, job: { id: 'job-1' } };
  },
  hermesCronAction: async () => ({ success: true }),
  fetchHermesCronRuns: async () => {
    const t = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_');
    return { success: true, runs: [{ id: `cron_job-1_${t.slice(0, 8)}_${t.slice(9, 15)}` }] };
  },
  fetchHermesSessionMessages: async () => ({
    success: true,
    messages: [{ role: 'assistant', content: nextReply }],
  }),
  fetchHermesModelOptions: async () => ({ success: true, provider: '', model: '', providers: [] }),
  setHermesModel: async () => ({ success: true }),
}));

const OVERSEER_FILE = path.join(tmp, 'overseer.json');
let overseer: typeof import('../../../electron/services/overseer');

/** The conversation as it is on disk, which is what conditions the next turn. */
function persisted(): { role: string; text: string }[] {
  if (!fs.existsSync(OVERSEER_FILE)) return [];
  return JSON.parse(fs.readFileSync(OVERSEER_FILE, 'utf-8')).messages ?? [];
}

function seed(messages: { role: string; text: string }[]): void {
  fs.writeFileSync(OVERSEER_FILE, JSON.stringify({
    jobId: 'job-1',
    messages: messages.map((m, i) => ({
      id: `seed-${i}`,
      role: m.role,
      text: m.text,
      action: null,
      timestamp: new Date().toISOString(),
    })),
    previousSnapshot: null,
    longRunningReported: [],
    paused: false,
  }, null, 2));
}

beforeEach(async () => {
  promptsSent.length = 0;
  nextReply = 'the fleet is quiet';
  if (fs.existsSync(OVERSEER_FILE)) fs.rmSync(OVERSEER_FILE);
  vi.resetModules();
  overseer = await import('../../../electron/services/overseer');
});

describe('a reply that is the format template', () => {
  it('is refused, and never reaches the conversation', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });

    const result = await overseer.askOverseer('salut');

    expect(result.ok).toBe(false);
    // Noah's own turn is kept: he did say it. The echo is not.
    expect(persisted().map(m => m.role)).toEqual(['user']);
    expect(JSON.stringify(persisted())).not.toContain('what you tell Noah');
  }, 30000);

  it('leaves the next turn free to answer properly', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });
    await overseer.askOverseer('salut');

    nextReply = JSON.stringify({ say: 'Frontend is waiting on you.', action: null });
    const second = await overseer.askOverseer('et maintenant?');

    expect(second.ok).toBe(true);
    // The refused turn left nothing behind for this one to copy.
    expect(promptsSent[promptsSent.length - 1]).not.toContain('OVERSEER: <what you tell Noah');
    const texts = persisted().map(m => m.text);
    expect(texts).toContain('Frontend is waiting on you.');
    expect(texts).not.toContain(TEMPLATE);
  }, 30000);

  it('catches the bare gateway sentinel too', async () => {
    // Not JSON and not in the repo: the gateway's own "produce no output"
    // marker, which used to be shown to Noah as if it were a message.
    nextReply = '[SILENT]';

    const result = await overseer.askOverseer('salut');

    expect(result.ok).toBe(false);
    expect(persisted().map(m => m.role)).toEqual(['user']);
  }, 30000);

  it('does not refuse a real answer that happens to use angle brackets', async () => {
    const real = 'Backend printed `a < b && c > d` in its output, which is the comparison that fails.';
    nextReply = JSON.stringify({ say: real, action: null });

    const result = await overseer.askOverseer('salut');

    expect(result.ok).toBe(true);
    expect(persisted().map(m => m.text)).toContain(real);
  }, 30000);
});

describe('a conversation that is already poisoned', () => {
  /** Noah's file: two real answers, then the echo on every turn after. */
  const poisoned = [
    { role: 'user', text: 'salut' },
    { role: 'overseer', text: 'Salut Noah. Rien de bloque, mais un agent t attend.' },
    ...Array.from({ length: 17 }, () => ({ role: 'overseer', text: TEMPLATE })),
    { role: 'user', text: 'ca dit quoi?' },
  ];

  it('is cleaned up on load rather than needing the file edited by hand', async () => {
    seed(poisoned);

    const history = overseer.getOverseerHistory();

    expect(history.map(m => m.text)).not.toContain(TEMPLATE);
    expect(history).toHaveLength(3);
    // Written back, so the next process does not start from the poison again.
    expect(JSON.stringify(persisted())).not.toContain('what you tell Noah');
  });

  it('keeps the real answers it is sitting between', async () => {
    seed(poisoned);

    const texts = overseer.getOverseerHistory().map(m => m.text);

    expect(texts).toContain('Salut Noah. Rien de bloque, mais un agent t attend.');
    expect(texts).toContain('salut');
    expect(texts).toContain('ca dit quoi?');
  });

  it('never quotes the echo back to the model as an example to follow', async () => {
    seed(poisoned);

    await overseer.askOverseer('et maintenant?');

    const prompt = promptsSent[promptsSent.length - 1];
    expect(prompt).toBeTypeOf('string');
    // The conversation section is what conditions the reply. The 17 echoes
    // must not appear in it under any speaker.
    expect(prompt).not.toContain(TEMPLATE);
    // The real turns still do, or the fix would have cost the context.
    expect(prompt).toContain('Salut Noah. Rien de bloque');
  }, 30000);

  it('offers no bracketed placeholder for the model to copy in the first place', async () => {
    await overseer.askOverseer('salut');

    const prompt = promptsSent[promptsSent.length - 1];
    const instructions = prompt.slice(0, prompt.indexOf('=== FLEET SNAPSHOT ==='));
    expect(instructions).toContain('"say"');
    // The example is filled in, so copying it verbatim is no longer the path
    // of least resistance.
    expect(instructions).not.toMatch(/<what you tell Noah/);
    expect(instructions).not.toMatch(/<id from the snapshot>/);
  }, 30000);
});

describe('clearing the conversation', () => {
  it('empties it and says how much it dropped, keeping the settings', async () => {
    seed([
      { role: 'user', text: 'salut' },
      { role: 'overseer', text: 'Frontend is waiting on you.' },
    ]);
    overseer.setOverseerSettings({ watchIntervalMs: 900_000, provider: 'anthropic', model: 'claude-opus-5' });

    expect(overseer.clearOverseerHistory()).toEqual({ cleared: 2 });

    expect(overseer.getOverseerHistory()).toEqual([]);
    expect(overseer.getOverseerSettings()).toMatchObject({
      watchIntervalMs: 900_000,
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('is a no-op on an empty conversation', () => {
    expect(overseer.clearOverseerHistory()).toEqual({ cleared: 0 });
  });
});
