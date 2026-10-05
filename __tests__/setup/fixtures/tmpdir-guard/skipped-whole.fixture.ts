import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A file skipped whole still runs its imports, as real-target.test.ts writes
// five files at import.
fs.writeFileSync(path.join(os.tmpdir(), 'written-at-import'), '');

// Skipped whole, as real-claude-bypass.test.ts is on a runner without claude.
describe.skipIf(true)('a file skipped whole', () => {
  it('never runs', () => {});
});
