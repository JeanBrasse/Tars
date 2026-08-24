import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { orchestratorToolFlags } from '../../../electron/providers/cli-provider';

/**
 * What an orchestrator is not allowed to do.
 *
 * Orchestrator mode exists so an agent delegates instead of doing the work
 * itself. The restriction lived in claude-provider.ts alone, next to thirteen
 * providers that run the same `claude` binary and applied none of it: an
 * orchestrator on DeepSeek, Venice or Ollama Cloud could edit files directly.
 *
 * `Task` is on the list because it spawns an ephemeral subagent, which looks
 * like delegating and is not: the work stays inside the orchestrator's own
 * session, never reaches the specialist agent, and cannot be seen or stopped
 * from Tars. An orchestrator asked for a security audit did exactly that.
 *
 * The last test is the one that matters over time: it reads the provider
 * directory, so a fourteenth provider added without the restriction fails
 * here rather than shipping.
 */

describe('the restriction itself', () => {
  it('is empty for an ordinary agent', () => {
    expect(orchestratorToolFlags(false)).toBe('');
    expect(orchestratorToolFlags(undefined)).toBe('');
  });

  it('blocks every file-mutating tool', () => {
    const flags = orchestratorToolFlags(true);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(flags).toContain(`"${tool}"`);
    }
  });

  it('blocks the built-in subagent tool', () => {
    expect(orchestratorToolFlags(true)).toContain('"Task"');
  });

  it('leaves Bash alone, which an orchestrator needs to know what to delegate', () => {
    expect(orchestratorToolFlags(true)).not.toContain('"Bash"');
  });
});

describe('every provider that runs the claude binary applies it', () => {
  const dir = 'electron/providers';
  const repointed = fs.readdirSync(dir)
    .filter(f => f.endsWith('-provider.ts'))
    .filter(f => {
      const s = fs.readFileSync(path.join(dir, f), 'utf-8');
      return s.includes("binaryName = 'claude'") && s.includes('buildInteractiveCommand');
    });

  it('finds all of them', () => {
    // Claude plus the ones that re-point the same binary at another vendor.
    expect(repointed.length).toBeGreaterThanOrEqual(14);
  });

  for (const file of repointed) {
    it(`${file} restricts orchestrator mode`, () => {
      const src = fs.readFileSync(path.join(dir, file), 'utf-8');
      expect(
        src.includes('orchestratorToolFlags(params.orchestratorMode)'),
        `${file} builds a claude command but never calls orchestratorToolFlags`,
      ).toBe(true);
    });
  }

  it('nobody keeps a private copy of the list', () => {
    // Two copies drift. That is how thirteen providers ended up with none.
    for (const file of repointed) {
      const src = fs.readFileSync(path.join(dir, file), 'utf-8');
      expect(src.includes('--disallowed-tools'), `${file} spells the list out itself`).toBe(false);
    }
  });
});
