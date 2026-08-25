import { describe, it, expect } from 'vitest';
import { decide } from '../../scripts/scope-checks.mjs';

/**
 * Which checks a change actually needs.
 *
 * The end to end suite is three minutes of the roughly four a review round
 * costs, and it was run after every change including ones that could not have
 * moved a pixel. The saving is only worth having if the decision is safe, and
 * safe here has a direction: a file nobody has classified must run the suite,
 * never skip it. A skip that is wrong hides a visual regression, which costs
 * incomparably more than the three minutes it saved.
 *
 * So the assertions below are mostly about what still runs.
 */

const runs = (files: string[]) => decide(files).runE2E;

describe('changes that cannot reach a rendered surface', () => {
  it.each([
    ['a round of unit tests', ['__tests__/electron/services/agent-watch.test.ts']],
    ['an MCP server bundle', ['mcp-orchestrator/src/tools/agents.ts']],
    ['several MCP servers at once', ['mcp-vault/src/index.ts', 'mcp-x/src/tools/post.ts']],
    ['the shell hooks', ['hooks/session-start.sh', 'hooks/on-stop.sh']],
    ['build tooling', ['scripts/sandbox.sh', 'scripts/scope-checks.mjs']],
    ['documentation', ['README.md', 'SPECS.md', 'CLAUDE.md']],
    ['agent prompt text', ['electron/resources/super-agent-instructions.md']],
    ['CI configuration', ['.github/workflows/ci.yml']],
    ['the landing site', ['landing/src/app/page.tsx']],
  ])('skips the suite for %s', (_name, files) => {
    expect(runs(files as string[])).toBe(false);
  });

  it('names every file it skipped, and why', () => {
    const decision = decide(['__tests__/a.test.ts', 'hooks/on-stop.sh']);

    expect(decision.skipped.map(s => s.file)).toEqual(['__tests__/a.test.ts', 'hooks/on-stop.sh']);
    for (const entry of decision.skipped) expect(entry.why.length).toBeGreaterThan(0);
  });
});

describe('changes that can', () => {
  it.each([
    ['a renderer component', ['src/components/Overseer/MessageCard.tsx']],
    ['a shared ui primitive', ['src/components/ui/index.ts']],
    ['the token system', ['src/app/globals.css']],
    ['a hook the pages read', ['src/hooks/useAgents.ts']],
    ['data that is rendered', ['src/data/changelog.ts']],
    ['a Pencil frame', ['design/tars-redesign.pen']],
    ['a public asset', ['public/icon.svg']],
    ['the window itself', ['electron/core/window-manager.ts']],
    ['the renderer contract', ['electron/preload.ts']],
    ['a service behind a page', ['electron/services/overseer.ts']],
    ['an IPC handler', ['electron/handlers/ipc-handlers.ts']],
    ['the build configuration', ['next.config.ts']],
    ['the dependency set', ['package.json']],
    ['the suite itself', ['e2e/surfaces.mjs']],
    ['the suite configuration', ['playwright.config.ts']],
  ])('runs the suite for %s', (_name, files) => {
    expect(runs(files as string[])).toBe(true);
  });

  /**
   * electron/ is the one people assume is safe, and it is not: the suite boots
   * the real app against a seeded home, so what a page shows arrives through
   * real main process code.
   */
  it('runs the suite for electron, which is not the renderer but reaches it', () => {
    expect(runs(['electron/services/usage-ledger.ts'])).toBe(true);
    expect(runs(['electron/core/agent-manager.ts'])).toBe(true);
  });
});

describe('anything it has never heard of', () => {
  it.each([
    ['a brand new top level directory', ['packages/design-system/Button.tsx']],
    ['a config nobody classified', ['vite.config.ts']],
    ['a file with no directory at all', ['weird-thing.ts']],
    ['an unexpected extension', ['src/theme.scss']],
  ])('runs the suite for %s', (_name, files) => {
    expect(runs(files as string[])).toBe(true);
  });

  it('runs the suite when there is no diff to reason about', () => {
    // No files means the comparison failed, not that nothing changed.
    expect(runs([])).toBe(true);
    expect(decide([]).reason).toMatch(/nothing can be ruled out/);
  });
});

describe('a mixed change', () => {
  it('runs the suite when a single file in it can reach the renderer', () => {
    const files = [
      '__tests__/a.test.ts',
      'hooks/on-stop.sh',
      'scripts/sandbox.sh',
      'README.md',
      'src/app/page.tsx',
    ];

    const decision = decide(files);

    expect(decision.runE2E).toBe(true);
    // And it says which one forced it, so the decision can be argued with.
    expect(decision.forcing.map(f => f.file)).toEqual(['src/app/page.tsx']);
  });

  it('does not let a safe majority outvote one risky file', () => {
    const safe = Array.from({ length: 40 }, (_, i) => `__tests__/t${i}.test.ts`);

    expect(runs([...safe, 'electron/preload.ts'])).toBe(true);
  });
});

describe('the classification itself', () => {
  it('treats a path prefix as a prefix, not a substring', () => {
    // A directory that merely starts with the same letters is not the same
    // directory, and must not inherit its exemption.
    expect(runs(['src/hooks/useAgents.ts'])).toBe(true);
    expect(runs(['src/scripts/loader.ts'])).toBe(true);
    expect(runs(['electron/resources/local-agent-runner.js'])).toBe(true);
  });

  it('exempts documentation only at the repository root', () => {
    expect(runs(['README.md'])).toBe(false);
    // A markdown file inside the renderer is content the app can display.
    expect(runs(['src/content/guide.md'])).toBe(true);
  });
});
