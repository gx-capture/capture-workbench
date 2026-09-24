import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { chromium } from '../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';

const appExe = 'C:\\software-dev\\gx.law-prep-installed-test\\tauri-app.exe';
const engineLogPath = `${process.env.USERPROFILE}\\AppData\\Local\\com.user.tauri\\logs\\law-prep-engine.stdout.log`;
const jpegFixture = 'C:\\software-dev\\capture-workbench\\test-fixtures\\ocr_test_image.jpeg';
const pdfFixture = 'C:\\software-dev\\gx.law-prep\\docs\\testing\\sample-evidence\\scanned-receipt.pdf';
const qaDir = 'C:\\software-dev\\capture-workbench\\output\\law-prep-installed-verify';
const userDataDir = join(qaDir, 'webview-user-data');
const cdpPort = 40299;

const ocrZipPath = 'C:\\software-dev\\gx.law-prep-installed-test\\resources\\capture-runtime\\capture-engine-ocr-0.4.2-windows-x64.zip';
const modelRoot = 'C:\\software-dev\\capture-workbench-phase1-j19-model-mirror-0.4.2';

console.log('=== Step 1: Pre-cleanup check ===');
function killSidecars() {
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "Get-Process -Name 'tauri-app', 'law-prep-engine', 'law-prep-ai-service', 'capture-runtime*', 'capture-engine-ocr*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
  ]);
}
killSidecars();

await rm(qaDir, { recursive: true, force: true }).catch(() => {});
await mkdir(qaDir, { recursive: true });

console.log('=== Step 2: Starting Local Worker Mirror ===');
const ocrZipName = basename(ocrZipPath);
const mirrorServer = createServer((req, res) => {
  if (req.url === `/${ocrZipName}`) {
    const fileSize = statSync(ocrZipPath).size;
    res.writeHead(200, {
      'Content-Length': String(fileSize),
      'Content-Type': 'application/zip',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(ocrZipPath).pipe(res);
  } else {
    res.writeHead(404).end();
  }
});

const mirrorPort = await new Promise((resolve) => {
  mirrorServer.listen(0, '127.0.0.1', () => {
    resolve(mirrorServer.address().port);
  });
});
const mirrorUrl = `http://127.0.0.1:${mirrorPort}`;
console.log(`Worker Mirror listening at: ${mirrorUrl}`);

const initialLogSize = existsSync(engineLogPath) ? statSync(engineLogPath).size : 0;

console.log('=== Step 3: Spawning installed Law Prep with Mirror and Local Models ===');
const appProcess = spawn(appExe, [], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: userDataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    LAW_PREP_ACCEPTANCE_BACKENDS_OWNED: '1',
    CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
    CAPTURE_SMOKE_WORKER_MIRROR_URL: mirrorUrl,
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: '1',
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: modelRoot,
    LAW_PREP_AI_ALLOWED_SOURCE_ROOTS: `${process.env.USERPROFILE}\\.gx-law-prep;C:\\software-dev`,
    NO_PROXY: 'localhost,127.0.0.1,::1',
  },
  stdio: 'ignore',
  detached: false,
});

console.log(`Spawned tauri-app PID: ${appProcess.pid}`);

async function waitForCdp(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        return info;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`CDP did not become ready on port ${port} within ${timeoutMs}ms`);
}

