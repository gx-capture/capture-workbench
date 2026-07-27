import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeExecutable = join(
  repoRoot,
  'packages/capture-runtime/dist/executable/capture-runtime.exe',
);
const modelBundleRoot = join(
  repoRoot,
  'packages/capture-runtime/dist/windowsml',
);
const configuredModelDir = process.env.CAPTURE_USER_MODEL_DIR
  ? resolve(process.env.CAPTURE_USER_MODEL_DIR)
  : undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function startRuntime(
  root: string,
  modelDir: string,
  dataDir: string,
  port: number,
  token: string,
): ChildProcess {
  return spawn(
    runtimeExecutable,
    ['serve', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CAPTURE_HOST: '127.0.0.1',
        CAPTURE_PORT: String(port),
        CAPTURE_API_TOKEN: token,
        CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        CAPTURE_ALLOWED_ORIGINS: '',
        CAPTURE_ENABLE_API_DOCS: 'false',
        CAPTURE_APP_DATA_DIR: dataDir,
        CAPTURE_EXTRACTION_PROVIDER: 'runtime',
        CAPTURE_STRUCTURING_PROVIDER: 'host',
        CAPTURE_WINDOWSML_MODEL_DIR: modelDir,
      },
    },
  );
}

function stopRuntime(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 10_000,
  });
}

async function waitForReady(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/health/ready`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // The packaged sidecar is still starting.
    }
    await delay(250);
  }
  throw new Error('Capture Runtime did not become ready.');
}

async function getJson(
  url: string,
  token: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  return body;
}

async function waitForExtraction(
  baseUrl: string,
  captureId: string,
  token: string,
  timeoutMilliseconds = 300_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastState = '';
  let job = await getJson(
    `${baseUrl}/v1/captures/${encodeURIComponent(captureId)}`,
    token,
  );

  while (Date.now() < deadline) {
    const state = `${String(job.status)}:${String(job.stage)}:${String(job.progress)}`;
    if (state !== lastState) {
      console.log(`[capture-runtime] poll ${state}`);
      lastState = state;
    }
    if (job.stage === 'awaiting_structuring') return job;
    if (job.stage === 'failed' || job.stage === 'cancelled') {
      throw new Error(`Capture extraction failed: ${JSON.stringify(job)}`);
    }
    await delay(500);
    job = await getJson(
      `${baseUrl}/v1/captures/${encodeURIComponent(captureId)}`,
      token,
    );
  }

  throw new Error(
    `Capture extraction timed out after ${timeoutMilliseconds} ms: ${JSON.stringify(job)}`,
  );
}

async function main(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This probe requires Windows x64.');
  }
  const configuredPdfPath = process.env.CAPTURE_USER_PDF;
  if (!configuredPdfPath) {
    throw new Error(
      'Set CAPTURE_USER_PDF to the PDF path before running this probe.',
    );
  }
  const pdfPath = resolve(configuredPdfPath);
  await stat(runtimeExecutable);
  const pdf = await readFile(pdfPath);
  if (pdf.byteLength === 0) throw new Error(`PDF is empty: ${pdfPath}`);
  if (!configuredModelDir) {
    const bundles = (await readdir(modelBundleRoot)).filter((name) =>
      name.endsWith('.zip'),
    );
    if (bundles.length !== 1)
      throw new Error(`Expected one model bundle under ${modelBundleRoot}.`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'capture-user-pdf-ocr-'));
  const modelDir = configuredModelDir ?? join(temporaryRoot, 'models');
  const dataDir = join(temporaryRoot, 'runtime-data');
  let runtime: ChildProcess | undefined;
  try {
    if (!configuredModelDir) {
      await mkdir(join(modelDir, 'det'), { recursive: true });
      await mkdir(join(modelDir, 'rec'), { recursive: true });
      const bundle = (await readdir(modelBundleRoot)).find((name) =>
        name.endsWith('.zip'),
      );
      if (!bundle)
        throw new Error(`Expected one model bundle under ${modelBundleRoot}.`);
      const extraction = spawnSync(
        'tar',
        ['-xf', join(modelBundleRoot, bundle), '-C', modelDir],
        { windowsHide: true, encoding: 'utf8' },
      );
      if (extraction.status !== 0) {
        throw new Error(
          `Model bundle extraction failed: ${extraction.error?.message ?? extraction.stderr ?? `status ${extraction.status}`}`,
        );
      }
    }

    const port = 49173;
    const token = `capture-user-pdf-${randomUUID()}`;
    const baseUrl = `http://127.0.0.1:${port}`;
    runtime = startRuntime(temporaryRoot, modelDir, dataDir, port, token);
    await waitForReady(baseUrl, token);

    const form = new FormData();
    form.append(
      'file',
      new Blob([pdf], { type: 'application/pdf' }),
      basename(pdfPath),
    );
    form.append('sourceKind', 'pdf');
    form.append('structuringMode', 'host');
    const createResponse = await fetch(`${baseUrl}/v1/captures`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Idempotency-Key': randomUUID(),
      },
      body: form,
    });
    const created = (await createResponse.json()) as Record<string, unknown>;
    if (!createResponse.ok)
      throw new Error(`Capture upload failed: ${JSON.stringify(created)}`);
    const captureId = String(created.captureId);
    const job = await waitForExtraction(baseUrl, captureId, token);
    const raw = await getJson(
      `${baseUrl}/v1/captures/${encodeURIComponent(captureId)}/raw`,
      token,
    );
    const segments = Array.isArray(raw.segments) ? raw.segments : [];
    const sourceText = String(raw.sourceText ?? '');
    console.log(
      JSON.stringify(
        {
          pdf: pdfPath,
          bytes: pdf.byteLength,
          captureId,
          stage: job.stage,
          extractionEngine: raw.extractionEngine,
          segments: segments.length,
          textCharacters: sourceText.length,
          textPreview: sourceText.slice(0, 500),
        },
        null,
        2,
      ),
    );
  } finally {
    stopRuntime(runtime);
    const relativeRoot = temporaryRoot
      .replace(resolve(tmpdir()), '')
      .replace(/^[/\\]+/u, '');
    if (
      !relativeRoot ||
      relativeRoot === '..' ||
      relativeRoot.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `Refusing to remove unexpected temporary path: ${temporaryRoot}`,
      );
    }
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
