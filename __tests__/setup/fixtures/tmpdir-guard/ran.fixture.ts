import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

fs.writeFileSync(path.join(os.tmpdir(), 'written-at-import'), '');

it('runs, and leaves what it wrote for the setup to remove', () => {
  fs.writeFileSync(path.join(os.tmpdir(), 'written-by-the-test'), '');
  expect(fs.existsSync(path.join(os.tmpdir(), 'written-by-the-test'))).toBe(true);
});
