import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defer, from, map, of, switchMap } from 'rxjs';

import {
  stageProvenance,
  stagedExecutable,
  stagedManifest,
  stagedSchema,
  validateRuntime,
} from './stage-runtime.ts';

export function assertStagedRuntime(expectedSource) {
  if (!['release', 'deterministic'].includes(expectedSource)) {
    return defer(() => {
      throw new Error('Expected stage source must be release or deterministic.');
    });
  }
  return defer(() => from(readFile(stageProvenance, 'utf8'))).pipe(
    map((contents) => JSON.parse(contents)),
    switchMap((provenance) => {
      if (provenance.source !== expectedSource) {
        throw new Error(
          `Refusing to build: staged runtime source is ${String(provenance.source)}, expected ${expectedSource}.`,
        );
      }
      return validateRuntime(stagedManifest, stagedExecutable, stagedSchema).pipe(
        map((verified) => {
          if (verified.manifest.runtimeVersion !== provenance.runtimeVersion) {
            throw new Error(
              'Runtime staging provenance version does not match its manifest.',
            );
          }
          if (verified.schemaDigest !== provenance.schemaSha256) {
            throw new Error(
              'Runtime staging provenance schema digest does not match its manifest.',
            );
          }
          if (
            (verified.manifest.runtimeRequirements?.['windowsml-ocr']?.sha256 ??
              null) !== provenance.windowsmlBundleSha256
          ) {
            throw new Error(
              'Runtime staging provenance WindowsML digest does not match its manifest.',
            );
          }
          if (
            verified.manifest.runtimeRequirements['windowsml-ocr'].bytes !==
            provenance.windowsmlBundleBytes
          ) {
            throw new Error(
              'Runtime staging provenance WindowsML byte count does not match its manifest.',
            );
          }
          return { provenance, ...verified };
        }),
      );
    }),
  );
}

function expectedSource(args) {
  if (
    args.length !== 1 ||
    !['--release', '--deterministic'].includes(args[0])
  ) {
    throw new Error('Use exactly one of --release or --deterministic.');
  }
  return args[0] === '--release' ? 'release' : 'deterministic';
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  of(expectedSource(process.argv.slice(2)))
    .pipe(
      switchMap((source) => assertStagedRuntime(source)),
    )
    .subscribe({
      next: ({ provenance }) => {
      process.stdout.write(
        `Verified ${provenance.source} staged runtime provenance.\n`,
      );
      },
      error: (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
      },
    });
}
