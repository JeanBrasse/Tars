import { builtinModules } from 'node:module';

/**
 * The built-in modules vitest cannot load when its own install lies outside the
 * folder it runs in. Found by the Database Engineer on 2026-09-23.
 *
 * vitest 4.1 (getCachedVitestImport, in startVitestModuleRunner) takes
 * `distDir.slice(root.length)` for the path of its own files inside the root,
 * and loads any import that starts with it as a file of the root. Installed
 * inside the root, that is `/node_modules/vitest/dist`, and no bare import
 * starts with a slash. Installed outside it, as for a worktree that resolves to
 * the repository's node_modules, it is whatever of the install's path lies past
 * the root's length. Under /Users/noah/tars/.worktrees/, a name of 11
 * characters leaves `st`, so `import { StringDecoder } from 'string_decoder'`
 * is looked for as <worktree>/string_decoder; 12 leaves `t`, which takes
 * timers, tls and tty.
 */
export function builtinsVitestCannotLoad(distDir: string, root: string): string[] {
  const kept = distDir.replace(/\\/g, '/').slice(root.length);
  // Empty, vitest keeps nothing. A slash needs no case: no built-in starts with one.
  if (!kept) return [];
  return builtinModules.filter(name => name.startsWith(kept));
}