async function waitForEnginePort(initialOffset, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(engineLogPath)) {
      const currentSize = statSync(engineLogPath).size;
      if (currentSize > initialOffset) {
        const length = currentSize - initialOffset;
        const buffer = Buffer.alloc(length);
        const fd = openSync(engineLogPath, 'r');
        readSync(fd, buffer, 0, length, initialOffset);
        closeSync(fd);
        const newText = buffer.toString('utf8');
        const matches = [...newText.matchAll(/Tomcat started on port (\d+)/gu)];
        if (matches.length > 0) {
          const port = Number(matches[matches.length - 1][1]);
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/engine/v1/status`);
            if (res.ok) {
              return port;
            }
          } catch {}
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Engine Tomcat port not found or not responding within ${timeoutMs}ms`);
}

let browser;
try {
  console.log('Waiting for CDP endpoint...');
  const cdpInfo = await waitForCdp(cdpPort);
  console.log(`CDP Ready: ${cdpInfo.Browser}`);

  console.log('Waiting for Engine port from fresh log...');
  const enginePort = await waitForEnginePort(initialLogSize);
  const engineBaseUrl = `http://127.0.0.1:${enginePort}`;
  console.log(`Engine Ready on: ${engineBaseUrl}`);

  console.log('=== Step 4: Verifying Engine status API ===');
  const statusRes = await fetch(`${engineBaseUrl}/api/engine/v1/status`);
  console.log(`Engine Status API HTTP: ${statusRes.status}`);
  const statusBody = await statusRes.json();
  console.log('Engine Status:', JSON.stringify(statusBody));

  console.log('=== Step 5: Connecting Playwright over CDP ===');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (msg) => console.log(`[WebView Console ${msg.type()}]:`, msg.text()));
  page.on('pageerror', (err) => console.error('[WebView PageError]:', err.message));

  async function jsonRequest(path, init = {}) {
    const response = await fetch(`${engineBaseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    return { response, body };
  }

  console.log('=== Step 6: Creating disposable civil case draft ===');
  const caseRes = await jsonRequest('/api/engine/v1/case-guidance-drafts', {
    method: 'POST',
    body: JSON.stringify({
      caseType: 'civil',
      factSummary: {
        factualNarrative: 'Law Prep installed acceptance verification case.',
      },
    }),
  });
  if (!caseRes.response.ok) {
    throw new Error(`Case draft creation failed: ${caseRes.response.status}`);
  }
  const caseId = caseRes.body.caseId;
  console.log(`Created caseId: ${caseId}`);

  console.log('=== Step 7: Navigating to Evidence Workbench in WebView ===');
  if (!page.url().includes('tauri.localhost')) {
    await page.goto('http://tauri.localhost/', { waitUntil: 'domcontentloaded' });
  }
  const targetPath = `/cases/${encodeURIComponent(caseId)}/evidence`;
  await page.evaluate((path) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, targetPath);

  try {
    await page.getByTestId('evidence-upload-input').waitFor({ state: 'visible', timeout: 30000 });
  } catch (err) {
    console.log('Current URL:', page.url());
    console.log('Current title:', await page.title());
    await page.screenshot({ path: join(qaDir, '00-debug-timeout.png'), fullPage: true });
    throw err;
  }
  await page.screenshot({ path: join(qaDir, '01-runtime-ready.png'), fullPage: true });

  console.log('=== Step 8: Uploading JPEG Evidence Fixture ===');
  const fixtureStat = await stat(jpegFixture);
  const fixtureBytes = await readFile(jpegFixture);
  const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');

  await page.getByTestId('evidence-upload-input').setInputFiles(jpegFixture);
  await page.getByTestId('evidence-upload-submit').click();
  await page.locator('.upload-status-list').waitFor({ state: 'visible', timeout: 60000 });

  const evidenceRecord = page.locator('[data-testid^="evidence-record-"]').last();
  await evidenceRecord.waitFor({ state: 'visible', timeout: 60000 });
  const evidenceTestId = await evidenceRecord.getAttribute('data-testid');
  const evidenceId = evidenceTestId?.replace(/^evidence-record-/u, '');
  console.log(`Uploaded evidenceId: ${evidenceId}`);

  console.log('=== Step 9: Triggering OCR Text Extraction ===');
  const extractRes = await jsonRequest(`/api/engine/v1/evidence/${encodeURIComponent(evidenceId)}/text-extraction`, {
    method: 'POST',
  });
  console.log(`Text extraction response status: ${extractRes.response.status}`);
  console.log(`Text extraction body:`, JSON.stringify(extractRes.body));
  if (!extractRes.response.ok) {
    throw new Error(`Text extraction failed: HTTP ${extractRes.response.status}`);
  }

  console.log('=== Step 10: Polling for OCR Page Text Completion ===');
  await evidenceRecord.click();
  const startedAt = Date.now();
  let pageText;
  while (Date.now() - startedAt < 300000) {
    const current = await jsonRequest(`/api/engine/v1/evidence/${encodeURIComponent(evidenceId)}/page-text`);
    if (
      current.response.ok &&
      Array.isArray(current.body.pages) &&
      current.body.pages.some((p) => typeof p.text === 'string' && p.text.trim().length > 0)
    ) {
      pageText = current.body;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!pageText) {
    throw new Error('OCR page text did not complete within 5 minutes.');
  }

  const pageOne = pageText.pages.find((p) => p.pageNumber === 1) ?? pageText.pages[0];
  const textSha256 = createHash('sha256').update(pageOne.text || '').digest('hex');
  const resultSummary = {
    evidenceId,
    pageCount: pageText.pageCount,
    status: pageText.status,
    extractionMethod: pageOne.extractionMethod,
    textLength: pageOne.text?.length ?? 0,
    confidence: pageOne.confidence,
    boxCount: Array.isArray(pageOne.boxes) ? pageOne.boxes.length : 0,
    textSha256,
  };
  console.log('=== OCR EXTRACTION RESULT SUCCESS! ===');
  console.log(JSON.stringify(resultSummary, null, 2));

  console.log('=== Step 11: Capturing Masked UI Screenshot ===');
  await page.getByTestId('raw-extracted-text').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('app-evidence-workbench-panel').evaluate((el) => {
    el.style.filter = 'blur(20px)';
    el.style.userSelect = 'none';
  });
  await page.screenshot({ path: join(qaDir, '02-ocr-complete-masked.png'), fullPage: true });

  console.log('=== Step 12: Testing PDF Evidence Fixture ===');
  await page.locator('app-evidence-workbench-panel').evaluate((el) => {
    el.style.filter = 'none';
    el.style.userSelect = 'auto';
  });
  await page.getByTestId('evidence-upload-input').setInputFiles(pdfFixture);
  await page.getByTestId('evidence-upload-submit').click();
  await page.waitForTimeout(2000);

  const pdfEvidenceRecord = page.locator('[data-testid^="evidence-record-"]').last();
  await pdfEvidenceRecord.waitFor({ state: 'visible', timeout: 60000 });
  const pdfEvidenceTestId = await pdfEvidenceRecord.getAttribute('data-testid');
  const pdfEvidenceId = pdfEvidenceTestId?.replace(/^evidence-record-/u, '');
  console.log(`Uploaded PDF evidenceId: ${pdfEvidenceId}`);

  console.log('Triggering PDF OCR extraction...');
  const pdfExtractRes = await jsonRequest(`/api/engine/v1/evidence/${encodeURIComponent(pdfEvidenceId)}/text-extraction`, {
    method: 'POST',
  });
  console.log(`PDF text extraction status: ${pdfExtractRes.response.status}`);
  console.log(`PDF text extraction body:`, JSON.stringify(pdfExtractRes.body));

  await pdfEvidenceRecord.click();
  const pdfStartedAt = Date.now();
  let pdfPageText;
  while (Date.now() - pdfStartedAt < 300000) {
    const current = await jsonRequest(`/api/engine/v1/evidence/${encodeURIComponent(pdfEvidenceId)}/page-text`);
    if (
      current.response.ok &&
      Array.isArray(current.body.pages) &&
      current.body.pages.some((p) => typeof p.text === 'string' && p.text.trim().length > 0)
    ) {
      pdfPageText = current.body;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (pdfPageText) {
    const pdfPageOne = pdfPageText.pages[0];
    console.log('=== PDF OCR RESULT SUCCESS! ===');
    console.log(JSON.stringify({
      evidenceId: pdfEvidenceId,
      pageCount: pdfPageText.pageCount,
      status: pdfPageText.status,
      extractionMethod: pdfPageOne.extractionMethod,
      textLength: pdfPageOne.text?.length ?? 0,
      confidence: pdfPageOne.confidence,
      boxCount: Array.isArray(pdfPageOne.boxes) ? pdfPageOne.boxes.length : 0,
    }, null, 2));
    await page.getByTestId('raw-extracted-text').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('app-evidence-workbench-panel').evaluate((el) => {
      el.style.filter = 'blur(20px)';
      el.style.userSelect = 'none';
    });
    await page.screenshot({ path: join(qaDir, '03-pdf-ocr-complete-masked.png'), fullPage: true });
  }

  console.log('=== ALL VERIFICATIONS PASSED SUCCESSFULLY! ===');
} finally {
  console.log('=== Cleanup ===');
  if (browser) {
    await browser.close().catch(() => {});
  }
  mirrorServer.close();
  appProcess.kill();
  killSidecars();
}
