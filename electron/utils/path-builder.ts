import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { buildWindowsFullPath } from '../platform/path-env';

/**
 * Build a full PATH string that includes nvm node versions,
 * common binary locations, and the existing process PATH.
 *
 * @param extraPaths - Additional paths to prepend (e.g. user-configured CLI paths)
 * @param opts - The environment and platform to build for (default: this process's).
 *   On win32 the Windows rules apply (electron/platform/path-env.ts).
 * @returns Deduplicated PATH string
 */
export function buildFullPath(
  extraPaths: string[] = [],
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string {
  const env = opts.env ?? process.env;
  if ((opts.platform ?? process.platform) === 'win32') return buildWindowsFullPath(extraPaths, env);
  const homeDir = env.HOME || os.homedir();
  const existingPath = env.PATH || '';

  const additionalPaths = [
    ...extraPaths,
    path.join(homeDir, '.nvm/versions/node/v20.11.1/bin'),
    path.join(homeDir, '.nvm/versions/node/v22.0.0/bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(homeDir, '.local/bin'),
  ];

  // Find any nvm node version directories
  const nvmDir = path.join(homeDir, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      for (const version of versions) {
        additionalPaths.push(path.join(nvmDir, version, 'bin'));
      }
    } catch {
      // Ignore errors
    }
  }

  return [...new Set([...additionalPaths, ...existingPath.split(':')])].join(':');
}
