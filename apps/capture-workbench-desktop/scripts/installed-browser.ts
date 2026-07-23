import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from '@playwright/test';

import { INSTALLED_FIXTURES, EXPECTED_REQUIREMENT_IDS } from './constants/installed.ts';
import { assertCaptureDocumentForFixture } from './installed-document-assertions.ts';

const expectedRequirementIds = EXPECTED_REQUIREMENT_IDS;
const fixtures = INSTALLED_FIXTURES;

export async function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Dynamic CDP port was unavailable.'));
        else resolvePort(port);
      });
    });
  });
}

export async function connectToInstalledWebView(port, appProcess) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) {
      throw new Error(
        `Installed Tauri app exited before WebView2 CDP readiness (${appProcess.exitCode}).`,
      );
    }
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `Installed WebView2 CDP endpoint was not ready: ${errorMessage(lastError)}.`,
  );
}

export async function installedPage(browser, appProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) {
      throw new Error(
        'Installed Tauri app exited before its page was available.',
      );
    }
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find(
      (candidate) => candidate.url() === 'http://tauri.localhost/',
    );
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await delay(100);
  }
  throw new Error(
    'Installed Tauri WebView did not expose an application page.',
  );
}

export async function exerciseInstalledUi(page) {
  const mode = page.locator('.client-mode');
  await mode.waitFor({ state: 'visible', timeout: 30_000 });
  const clientMode = await mode.getAttribute('data-client-mode');
  assert.equal(clientMode, 'tauri-http');
  assert.equal(
    await page.getByRole('button', { name: 'Host provider interface' }).count(),
    0,
  );
  await page
    .getByRole('button', { name: 'Isolated runtime provider' })
    .waitFor({ state: 'visible' });
  await page.getByText('Runtime is ready').waitFor({
    state: 'visible',
    timeout: 45_000,
  });

  const requirements = page
    .getByLabel('Runtime requirements')
    .getByRole('listitem');
  await waitUntil(
    async () => (await requirements.count()) === 4,
    20_000,
    'Installed runtime did not render exactly four requirements.',
  );
  const readyRequirements = page.locator(
    '.requirements .requirement-status[data-status="ready"]',
  );
  assert.equal(await readyRequirements.count(), 4);
  const requirementIds = await requirements.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-requirement-id')),
  );
  assert.deepEqual(
    [...requirementIds].sort(),
    [...expectedRequirementIds].sort(),
  );
  const displayNames = await requirements.locator('strong').allTextContents();

  const captures = [];
  const filePicker = page.getByLabel('Choose files');
  for (const fixture of fixtures) {
    await filePicker.setInputFiles({
      name: fixture.fileName,
      mimeType: fixture.mimeType,
      buffer: fixture.buffer,
    });
    const task = page
      .locator('.task-list > li')
      .filter({ hasText: fixture.fileName });
    await task.waitFor({ state: 'visible', timeout: 15_000 });
    await waitUntil(
      async () => (await task.getAttribute('data-task-status')) === 'completed',
      45_000,
      `Installed ${fixture.sourceKind} capture did not complete.`,
    );
    const preview = task.locator('pre.result-preview');
    await preview.waitFor({ state: 'visible', timeout: 15_000 });
    const document = JSON.parse((await preview.textContent()) ?? '');
    assertCaptureDocumentForFixture(document, fixture);
    captures.push({
      sourceKind: fixture.sourceKind,
      fileName: fixture.fileName,
      locatorKind: fixture.locatorKind,
      segments: fixture.expectedSegments,
      jsonReparsed: true,
      textProjection: true,
    });
  }

  return {
    clientMode,
    isolatedRuntimeMode: true,
    hostProviderButtonVisible: false,
    requirements: {
      requirementIds,
      displayNames,
      allReady: true,
    },
    captures,
  };
}
async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
