import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Read access lists, for the ACL tests (owner-only, secret-file-acl,
 * secret-file-staging), as SDDL: SIDs, whatever the language of the machine.
 *
 * Windows PowerShell 5.1, by its System32 path, and .NET only: no module is
 * loaded. On CI the step's shell is PowerShell 7, whose PSModulePath the 5.1
 * child inherited; it found PowerShell 7's Microsoft.PowerShell.Security
 * first, could not load it, and had no Get-Acl (run 36419462139). So the child
 * gets no PSModulePath (5.1 then builds its own), and the script calls
 * File/Directory.GetAccessControl, which needs no module at all.
 *
 * Loud: a read that fails, or returns fewer lists than it was asked for,
 * throws with the paths, the exit code, stderr and stdout. 5.1 exits 0 when a
 * command it cannot find fails, so the count is checked, not only the code.
 *
 * By SID, never by spelling: SDDL writes a trustee with a well-known alias
 * when it has one (SY, BA, WD, and LA for the built-in Administrator, RID 500,
 * which is the account on the windows-latest runner, run 36421786193). Every
 * trustee is rewritten as its SID, resolved by the same PowerShell through
 * SecurityIdentifier, so an entry for LA and one built from its SID compare
 * equal. The kind, flags and rights of each entry, the entries themselves and
 * the protected flag are kept as read.
 */

const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export type Dacl = { protectedFromParent: boolean; aces: string[] };

/** The environment the child runs in: this one, less PSModulePath (whatever its case). */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'psmodulepath') env[k] = v;
  return { ...env, ...extra };
}

function powershell(script: string, extra: Record<string, string> = {}): { lines: string[]; describe: () => string; ok: boolean } {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference = 'Stop'; ${script}`], { env: childEnv(extra), encoding: 'utf8', windowsHide: true });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  return {
    lines: stdout.trim() ? stdout.trim().split(/\r?\n/) : [],
    ok: !r.error && r.status === 0,
    describe: () => `exit ${r.status ?? 'none'}${r.error ? ` (${r.error.message})` : ''}\nstderr: ${stderr.trim() || '(empty)'}\nstdout: ${stdout.trim() || '(empty)'}`,
  };
}

// One line per path, "SDDL <form>", then one per alias seen, "ALIAS <alias> <SID>".
const READ = '$sddls = @($env:TARS_ACL_PROBE -split [char]10 | ForEach-Object { '
  + 'if ([System.IO.Directory]::Exists($_)) { [System.IO.Directory]::GetAccessControl($_, \'Access\').GetSecurityDescriptorSddlForm(\'Access\') } '
  + 'else { [System.IO.File]::GetAccessControl($_, \'Access\').GetSecurityDescriptorSddlForm(\'Access\') } }); '
  + 'foreach ($x in $sddls) { \'SDDL \' + $x }; $seen = @{}; '
  + 'foreach ($m in [regex]::Matches(($sddls -join \'\'), \';([A-Z]{2})\\)\')) { $a = $m.Groups[1].Value; '
  + 'if (-not $seen.ContainsKey($a)) { $seen[$a] = 1; \'ALIAS \' + $a + \' \' + ([System.Security.Principal.SecurityIdentifier]::new($a)).Value } }';

const SID = /^S-1-\d+(-\d+)+$/;

/**
 * An SDDL access list with every trustee written as its SID: `sidOf` resolves
 * an alias (two capitals) and must know every one met. The kind, flags and
 * rights of each entry and the protected flag are kept as they are.
 */
export function normalizeSddl(sddl: string, sidOf: (alias: string) => string): Dacl {
  const d = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!d) throw new Error(`no DACL in ${JSON.stringify(sddl)}`);
  const aces = (d[2].match(/\([^)]*\)/g) ?? []).map((ace) => {
    const fields = ace.slice(1, -1).split(';');
    const trustee = fields[fields.length - 1];
    let sid = trustee;
    if (/^[A-Z]{2}$/.test(trustee)) sid = sidOf(trustee);
    if (!SID.test(sid)) throw new Error(`${trustee} in ${ace} is not a SID (resolved to ${JSON.stringify(sid)})`);
    fields[fields.length - 1] = sid;
    return `(${fields.join(';')})`;
  });
  return { protectedFromParent: d[1].includes('P'), aces: aces.sort() };
}

export function readDacls(...paths: string[]): Dacl[] {
  const run = powershell(READ, { TARS_ACL_PROBE: paths.join('\n') });
  const sddls = run.lines.filter(l => l.startsWith('SDDL ')).map(l => l.slice(5));
  const aliases = new Map(run.lines.filter(l => l.startsWith('ALIAS ')).map((l) => {
    const [, alias, sid] = l.split(' ');
    return [alias, sid] as const;
  }));
  if (!run.ok || sddls.length !== paths.length) {
    throw new Error(`reading the access list of ${paths.join(', ')} failed: ${run.describe()}`);
  }
  const sidOf = (alias: string) => {
    const sid = aliases.get(alias);
    if (!sid) throw new Error(`no SID read for the alias ${alias}: ${run.describe()}`);
    return sid;
  };
  return sddls.map((sddl, i) => {
    try {
      return normalizeSddl(sddl, sidOf);
    } catch (err) {
      throw new Error(`the access list of ${paths[i]}: ${(err as Error).message}: ${run.describe()}`);
    }
  });
}

export function currentUserSid(): string {
  const run = powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  const sid = run.lines[0]?.trim() ?? '';
  if (!run.ok || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid)) throw new Error(`reading the current user's SID failed: ${run.describe()}`);
  return sid;
}
