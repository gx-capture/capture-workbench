import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageDirectory = resolve(
  process.argv[2] ?? 'dist/packages/capture-angular',
);
const manifestPath = join(packageDirectory, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const fesmPath = './fesm2022/gx-capture-capture-workbench.mjs';
const loaderPath = './loader.mjs';
const usesPristineEntryPoint =
  manifest.module === fesmPath.slice(2) &&
  manifest.exports?.['.']?.default === fesmPath;
const usesFinalizedEntryPoint =
  manifest.module === loaderPath.slice(2) &&
  manifest.exports?.['.']?.default === loaderPath;

if (
  manifest.name !== '@gx-capture/capture-workbench' ||
  (!usesPristineEntryPoint && !usesFinalizedEntryPoint) ||
  JSON.stringify(manifest.sideEffects) !== JSON.stringify([loaderPath])
) {
  throw new Error(
    'Refusing to finalize an unexpected Capture Workbench package layout.',
  );
}

writeFileSync(
  join(packageDirectory, loaderPath.slice(2)),
  `import '@angular/compiler';\nexport * from '${fesmPath}';\n`,
  'utf8',
);
manifest.module = loaderPath.slice(2);
manifest.exports['.'].default = loaderPath;
manifest.sideEffects = [loaderPath];

if (
  manifest.dependencies?.['@gx-capture/capture-contracts'] === 'workspace:*'
) {
  const contractsManifestPath = resolve(
    packageDirectory,
    '../capture-contracts/package.json',
  );
  const contractsManifest = JSON.parse(
    readFileSync(contractsManifestPath, 'utf8'),
  );
  manifest.dependencies['@gx-capture/capture-contracts'] =
    contractsManifest.version;
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(
  'Finalized package-owned Angular compiler loader before packing.\n',
);
