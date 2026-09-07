import * as path from 'path';
import { CLI_PATH_KEYS } from '../types';

/**
 * The directories holding the CLIs the user has configured.
 *
 * Every caller that spawns an agent PTY needs exactly this, and every caller
 * used to spell it out: four hand-written key lists that had already stopped
 * agreeing with each other. Reading CLI_PATH_KEYS means adding a binary is one
 * edit rather than five, and forgetting one of the five is no longer possible.
 *
 * Takes a loose shape on purpose: this is fed straight from app-settings.json,
 * which is a file on disk and may predate any given key.
 *
 * Its own module rather than a function in path-builder, because six suites
 * stub that module down to buildFullPath alone. Adding an export there breaks
 * all six, and stubbing this one would be stubbing the thing under test: it is
 * pure, it touches no filesystem, and the real one is what those tests want.
 */
export function cliPathDirs(cliPaths: Partial<Record<string, unknown>> | undefined | null): string[] {
  if (!cliPaths) return [];
  const dirs: string[] = [];
  for (const key of CLI_PATH_KEYS) {
    const value = cliPaths[key];
    if (typeof value === 'string' && value) dirs.push(path.dirname(value));
  }
  const extra = cliPaths.additionalPaths;
  if (Array.isArray(extra)) {
    dirs.push(...extra.filter((p): p is string => typeof p === 'string' && !!p));
  }
  return dirs;
}
