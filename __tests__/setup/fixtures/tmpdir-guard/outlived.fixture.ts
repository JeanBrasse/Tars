import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

it('leaves in the run\'s folder a file\'s folder whose hooks ran, and a file past every file\'s folder', () => {
  const run = path.dirname(os.tmpdir());
  // The shape a file's folder has when its hooks ran and its removal did not:
  // the mark tmpdir-isolation.ts leaves, and what the file wrote.
  const outlived = fs.mkdtempSync(path.join(run, 'tars-vitest-file-outlived-'));
  fs.writeFileSync(path.join(outlived, 'tars-vitest-hooks-ran'), '');
  fs.writeFileSync(path.join(run, 'written-past'), '');
  expect(fs.readdirSync(run)).toEqual(expect.arrayContaining([path.basename(outlived), 'written-past']));
});
