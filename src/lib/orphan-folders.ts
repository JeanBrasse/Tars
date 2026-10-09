import type { DiskSpace, OrphanFolder, OrphanListing, OrphanRemovalProgress, OrphanRemovalReport } from '@/types/electron';
import { flat } from '@/lib/stop-line';
import { pathName } from '@/lib/display-path';

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

/** A project by its folder's name: its path holds the home. A Windows path's too (pathName reads `\`). */
const projectName = (project: string) => pathName(project) || project;

/** A folder by its project and its place under .worktrees: its path holds the home, and a name is whatever made it. */
export function folderLabel(folder: Pick<OrphanFolder, 'project' | 'name'>): string {
  return flat(`${projectName(folder.project)}/.worktrees/${folder.name}`);
}

/**
 * The line under the row naming the projects git could not list, as the rows
 * name a project: none of their folders is offered (PR 334), and git's reason
 * stays in the main process log. Null when git listed them all.
 */
export function unreadLine(projects: readonly string[]): string | null {
  if (projects.length === 0) return null;
  const names = projects.map(p => flat(projectName(p)));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Git could not list the worktrees of ${list}, so Tars cannot say which of ${names.length === 1 ? 'its' : 'their'} folders no agent owns.`;
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

/** The row's sentence over its list, or that there is none: never that every folder is known when git could not list a project. */
export function listingHint(listing: Pick<OrphanListing, 'count' | 'totalBytes' | 'unreadProjects'>): string {
  const { count, totalBytes } = listing;
  if (count === 0) {
    return listing.unreadProjects.length > 0
      ? 'None in the projects git could read.'
      : 'None: every folder in your projects\' .worktrees belongs to a worktree git knows.';
  }
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
  // Not removed: it failed, or holds a repository or a live worktree by now (PR 334); its title says which.
  failed: ['its row says why', 'their rows say why'],
};

/**
 * What the removal did, and why what stayed stayed. `listed` is the list read
 * again after it: a kept folder missing from it was no longer one no agent
 * owns when its turn came (PR 334), so no row is left to say why, and this
 * line says it. Without `listed`, every kept folder is taken as listed.
 */
export function doneHint(report: OrphanRemovalReport, listed?: ReadonlySet<string>): string {
  const stays = listed ? report.kept.filter(k => listed.has(k.path)) : report.kept;
  const changed = report.kept.length - stays.length;
  const after = changed === 0 ? ''
    : changed === 1 ? ' One was no longer a folder no agent owns.'
    : ` ${changed} were no longer folders no agent owns.`;
  const kept = stays.length;
  const reasons = new Set(stays.map(k => k.reason));
  if (report.removed === 0 && kept > 0 && reasons.size === 1 && reasons.has('unknown-use')) {
    return (kept === 1
      ? 'None was removed: Tars could not read which processes work in it, so it was kept.'
      : `None was removed: Tars could not read which processes work in them, so all ${kept} were kept.`) + after;
  }
  const head = report.removed > 0
    ? `Removed ${report.removed} ${plural(report.removed, 'folder')}: ${sizeLabel(report.freedBytes)} given back.`
    : 'None was removed.';
  if (kept === 0) return head + after;
  const [reason] = [...reasons];
  const why = reasons.size === 1 ? KEPT_BECAUSE[reason][kept === 1 ? 0 : 1] : 'their rows say why';
  return `${head} ${kept === 1 ? 'One was' : `${kept} were`} kept: ${why}.${after}`;
}

/** Node's codes for a removal that failed, in plain words: the title gave the code alone. */
const FAILED_BECAUSE: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'not permitted',
  ENOTEMPTY: 'not empty',
  EBUSY: 'in use',
  ENOENT: 'no longer there',
  ENOTDIR: 'not a folder',
  EROFS: 'on a read-only disk',
  EIO: 'the disk failed to read or write it',
  ENAMETOOLONG: 'a name too long',
  ELOOP: 'too many links',
  EMFILE: 'too many files open',
  ENFILE: 'too many files open',
};

/**
 * The title of a kept folder's why. A failure as main sends it since PR 334,
 * `CODE` or `CODE on <path inside the folder>`, reads in plain words, then the
 * path, then the code a search needs. A code without words, one of main's own
 * sentences and a process's name stay as main sent them. Nothing when main
 * said nothing.
 */
export function keptTitle(kept: Pick<OrphanRemovalReport['kept'][number], 'detail'>): string | undefined {
  if (!kept.detail) return undefined;
  const failure = /^(E[A-Z]+)(?: on ([\s\S]+))?$/.exec(kept.detail);
  const words = failure ? FAILED_BECAUSE[failure[1]] : undefined;
  if (!failure || !words) return flat(kept.detail);
  return flat(failure[2] ? `${words}: ${failure[2]} (${failure[1]})` : `${words} (${failure[1]})`);
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
