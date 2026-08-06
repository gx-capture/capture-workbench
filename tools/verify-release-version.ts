import {
  verifyGeneratedVersions,
  workspaceRoot,
} from './release/version-sources.ts';

const rawArguments = process.argv.slice(2);
const positionalArguments =
  rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
if (positionalArguments.length > 1) {
  throw new Error('Pass one release tag such as v0.3.0.');
}
const requestedTag = positionalArguments[0] ?? process.env.GITHUB_REF_NAME;

if (!requestedTag) {
  throw new Error('Pass a release tag such as v0.3.0.');
}

const releaseVersion = requestedTag.startsWith('v')
  ? requestedTag.slice(1)
  : requestedTag;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  throw new Error(`Unsupported release tag: ${requestedTag}`);
}

try {
  verifyGeneratedVersions(workspaceRoot, releaseVersion);
  process.stdout.write(
    `Release versions are synchronized at ${releaseVersion}.\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
