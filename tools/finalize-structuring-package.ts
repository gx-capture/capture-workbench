import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageDirectory = resolve(
  process.argv[2] ?? 'dist/packages/capture-structuring',
);
const manifestPath = join(packageDirectory, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  name: string;
  dependencies?: Record<string, string>;
};

if (manifest.name !== '@gx-capture/capture-structuring') {
  throw new Error('Refusing to finalize an unexpected Capture Structuring package.');
}

if (manifest.dependencies?.['@gx-capture/capture-runtime-client'] === 'workspace:*') {
  const runtimeClientManifest = JSON.parse(
    readFileSync(join(packageDirectory, '../capture-runtime-client/package.json'), 'utf8'),
  ) as { version: string };
  manifest.dependencies['@gx-capture/capture-runtime-client'] = runtimeClientManifest.version;
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write('Finalized Capture Structuring package dependency versions.\n');
