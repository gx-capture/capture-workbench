// Resolves the Capture release a consumer (LAW, Cert Prep) should pin next and
// proves it came from this repository's release workflows. Consumer bump
// workflows call it through .github/actions/resolve-capture-release. It reads
// only public data through `gh`, runs synchronously, and fails closed: any
// digest, attestation, supersession or manifest problem throws.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertIndexes,
  type ReleaseIndex,
  type StableIndex,
} from './update-release-index.ts';

const CAPTURE_REPOSITORY = 'gx-capture/capture-workbench';
const RELEASE_MANIFEST_ASSET = 'capture-release-manifest-v1.json';
const RUNTIME_MANIFEST_ASSET = 'capture-runtime-candidate-manifest.json';
const CANDIDATE_MANIFEST_ASSET = 'candidate-manifest.json';
const SIGNER_WORKFLOWS = {
  'route-a': `${CAPTURE_REPOSITORY}/.github/workflows/_publish-runtime-github-release.yml`,
  stable: `${CAPTURE_REPOSITORY}/.github/workflows/_publish-github-release.yml`,
} as const;
const CLASSIFICATIONS = [
  'no-impact',
  'additive',
  'breaking',
  'manual-review',
] as const;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type ResolveMode = keyof typeof SIGNER_WORKFLOWS;
type ContractClassification = (typeof CLASSIFICATIONS)[number];

export type ReleaseSummary = {
  readonly tag: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
};

/** Everything the resolver reads from GitHub; tests inject a fake. */
export type CaptureReleaseSource = {
  listReleases(): readonly ReleaseSummary[];
  readReleaseIndexFile(name: 'stable.json' | 'releases.json'): string;
  /** Downloads one release asset and returns its local path. */
  downloadAsset(tag: string, assetName: string): string;
  /** Throws unless `path` carries an attestation from `signerWorkflow`. */
  verifyAttestation(path: string, signerWorkflow: string): void;
};

type ResolveInput = {
  readonly mode: ResolveMode;
  readonly currentVersion: string;
  readonly currentContractSetSha256?: string;
};

export type ResolvedCaptureRelease = {
  readonly tag: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly contractClassification: ContractClassification;
  readonly contractSetSha256: string;
  readonly changed: boolean;
};

