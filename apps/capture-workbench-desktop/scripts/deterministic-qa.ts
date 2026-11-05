import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const deterministicQaProductName = 'Capture Workbench QA Fake Data';
export const deterministicQaTarget = join(appRoot, 'src-tauri', 'target', 'deterministic-qa');
export const deterministicQaStage = join(deterministicQaTarget, 'staged');
export const deterministicQaNsis = join(
  deterministicQaTarget, 'x86_64-pc-windows-msvc', 'release', 'bundle', 'nsis',
);

export const deterministicQaPaths = {
  stagedExecutable: join(deterministicQaStage, 'binaries', 'capture-runtime-x86_64-pc-windows-msvc.exe'),
  stagedManifest: join(deterministicQaStage, 'resources', 'capture-runtime-manifest.json'),
  stagedSchema: join(deterministicQaStage, 'resources', 'capture-document-v2.schema.json'),
  stageProvenance: join(deterministicQaStage, 'resources', '.runtime-stage.json'),
};
