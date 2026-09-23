/**
 * The main process's compiled code, kept between launches.
 *
 * Node compiles every module the main process requires, at every launch, from
 * source. Its compile cache (Node 22.1+, Node 24.21 in Electron 44) stores
 * what V8 produced, keyed by each file's content, and a later launch reads it
 * instead of compiling again. Imported first by main.ts, so that everything
 * main.ts requires after it is covered; main.ts itself is compiled before any
 * of its code runs, and is not.
 *
 * The directory is under userData, beside the renderer's own code cache
 * (Chromium's `Code Cache`, which the app:// scheme feeds since it was given
 * the codeCache privilege, core/window-manager.ts). An app update changes the
 * files, their keys no longer match, and they are compiled once more.
 *
 * Node writes the cache when its process exits, and Electron's main process
 * does not always exit through Node: it is flushed once the window has loaded,
 * by which time main has required everything it requires at startup.
 */
import { app } from 'electron';
import * as path from 'path';
import * as nodeModule from 'module';

// @types/node follows the engines floor, which predates these two.
const compileCache = nodeModule as unknown as {
  enableCompileCache?: (directory: string) => unknown;
  flushCompileCache?: () => void;
};

compileCache.enableCompileCache?.(path.join(app.getPath('userData'), 'compile-cache'));

app.once('web-contents-created', (_event, contents) => {
  contents.once('did-finish-load', () => compileCache.flushCompileCache?.());
});
