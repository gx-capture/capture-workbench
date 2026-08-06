import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type ReleaseStatus = 'released' | 'superseded';

export type ReleaseRecord = {
  readonly status: ReleaseStatus;
  readonly manifestSha256: string;
  readonly candidateId: string;
  readonly supersededBy?: string;
  readonly reason?: string;
};

export type StableIndex = {
  readonly schemaVersion: '1';
  readonly channel: 'stable';
  readonly releaseTag: string | null;
  readonly manifestSha256: string | null;
  readonly manifestAssetName: 'capture-release-manifest-v1.json';
  readonly updatedAt: string | null;
};

export type ReleaseIndex = {
  readonly schemaVersion: '1';
  readonly releases: Record<string, ReleaseRecord>;
};

type UpdateInput =
  | {
      readonly operation: 'promote';
      readonly tag: string;
      readonly candidateId: string;
      readonly manifestSha256: string;
      readonly updatedAt: string;
    }
  | {
      readonly operation: 'supersede';
      readonly defectiveTag: string;
      readonly replacementTag: string;
      readonly defectiveManifestSha256: string;
      readonly replacementManifestSha256: string;
      readonly reason: string;
      readonly updatedAt: string;
    };

function assertTag(value: string, label: string): void {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value))
    throw new Error(`${label} is invalid.`);
}

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

function assertCandidateId(value: string): void {
  assertSha(value, 'Candidate ID');
}

function assertIndexes(stable: StableIndex, releases: ReleaseIndex): void {
  if (
    stable.schemaVersion !== '1' ||
    stable.channel !== 'stable' ||
    stable.manifestAssetName !== 'capture-release-manifest-v1.json' ||
    releases.schemaVersion !== '1' ||
    !releases.releases ||
    typeof releases.releases !== 'object'
  ) {
    throw new Error('Release index schema is unsupported.');
  }
  if (stable.releaseTag !== null) {
    assertTag(stable.releaseTag, 'Stable release tag');
    assertSha(stable.manifestSha256 ?? '', 'Stable manifest digest');
    const record = releases.releases[stable.releaseTag];
    if (!record || record.status !== 'released') {
      throw new Error(
        'Stable pointer does not reference a released index entry.',
      );
    }
    if (record.manifestSha256 !== stable.manifestSha256) {
      throw new Error('Stable pointer digest differs from its release entry.');
    }
  } else if (stable.manifestSha256 !== null || stable.updatedAt !== null) {
    throw new Error('Empty stable pointer contains release metadata.');
  }
}

export function updateReleaseIndex(
  stable: StableIndex,
  releases: ReleaseIndex,
  input: UpdateInput,
): { stable: StableIndex; releases: ReleaseIndex } {
  assertIndexes(stable, releases);
  const nextReleases = { ...releases.releases };
  if (input.operation === 'promote') {
    assertTag(input.tag, 'Release tag');
    assertCandidateId(input.candidateId);
    assertSha(input.manifestSha256, 'Manifest digest');
    const existing = nextReleases[input.tag];
    if (existing?.status === 'superseded') {
      throw new Error('A superseded release cannot be promoted again.');
    }
    if (
      existing &&
      (existing.manifestSha256 !== input.manifestSha256 ||
        existing.candidateId !== input.candidateId)
    ) {
      throw new Error(
        'Release index entry conflicts with the promotion input.',
      );
    }
    nextReleases[input.tag] = {
      status: 'released',
      manifestSha256: input.manifestSha256,
      candidateId: input.candidateId,
    };
    return {
      stable: {
        schemaVersion: '1',
        channel: 'stable',
        releaseTag: input.tag,
        manifestSha256: input.manifestSha256,
        manifestAssetName: 'capture-release-manifest-v1.json',
        updatedAt: input.updatedAt,
      },
      releases: { schemaVersion: '1', releases: nextReleases },
    };
  }

  assertTag(input.defectiveTag, 'Defective release tag');
  assertTag(input.replacementTag, 'Replacement release tag');
  if (input.defectiveTag === input.replacementTag)
    throw new Error('Defective and replacement releases must differ.');
  if (!input.reason.trim()) throw new Error('Supersession reason is required.');
  assertSha(input.defectiveManifestSha256, 'Defective manifest digest');
  assertSha(input.replacementManifestSha256, 'Replacement manifest digest');
  const defective = nextReleases[input.defectiveTag];
  const replacement = nextReleases[input.replacementTag];
  if (!defective || defective.status !== 'released') {
    throw new Error('Only an unretracted released entry may be superseded.');
  }
  if (!replacement || replacement.status !== 'released') {
    throw new Error('Replacement release is not a known-good released entry.');
  }
  if (
    defective.manifestSha256 !== input.defectiveManifestSha256 ||
    replacement.manifestSha256 !== input.replacementManifestSha256
  ) {
    throw new Error('Downloaded manifests do not match the protected index.');
  }
  nextReleases[input.defectiveTag] = {
    ...defective,
    status: 'superseded',
    supersededBy: input.replacementTag,
    reason: input.reason.trim(),
  };
  return {
    stable: {
      schemaVersion: '1',
      channel: 'stable',
      releaseTag: input.replacementTag,
      manifestSha256: replacement.manifestSha256,
      manifestAssetName: 'capture-release-manifest-v1.json',
      updatedAt: input.updatedAt,
    },
    releases: { schemaVersion: '1', releases: nextReleases },
  };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--index',
        '--operation',
        '--tag',
        '--candidate-id',
        '--manifest-sha256',
        '--defective-tag',
        '--replacement-tag',
        '--reason',
        '--defective-manifest-sha256',
        '--replacement-manifest-sha256',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error('Release index arguments are invalid.');
    }
    values.set(name, value);
  }
  return values;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const index = resolve(required(values, '--index'));
  const operation = required(values, '--operation');
  const stable = JSON.parse(
    await readFile(resolve(index, 'stable.json'), 'utf8'),
  ) as StableIndex;
  const releases = JSON.parse(
    await readFile(resolve(index, 'releases.json'), 'utf8'),
  ) as ReleaseIndex;
  const updatedAt = new Date().toISOString();
  const result =
    operation === 'promote'
      ? updateReleaseIndex(stable, releases, {
          operation: 'promote',
          tag: required(values, '--tag'),
          candidateId: required(values, '--candidate-id'),
          manifestSha256: required(values, '--manifest-sha256'),
          updatedAt,
        })
      : operation === 'supersede'
        ? updateReleaseIndex(stable, releases, {
            operation: 'supersede',
            defectiveTag: required(values, '--defective-tag'),
            replacementTag: required(values, '--replacement-tag'),
            defectiveManifestSha256: required(
              values,
              '--defective-manifest-sha256',
            ),
            replacementManifestSha256: required(
              values,
              '--replacement-manifest-sha256',
            ),
            reason: required(values, '--reason'),
            updatedAt,
          })
        : (() => {
            throw new Error('Release index operation is invalid.');
          })();
  await writeFile(
    resolve(index, 'stable.json'),
    `${JSON.stringify(result.stable, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(index, 'releases.json'),
    `${JSON.stringify(result.releases, null, 2)}\n`,
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
