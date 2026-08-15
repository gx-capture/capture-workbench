import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function args(values: readonly string[]) {
  const parsed = new Map<string, string>();
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i];
    const value = values[i + 1];
    if (!['--output', '--version', '--source-commit', '--producer-run-id', '--contract-set-sha256'].includes(key) || !value || parsed.has(key)) {
      throw new Error('Use --output <directory> --version <semver> --source-commit <sha> --producer-run-id <id> --contract-set-sha256 <sha>.');
    }
    parsed.set(key, value);
  }
  const output = parsed.get('--output');
  const version = parsed.get('--version');
  const sourceCommit = parsed.get('--source-commit');
  const producerRunId = Number(parsed.get('--producer-run-id'));
  const contractSetSha256 = parsed.get('--contract-set-sha256');
  if (!output || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) || !sourceCommit || !/^(?:local|[0-9a-f]{40})$/u.test(sourceCommit) || !Number.isSafeInteger(producerRunId) || producerRunId < 1 || !contractSetSha256 || !/^[0-9a-f]{64}$/u.test(contractSetSha256)) {
    throw new Error('Java SDK candidate identity arguments are invalid.');
  }
  return { output: resolve(output), version, sourceCommit, producerRunId, contractSetSha256 };
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main(): Promise<void> {
  const { output, version, sourceCommit, producerRunId, contractSetSha256 } = args(process.argv.slice(2));
  const root = resolve(import.meta.dirname, '..');
  const sdk = resolve(root, 'packages/capture-runtime-client-java');
  const maven = join(output, 'maven');
  const checksums = join(output, 'checksums');
  await mkdir(output, { recursive: true });
  await Promise.all([mkdir(maven, { recursive: true }), mkdir(checksums, { recursive: true })]);
  const files = [
    `capture-runtime-client-${version}.jar`,
    `capture-runtime-client-${version}-sources.jar`,
    'pom.xml',
    'capture-runtime-contract-set.sha256',
  ];
  for (const file of files) {
    const source =
      file === 'pom.xml'
        ? join(sdk, file)
        : file === 'capture-runtime-contract-set.sha256'
          ? join(sdk, 'target', 'classes', file)
          : join(sdk, 'target', file);
    const target = join(maven, file);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error(`Java SDK publication artifact is not a file: ${source}`);
    await cp(source, target);
  }
  const embeddedHash = (await readFile(join(maven, 'capture-runtime-contract-set.sha256'), 'utf8')).trim();
  if (embeddedHash !== contractSetSha256) {
    throw new Error(`Java SDK embedded contract-set hash differs from requested ${contractSetSha256}: ${embeddedHash}`);
  }
  const artifacts = [] as Array<{ path: string; bytes: number; sha256: string }>;
  for (const file of files) {
    const path = join(maven, file);
    const metadata = await stat(path);
    artifacts.push({ path: `maven/${file}`, bytes: metadata.size, sha256: await digest(path) });
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'maven-java-sdk',
    sourceCommit,
    releaseVersion: version,
    producerRunId,
    coordinates: { groupId: 'com.gx.capture', artifactId: 'capture-runtime-client', packaging: 'jar' },
    contractSetSha256,
    artifacts,
    toolchains: { java: process.env.JAVA_HOME ?? 'unknown', maven: 'maven' },
  } as const;
  const candidateId = createHash('sha256').update(JSON.stringify(baseManifest)).digest('hex');
  const manifest = { ...baseManifest, candidateId };
  const manifestPath = join(output, 'java-candidate-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(`${manifestPath}.sha256`, `${await digest(manifestPath)}  java-candidate-manifest.json\n`, 'utf8');
  for (const artifact of artifacts) {
    await writeFile(join(checksums, `${artifact.path.replaceAll('/', '__')}.sha256`), `${artifact.sha256}  ${artifact.path}\n`, 'utf8');
  }
  process.stdout.write(`Assembled Maven Java SDK candidate ${version} (${candidateId}) at ${output}.\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
