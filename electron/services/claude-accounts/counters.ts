import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '../../constants';
import type { ClaudeAccountWindow } from '../../types';
import type { AccountUsage } from './choose';

/**
 * Each account's 5 h and weekly counters, as its status line last left them
 * (DESIGN-COMPTES-CLAUDE.md B4).
 *
 * The status line script (utils/statusline.ts) writes one file per account,
 * named by TARS_CLAUDE_ACCOUNT, which the launch sets: rate-limits.d/<id>.json,
 * `{ updatedAt: <epoch s>, rate_limits: <what Claude Code gave it> }`. Only
 * account names are read, and only numbers from them: ~/.dorothy is every
 * agent's, and a planted file must at worst skew one choice, never reach a
 * path or the page as anything but a percentage.
 */

const ACCOUNT_FILE = /^(default|acct-[0-9a-f]{6})\.json$/;

export function countersDir(): string {
  return dataPath('rate-limits.d');
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readWindow(raw: unknown): ClaudeAccountWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const used = num(r.used_percentage);
  const resets = num(r.resets_at);
  return used === null || resets === null ? null : { usedPercentage: used, resetsAt: Math.round(resets) };
}

export function readAccountUsage(): Record<string, AccountUsage> {
  let names: string[];
  try {
    names = fs.readdirSync(countersDir());
  } catch {
    return {};
  }
  const out: Record<string, AccountUsage> = {};
  for (const name of names) {
    const match = ACCOUNT_FILE.exec(name);
    if (!match) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(countersDir(), name), 'utf-8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const limits = parsed.rate_limits && typeof parsed.rate_limits === 'object' ? parsed.rate_limits as Record<string, unknown> : {};
    const updated = num(parsed.updatedAt);
    out[match[1]] = {
      fiveHour: readWindow(limits.five_hour),
      sevenDay: readWindow(limits.seven_day),
      updatedAt: updated === null ? null : updated * 1000,
    };
  }
  return out;
}

/** What the page shows: a window whose reset has passed is no longer a figure. */
export function usageForView(usage: AccountUsage | undefined, now: number = Date.now()): AccountUsage {
  const live = (w: ClaudeAccountWindow | null | undefined) => (w && w.resetsAt * 1000 > now ? w : null);
  return { fiveHour: live(usage?.fiveHour), sevenDay: live(usage?.sevenDay), updatedAt: usage?.updatedAt ?? null };
}
