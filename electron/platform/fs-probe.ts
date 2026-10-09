import * as fs from 'fs';

/**
 * The two questions the platform layer asks the disk. Injected everywhere so
 * the Windows rules are tested on any host with an in-memory disk, and the
 * real one is used in production.
 */
export interface FsProbe {
  /** True for an existing regular file (a directory named `x.exe` is not one). */
  isFile(p: string): boolean;
  /** The file as UTF-8 text. Throws as fs.readFileSync does. */
  readFile(p: string): string;
}

export const realFs: FsProbe = {
  isFile(p) {
    try {
      return fs.statSync(p).isFile();
    } catch (err) {
      // A Windows app execution alias (%LOCALAPPDATA%\Microsoft\WindowsApps\
      // wt.exe, and pwsh.exe or python.exe from the Store): a link Node cannot
      // follow into its package (stat EACCES, measured), which CreateProcess
      // starts all the same. Missing, unreadable otherwise, or a broken link:
      // not a file we can start.
      if ((err as NodeJS.ErrnoException)?.code !== 'EACCES') return false;
      try {
        return fs.lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    }
  },
  readFile(p) {
    return fs.readFileSync(p, 'utf8');
  },
};

/** An environment block as the spawners take it. */
export type Env = Record<string, string | undefined>;
