// Import this first in any test file that creates temporary files. It points
// the test process, and every child it spawns, at a private temp root and
// removes that root when the process exits, so a test run never leaves files
// in the shared temp directory, even when an individual test forgets to.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'capture-test-'));
for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = root;

process.once('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`Could not remove test temp root ${root}: ${String(error)}\n`);
  }
});