type VerifiedManifest = {
  readonly manifestSha256: string;
  readonly contractSetSha256: string;
  readonly recordedClassification?: ContractClassification;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJson(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is malformed JSON.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} is malformed.`);
  return value as Record<string, unknown>;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value))
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function tagParts(tag: string): number[] {
  return (RELEASE_TAG.exec(tag) ?? []).slice(1).map(Number);
}

function compareTags(left: string, right: string): number {
  const a = tagParts(left);
  const b = tagParts(right);
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function readIndexes(source: CaptureReleaseSource): {
  stable: StableIndex;
  releases: ReleaseIndex;
} {
  const stable = parseJson(
    source.readReleaseIndexFile('stable.json'),
    'release-index/stable.json',
  ) as unknown as StableIndex;
  const releases = parseJson(
    source.readReleaseIndexFile('releases.json'),
    'release-index/releases.json',
  ) as unknown as ReleaseIndex;
  // Same invariants the promotion workflow enforces when it writes the index:
  // the stable pointer must name a released (never superseded) entry with the
  // same manifest digest.
  assertIndexes(stable, releases);
  return { stable, releases };
}

function selectRouteATag(
  source: CaptureReleaseSource,
  releases: ReleaseIndex,
): string {
  const candidates = source
    .listReleases()
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        RELEASE_TAG.test(release.tag) &&
        releases.releases[release.tag]?.status !== 'superseded',
    )
    .map((release) => release.tag)
    .sort((left, right) => compareTags(right, left));
  if (candidates.length === 0)
    throw new Error('No published, unsuperseded Capture runtime release.');
  return candidates[0];
}

function verifyRouteAManifest(
  source: CaptureReleaseSource,
  tag: string,
): VerifiedManifest {
  const path = source.downloadAsset(tag, RUNTIME_MANIFEST_ASSET);
  const bytes = readFileSync(path);
  // The runtime release workflow attests this exact file, so the attestation
  // binds its digest; Route A has no external pointer to compare against.
  source.verifyAttestation(path, SIGNER_WORKFLOWS['route-a']);
  const manifest = parseJson(bytes.toString('utf8'), RUNTIME_MANIFEST_ASSET);
  if (
    manifest.schemaVersion !== '1' ||
    manifest.candidateKind !== 'runtime' ||
    manifest.releaseVersion !== tag.slice(1)
  ) {
    throw new Error(`${RUNTIME_MANIFEST_ASSET} does not describe ${tag}.`);
  }
  requireSha(manifest.candidateId, 'Runtime candidate ID');
  return {
    manifestSha256: sha256(bytes),
    contractSetSha256: requireSha(
      manifest.contractSetSha256,
      'Runtime contract-set digest',
    ),
  };
}

function verifyStableManifest(
  source: CaptureReleaseSource,
  tag: string,
  stable: StableIndex,
  releases: ReleaseIndex,
): VerifiedManifest {
  const path = source.downloadAsset(tag, RELEASE_MANIFEST_ASSET);
  const bytes = readFileSync(path);
  const manifestSha256 = sha256(bytes);
  if (manifestSha256 !== stable.manifestSha256)
    throw new Error(
      `${RELEASE_MANIFEST_ASSET} digest does not match release-index/stable.json.`,
    );
  source.verifyAttestation(path, SIGNER_WORKFLOWS.stable);
  const manifest = parseJson(bytes.toString('utf8'), RELEASE_MANIFEST_ASSET);
  const components = manifest.components as Record<string, unknown> | undefined;
  const contract = manifest.contractClassification as
    | Record<string, unknown>
    | undefined;
  const classification = contract?.classification;
  if (
    manifest.schemaVersion !== '1' ||
    manifest.status !== 'released' ||
    manifest.releaseTag !== tag ||
    manifest.releaseVersion !== tag.slice(1) ||
    manifest.candidateId !== releases.releases[tag].candidateId ||
    !components ||
    !CLASSIFICATIONS.includes(classification as ContractClassification)
  ) {
    throw new Error(`${RELEASE_MANIFEST_ASSET} does not describe ${tag}.`);
  }
  // The release manifest records the candidate manifest's digest, and only the
  // candidate manifest records the contract-set digest.
  const candidateSha256 = requireSha(
    components.candidateManifestSha256,
    'Candidate manifest digest',
  );
  const candidateBytes = readFileSync(
    source.downloadAsset(tag, CANDIDATE_MANIFEST_ASSET),
  );
  if (sha256(candidateBytes) !== candidateSha256)
    throw new Error(
      `${CANDIDATE_MANIFEST_ASSET} digest does not match the release manifest.`,
    );
  const candidate = parseJson(
    candidateBytes.toString('utf8'),
    CANDIDATE_MANIFEST_ASSET,
  );
  if (candidate.candidateId !== manifest.candidateId)
    throw new Error(`${CANDIDATE_MANIFEST_ASSET} does not describe ${tag}.`);
  return {
    manifestSha256,
    contractSetSha256: requireSha(
      candidate.contractSetSha256,
      'Release contract-set digest',
    ),
    recordedClassification: classification as ContractClassification,
  };
}

export function resolveCaptureRelease(
  source: CaptureReleaseSource,
  input: ResolveInput,
): ResolvedCaptureRelease {
  const currentVersion = input.currentVersion.replace(/^v/u, '');
  if (!RELEASE_TAG.test(`v${currentVersion}`))
    throw new Error('Current Capture version must be MAJOR.MINOR.PATCH.');
  if (input.currentContractSetSha256 !== undefined)
    requireSha(input.currentContractSetSha256, 'Current contract-set digest');
  const { stable, releases } = readIndexes(source);
  let tag: string;
  let verified: VerifiedManifest;
  if (input.mode === 'stable') {
    if (stable.releaseTag === null)
      throw new Error('release-index/stable.json names no release.');
    tag = stable.releaseTag;
    if (!RELEASE_TAG.test(tag))
      throw new Error('Stable release tag is not MAJOR.MINOR.PATCH.');
    verified = verifyStableManifest(source, tag, stable, releases);
  } else if (input.mode === 'route-a') {
    tag = selectRouteATag(source, releases);
    verified = verifyRouteAManifest(source, tag);
  } else {
    throw new Error('Resolve mode must be route-a or stable.');
  }
  const version = tag.slice(1);
  const changed = version !== currentVersion;
  // A Route A release records no classification (that is measured only for a
  // full release). Without a matching contract-set digest the consumer must
  // review the migration.
  const contractClassification: ContractClassification =
    verified.recordedClassification ??
    (!changed || verified.contractSetSha256 === input.currentContractSetSha256
      ? 'no-impact'
      : 'manual-review');
  return {
    tag,
    version,
    manifestSha256: verified.manifestSha256,
    contractClassification,
    contractSetSha256: verified.contractSetSha256,
    changed,
  };
}

export function formatGithubOutput(result: ResolvedCaptureRelease): string {
  return [
    `tag=${result.tag}`,
    `version=${result.version}`,
    `manifest_sha256=${result.manifestSha256}`,
    `contract_classification=${result.contractClassification}`,
    `contract_set_sha256=${result.contractSetSha256}`,
    `changed=${String(result.changed)}`,
    '',
  ].join('\n');
}

function gh(args: readonly string[]): string {
  // GH_TOKEN comes from the environment and is never part of the arguments.
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error)
    throw new Error(`Unable to run gh: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function ghReleaseSource(workDirectory: string): CaptureReleaseSource {
  return {
    listReleases: () =>
      gh([
        'api',
        '--paginate',
        `repos/${CAPTURE_REPOSITORY}/releases?per_page=100`,
        '--jq',
        '.[] | {tag: .tag_name, draft: .draft, prerelease: .prerelease}',
      ])
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const release = parseJson(line, 'GitHub release listing');
          return {
            tag: String(release.tag),
            draft: release.draft === true,
            prerelease: release.prerelease === true,
          };
        }),
    readReleaseIndexFile: (name) =>
      gh([
        'api',
        '-H',
        'Accept: application/vnd.github.raw+json',
        `repos/${CAPTURE_REPOSITORY}/contents/release-index/${name}?ref=release-index`,
      ]),
    downloadAsset: (tag, assetName) => {
      const directory = join(workDirectory, tag);
      mkdirSync(directory, { recursive: true });
      gh([
        'release',
        'download',
        tag,
        '--repo',
        CAPTURE_REPOSITORY,
        '--pattern',
        assetName,
        '--dir',
        directory,
      ]);
      return join(directory, assetName);
    },
    verifyAttestation: (path, signerWorkflow) => {
      gh([
        'attestation',
        'verify',
        path,
        '--repo',
        CAPTURE_REPOSITORY,
        '--signer-workflow',
        signerWorkflow,
      ]);
    },
  };
}

export function parseArguments(args: readonly string[]): ResolveInput & {
  readonly githubOutput?: string;
} {
  const values = new Map<string, string>();
  const names = [
    '--mode',
    '--current-version',
    '--current-contract-set-sha256',
    '--github-output',
  ];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!names.includes(name) || !value || values.has(name))
      throw new Error('Resolve Capture release arguments are invalid.');
    values.set(name, value);
  }
  const mode = values.get('--mode');
  const currentVersion = values.get('--current-version');
  if ((mode !== 'route-a' && mode !== 'stable') || !currentVersion)
    throw new Error(
      '--mode (route-a | stable) and --current-version are required.',
    );
  return {
    mode,
    currentVersion,
    currentContractSetSha256: values.get('--current-contract-set-sha256'),
    githubOutput: values.get('--github-output'),
  };
}

function main(): void {
  const { githubOutput, ...input } = parseArguments(process.argv.slice(2));
  const workDirectory = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), 'capture-release-'),
  );
  try {
    const result = resolveCaptureRelease(ghReleaseSource(workDirectory), input);
    if (githubOutput) appendFileSync(githubOutput, formatGithubOutput(result));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
