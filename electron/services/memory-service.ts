import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { projectFolders } from './project-index';
import { encodeClaudeProjectDir, claudeProjectDirNames } from '../platform/claude-project-dir';
import { unlinkRetryingSync } from '../platform/rename-replacing';
import { spellingsOf } from '../utils/resume-session';

export interface MemoryFile {
  name: string;
  path: string;
  content: string;
  size: number;
  lastModified: string;
  isEntrypoint: boolean; // true for MEMORY.md
}

export interface ProjectMemory {
  id: string;          // encoded dir name
  projectName: string; // last segment of decoded path
  projectPath: string; // decoded full path
  memoryDir: string;   // absolute path to memory/ dir
  files: MemoryFile[];
  totalSize: number;
  lastModified: string;
  hasMemory: boolean;
  provider: string;    // 'claude' | 'codex' | 'gemini'
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** All provider memory directories to scan */
const PROVIDER_MEMORY_DIRS: { provider: string; dir: string }[] = [
  { provider: 'claude', dir: CLAUDE_PROJECTS_DIR },
  // Codex and Gemini may store project memory in similar structures.
  // These are checked only if they exist: no error if missing.
  { provider: 'codex', dir: path.join(os.homedir(), '.codex', 'projects') },
  { provider: 'gemini', dir: path.join(os.homedir(), '.gemini', 'projects') },
  { provider: 'grok', dir: path.join(os.homedir(), '.grok', 'projects') },
];

/**
 * Validate that a file path is within any provider's projects directory.
 * Uses path.resolve + startsWith to prevent traversal bypasses.
 */
function isWithinProjectsDir(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return PROVIDER_MEMORY_DIRS.some(({ dir }) =>
    resolved.startsWith(dir + path.sep) || resolved === dir
  );
}

function getProjectName(decodedPath: string): string {
  return path.basename(decodedPath) || decodedPath;
}

function memoryFile(filePath: string, stat: fs.Stats, content: string): MemoryFile {
  const name = path.basename(filePath);
  return {
    name,
    path: filePath,
    content,
    size: stat.size,
    lastModified: stat.mtime.toISOString(),
    isEntrypoint: name === 'MEMORY.md',
  };
}

function readMemoryFile(filePath: string): MemoryFile {
  const stat = fs.statSync(filePath);
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    content = '';
  }
  return memoryFile(filePath, stat, content);
}

/** The same, without blocking, for the listing of every project. */
async function readMemoryFileAsync(filePath: string): Promise<MemoryFile> {
  const stat = await fs.promises.stat(filePath);
  const content = await fs.promises.readFile(filePath, 'utf-8').catch(() => '');
  return memoryFile(filePath, stat, content);
}

/** Claude Code's own encoding: every character that is not a letter or a digit becomes '-'. */
function encodeProjectPath(projectPath: string): string {
  return encodeClaudeProjectDir(projectPath);
}

/**
 * @param extraProjectPaths Tars's own projects (agent folders, projects
 * page). They belong in Brain even when Claude Code never opened them:
 * otherwise a freshly added project is invisible here.
 */
