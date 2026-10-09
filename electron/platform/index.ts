/**
 * The platform layer: every decision that differs between darwin/linux and
 * win32 in how Tars starts and ends processes. Callers import from here and
 * pass no `if (win32)` of their own. darwin and linux get what they got
 * before this layer existed, byte for byte.
 */
export { realFs, type FsProbe, type Env } from './fs-probe';
export { envValue, getPath, withPath, pathEntries, joinPathEntries, unquoteEntry } from './path-env';
export { resolveShell, shellArgs, agentShell } from './shell';
export {
  resolveCliBinary, findOnPath, isPlainAbsolute, pathExts, DEFAULT_PATHEXT,
  type CliBinary, type CliBinaryFailure, type CliBinaryFailureReason,
} from './cli-binary';
export { posixWords, PosixWordsError, type PosixWordsErrorCode } from './posix-words';
export {
  buildWindowsCommandLine, quoteWindowsArg, quoteWindowsProgram, WindowsCommandLineError, WINDOWS_COMMAND_LINE_MAX,
  type WindowsCommandLineErrorCode,
} from './windows-command-line';
export { toLaunch, LaunchError, type Launch, type PosixLaunch, type DirectLaunch, type LaunchErrorCode } from './launch';
export { killTree, KillTreeError, type KillTreeResult, type KillTreeDeps, type KillTreeErrorCode } from './kill-tree';
