import * as path from 'path';

/**
 * The name a project goes by where a person reads it (the agent lines of the
 * Telegram, Slack and Discord bots): the last folder of its path, or ''
 * for a root or an empty path, which each caller replaces with its own
 * fallback.
 *
 * darwin/linux: the last `/` segment, exactly as `split('/').pop()` gave it
 * (a trailing `/` gives ''). `\` is an ordinary character there. win32: `\`
 * and `/` are both separators, a trailing one is dropped, and a drive or share
 * root (`C:\`, `C:`, `\\srv\share`) is no name.
 */
export function projectName(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return p.split('/').pop() ?? '';
  // basename would name a share root by its share.
  return path.win32.basename(p.slice(path.win32.parse(p).root.length));
}
