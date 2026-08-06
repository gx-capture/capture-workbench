import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--promotion-evidence',
        '--registry-directory',
        '--github-release-ledger',
        '--output',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --promotion-evidence <file> --registry-directory <directory> --github-release-ledger <file> --output <file>.',
      );
    }
    values.set(name, value);
  }
  if (values.size !== 4)
    throw new Error('Promotion ledger arguments are incomplete.');
  return values;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const evidencePath = resolve(values.get('--promotion-evidence')!);
  const registryDirectory = resolve(values.get('--registry-directory')!);
  const githubReleasePath = resolve(values.get('--github-release-ledger')!);
  const output = resolve(values.get('--output')!);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as {
    candidateId?: unknown;
    candidateManifestSha256?: unknown;
    sourceCommit?: unknown;
    releaseVersion?: unknown;
    contractClassification?: unknown;
  };
  const githubRelease = JSON.parse(
    await readFile(githubReleasePath, 'utf8'),
  ) as {
    schemaVersion?: unknown;
    candidateId?: unknown;
    sourceCommit?: unknown;
    tag?: unknown;
    status?: unknown;
    candidateManifestSha256?: unknown;
  };
  if (
    typeof evidence.candidateId !== 'string' ||
    typeof evidence.candidateManifestSha256 !== 'string' ||
    typeof evidence.sourceCommit !== 'string' ||
    typeof evidence.releaseVersion !== 'string' ||
    typeof evidence.contractClassification !== 'string'
  ) {
    throw new Error('Promotion evidence metadata is incomplete.');
  }
  if (
    githubRelease.schemaVersion !== '1' ||
    githubRelease.candidateId !== evidence.candidateId ||
    githubRelease.sourceCommit !== evidence.sourceCommit ||
    githubRelease.tag !== `v${evidence.releaseVersion}` ||
    githubRelease.status !== 'public' ||
    githubRelease.candidateManifestSha256 !== evidence.candidateManifestSha256
  ) {
    throw new Error(
      'GitHub Release ledger is not bound to the approved promotion evidence.',
    );
  }
  const registryLedgers: Record<string, unknown> = {};
  for (const name of ['npm', 'pypi', 'crates.io']) {
    const path = join(registryDirectory, `registry-ledger-${name}.json`);
    registryLedgers[name] = JSON.parse(await readFile(path, 'utf8')) as unknown;
  }
  const evidenceBytes = await readBytes(evidencePath);
  const githubReleaseBytes = await readBytes(githubReleasePath);
  const registryDigests: Record<string, string> = {};
  for (const name of Object.keys(registryLedgers)) {
    registryDigests[name] = sha256(
      await readBytes(join(registryDirectory, `registry-ledger-${name}.json`)),
    );
  }
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: '1',
        candidateId: evidence.candidateId,
        candidateManifestSha256: evidence.candidateManifestSha256,
        sourceCommit: evidence.sourceCommit,
        releaseVersion: evidence.releaseVersion,
        contractClassification: evidence.contractClassification,
        tag: `v${evidence.releaseVersion}`,
        status: 'promoted',
        evidenceSha256: sha256(evidenceBytes),
        githubReleaseLedgerSha256: sha256(githubReleaseBytes),
        registryLedgerSha256: registryDigests,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
