import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageManifestPath = join(
  repoRoot,
  'packages/capture-angular/package.json',
);
const packageManifest = JSON.parse(
  readFileSync(packageManifestPath, 'utf8'),
) as { name: string; version: string };
const registry =
  process.env.CAPTURE_WORKBENCH_LOCAL_REGISTRY ?? 'http://127.0.0.1:4873';
const archivePath = join(
  repoRoot,
  'dist',
  'packs',
  packageArchiveName(packageManifest.name, packageManifest.version),
);
const builtManifestPath = join(
  repoRoot,
  'dist/packages/capture-angular/package.json',
);
const corepackCli = join(
  dirname(process.execPath),
  'node_modules',
  'corepack',
  'dist',
  'corepack.js',
);

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

async function publishedPackageIntegrity(): Promise<string | undefined> {
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
  const integrity = metadata.versions?.[packageManifest.version]?.dist?.integrity;
  if (integrity === undefined) return undefined;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error('Local registry returned an invalid package integrity value.');
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
  if (!existsSync(corepackCli)) {
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

  if (!existsSync(archivePath) || !existsSync(builtManifestPath)) {
    throw new Error(
      `Expected package artifacts were not created under ${repoRoot}/dist.`,
    );
  }

  const originalBuiltManifest = readFileSync(builtManifestPath, 'utf8');
  try {
    const localBuiltManifest = JSON.parse(originalBuiltManifest) as {
      publishConfig?: Record<string, unknown>;
    };
    localBuiltManifest.publishConfig = {
      ...(localBuiltManifest.publishConfig ?? {}),
      registry,
    };
    writeFileSync(
      builtManifestPath,
      `${JSON.stringify(localBuiltManifest, null, 2)}\n`,
      'utf8',
    );
    rmSync(archivePath, { force: true });
    await run(
      process.execPath,
      [corepackCli, 'pnpm', 'pack', '--pack-destination', '../../packs'],
      join(repoRoot, 'dist/packages/capture-angular'),
    );

    if (!existsSync(archivePath)) {
      throw new Error(
        `Expected local package archive was not created: ${archivePath}`,
      );
    }

    const localIntegrity = sha512Integrity(archivePath);
    const existingIntegrity = await publishedPackageIntegrity();
    const decision = packagePublicationDecision(existingIntegrity, localIntegrity);
    if (decision === 'publish') {
      await run(process.execPath, [
        corepackCli,
        'pnpm',
        'publish',
        archivePath,
        '--registry',
        registry,
        '--no-git-checks',
        '--tag',
        'local',
      ]);
    }

    const publishedIntegrity = await publishedPackageIntegrity();
    if (publishedIntegrity !== localIntegrity) {
      throw new Error(
        'Local registry package integrity did not match the synchronized package.',
      );
    }

    process.stdout.write(
      `${decision === 'publish' ? 'Published' : 'Reused'} ${packageManifest.name}@${packageManifest.version} at ${registry} with matching integrity.\n`,
    );
  } finally {
    writeFileSync(builtManifestPath, originalBuiltManifest, 'utf8');
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
