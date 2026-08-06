import {
  verifyGeneratedVersions,
  workspaceRoot,
} from './release/version-sources.ts';

try {
  const intent = verifyGeneratedVersions(workspaceRoot);
  process.stdout.write(
    `Release versions are synchronized at ${intent.releaseVersion}; API ${intent.runtimeApiVersion}; schema ${intent.documentSchemaVersion}.\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
