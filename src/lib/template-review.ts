import type { AgentCharacter, AgentTemplateInput, TemplateExport } from '@/types/electron';
import { getProviderDef } from '@/lib/providers';
import { isAbsolutePath, rendererPlatform } from '@/lib/display-path';

/**
 * What a template sets, as the import and "Use" show it before an agent is
 * made from it: its permission mode, the folders it adds, the skills named at
 * the head of every task it starts with, and its whole prompt. Security #5 of
 * the Audit: an imported template used to set all four unseen, and "Use" sent
 * its prompt at once. Frames: Overlay · Import template · review and Overlay ·
 * Instantiate template · prompt, in design/tars-redesign.pen.
 *
 * A file the review cannot show as it will be used is refused whole, naming
 * the template and the field, so what lands is always the list that was shown.
 */

export type PermissionMode = 'normal' | 'auto' | 'bypass';

const PERMISSION_WORDS: Record<PermissionMode, string> = {
  normal: 'Ask each time',
  auto: 'Run freely',
  bypass: 'Skip all checks',
};

/** The template form's words for a mode, so the review reads like the form that set it. */
export const permissionWord = (mode: PermissionMode): string => PERMISSION_WORDS[mode];

// --- Characters that do not show ------------------------------------------

const FORMAT = /\p{Cf}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;
const KEYCAP_BASE = /^[#*0-9]$/;

/**
 * Bidi and zero width controls, tag characters and the other format
 * characters, C0 and C1 controls (a tab and a newline aside, where the text
 * keeps its lines), the line and paragraph separators, variation selectors,
 * and the blank fillers. A model reads every one of them; a person reading the
 * prompt sees none.
 */
function hiddenCodePoint(cp: number, keepLines: boolean): boolean {
  if (keepLines && (cp === 0x09 || cp === 0x0a)) return false;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x2028 || cp === 0x2029) return true;
  if (cp === 0x034f || cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) return true;
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  return FORMAT.test(String.fromCodePoint(cp));
}

/** Whether `chars[i]` closes an emoji: a pictograph, then maybe its variation selector or a skin tone. */
function closesEmoji(chars: string[], i: number): boolean {
  let j = i;
  while (j >= 0 && (chars[j] === '\u{FE0F}' || SKIN_TONE.test(chars[j]))) j -= 1;
  return j >= 0 && PICTOGRAPH.test(chars[j]);
}

/** The two that belong to an emoji: a variation selector after a pictograph or a keycap, a joiner between two pictographs. */
function partOfEmoji(chars: string[], i: number, cp: number): boolean {
  if (cp === 0xfe0e || cp === 0xfe0f) {
    const before = chars[i - 1];
    return before !== undefined && (PICTOGRAPH.test(before) || KEYCAP_BASE.test(before));
  }
  if (cp === 0x200d) {
    const after = chars[i + 1];
    return after !== undefined && PICTOGRAPH.test(after) && closesEmoji(chars, i - 1);
  }
  return false;
}

