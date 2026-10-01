import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Read-only checks of local package identities; package managers own lock writes. */
export const NATIVE_RELEASE_LOCKS = [
  ['packages/capture-runtime/uv.lock', ['capture-runtime']],
  [
    'packages/capture-runtime-client-python/uv.lock',
    ['capture-runtime-client'],
  ],
  [
    'packages/capture-sidecar-launcher/Cargo.lock',
    ['capture-sidecar-launcher'],
  ],
  [
    'packages/capture-sidecar-launcher/tests/fixtures/activation-probe/Cargo.lock',
    ['capture-activation-probe'],
  ],
  [
    'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.lock',
    ['capture-runtime-deterministic-fixture'],
  ],
  [
    'apps/capture-workbench-desktop/src-tauri/Cargo.lock',
    ['capture-workbench-desktop', 'capture-sidecar-launcher'],
  ],
] as const;

export function verifyNativeLockVersions(root: string, version: string): void {
  for (const [path, names] of NATIVE_RELEASE_LOCKS) {
    const blocks = readFileSync(resolve(root, path), 'utf8')
      .split(/^\[\[package\]\][\t ]*\r?$/mu)
      .slice(1);
    for (const name of names) {
      const matches = blocks.filter((block) =>
        [...block.matchAll(/^name = "([^"]+)"\r?$/gmu)].some(
          (match) => match[1] === name,
        ),
      );
      if (matches.length !== 1)
        throw new Error(`${path}: expected one local package ${name}.`);
      const block = matches[0].split(/^\[/mu)[0];
      const versions = [...block.matchAll(/^version = "([^"]+)"\r?$/gmu)];
      const sources = [...block.matchAll(/^source = (.+)\r?$/gmu)];
      const validSource = path.endsWith('uv.lock')
        ? sources.length === 1 &&
          /^\{ editable = "\." \}\r?$/u.test(sources[0][1])
        : sources.length === 0;
      if (versions.length !== 1 || versions[0][1] !== version || !validSource) {
        throw new Error(
          `${path}: ${name} must resolve to the local release ${version}; refresh with its package manager.`,
        );
      }
    }
  }
}
