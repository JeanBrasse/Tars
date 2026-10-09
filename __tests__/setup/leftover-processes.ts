import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * The processes a test started by way of the code under test, which it ends
 * afterwards by id in case that code did not: `leftovers.push(pid)` while they
 * run, `leftovers.end()` in afterEach.
 *
 * Most of them are gone by then: ending them is what the code under test is
 * for. On Windows the id of a process that has exited is free at once, and
 * Windows hands ids out again soon (freed ids first, in small numbers on a
 * fresh machine); a kill sent to it by id is a TerminateProcess of whatever
 * holds it now: on CI's windows-latest, an administrator, any process at all,
 * a vitest worker included. So on win32 an id is ended only when the process
 * holding it was created no later than the test saw it: the one the test
 * meant, not one started since. Nothing is asked of PowerShell when no id is
 * held any more, which is how a passing test ends.
 *
 * darwin and linux hand ids out in sequence and reuse one only once the range
 * has wrapped: every id is signalled there, as the tests always did. On every
 * platform an id that is not a positive integer is never signalled: 0 is the
 * caller's own process group (its own process on Windows), and -1 every
 * process the account may signal.
 */
export class Leftovers {
  private seen: Array<{ pid: number; at: number }> = [];

  /** `now` is the clock the ids are seen by: Date.now, or a witness's. */
  constructor(private readonly now: () => number = Date.now) {}

  push(...pids: number[]): number {
    const at = this.now();
    for (const pid of pids) if (Number.isSafeInteger(pid) && pid > 0) this.seen.push({ pid, at });
    return this.seen.length;
  }

  end(): void {
    const seen = this.seen.splice(0);
    if (process.platform !== 'win32') {
      for (const { pid } of seen) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      return;
    }
    const held = seen.filter(({ pid }) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (held.length === 0) return;
    const created = creationTimes(held.map(({ pid }) => pid));
    for (const { pid, at } of held) {
      const when = created.get(pid);
      // Gone since, or someone else's: not ours to end.
      if (when === undefined || when > at) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

/** win32: when each process was created, in ms since the epoch, from Win32_Process. The filter holds numbers only. */
function creationTimes(pids: number[]): Map<number, number> {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const filter = pids.map(pid => `ProcessId=${Math.trunc(pid)}`).join(' OR ');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`],
  { windowsHide: true, timeout: 60_000 }).toString();
  return new Map(out.split(/\r?\n/).filter(Boolean).map(line => line.trim().split(' ').map(Number) as [number, number]));
}