export async function listProjectMemories(extraProjectPaths: string[] = []): Promise<ProjectMemory[]> {
  const results: ProjectMemory[] = [];
  const seenPaths = new Set<string>();
  // A folder a known project's own name points at is that project: decoding is
  // lossy (a space comes back as a separator on macOS), and a Tars project was
  // listed once under the guess, with its memory, and again empty.
  const knownByFolder = new Map<string, string>();
  for (const known of extraProjectPaths) {
    for (const name of known ? claudeProjectDirNames(known) : []) if (!knownByFolder.has(name)) knownByFolder.set(name, known);
  }
  /** The rows read from the CLIs' folders, by the path each folder stands for. */
  const byPath = new Map<string, ProjectMemory>();

  for (const { provider, dir: projectsDir } of PROVIDER_MEMORY_DIRS) {
    // Read without blocking, each folder's path decoded once (project-index.ts).
    for (const folder of await projectFolders(projectsDir)) {
      const memoryDir = path.join(folder.dir, 'memory');
      const decodedPath = knownByFolder.get(folder.name) ?? folder.projectPath;
      const projectName = getProjectName(decodedPath);

      const project: ProjectMemory = {
        id: `${provider}:${folder.name}`,
        projectName,
        projectPath: decodedPath,
        memoryDir,
        files: [],
        totalSize: 0,
        lastModified: '',
        hasMemory: false,
        provider,
      };

      if (await fs.promises.access(memoryDir).then(() => true, () => false)) {
        try {
          const mdFiles = (await fs.promises.readdir(memoryDir))
            .filter(f => f.endsWith('.md'))
            .sort((a, b) => {
              // MEMORY.md always first
              if (a === 'MEMORY.md') return -1;
              if (b === 'MEMORY.md') return 1;
              return a.localeCompare(b);
            });

          const files = await Promise.all(mdFiles.map(f => readMemoryFileAsync(path.join(memoryDir, f))));
          const totalSize = files.reduce((sum, f) => sum + f.size, 0);
          const lastModified = files.reduce((latest, f) =>
            f.lastModified > latest ? f.lastModified : latest, '');

          project.files = files;
          project.totalSize = totalSize;
          project.lastModified = lastModified;
          project.hasMemory = files.length > 0;
        } catch {
          // Skip unreadable directories
        }
      }

      seenPaths.add(project.projectPath);
      if (!byPath.has(project.projectPath)) byPath.set(project.projectPath, project);
      results.push(project);
    }
  }

  // Tars-known projects with no memory yet: surfaced as empty entries so
  // the user can create their MEMORY.md from the UI. Compared by both
  // spellings, as Tars saved it and its real path: Claude Code files a
  // session under the real one, so a project saved through a link (/tmp on
  // macOS, a symlinked checkout) was listed twice, and its memory folder,
  // named from the saved spelling, was one Claude Code never reads.
  // A row found under the real spelling is shown under the path Tars saved,
  // its memory still Claude Code's: the window counts a project's agents by
  // that path and the hooks file observations under it (QA's gate of #346).
  const claimed = new Set<ProjectMemory>();
  for (const projectPath of extraProjectPaths) {
    if (!projectPath) continue;
    const spellings = spellingsOf(projectPath);
    const exact = byPath.get(projectPath);
    if (exact) { claimed.add(exact); continue; }
    const other = spellings.slice(1).map(spelling => byPath.get(spelling)).find(row => row && !claimed.has(row));
    if (other) {
      claimed.add(other);
      other.projectPath = projectPath;
      other.projectName = getProjectName(projectPath);
      for (const spelling of spellings) seenPaths.add(spelling);
      continue;
    }
    if (spellings.some(spelling => seenPaths.has(spelling))) continue;
    for (const spelling of spellings) seenPaths.add(spelling);
    const real = spellings[spellings.length - 1];
    results.push({
      id: `tars:${projectPath}`,
      projectName: getProjectName(projectPath),
      projectPath,
      memoryDir: path.join(CLAUDE_PROJECTS_DIR, encodeProjectPath(real), 'memory'),
      files: [],
      totalSize: 0,
      lastModified: '',
      hasMemory: false,
      provider: 'claude',
    });
  }

  // Sort: projects with memory first, then by lastModified desc
  return results.sort((a, b) => {
    if (a.hasMemory && !b.hasMemory) return -1;
    if (!a.hasMemory && b.hasMemory) return 1;
    return b.lastModified.localeCompare(a.lastModified);
  });
}

export function readMemoryFileContent(filePath: string): { content: string; error?: string } {
  try {
    if (!isWithinProjectsDir(filePath)) {
      return { content: '', error: 'Access denied: path outside Claude projects directory' };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content };
  } catch (err) {
    return { content: '', error: err instanceof Error ? err.message : 'Failed to read file' };
  }
}

export function writeMemoryFileContent(filePath: string, content: string): { success: boolean; error?: string } {
  try {
    if (!isWithinProjectsDir(filePath)) {
      return { success: false, error: 'Access denied: path outside Claude projects directory' };
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to write file' };
  }
}

export function createMemoryFile(memoryDir: string, fileName: string, content: string = ''): { success: boolean; file?: MemoryFile; error?: string } {
  try {
    if (!isWithinProjectsDir(memoryDir)) {
      return { success: false, error: 'Access denied' };
    }
    // Reject path traversal and a subdirectory in fileName (`\` separates too, on Windows)
    if (fileName.includes('/') || fileName.includes(path.sep) || fileName.includes('..')) {
      return { success: false, error: 'Invalid file name' };
    }
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    const filePath = path.join(memoryDir, fileName.endsWith('.md') ? fileName : `${fileName}.md`);
    if (fs.existsSync(filePath)) {
      return { success: false, error: 'File already exists' };
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, file: readMemoryFile(filePath) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create file' };
  }
}

export function deleteMemoryFile(filePath: string): { success: boolean; error?: string } {
  try {
    if (!isWithinProjectsDir(filePath)) {
      return { success: false, error: 'Access denied' };
    }
    if (path.basename(filePath) === 'MEMORY.md') {
      return { success: false, error: 'Cannot delete the main MEMORY.md entrypoint' };
    }
    unlinkRetryingSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to delete file' };
  }
}
