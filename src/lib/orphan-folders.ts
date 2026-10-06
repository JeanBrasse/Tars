import type { DiskSpace, OrphanFolder, OrphanListing, OrphanRemovalProgress, OrphanRemovalReport } from '@/types/electron';
import { flat } from '@/lib/stop-line';

/**
 * What Settings, System says of the folders no agent owns and of the disk, on
 * the contract of PR 334 (electron/services/orphan-folders.ts). Frames:
 * `Settings · System · folders no agent owns` and its states. Its failures are
 * listed, and pinned, in __tests__/lib/orphan-folders.test.ts.
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** KB and MB whole, GB with one decimal: a folder's size and a total, as the frame reads them. */
export function sizeLabel(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round(bytes / KB)} KB`;
}

/** The disk in whole GB, as its row reads. */
const diskSize = (bytes: number) => `${Math.round(bytes / GB)} GB`;

/** A folder by its project and its place under .worktrees: its path holds the home, and a name is whatever made it. */
export function folderLabel(folder: Pick<OrphanFolder, 'project' | 'name'>): string {
  const project = folder.project.replace(/\/+$/, '').split('/').pop() || folder.project;
  return flat(`${project}/.worktrees/${folder.name}`);
}

const WHY: Record<OrphanFolder['reason'] | OrphanRemovalReport['kept'][number]['reason'], string> = {
  'git-forgot': 'git forgot it',
  'no-git': 'no .git',
  'in-use': 'in use',
  'unknown-use': 'use unknown',
  failed: 'not removed',
};

export const whyLabel = (reason: keyof typeof WHY) => WHY[reason];

/** How long since it last changed, in the largest whole unit: "5 months", "3 hours". */
export function changedLabel(iso: string | null, now = new Date()): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return 'unknown';
  const months = (now.getFullYear() - at.getFullYear()) * 12 + now.getMonth() - at.getMonth() - (now.getDate() < at.getDate() ? 1 : 0);
  if (months >= 12) return `${Math.floor(months / 12)} ${plural(Math.floor(months / 12), 'year')}`;
  if (months >= 1) return `${months} ${plural(months, 'month')}`;
  const seconds = Math.max(0, (now.getTime() - at.getTime()) / 1000);
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days} ${plural(days, 'day')}`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours} ${plural(hours, 'hour')}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 1) return `${minutes} ${plural(minutes, 'minute')}`;
  return 'just now';
}

export const removeLabel = (count: number) => `remove ${count} ${plural(count, 'folder')}`;

/** The row's sentence over its list, or that there is none. */
export function listingHint(listing: Pick<OrphanListing, 'count' | 'totalBytes'>): string {
  const { count, totalBytes } = listing;
  if (count === 0) return 'None: every folder in your projects\' .worktrees belongs to a worktree git knows.';
  const one = count === 1;
  return `${count} ${plural(count, 'folder')}, ${sizeLabel(totalBytes)}, in your projects' .worktrees that git no longer knows, so nothing says whether ${one ? 'it holds' : 'they hold'} work. Tars never removes ${one ? 'it' : 'them'} on its own.`;
}

/** What remove asks before anything goes. */
export function confirmText(listing: Pick<OrphanListing, 'count' | 'totalBytes'>): string {
  const size = sizeLabel(listing.totalBytes);
  return listing.count === 1
    ? `Remove this folder, ${size}, for good? Git no longer knows it, so nothing says whether it holds work, and what is in it is lost.`
    : `Remove these ${listing.count} folders, ${size}, for good? Git no longer knows them, so nothing says whether they hold work, and what is in them is lost.`;
}

/** The row's sentence while the folders go, one at a time. */
export function removingHint(progress: OrphanRemovalProgress | null): string {
  if (!progress) return 'Removing…';
  return `Removing ${progress.done} of ${progress.total}: ${sizeLabel(progress.freedBytes)} given back so far.`;
}

const KEPT_BECAUSE: Record<OrphanRemovalReport['kept'][number]['reason'], [one: string, many: string]> = {
  'in-use': ['a process works in it', 'a process works in each'],
  'unknown-use': ['Tars could not read whether a process works in it', 'Tars could not read whether a process works in them'],
  failed: ['it could not be removed', 'they could not be removed'],
};

/** What the removal did, and why what stayed stayed. */
export function doneHint(report: OrphanRemovalReport): string {
  const kept = report.kept.length;
  const reasons = new Set(report.kept.map(k => k.reason));
  if (report.removed === 0 && kept > 0 && reasons.size === 1 && reasons.has('unknown-use')) {
    return kept === 1
      ? 'None was removed: Tars could not read which processes work in it, so it was kept.'
      : `None was removed: Tars could not read which processes work in them, so all ${kept} were kept.`;
  }
  const head = report.removed > 0
    ? `Removed ${report.removed} ${plural(report.removed, 'folder')}: ${sizeLabel(report.freedBytes)} given back.`
    : 'None was removed.';
  if (kept === 0) return head;
  const [reason] = [...reasons];
  const why = reasons.size === 1 ? KEPT_BECAUSE[reason][kept === 1 ? 0 : 1] : 'their rows say why';
  return `${head} ${kept === 1 ? 'One was' : `${kept} were`} kept: ${why}.`;
}

/** The disk's row: how much is free, of how much, and whether it is below the floor Tars warns under. */
export function diskLine(disk: DiskSpace): { hint: string; value: string; low: boolean } {
  const free = diskSize(disk.freeBytes);
  return {
    hint: `${free} free of ${diskSize(disk.totalBytes)} on the startup disk. Tars warns below ${diskSize(disk.floorBytes)}.`,
    value: `${free} free`,
    low: disk.freeBytes < disk.floorBytes,
  };
}
