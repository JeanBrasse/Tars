import * as path from 'path';

/**
 * The name a project goes by where a person reads it (the bots' fleet and
 * project lists, a chat room's title): the last folder of its path, or ''
 * for a root or an empty path, which each caller replaces with its own
 * fallback (audit B/J-01).
 *
 * darwin/linux: the last `/` segment, as `split('/').pop()` gave it, except
 * that a trailing `/` is dropped (`/a/atlas/` is `atlas`, where the bots said
 * 'Unknown'; the chat room already dropped it). `\` is an ordinary character
 * there. win32: `\` and `/` are both separators, and a drive or share root
 * (`C:\`, `C:`, `\\srv\share`) is no name.
 */
export function projectName(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.posix.basename(p);
  // basename would name a share root by its share.
  return path.win32.basename(p.slice(path.win32.parse(p).root.length));
}
