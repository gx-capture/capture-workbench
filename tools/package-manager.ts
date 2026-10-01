import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function packageManagerPolicy(manifest: {
  packageManager?: unknown;
  engines?: { node?: unknown; pnpm?: unknown };
}): { packageManager: string; engines: { node: string; pnpm: string } } {
  const version =
    typeof manifest.packageManager === 'string'
      ? /^pnpm@(12\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(
          manifest.packageManager,
        )?.[1]
      : undefined;
  if (
    !version ||
    manifest.engines?.pnpm !== version ||
    typeof manifest.engines.node !== 'string'
  ) {
    throw new Error(
      'Workspace packageManager must pin exact pnpm 12 and match engines.pnpm.',
    );
  }
  return {
    packageManager: `pnpm@${version}`,
    engines: { node: manifest.engines.node, pnpm: version },
  };
}

/** The checkout owns tooling versions; isolated consumers copy only these fields. */
export function readPackageManagerPolicy(root: string) {
  return packageManagerPolicy(
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
  );
}
