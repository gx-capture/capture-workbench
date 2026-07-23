import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  forkJoin,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
  toArray,
} from 'rxjs';

const packageName = '@gx/capture-angular';
const registry = 'https://npm.pkg.github.com';
const runtimeAssetNames = Object.freeze([
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe.sha256',
  'capture-runtime-manifest.json',
  'capture-document-v1.schema.json',
]);

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(-2000)}`,
    );
  }
  return result;
}

function hashFile(path, algorithm, encoding = 'hex') {
  return new Observable((subscriber) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    const onData = (chunk) => hash.update(chunk);
    const onError = (error) => subscriber.error(error);
    const onEnd = () => {
      if (subscriber.closed) return;
      subscriber.next(hash.digest(encoding));
      subscriber.complete();
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
    return () => {
      stream.off('data', onData);
      stream.destroy();
    };
  });
}

export function sha512Integrity(path) {
  return hashFile(path, 'sha512', 'base64').pipe(
    map((digest) => `sha512-${digest}`),
  );
}

export function packagePublicationDecision(existingIntegrity, localIntegrity) {
  if (existingIntegrity === undefined) return 'publish';
  if (existingIntegrity === localIntegrity) return 'already-published';
  throw new Error(
    'Published package integrity differs from the local synchronized package.',
  );
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--tag', '--runtime-dir', '--package'].includes(name) || !value) {
      throw new Error('Use --tag, --runtime-dir, and --package exactly once.');
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error('Use --tag, --runtime-dir, and --package exactly once.');
  }
  const tag = values.get('--tag');
  if (!/^v\d+\.\d+\.\d+$/u.test(tag))
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH.');
  return {
    tag,
    version: tag.slice(1),
    runtimeDirectory: resolve(values.get('--runtime-dir')),
    packagePath: resolve(values.get('--package')),
  };
}

function exactRuntimeAssets(runtimeDirectory) {
  return from(runtimeAssetNames).pipe(
    map((name) => join(runtimeDirectory, name)),
    concatMap((path, index) =>
      defer(() => from(stat(path))).pipe(
        map((metadata) => {
          if (!metadata.isFile())
            throw new Error(`Runtime release asset is not a file: ${path}`);
          if (basename(path) !== runtimeAssetNames[index]) {
            throw new Error('Runtime release asset name is not canonical.');
          }
          return path;
        }),
      ),
    ),
    toArray(),
  );
}

function sha256(path) {
  return hashFile(path, 'sha256');
}

function assertSameFile(left, right) {
  return forkJoin({ left: defer(() => from(stat(left))), right: defer(() => from(stat(right))) }).pipe(
    concatMap(({ left: leftStat, right: rightStat }) =>
      forkJoin({ left: sha256(left), right: sha256(right) }).pipe(
        map(({ left: leftDigest, right: rightDigest }) => {
          if (leftStat.size !== rightStat.size || leftDigest !== rightDigest) {
            throw new Error(
              `Published runtime asset differs from local bytes: ${basename(left)}`,
            );
          }
        }),
      ),
    ),
  );
}

function releaseState(tag, runCommand) {
  const result = runCommand(
    'gh',
    ['release', 'view', tag, '--json', 'isDraft'],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    if (/release not found|HTTP 404|not found/iu.test(result.stderr || result.stdout || '')) {
      return 'missing';
    }
    throw new Error(
      `Unable to inspect release ${tag}: ${(result.stderr || '').slice(-1000)}`,
    );
  }
  return JSON.parse(result.stdout).isDraft ? 'draft' : 'public';
}

function ensureRuntimeReleasePublic(tag, runtimeDirectory, runCommand) {
  return exactRuntimeAssets(runtimeDirectory).pipe(
    switchMap((assets) =>
      defer(() => of(releaseState(tag, runCommand))).pipe(
        concatMap((state) => {
          if (state === 'missing') {
            runCommand('gh', [
              'release',
              'create',
              tag,
              '--verify-tag',
              '--draft',
              '--generate-notes',
            ]);
            return of('draft');
          }
          return of(state);
        }),
        concatMap((state) => {
          if (state === 'draft') {
            return from(assets).pipe(
              tap((asset) =>
                runCommand('gh', [
                  'release',
                  'upload',
                  tag,
                  asset,
                  '--clobber',
                ]),
              ),
              toArray(),
              tap(() =>
                runCommand('gh', [
                  'release',
                  'edit',
                  tag,
                  '--verify-tag',
                  '--draft=false',
                ]),
              ),
              map(() => undefined),
            );
          }
          const temporaryPrefix = join(tmpdir(), 'capture-release-verify-');
          return defer(() => from(mkdtemp(temporaryPrefix))).pipe(
            switchMap((temporary) =>
              from(assets).pipe(
                concatMap((asset) =>
                  defer(() => {
                    runCommand('gh', [
                      'release',
                      'download',
                      tag,
                      '--pattern',
                      basename(asset),
                      '--dir',
                      temporary,
                      '--clobber',
                    ]);
                    return of(undefined);
                  }).pipe(
                    concatMap(() => assertSameFile(asset, join(temporary, basename(asset)))),
                  ),
                ),
                toArray(),
                map(() => undefined),
                catchError((error) =>
                  defer(() => from(rm(temporary, { recursive: true, force: true }))).pipe(
                    concatMap(() => throwError(() => error)),
                  ),
                ),
                concatMap(() =>
                  defer(() => from(rm(temporary, { recursive: true, force: true }))).pipe(
                    map(() => undefined),
                  ),
                ),
              ),
            ),
          );
        }),
      ).pipe(
        concatMap(() =>
          defer(() => of(releaseState(tag, runCommand))).pipe(
            concatMap((state) =>
              state === 'public'
                ? of(undefined)
                : throwError(() => new Error('Runtime release did not become public.')),
            ),
          ),
        ),
      ),
    ),
  );
}

function existingPackageIntegrity(version, runCommand) {
  const result = runCommand(
    'npm',
    [
      'view',
      `${packageName}@${version}`,
      'dist.integrity',
      '--json',
      '--registry',
      registry,
    ],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    if (/E404|404 Not Found/iu.test(result.stderr || result.stdout || ''))
      return undefined;
    throw new Error(
      `Unable to inspect package version: ${(result.stderr || '').slice(-1000)}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed !== 'string' || !parsed.startsWith('sha512-')) {
    throw new Error('Registry returned an invalid package integrity value.');
  }
  return parsed;
}

