import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseRuntimeIdentityMode,
  type RuntimeIdentityMode,
} from './runtime-identity.ts';

export type RuntimeReleaseManifest = {
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaFileName: string;
  readonly schemaSha256: string;
};

export type RuntimeReleaseVerificationMode = RuntimeIdentityMode;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertSafeName(value: unknown, expected: string): asserts value is string {
  if (value !== expected) throw new Error(`Runtime release asset must be ${expected}.`);
}

export async function verifyRuntimeRelease(
  releaseRoot: string,
  expectedVersion: string,
  mode: unknown,
): Promise<RuntimeReleaseManifest> {
  const verificationMode = parseRuntimeIdentityMode(mode);
  const raw = JSON.parse(
    await readFile(join(releaseRoot, 'capture-runtime-manifest.json'), 'utf8'),
  ) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Runtime release manifest must be an object.');
  }
  const manifest = raw as Partial<RuntimeReleaseManifest>;
  if (
    manifest.manifestVersion !== '1' ||
    (verificationMode === 'release' && manifest.runtimeVersion !== expectedVersion) ||
    manifest.apiVersion !== '2.0' ||
    manifest.captureDocumentSchemaVersion !== '2' ||
    manifest.platform !== 'windows' ||
    manifest.arch !== 'x86_64' ||
    !Number.isSafeInteger(manifest.bytes) ||
    Number(manifest.bytes) < 1
  ) {
    throw new Error('Runtime release manifest contract is invalid.');
  }
  assertSafeName(
    manifest.fileName,
    'capture-runtime-x86_64-pc-windows-msvc.exe',
  );
  assertSafeName(manifest.schemaFileName, 'capture-document-v2.schema.json');
  assertSha256(manifest.sha256, 'Runtime executable digest');
  assertSha256(manifest.schemaSha256, 'Runtime schema digest');

  const executablePath = join(releaseRoot, manifest.fileName);
  const executableMetadata = await stat(executablePath);
  const executable = await readFile(executablePath);
  if (
    executableMetadata.size !== manifest.bytes ||
    sha256(executable) !== manifest.sha256
  ) {
    throw new Error('Runtime executable does not match its release manifest.');
  }
  const checksum = await readFile(`${executablePath}.sha256`, 'utf8');
  if (checksum.trim() !== `${manifest.sha256}  ${manifest.fileName}`) {
    throw new Error('Runtime executable checksum file is invalid.');
  }
  const schema = await readFile(join(releaseRoot, manifest.schemaFileName));
  if (sha256(schema) !== manifest.schemaSha256) {
    throw new Error('Runtime schema does not match its release manifest.');
  }
  return manifest as RuntimeReleaseManifest;
}
