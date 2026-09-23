import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DATA_DIR } from '../constants';
import { MAX_ATTACHMENT_BYTES, safeUploadName } from './hermes-client';
import type { BusAttachment } from '../types';

/**
 * Files for a room: what the composer's + (and a paste or a drop) hands the
 * agents in it.
 *
 * The renderer has the bytes and no path (Electron stopped exposing a real
 * path on its File objects), and an agent needs a path it can read. So the
 * bytes are written here, under ~/.dorothy, which is in every agent's
 * `--add-dir`, one folder per file so two files of the same name never meet,
 * and the message that sends them names each by its absolute path. Staged in
 * memory until a message takes them: a staged file nobody sends stays on disk
 * with the others, and is never named to anyone.
 */

/** Where staged files live. A function so a test's DATA_DIR is read when used. */
export function busFilesDir(): string {
  return path.join(DATA_DIR, 'bus-files');
}

const staged = new Map<string, { roomId: string; attachment: BusAttachment }>();

const IMAGE = /^image\//;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;

export interface StagedFiles {
  attachments: BusAttachment[];
  errors: string[];
}

/** Write each file, or name why it was refused. The same cap as Hermes's. */
export function stageFiles(roomId: string, files: unknown): StagedFiles {
  const attachments: BusAttachment[] = [];
  const errors: string[] = [];
  for (const file of Array.isArray(files) ? files : []) {
    const f = (file ?? {}) as { name?: unknown; mimeType?: unknown; data?: unknown };
    const name = safeUploadName(typeof f.name === 'string' ? f.name : 'file');
    if (!(f.data instanceof Uint8Array)) {
      errors.push(`${name} came without its bytes.`);
      continue;
    }
    if (f.data.byteLength > MAX_ATTACHMENT_BYTES) {
      errors.push(`${name} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`);
      continue;
    }
    const id = uuidv4();
    const dir = path.join(busFilesDir(), id);
    const file_ = path.join(dir, name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file_, f.data);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const mimeType = typeof f.mimeType === 'string' ? f.mimeType : '';
    const attachment: BusAttachment = {
      id, name, path: file_, bytes: f.data.byteLength, isImage: IMAGE.test(mimeType) || IMAGE_EXT.test(name),
    };
    staged.set(id, { roomId, attachment });
    attachments.push(attachment);
  }
  return { attachments, errors };
}

/**
 * The staged files these ids name, for a message in this room, or the reason
 * one cannot be sent: an id nobody staged, or staged for another room. Taken
 * off the staged list only once the message is recorded (forgetStaged).
 */
export function stagedFor(roomId: string, ids: unknown): { attachments: BusAttachment[] } | { error: string } {
  if (ids === undefined) return { attachments: [] };
  if (!Array.isArray(ids)) return { error: 'attachments must be a list of staged file ids' };
  const attachments: BusAttachment[] = [];
  for (const id of ids) {
    const entry = typeof id === 'string' ? staged.get(id) : undefined;
    if (!entry || entry.roomId !== roomId) return { error: 'An attached file was not staged for this room: stage it again.' };
    attachments.push(entry.attachment);
  }
  return { attachments };
}

export function forgetStaged(attachments: BusAttachment[]): void {
  for (const a of attachments) staged.delete(a.id);
}

/** What a target receives: the text, then each file by its absolute path. */
export function withAttachmentPaths(text: string, attachments?: BusAttachment[]): string {
  if (!attachments?.length) return text;
  const lines = attachments.map(a => `- ${a.path} (${a.name}, ${a.bytes} bytes)`);
  return `${text}\n\nAttached files, readable at these paths:\n${lines.join('\n')}`;
}
