import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FULL_RELEASE_MANIFEST_V2 = 'capture-release-manifest-v2.json';
const FULL_RELEASE_MANIFEST_V1 = 'capture-release-manifest-v1.json';

export type FullReleaseManifestName =
  | typeof FULL_RELEASE_MANIFEST_V1
  | typeof FULL_RELEASE_MANIFEST_V2;

export function isFullReleaseManifestName(
  name: unknown,
): name is FullReleaseManifestName {
  return name === FULL_RELEASE_MANIFEST_V1 || name === FULL_RELEASE_MANIFEST_V2;
}

export function parseFullReleaseManifest(
  bytes: Uint8Array,
  name: string,
): Record<string, unknown> {
  if (!isFullReleaseManifestName(name))
    throw new Error('Full release manifest filename is unsupported.');
  const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<
    string,
    unknown
  > | null;
  const legacy = name === FULL_RELEASE_MANIFEST_V1;
  if (
    manifest?.schemaVersion !== (legacy ? '1' : '2') ||
    !Array.isArray(legacy ? manifest.runtimeAssets : manifest.releaseAssets) ||
    Object.hasOwn(manifest, legacy ? 'releaseAssets' : 'runtimeAssets')
  ) {
    throw new Error(`${name} has an incompatible manifest schema.`);
  }
  return manifest;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const [path, tag, candidateId] = process.argv.slice(2);
  const manifest = parseFullReleaseManifest(readFileSync(path), basename(path));
  if (
    manifest.status !== 'released' ||
    manifest.releaseTag !== tag ||
    manifest.releaseVersion !== tag.slice(1) ||
    (candidateId !== undefined && manifest.candidateId !== candidateId)
  ) {
    throw new Error('Full release manifest identity does not match the request.');
  }
}