function revealWith(input: string, keepLines: boolean): { text: string; hidden: number } {
  const chars = Array.from(keepLines ? input.replace(/\r\n/g, '\n') : input);
  let hidden = 0;
  const text = chars.map((ch, i) => {
    const cp = ch.codePointAt(0)!;
    if (!hiddenCodePoint(cp, keepLines) || partOfEmoji(chars, i, cp)) return ch;
    hidden += 1;
    return `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
  }).join('');
  return { text, hidden };
}

/**
 * The text with every character that does not show written out as `[U+202E]`,
 * and how many there were. A Windows line end reads as the newline it is.
 */
export const reveal = (input: string) => revealWith(input, true);

/**
 * The same for a field that is one line (a name, a folder, a skill): its
 * newlines, carriage returns and tabs are written out too, so it cannot split
 * over two lines or hide a second one.
 */
export const revealLine = (input: string) => revealWith(input, false);

// --- What a template sets ---------------------------------------------------

export interface TemplatePrompt {
  /** The prompt as it is sent (trimmed), with what does not show written out. */
  text: string;
  /** Characters, not UTF-16 units, of the prompt as it is sent. */
  characters: number;
  hidden: number;
}

export interface TemplateFacts {
  name: string;
  /** Provider, and the model when the template names one: `claude · opus-5`. */
  runs: string;
  permissionMode: PermissionMode;
  folders: string[];
  skills: string[];
  prompt: TemplatePrompt | null;
}

/** A saved template or one read from a file. `null` is "not set", as the main process reads it. */
export interface TemplateLike {
  displayName: string;
  provider?: string | null;
  model?: string | null;
  localModel?: string | null;
  permissionMode?: PermissionMode | null;
  obsidianVaultPaths?: string[] | null;
  skills?: string[] | null;
  savedPrompt?: string | null;
}

export function templateFacts(t: TemplateLike): TemplateFacts {
  const prompt = (t.savedPrompt ?? '').trim();
  const shown = reveal(prompt);
  return {
    name: revealLine(t.displayName).text,
    runs: [t.provider || 'claude', t.model || t.localModel].filter(Boolean).join(' · '),
    permissionMode: t.permissionMode ?? 'normal',
    folders: (t.obsidianVaultPaths ?? []).map(folder => revealLine(folder).text),
    skills: (t.skills ?? []).map(skill => revealLine(skill).text),
    prompt: prompt ? { text: shown.text, characters: Array.from(prompt).length, hidden: shown.hidden } : null,
  };
}

// --- Reading a file ----------------------------------------------------------

export interface ReviewedTemplate {
  /** What is saved: the fields Tars reads, as the file has them. */
  input: AgentTemplateInput;
  facts: TemplateFacts;
}

export type TemplateFileReview =
  | { ok: true; templates: ReviewedTemplate[]; payload: TemplateExport }
  | { ok: false; error: string };

const KIND = 'tars.agent-template';
const MODES: readonly string[] = ['normal', 'auto', 'bypass'];
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CHARACTERS: readonly string[] = ['robot', 'ninja', 'wizard', 'astronaut', 'knight', 'pirate', 'alien', 'viking', 'frog'];
/** The launch's own check on `--model` (electron/providers/claude-provider.ts). */
const MODEL_NAME = /^[a-zA-Z0-9._:/[\]-]+$/;
/** A skill is a folder name, `copywriting` or `vercel:nextjs`: never a sentence. */
const SKILL_NAME = /^[A-Za-z0-9@][A-Za-z0-9._:@/-]{0,99}$/;
const QUOTE_LIMIT = 60;

/** A value in a refusal: written out, and cut, since the refusal only has to name it. */
function quoted(value: unknown): string {
  const cut = (s: string) => {
    const chars = Array.from(s);
    return chars.length > QUOTE_LIMIT ? `${chars.slice(0, QUOTE_LIMIT).join('')}…` : s;
  };
  if (typeof value === 'string') return `"${cut(revealLine(value).text)}"`;
  return cut(JSON.stringify(value) ?? String(value));
}

class Refused extends Error {}
const refuse = (sentence: string): never => { throw new Refused(`Not imported: ${sentence}`); };

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');

function readTemplate(raw: unknown, place: number, platform: string): AgentTemplateInput {
  const t = raw as Record<string, unknown> | null;
  if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.displayName !== 'string' || !t.displayName.trim()) {
    return refuse(`template ${place} has no name.`);
  }
  const name = quoted(t.displayName);
  const input: AgentTemplateInput = { displayName: t.displayName };

  if (t.provider != null) {
    if (typeof t.provider !== 'string' || (t.provider !== 'local' && !getProviderDef(t.provider))) {
      refuse(`${name} asks for the provider ${quoted(t.provider)}, which Tars does not know.`);
    }
    input.provider = t.provider as AgentTemplateInput['provider'];
  }
  for (const field of ['model', 'localModel'] as const) {
    const value = t[field];
    if (value == null) continue;
    if (typeof value !== 'string' || !MODEL_NAME.test(value)) {
      refuse(`${name} asks for the model ${quoted(value)}, which is not a model name.`);
    }
    input[field] = value as string;
  }

  if (t.permissionMode != null && (typeof t.permissionMode !== 'string' || !MODES.includes(t.permissionMode))) {
    refuse(`${name} asks for permissions ${quoted(t.permissionMode)}, which Tars does not know.`);
  }
  input.permissionMode = (t.permissionMode ?? 'normal') as PermissionMode;

  const folders = t.obsidianVaultPaths ?? [];
  if (!Array.isArray(folders)) refuse(`${name} has folders that are not a list of paths.`);
  for (const folder of folders as unknown[]) {
    if (typeof folder !== 'string' || !isAbsolutePath(folder, platform)) {
      refuse(`${name} asks for the folder ${quoted(folder)}, which is not an absolute path.`);
    }
  }
  input.obsidianVaultPaths = folders as string[];

  const skills = t.skills ?? [];
  if (!Array.isArray(skills)) refuse(`${name} has skills that are not a list of names.`);
  for (const skill of skills as unknown[]) {
    if (typeof skill !== 'string' || !SKILL_NAME.test(skill)) {
      refuse(`${name} names the skill ${quoted(skill)}, which is not a skill name.`);
    }
  }
  input.skills = skills as string[];

  if (t.savedPrompt != null) {
    if (typeof t.savedPrompt !== 'string') refuse(`${name} has a prompt that is not text.`);
    input.savedPrompt = t.savedPrompt as string;
  }

  // Shown nowhere and run by nothing: kept when well formed, dropped when not.
  if (typeof t.description === 'string') input.description = t.description;
  if (typeof t.icon === 'string') input.icon = t.icon;
  if (isStringList(t.tags)) input.tags = t.tags;
  if (typeof t.character === 'string' && CHARACTERS.includes(t.character)) input.character = t.character as AgentCharacter;
  if (typeof t.effort === 'string' && EFFORTS.includes(t.effort)) input.effort = t.effort as AgentTemplateInput['effort'];

  return input;
}

/**
 * Reads a template file as the import will save it. Refused whole, with the
 * sentence the dialog shows, when any template in it cannot be shown as it
 * will be used; otherwise every template with what it sets, and the payload
 * to hand the main process: those templates and nothing else from the file.
 * A folder is absolute as the platform the app runs on reads it.
 */
export function reviewTemplateFile(json: unknown, platform: string = rendererPlatform()): TemplateFileReview {
  try {
    const file = json as Record<string, unknown> | null;
    if (!file || typeof file !== 'object' || Array.isArray(file) || file.kind !== KIND) {
      refuse('this is not a Tars template file.');
    }
    if (file!.version !== 1) refuse('this Tars reads version 1 template files only.');
    const list = file!.templates;
    if (!Array.isArray(list) || list.length === 0) refuse('this file lists no templates.');
    const inputs = (list as unknown[]).map((raw, i) => readTemplate(raw, i + 1, platform));
    return {
      ok: true,
      templates: inputs.map(input => ({ input, facts: templateFacts(input) })),
      payload: {
        version: 1,
        kind: KIND,
        exportedAt: typeof file!.exportedAt === 'string' ? file!.exportedAt : new Date().toISOString(),
        templates: inputs,
      },
    };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
}

// --- The words around the list ---------------------------------------------

const listed = (names: string[]) =>
  names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Said above the buttons for the templates that skip all checks, or nothing when none does. */
export function skipsChecksNotice(names: string[]): string | null {
  if (names.length === 0) return null;
  return names.length === 1
    ? `${names[0]} skips all checks: an agent made from it runs any command without asking you first.`
    : `${listed(names)} skip all checks: an agent made from any of them runs any command without asking you first.`;
}

export function importButtonLabel(count: number): string {
  if (count === 0) return 'Import';
  return `Import ${count} template${count === 1 ? '' : 's'}`;
}

/**
 * Whether "Use" starts the new agent with the template's prompt before you
 * touch the switch. Only a built-in as it ships: once saved, an imported
 * template looks just like one you made, and an edit to a built-in lives in
 * ~/.dorothy/templates.json, which any agent can write.
 */
export function startsWithPromptByDefault(template: { builtin: boolean; overridden?: boolean }): boolean {
  return template.builtin && !template.overridden;
}
