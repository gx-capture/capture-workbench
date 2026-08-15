import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--candidate', '--version', '--output'].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --candidate <directory> --version <semver> --output <file>.',
      );
    }
    values.set(name, value);
  }
  if (values.size !== 3)
    throw new Error(
      'Use --candidate <directory> --version <semver> --output <file>.',
    );
  return values;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const candidate = resolve(values.get('--candidate')!);
  const version = values.get('--version')!;
  const output = resolve(values.get('--output')!);
  const manifestBytes = await readFile(join(candidate, 'candidate-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { candidateId?: unknown };
  if (
    typeof manifest.candidateId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifest.candidateId)
  ) {
    throw new Error('PyPI candidate manifest has no valid candidate ID.');
  }
  const artifacts = (await readdir(join(candidate, 'python')))
    .filter((name) => /\.(?:whl|tar\.gz)$/u.test(name))
    .sort();
  if (
    artifacts.length !== 4 ||
    artifacts.some(
      (name) =>
        !new RegExp(
        `^(?:capture_runtime_client|capture_structuring)-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
          'u',
        ).test(name),
    )
  ) {
    throw new Error(
      'PyPI candidate artifact set is not the exact approved version.',
    );
  }
  const artifactRecords = [] as Array<{ name: string; sha256: string }>;
  for (const project of ['capture-runtime-client', 'capture-structuring']) {
    const response = await fetch(
      `https://pypi.org/pypi/${project}/${version}/json`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gx-capture-release-verifier',
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `PyPI ${project} ${version} is not available after publication.`,
      );
    }
    const payload = (await response.json()) as {
      urls?: Array<{
        filename?: unknown;
        digests?: { sha256?: unknown };
      }>;
    };
    const remote = new Map(
      (payload.urls ?? []).flatMap((item) =>
        typeof item.filename === 'string' &&
        typeof item.digests?.sha256 === 'string'
          ? [[item.filename, item.digests.sha256] as const]
          : [],
      ),
    );
    for (const name of artifacts.filter((artifact) =>
      artifact.startsWith(`${project.replaceAll('-', '_')}_`),
    )) {
      const candidateDigest = createHash('sha256')
        .update(await readFile(join(candidate, 'python', name)))
        .digest('hex');
      if (remote.get(name) !== candidateDigest) {
        throw new Error(
          `PyPI artifact differs from the approved candidate: ${name}.`,
        );
      }
      artifactRecords.push({ name, sha256: candidateDigest });
    }
  }
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: '1',
        registry: 'pypi',
        candidateId: manifest.candidateId,
        sourceCandidateManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        releaseVersion: version,
        status: 'published',
        artifacts: artifactRecords.sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
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
