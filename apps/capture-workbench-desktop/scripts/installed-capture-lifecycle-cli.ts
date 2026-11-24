// Command line of the installed capture-lifecycle check
// (installed-capture-lifecycle.ts; run it through the Nx target
// capture-workbench-desktop:diagnostic-installed-deterministic-capture-lifecycle).
// Playwright fixes its temporary folder when it loads, and PowerShell compiles
// the window helpers in TEMP, so TEMP and TMP point at a directory of this run
// under the check's root before the check loads. Before the first write, the
// workspace root itself and every component from it down to the run tree must
// be a real directory: no link, junction or other redirecting reparse point.
// The check's cleanup phase removes the temporary directory and reports it;
// the exit hook below removes it only when the check never got that far. Both
// use the same removal, which leaves the directory in place when its path or
// its identity no longer proves it is the one this process made.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type OwnedDirectory,
  assertNotRedirected,
  claimOwnedDirectory,
  keptRunTreeReport,
  lifecycleCheckPaths,
  removeOwnedDirectory,
} from './installed-capture-lifecycle-checks.ts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const paths = lifecycleCheckPaths(workspaceRoot);

function prepareTemporaryDirectory(): OwnedDirectory {
  assertNotRedirected(workspaceRoot, paths.run);
  mkdirSync(paths.root, { recursive: true });
  assertNotRedirected(workspaceRoot, paths.run);
  // One directory per process: a second run that finds the lock taken must
  // not remove the first run's directory.
  return claimOwnedDirectory(mkdtempSync(join(paths.root, 'check-temp-')));
}

if (process.argv.length > 2) {
  process.stderr.write('The installed capture-lifecycle check takes no arguments.\n');
  process.exitCode = 1;
} else if (process.platform !== 'win32') {
  process.stderr.write('The installed capture-lifecycle check needs Windows x64.\n');
  process.exitCode = 1;
} else {
  let checkTemporary: OwnedDirectory | undefined;
  try {
    checkTemporary = prepareTemporaryDirectory();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  if (checkTemporary) {
    const temporary = checkTemporary;
    const originalTemporary = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    for (const name of ['TEMP', 'TMP']) process.env[name] = temporary.path;
    process.once('exit', () => {
      const outcome = removeOwnedDirectory(workspaceRoot, paths.root, temporary);
      if (outcome.removed) return;
      process.stderr.write(`The check's temporary directory was left in place: ${temporary.path}. ${outcome.detail}\n`);
      process.exitCode = 1;
    });
    import('./installed-capture-lifecycle.ts')
      .then(({ runInstalledCaptureLifecycle }) =>
        runInstalledCaptureLifecycle({ workspaceRoot, checkTemporary: temporary, originalTemporary }))
      .then(
        ({ evidencePath, evidence }) => {
          for (const phase of evidence.phases) process.stdout.write(`${phase.phase}: ${phase.outcome}\n`);
          for (const failure of evidence.failures) process.stderr.write(`${failure}\n`);
          // The evidence names workspace-relative paths only; the absolute ones go here.
          for (const line of keptRunTreeReport(workspaceRoot, evidence.keptRunTree, evidence.recovery)) {
            process.stderr.write(`${line}\n`);
          }
          process.stdout.write(`Installed capture-lifecycle evidence (${evidence.outcome}): ${evidencePath}\n`);
          if (evidence.outcome !== 'passed') process.exitCode = 1;
        },
        (error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
        },
      );
  }
}
