import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * The version probes Tars runs end with the quit (the Audit's gate of #298).
 *
 * Settings runs `amp --version`, `gemini --version` and the others
 * (`shell:version`), and Settings > System `claude --version`, each through
 * execFile with an 8 s timeout. Quitting Tars did not end them: amp, started
 * just before a quit, kept writing into the home after the app was gone, and
 * QA's bench (nex/r-amp-probe/) measured it.
 *
 * How it fails, written before the code (2026-10-04):
 * 1. A probe running when the quit begins outlives it, and writes.
 * 2. What the probe started outlives it: only the binary is ended, not its tree.
 * 3. A probe asked for during the quit is started.
 * 4. Over-correction: a probe that answers in time no longer answers its
 *    version, or one that hangs is no longer cut by its timeout.
 * 5. The quit never ends them: main.ts's first pass has no step for it.
 * 6. A `--version` probe in electron/ goes around the module.
 */

const ELECTRON = path.join(__dirname, '../../../electron');

function standIn(body: string): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-probe-'));
  const bin = path.join(dir, 'stand-in');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { bin, dir };
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fresh() {
  const { vi } = await import('vitest');
  vi.resetModules();
  const quit = await import('../../../electron/core/quit-state');
  const probe = await import('../../../electron/core/version-probe');
  return { quit, probe };
}

describe('a version probe', () => {
  it('4. answers its version when the binary answers in time', async () => {
    const { probe } = await fresh();
    const { bin, dir } = standIn('echo "amp 1.2.3"');
    try {
      await expect(probe.probeVersion(bin, process.env)).resolves.toMatchObject({ stdout: 'amp 1.2.3\n' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. is still cut by its timeout', async () => {
    const { probe } = await fresh();
    const { bin, dir } = standIn('sleep 5; echo late');
    try {
      const began = Date.now();
      await expect(probe.probeVersion(bin, process.env, 300)).rejects.toThrow();
      expect(Date.now() - began).toBeLessThan(3000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1, 2. running when the quit begins, it ends with what it started, and nothing writes after', async () => {
    const { probe } = await fresh();
    // A Node stand-in, like amp: it starts a child, says so, and both write a
    // second later. (A shell's background child proved too slow to start, on a
    // loaded machine, to tell a kill of the group from a kill of the binary.)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-probe-'));
    const bin = path.join(dir, 'stand-in');
    fs.writeFileSync(bin, [
      `#!${process.execPath}`,
      "const { spawn } = require('child_process'); const fs = require('fs');",
      "spawn(process.execPath, ['-e', 'setTimeout(() => require(\"fs\").writeFileSync(process.argv[1], \"\"), 1000)', __filename + '.child'], { stdio: 'ignore' });",
      "fs.writeFileSync(__filename + '.started', '');",
      "setTimeout(() => { fs.writeFileSync(__filename + '.self', ''); console.log('late'); }, 1000);",
      '',
    ].join('\n'), { mode: 0o755 });
    try {
      const answer = probe.probeVersion(bin, process.env).then(() => 'answered', () => 'ended');
      for (const until = Date.now() + 10_000; !fs.existsSync(`${bin}.started`) && Date.now() < until;) await settle(50);
      expect(fs.existsSync(`${bin}.started`), 'the stand-in never started').toBe(true);
      probe.endVersionProbes();
      expect(await answer).toBe('ended');
      await settle(3000);
      expect(fs.existsSync(`${bin}.self`), 'the probe wrote after the quit').toBe(false);
      expect(fs.existsSync(`${bin}.child`), 'what the probe started wrote after the quit').toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('3. is not started during the quit', async () => {
    const { quit, probe } = await fresh();
    const { bin, dir } = standIn(`touch "${'$0'}.ran"; echo 1`);
    try {
      quit.beginQuit();
      await expect(probe.probeVersion(bin, process.env)).rejects.toThrow(/quitting/);
      await settle(300);
      expect(fs.existsSync(`${bin}.ran`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('in the app', () => {
  it("5. main.ts's first quit pass ends the probes", () => {
    const file = path.join(ELECTRON, 'main.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.ES2022, true);
    let first: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (first) return;
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'runShutdownSteps' && ts.isArrayLiteralExpression(node.arguments[0])) {
        first = node.arguments[0].elements.map(e => (ts.isArrayLiteralExpression(e) && ts.isStringLiteral(e.elements[0]) ? e.elements[0].text : '?'));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(first).toContain('endVersionProbes');
  });

  it('6. every --version probe in electron/ goes through probeVersion', () => {
    const around: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'dist') walk(p); continue; }
        if (!e.name.endsWith('.ts') || p.endsWith(path.join('core', 'version-probe.ts'))) continue;
        const text = fs.readFileSync(p, 'utf-8');
        if (/\[\s*'--version'\s*\]/.test(text)) around.push(path.relative(ELECTRON, p));
      }
    };
    walk(ELECTRON);
    expect(around).toEqual([]);
  });
});
