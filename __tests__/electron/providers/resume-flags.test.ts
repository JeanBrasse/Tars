import { describe, it, expect, vi } from 'vitest';

/**
 * A restart continues the conversation on every provider it restarts.
 *
 * The restart that applies a changed setting (core/agent-restart.ts) restarts
 * the providers that run the claude binary, fourteen of them, and asks each to
 * resume the session it ended, under a new id. Only Claude's own provider
 * passed the flags; the thirteen that point the binary at another vendor
 * dropped them, so a changed effort on an OpenRouter agent started it on a new
 * conversation without a word (the Audit's gate of #120). The binary resumes
 * wherever it is pointed, measured on 2.1.280 against a local Messages API.
 */

// Read by the providers' modules as they load, so it is set before any import.
const { tmpDir } = vi.hoisted(() => ({
  tmpDir: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-resume-flags-${process.pid}-${Date.now()}`),
}));

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

const SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';

async function commandFor(providerId: string, resume: { resumeSessionId?: string; forkSession?: boolean }): Promise<string> {
  const { getProvider } = await import('../../../electron/providers');
  return getProvider(providerId as never).buildInteractiveCommand({
    binaryPath: '/usr/local/bin/cli', prompt: '', model: 'some-model', ...resume,
  });
}

describe('the resume a restart asks for', () => {
  it('reaches every provider on the claude binary, forked', async () => {
    const { getAllProviders } = await import('../../../electron/providers');
    const onClaude = getAllProviders().filter(p => p.binaryName === 'claude');
    expect(onClaude.length).toBe(14);

    for (const provider of onClaude) {
      const command = await commandFor(provider.id, { resumeSessionId: SESSION, forkSession: true });
      expect(command, provider.id).toContain(` --resume '${SESSION}' --fork-session`);
    }
  });

  it('continues the session under its own id when no fork is asked for', async () => {
    const command = await commandFor('openrouter', { resumeSessionId: SESSION });

    expect(command).toContain(` --resume '${SESSION}'`);
    expect(command).not.toContain('--fork-session');
  });

  it('adds nothing without a session to resume', async () => {
    expect(await commandFor('openrouter', {})).not.toContain('--resume');
  });

  it('reaches no other CLI, whose resume flag nobody has verified', async () => {
    const { getAllProviders } = await import('../../../electron/providers');
    for (const provider of getAllProviders().filter(p => p.binaryName !== 'claude')) {
      const command = await commandFor(provider.id, { resumeSessionId: SESSION, forkSession: true });
      expect(command, provider.id).not.toContain(SESSION);
    }
  });
});
