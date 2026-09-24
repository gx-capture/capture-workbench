import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPdfOcrE2e } from '../support/pdf-ocr-journey.ts';

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);
const allowedDownloadHosts = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export type OnlinePackageOptions = {
  readonly runtimeVersion: string;
  readonly expectedRuntimeSha256: string;
  readonly baseUrl: string;
};

export function parseOnlinePackageOptions(
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): OnlinePackageOptions {
  const runtimeVersion =
    sourceEnvironment.CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_VERSION?.trim();
  const expectedRuntimeSha256 =
    sourceEnvironment.CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_SHA256?.trim();
  if (!runtimeVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(runtimeVersion)) {
    throw new Error(
      'CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_VERSION must identify the intended published semver.',
    );
  }
  if (!expectedRuntimeSha256 || !/^[a-f0-9]{64}$/u.test(expectedRuntimeSha256)) {
    throw new Error(
      'CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_SHA256 must pin the intended published executable.',
    );
  }
  const raw =
    sourceEnvironment.CAPTURE_PDF_OCR_E2E_ONLINE_RELEASE_BASE_URL?.trim() ??
    `https://github.com/gx-capture/capture-workbench/releases/download/v${runtimeVersion}`;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !==
      `/gx-capture/capture-workbench/releases/download/v${runtimeVersion}`
  ) {
    throw new Error(
      'Online-package PDF OCR E2E release base must be the exact official HTTPS GitHub release URL.',
    );
  }
  return {
    runtimeVersion,
    expectedRuntimeSha256,
    baseUrl: parsed.href.replace(/\/$/u, ''),
  };
}

function assertSafeAssetName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error('Online runtime manifest contains an unsafe asset name.');
  }
}

async function downloadAsset(
  baseUrl: string,
  name: string,
  destination: string,
): Promise<void> {
  assertSafeAssetName(name);
  const response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const finalUrl = new URL(response.url);
  if (
    !response.ok ||
    !response.body ||
    finalUrl.protocol !== 'https:' ||
    !allowedDownloadHosts.has(finalUrl.hostname)
  ) {
    throw new Error(
      `Official online runtime asset download failed for ${name} (${response.status}).`,
    );
  }
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()), {
    flag: 'wx',
  });
}

function assertTemporaryRoot(root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  const relativeRoot = relative(resolvedTemp, resolvedRoot);
  if (
    !relativeRoot ||
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${sep}`) ||
    resolve(resolvedTemp, relativeRoot) !== resolvedRoot
  ) {
    throw new Error(`Refusing to remove unexpected temporary path: ${root}`);
  }
}

async function main(): Promise<void> {
  const options = parseOnlinePackageOptions();
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'capture-runtime-online-pdf-ocr-e2e-'),
  );
  const releaseRoot = join(temporaryRoot, 'release');
  await mkdir(releaseRoot);
  try {
    const manifestName = 'capture-runtime-manifest.json';
    await downloadAsset(
      options.baseUrl,
      manifestName,
      join(releaseRoot, manifestName),
    );
    const manifest = JSON.parse(
      await readFile(join(releaseRoot, manifestName), 'utf8'),
    ) as {
      readonly fileName?: unknown;
      readonly schemaFileName?: unknown;
      readonly sha256?: unknown;
    };
    assertSafeAssetName(manifest.fileName);
    assertSafeAssetName(manifest.schemaFileName);
    if (manifest.sha256 !== options.expectedRuntimeSha256) {
      throw new Error(
        'Online runtime manifest does not match CAPTURE_PDF_OCR_E2E_ONLINE_RUNTIME_SHA256.',
      );
    }
    for (const name of [
      manifest.fileName,
      `${manifest.fileName}.sha256`,
      manifest.schemaFileName,
    ]) {
      await downloadAsset(options.baseUrl, name, join(releaseRoot, name));
    }
    await runPdfOcrE2e({
      packageKind: 'online-package',
      identityMode: 'release',
      releaseRoot,
      runtimeVersion: options.runtimeVersion,
      evidencePath: join(
        workspaceRoot,
        'tmp/capture-runtime/pdf-ocr-e2e/online-package/evidence.json',
      ),
    });
  } finally {
    assertTemporaryRoot(temporaryRoot);
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
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
