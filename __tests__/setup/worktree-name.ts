import * as path from 'node:path';
import { createRequire } from 'node:module';
import { builtinsVitestCannotLoad } from './vitest-root-prefix';

/**
 * Every file fails here, with the reason, in a folder where vitest cannot load
 * some built-in modules (see vitest-root-prefix.ts). The failure this replaces
 * named a file that does not exist, `<worktree>/string_decoder`, in five test
 * files out of two hundred, and was taken for a broken worktree more than once.
 */
const distDir = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'dist');
const root = (globalThis as { __vitest_worker__?: { config?: { root?: string } } }).__vitest_worker__?.config?.root ?? process.cwd();
const lost = builtinsVitestCannotLoad(distDir, root);

if (lost.length > 0) {
  const name = path.basename(root);
  throw new Error([
    `vitest cannot load ${lost.join(', ')} in ${root}.`,
    `Its install, ${distDir}, is outside this folder, and it takes "${distDir.slice(root.length)}", what lies past this folder's length in that path, for the path of its own files:`,
    `an import of ${lost[0]} starts with it, and is looked for as ${path.join(root, lost[0])}.`,
    `Give this folder its own node_modules (cp -cR from a checkout that has them), or a name of another length than ${name.length} characters (${name}).`,
  ].join(' '));
}
