import { createHash, randomUUID } from 'node:crypto';
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
  const response = await fetch(
    `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}/events`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Capture SSE failed with HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventData: string[] = [];
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await Promise.race([
      reader.read(),
      delay(remaining).then(() => ({ done: true, value: undefined })),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/u);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      eventData = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (eventData.length === 0) continue;
      const event = JSON.parse(eventData.join('\n')) as Record<string, unknown>;
      const stage = String(event.stage ?? '');
      console.log(`[capture-runtime] sse ${String(event.eventType)}:${stage}:${String(event.progress ?? '')}`);
      if (stage === 'awaiting_structuring') {
        await reader.cancel();
        return event;
      }
      if (event.eventType === 'failed' || event.eventType === 'cancelled') {
        throw new Error(`Capture extraction failed: ${JSON.stringify(event)}`);
      }
    }
  }
  await reader.cancel();
  throw new Error(`Capture extraction timed out after ${timeoutMilliseconds} ms.`);
}

async function startStreamingCapture(
  baseUrl: string,
  pdf: Buffer,
  fileName: string,
  token: string,
): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const ingestionResponse = await fetch(`${baseUrl}/v2/ingestions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `${requestId}-ingestion`,
    },
    body: JSON.stringify({
      protocolVersion: '2',
      clientRequestId: `${requestId}-ingestion`,
      kind: 'pdf',
      mode: 'file',
      fileName,
      mediaType: 'application/pdf',
      totalBytes: pdf.byteLength,
    }),
  });
  const ingestion = (await ingestionResponse.json()) as Record<string, unknown>;
  if (!ingestionResponse.ok) throw new Error(`Ingestion open failed: ${JSON.stringify(ingestion)}`);
  const ingestionId = String(ingestion.ingestionId);
  const chunkSize = 1024 * 1024;
  for (let offset = 0, index = 0; offset < pdf.byteLength; offset += chunkSize, index += 1) {
    const chunk = pdf.subarray(offset, Math.min(offset + chunkSize, pdf.byteLength));
    const digest = createHash('sha256').update(chunk).digest('hex');
    const end = offset + chunk.byteLength - 1;
    const response = await fetch(
      `${baseUrl}/v2/ingestions/${encodeURIComponent(ingestionId)}/chunks/${index}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end}/${pdf.byteLength}`,
          Digest: `sha-256=${digest}`,
          'X-Idempotency-Key': `${requestId}-chunk-${index}`,
        },
        body: chunk,
      },
    );
    if (!response.ok) throw new Error(`Ingestion chunk ${index} failed with HTTP ${response.status}.`);
  }
  const digest = createHash('sha256').update(pdf).digest('hex');
  const finalize = await fetch(`${baseUrl}/v2/ingestions/${encodeURIComponent(ingestionId)}/finalize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `${requestId}-finalize`,
    },
    body: JSON.stringify({ protocolVersion: '2', totalBytes: pdf.byteLength, sha256: digest }),
  });
  if (!finalize.ok) throw new Error(`Ingestion finalize failed with HTTP ${finalize.status}.`);
  const captureResponse = await fetch(`${baseUrl}/v2/captures`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': requestId,
    },
    body: JSON.stringify({
      protocolVersion: '2',
      clientRequestId: requestId,
      ingestionId,
      structuringMode: 'host',
      startPolicy: 'eager',
    }),
  });
  const capture = (await captureResponse.json()) as Record<string, unknown>;
  if (!captureResponse.ok) throw new Error(`Capture start failed: ${JSON.stringify(capture)}`);
  return capture;
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

    const created = await startStreamingCapture(baseUrl, pdf, basename(pdfPath), token);
    const captureId = String(created.captureId);
    const event = await waitForExtraction(baseUrl, captureId, token);
    const raw = await getJson(
      `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}/partial`,
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
          stage: event.stage,
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