export function preflightPackagePublication(
  version,
  packagePath,
  { runCommand = run, lstatPath = lstat } = {},
) {
  return defer(() => from(lstatPath(packagePath))).pipe(
    concatMap((metadata) => {
      if (!metadata.isFile() || !packagePath.endsWith('.tgz')) {
        return throwError(() => new Error('Angular publication input must be one .tgz file.'));
      }
      return sha512Integrity(packagePath);
    }),
    concatMap((localIntegrity) =>
      defer(() => of(runCommand('npm', ['pack', '--dry-run', '--json', packagePath]))).pipe(
        map((inspection) => ({ localIntegrity, inspection: JSON.parse(inspection.stdout) })),
      ),
    ),
    concatMap(({ localIntegrity, inspection }) => {
      if (
        !Array.isArray(inspection) ||
        inspection.length !== 1 ||
        inspection[0].name !== packageName ||
        inspection[0].version !== version ||
        inspection[0].integrity !== localIntegrity
      ) {
        return throwError(
          () => new Error('Angular tarball identity/version/integrity does not match the release tag.'),
        );
      }
      return defer(() => of(existingPackageIntegrity(version, runCommand))).pipe(
        map((existingIntegrity) =>
          Object.freeze({
            version,
            packagePath,
            localIntegrity,
            decision: packagePublicationDecision(existingIntegrity, localIntegrity),
          }),
        ),
      );
    }),
  );
}

function applyPackagePublication(plan, runCommand) {
  return defer(() =>
    of(
      packagePublicationDecision(
        existingPackageIntegrity(plan.version, runCommand),
        plan.localIntegrity,
      ),
    ),
  ).pipe(
    tap((decision) => {
      if (decision === 'publish') {
        runCommand('npm', [
          'publish',
          plan.packagePath,
          '--registry',
          registry,
          '--access',
          'public',
        ]);
      }
    }),
    concatMap(() => defer(() => of(existingPackageIntegrity(plan.version, runCommand)))),
    concatMap((publishedIntegrity) => {
      if (publishedIntegrity === undefined) {
        return throwError(() => new Error('Package registry did not expose the version after publish.'));
      }
      return defer(() => of(packagePublicationDecision(publishedIntegrity, plan.localIntegrity)));
    }),
    map(() => undefined),
  );
}

export function publishRelease(
  { tag, version, runtimeDirectory, packagePath },
  { runCommand = run } = {},
) {
  return preflightPackagePublication(version, packagePath, { runCommand }).pipe(
    concatMap((packagePlan) =>
      ensureRuntimeReleasePublic(tag, runtimeDirectory, runCommand).pipe(
        concatMap(() => applyPackagePublication(packagePlan, runCommand)),
      ),
    ),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  defer(() => of(parseArguments(process.argv.slice(2))))
    .pipe(switchMap((input) => publishRelease(input)))
    .subscribe({
      error: (error) => {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      },
    });
}
