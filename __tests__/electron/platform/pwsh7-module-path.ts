import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A PSModulePath as a process started from PowerShell 7 inherits it: PowerShell
 * 7's own modules first, then Windows PowerShell's. Emulated, since pwsh is not
 * installed everywhere: a folder of module manifests under PowerShell 7's
 * module names that ask for PowerShell 7.0 and the Core edition, which Windows
 * PowerShell 5.1 finds first and cannot load. It then has no New-Object,
 * Select-Object or ConvertTo-Json (Utility), no Get-Acl (Security), no
 * Get-CimInstance (CimCmdlets), says so on stderr and may still exit 0.
 *
 * Returns the value to put in a child's environment: the folder, then the
 * value this process has (the machine's own module folders), as pwsh 7 builds it.
 */
const CORE_ONLY: Record<string, string[]> = {
  'Microsoft.PowerShell.Utility': ['New-Object', 'Select-Object', 'ConvertTo-Json'],
  'Microsoft.PowerShell.Security': ['Get-Acl', 'Set-Acl'],
  'Microsoft.PowerShell.Management': ['Get-Item', 'Get-ChildItem'],
  CimCmdlets: ['Get-CimInstance'],
};

export function pwsh7ModulePath(under: string): string {
  const root = path.join(under, 'pwsh7-modules');
  for (const [name, cmdlets] of Object.entries(CORE_ONLY)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, `${name}.psd1`), [
      '@{',
      "  ModuleVersion = '7.0.0.0'",
      "  GUID = 'a94c8c7e-9810-47c0-b8af-65089c13a35a'",
      "  CompatiblePSEditions = @('Core')",
      "  PowerShellVersion = '7.0'",
      `  CmdletsToExport = @(${cmdlets.map(c => `'${c}'`).join(', ')})`,
      '}',
    ].join('\r\n'));
  }
  const inherited = Object.entries(process.env).find(([k]) => k.toLowerCase() === 'psmodulepath')?.[1];
  return inherited ? `${root};${inherited}` : root;
}

/** `env` less every spelling of PSModulePath, plus `value` under that name. */
export function withModulePath<E extends Record<string, string | undefined>>(env: E, value: string): E {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== 'psmodulepath') out[k] = v;
  out.PSModulePath = value;
  return out as E;
}
