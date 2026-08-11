import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNode24Corepack } from '../node24-corepack.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
interface PackageDescriptor {
  readonly project: string;
  readonly packageDirectory: string;
  readonly manifest: { name: string; version: string };
  readonly archivePath: string;
  readonly builtManifestPath: string;
}

const packageDescriptors: readonly PackageDescriptor[] = [
  'capture-contracts',
  'capture-angular',
  'capture-structuring',
].map((project) => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, `packages/${project}/package.json`), 'utf8'),
  ) as { name: string; version: string };
  return {
    project,
    packageDirectory: join(repoRoot, `dist/packages/${project}`),
    manifest,
    archivePath: join(
      repoRoot,
      'dist',
      'packs',
      packageArchiveName(manifest.name, manifest.version),
    ),
    builtManifestPath: join(repoRoot, `dist/packages/${project}/package.json`),
  };
});
const registry =
  process.env.CAPTURE_WORKBENCH_LOCAL_REGISTRY ?? 'http://127.0.0.1:4873';
const corepackCli = resolveNode24Corepack();

export function packageArchiveName(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}

export function packageMetadataPath(name: string): string {
  return `/${name.replace('/', '%2f')}`;
}

export function packagePublicationDecision(
  existingIntegrity: string | undefined,
  localIntegrity: string,
): 'publish' | 'already-published' {
  if (existingIntegrity === undefined) return 'publish';
  if (existingIntegrity === localIntegrity) return 'already-published';
  throw new Error(
    'Published package integrity differs from the local synchronized package.',
  );
}

function sha512Integrity(path: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

async function publishedPackageIntegrity(
  packageManifest: PackageDescriptor['manifest'],
): Promise<string | undefined> {
  const response = await fetch(
    `${registry}${packageMetadataPath(packageManifest.name)}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Unable to inspect ${packageManifest.name}@${packageManifest.version} from ${registry}: HTTP ${response.status}.`,
    );
  }
  const metadata = (await response.json()) as {
    versions?: Record<string, { dist?: { integrity?: unknown } }>;
  };
  const integrity =
    metadata.versions?.[packageManifest.version]?.dist?.integrity;
  if (integrity === undefined) return undefined;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error(
      'Local registry returned an invalid package integrity value.',
    );
  }
  return integrity;
}

function run(command: string, args: string[], cwd = repoRoot): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  if (!corepackCli) {
    throw new Error(
      'Node 24 Corepack is required to run the pnpm 11 workflow.',
    );
  }

  await run(process.execPath, [
    corepackCli,
    'pnpm',
    'nx',
    'run',
    'capture-angular:pack',
    '--skip-nx-cache',
  ]);
  await run(process.execPath, [
    corepackCli,
    'pnpm',
    'nx',
    'run',
    'capture-structuring:pack',
    '--skip-nx-cache',
  ]);

  const originalBuiltManifests = new Map<string, string>();
  try {
    for (const descriptor of packageDescriptors) {
      if (
        !existsSync(descriptor.archivePath) ||
        !existsSync(descriptor.builtManifestPath)
      ) {
        throw new Error(
          `Expected ${descriptor.manifest.name} artifacts were not created under ${repoRoot}/dist.`,
        );
      }
      const originalBuiltManifest = readFileSync(
        descriptor.builtManifestPath,
        'utf8',
      );
      originalBuiltManifests.set(
        descriptor.builtManifestPath,
        originalBuiltManifest,
      );
      const localBuiltManifest = JSON.parse(originalBuiltManifest) as {
        publishConfig?: Record<string, unknown>;
      };
      localBuiltManifest.publishConfig = {
        ...(localBuiltManifest.publishConfig ?? {}),
        registry,
      };
      writeFileSync(
        descriptor.builtManifestPath,
        `${JSON.stringify(localBuiltManifest, null, 2)}\n`,
        'utf8',
      );
      rmSync(descriptor.archivePath, { force: true });
      await run(
        process.execPath,
        [corepackCli, 'pnpm', 'pack', '--pack-destination', '../../packs'],
        descriptor.packageDirectory,
      );

      if (!existsSync(descriptor.archivePath)) {
        throw new Error(
          `Expected local package archive was not created: ${descriptor.archivePath}`,
        );
      }

      const localIntegrity = sha512Integrity(descriptor.archivePath);
      const existingIntegrity = await publishedPackageIntegrity(
        descriptor.manifest,
      );
      const decision = packagePublicationDecision(
        existingIntegrity,
        localIntegrity,
      );
      if (decision === 'publish') {
        await run(process.execPath, [
          corepackCli,
          'pnpm',
          'publish',
          descriptor.archivePath,
          '--registry',
          registry,
          '--no-git-checks',
          '--tag',
          'local',
        ]);
      }

      const publishedIntegrity = await publishedPackageIntegrity(
        descriptor.manifest,
      );
      if (publishedIntegrity !== localIntegrity) {
        throw new Error(
          'Local registry package integrity did not match the synchronized package.',
        );
      }

      process.stdout.write(
        `${decision === 'publish' ? 'Published' : 'Reused'} ${descriptor.manifest.name}@${descriptor.manifest.version} at ${registry} with matching integrity.\n`,
      );
    }
  } finally {
    for (const [path, contents] of originalBuiltManifests) {
      writeFileSync(path, contents, 'utf8');
    }
  }
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
