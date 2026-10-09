#!/usr/bin/env node
/**
 * `NODE_ENV=development electron <args>`, in a form every shell runs: the last
 * step of `npm run electron:start`. npm runs scripts through cmd.exe on
 * Windows, which read `NODE_ENV=development` as the name of a command.
 *
 * It sets the variable, then runs the `electron` command of this checkout, the
 * package's own bin, in this very process, as npm would have. So Electron is
 * started, its exit code handed back, a killed Electron turned into exit 1 and
 * SIGINT / SIGTERM passed on to it exactly as `electron .` did, on every
 * platform, because it is the same code.
 *
 * Tested in __tests__/scripts/electron-dev.test.ts.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

process.env.NODE_ENV = 'development';

const require = createRequire(import.meta.url);
const manifest = require.resolve('electron/package.json');
const { bin } = require(manifest);
// Its argv is ours past the script: process.argv.slice(2), what `electron <args>` received.
require(path.join(path.dirname(manifest), typeof bin === 'string' ? bin : bin.electron));
