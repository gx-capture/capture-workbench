import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { verifyContractImpact } from './classify-release-contract.ts';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--candidate',
        '--tag',
        '--promotion-evidence',
        '--consumer-gate-ledger',
        '--registry-directory',
        '--output',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error('Release manifest arguments are invalid or incomplete.');
    }
    values.set(name, value);
  }
  if (values.size !== 6)
    throw new Error('Release manifest arguments are incomplete.');
  return values;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function digestFile(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function assetRecords(candidate: string): Promise<readonly JsonRecord[]> {
  const records: JsonRecord[] = [];
  for (const directory of ['runtime', 'desktop']) {
    const root = join(candidate, directory);
    for (const name of await readdir(root)) {
      const path = join(root, name);
      if (!(await stat(path)).isFile())
        throw new Error(`Release asset is not a regular file: ${name}.`);
      const digest = await digestFile(path);
      records.push({ path: `${directory}/${name}`, ...digest });
    }
  }
  return records.sort((left, right) =>
    String(left.path).localeCompare(String(right.path)),
  );
}

function requireCandidateIdentity(
  candidate: JsonRecord,
  tag: string,
  evidence: JsonRecord,
): { candidateId: string; sourceCommit: string; releaseVersion: string } {
  const releaseVersion = tag.slice(1);
  if (
    typeof candidate.candidateId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(candidate.candidateId) ||
    typeof candidate.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(candidate.sourceCommit) ||
    candidate.releaseVersion !== releaseVersion ||
    evidence.candidateId !== candidate.candidateId ||
    evidence.sourceCommit !== candidate.sourceCommit ||
    evidence.releaseVersion !== releaseVersion
  ) {
    throw new Error(
      'Release manifest inputs are not bound to one candidate and tag.',
    );
  }
  return {
    candidateId: candidate.candidateId,
    sourceCommit: candidate.sourceCommit,
    releaseVersion,
  };
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const candidateRoot = resolve(values.get('--candidate')!);
  const tag = values.get('--tag')!;
  const evidence = JSON.parse(
    await readFile(resolve(values.get('--promotion-evidence')!), 'utf8'),
  ) as JsonRecord;
  const consumerLedgerPath = resolve(values.get('--consumer-gate-ledger')!);
  const consumerLedger = JSON.parse(
    await readFile(consumerLedgerPath, 'utf8'),
  ) as JsonRecord;
  const candidate = JSON.parse(
    await readFile(join(candidateRoot, 'candidate-manifest.json'), 'utf8'),
  ) as JsonRecord;
  const identity = requireCandidateIdentity(candidate, tag, evidence);
  const snapshotPath = join(
    candidateRoot,
    'contracts',
    'contract-snapshot.json',
  );
  const snapshotBytes = await readFile(snapshotPath);
  const contractImpact = verifyContractImpact(
    JSON.parse(
      await readFile(join(candidateRoot, 'contract-impact.json'), 'utf8'),
    ) as unknown,
    {
      candidateId: identity.candidateId,
      candidateSnapshotSha256: sha256(snapshotBytes),
    },
  );
  if (
    evidence.candidateManifestSha256 !==
      sha256(await readFile(join(candidateRoot, 'candidate-manifest.json'))) ||
    consumerLedger.candidateId !== identity.candidateId ||
    consumerLedger.candidateManifestSha256 !==
      evidence.candidateManifestSha256 ||
    consumerLedger.verdict !== 'passed' ||
    consumerLedger.contractClassification !== contractImpact.classification ||
    !Array.isArray(consumerLedger.gates) ||
    !Array.isArray(consumerLedger.resultDigests)
  ) {
    throw new Error(
      'Release manifest evidence is not a passing exact-candidate set.',
    );
  }
  const registryDirectory = resolve(values.get('--registry-directory')!);
  const registryArtifacts: JsonRecord[] = [];
  for (const registry of ['npm', 'pypi', 'crates.io']) {
    const ledger = JSON.parse(
      await readFile(
        join(registryDirectory, `registry-ledger-${registry}.json`),
        'utf8',
      ),
    ) as JsonRecord;
    if (
      ledger.schemaVersion !== '1' ||
      ledger.registry !== registry ||
      ledger.candidateId !== identity.candidateId ||
      ledger.releaseVersion !== identity.releaseVersion ||
      ledger.status !== 'published'
    ) {
      throw new Error(
        `Registry ledger is not bound to the release manifest: ${registry}.`,
      );
    }
    const items = Array.isArray(ledger.packages)
      ? ledger.packages
      : Array.isArray(ledger.artifacts)
        ? ledger.artifacts
        : [];
    for (const item of items) {
      if (!isRecord(item))
        throw new Error(`Registry ledger item is invalid: ${registry}.`);
      registryArtifacts.push({ registry, ...item });
    }
  }
  const gateSummaries = (consumerLedger.gates as readonly unknown[]).map(
    (value) => {
      if (!isRecord(value))
        throw new Error('Consumer gate summary is invalid.');
      return {
        consumerRepository: value.consumerRepository,
        consumerCommit: value.consumerCommit,
        workflowPath: value.workflowPath,
        workflowRunId: value.workflowRunId,
        candidateId: value.candidateId,
        candidateManifestSha256: value.candidateManifestSha256,
        verdict: value.verdict,
        startedAt: value.startedAt,
        completedAt: value.completedAt,
      };
    },
  );
  const manifest = {
    schemaVersion: '1',
    status: 'released',
    candidateId: identity.candidateId,
    sourceCommit: identity.sourceCommit,
    releaseTag: tag,
    releaseVersion: identity.releaseVersion,
    components: {
      runtimeApiVersion: candidate.runtimeApiVersion,
      documentSchemaVersion: candidate.documentSchemaVersion,
      candidateManifestSha256: evidence.candidateManifestSha256,
      contractSnapshotSha256: sha256(snapshotBytes),
      contractSnapshotAssetName: 'capture-contract-snapshot.json',
    },
    registryArtifacts: registryArtifacts.sort((left, right) =>
      `${left.registry}:${String(left.name)}`.localeCompare(
        `${right.registry}:${String(right.name)}`,
      ),
    ),
    runtimeAssets: await assetRecords(candidateRoot),
    contractClassification: {
      classification: contractImpact.classification,
      baselineRelease: contractImpact.baselineRelease,
      changes: contractImpact.changes,
      candidateId: identity.candidateId,
      candidateSnapshotSha256: contractImpact.candidateSnapshotSha256,
    },
    consumerGates: {
      ledgerSha256: sha256(await readFile(consumerLedgerPath)),
      gates: gateSummaries,
      resultDigests: consumerLedger.resultDigests,
    },
  };
  const output = resolve(values.get('--output')!);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(output, bytes);
  await writeFile(
    `${output}.sha256`,
    `${sha256(bytes)}  ${basename(output)}\n`,
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
