/**
 * The Brain page's projects, when a project's path goes through a link
 * (electron/services/memory-service.ts, listProjectMemories). Claude Code files
 * a session under the real path; Tars keeps a project's path as it was saved.
 * The Frontend found it in the README's sandbox, a project under /tmp on macOS
 * (/private/tmp), and on a symlinked checkout: repro in
 * readme-pics-0710/brain-dup/.
 *
 * How it fails, written before the code (2026-10-07):
 * 1. A project Tars saved through a link, which Claude Code filed under its
 *    real path, is listed twice: once with its memory from Claude Code's
 *    folder, once more as a project with no memory yet.
 * 2. The same project saved twice in Tars's list, once through the link and
 *    once by its real path, is listed twice.
 * 3. A project saved through a link that Claude Code has no folder for yet is
 *    offered a memory folder under the saved spelling, which Claude Code never
 *    reads: a MEMORY.md made there from the Brain page is never loaded.
 * 4. Over-correction: a project Claude Code has no folder for is no longer
 *    listed, or two projects of the same name in different folders become one.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-mem-spell-${process.pid}-${Date.now()}`,
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});

import { listProjectMemories } from '../../../electron/services/memory-service';

let base: string;
/** The folder Claude Code keeps for a project at `real`, as it names it. */
const claudeFolder = (real: string) => path.join(tmpHome, '.claude', 'projects', real.replace(/[/.]/g, '-'));

/** A project at a real path, a link to it, and optionally Claude Code's folder for it with a MEMORY.md. */
function project(name: string, withClaude: boolean): { real: string; link: string } {
  const real = path.join(base, 'real', name);
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(base, 'links', name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  if (withClaude) {
    fs.mkdirSync(path.join(claudeFolder(real), 'memory'), { recursive: true });
    fs.writeFileSync(path.join(claudeFolder(real), 'session.jsonl'), '{}\n');
    fs.writeFileSync(path.join(claudeFolder(real), 'memory', 'MEMORY.md'), '# kept\n');
  }
  return { real, link };
}

beforeAll(() => {
  fs.mkdirSync(tmpHome, { recursive: true });
  // The temp folder may itself go through a link (/var on macOS): the real one.
  base = fs.realpathSync(fs.mkdtempSync(path.join(tmpHome, 'projects-')));
});
afterAll(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

const of = (list: Awaited<ReturnType<typeof listProjectMemories>>, real: string, link: string) =>
  list.filter(p => p.projectPath === real || p.projectPath === link);

describe("the Brain page's projects, through a link", () => {
  it('1. lists a project saved through a link once, with the memory Claude Code keeps under its real path', async () => {
    const { real, link } = project('alpha', true);
    const listed = of(await listProjectMemories([link]), real, link);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ projectPath: real, hasMemory: true });
  });

  it('2. lists it once when Tars saved it both ways', async () => {
    const { real, link } = project('beta', true);
    expect(of(await listProjectMemories([link, real]), real, link)).toHaveLength(1);
    const { real: r2, link: l2 } = project('beta-new', false);
    expect(of(await listProjectMemories([l2, r2]), r2, l2)).toHaveLength(1);
  });

  it('3. offers a memory folder where Claude Code will read it: under the real path', async () => {
    const { real, link } = project('gamma', false);
    const [entry] = of(await listProjectMemories([link]), real, link);
    expect(entry.memoryDir).toBe(path.join(claudeFolder(real), 'memory'));
  });

  it('4. still lists a project Claude Code has no folder for, and two projects of one name in different folders', async () => {
    const { real, link } = project('delta', false);
    const other = path.join(base, 'elsewhere', 'delta');
    fs.mkdirSync(other, { recursive: true });
    const list = await listProjectMemories([link, other]);
    expect(of(list, real, link)).toHaveLength(1);
    expect(list.filter(p => p.projectPath === other)).toHaveLength(1);
    expect(list.filter(p => p.projectName === 'delta')).toHaveLength(2);
  });
});
