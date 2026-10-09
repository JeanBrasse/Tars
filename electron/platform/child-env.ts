import * as path from 'path';
import type { Env } from './fs-probe';

/**
 * The environment a program Tars starts gets: the one it was given, except
 * that Windows PowerShell 5.1 gets no PSModulePath.
 *
 * A Tars started from PowerShell 7 (a developer's pwsh, Windows Terminal, CI's
 * step shell) inherits pwsh 7's PSModulePath, which lists pwsh 7's own
 * modules first. Windows PowerShell handed that value finds
 * Microsoft.PowerShell.Utility, .Security and the rest there first, cannot
 * load them (Core edition, PowerShell 7.0), and has no New-Object, Get-Acl,
 * Select-Object: it says so on stderr and may exit 0. Without the variable,
 * 5.1 builds its own default, which is what it gets when started from
 * Explorer or cmd.exe. pwsh 7 does the same for the 5.1 it starts itself
 * (about_PSModulePath); Node does not.
 *
 * Only for powershell.exe, by the name of the file started (a path, a bare
 * name, quoted or not, any case). pwsh 7 repairs an inherited value itself and
 * needs its own modules first; any other program may start a pwsh of its own
 * and keeps the value it was given. Those, and darwin/linux whatever the
 * program, get the same object back. Every spelling of the key goes: a copied
 * env is a plain object, and Windows would read `PSMODULEPATH` as the same
 * variable. The caller's object is never changed.
 */
export function childEnv<E extends Env>(file: string, env: E, platform: NodeJS.Platform = process.platform): E {
  if (platform !== 'win32' || !isWindowsPowerShell(file)) return env;
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== 'psmodulepath') out[k] = v;
  return out as E;
}

function isWindowsPowerShell(file: string): boolean {
  const name = path.win32.basename(file.trim().replace(/^"|"$/g, '')).toLowerCase();
  return name === 'powershell' || name === 'powershell.exe';
}
