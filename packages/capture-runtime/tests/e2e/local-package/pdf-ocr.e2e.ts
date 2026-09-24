import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPdfOcrE2e } from '../support/pdf-ocr-journey.ts';

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);
const runtimeVersion = '0.4.2';

async function main(): Promise<void> {
  const releaseRoot = process.env.CAPTURE_PDF_OCR_E2E_RELEASE_DIR?.trim()
    ? resolve(process.env.CAPTURE_PDF_OCR_E2E_RELEASE_DIR)
    : join(workspaceRoot, 'packages/capture-runtime/dist/release');
  await runPdfOcrE2e({
    packageKind: 'local-package',
    identityMode: 'local-probe',
    releaseRoot,
    runtimeVersion,
    evidencePath: join(
      workspaceRoot,
      'tmp/capture-runtime/pdf-ocr-e2e/local-package/evidence.json',
    ),
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
