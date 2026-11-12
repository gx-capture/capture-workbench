import assert from 'node:assert/strict';
import type { Page, Request, Response } from '@playwright/test';

interface RendererBoundaryGlobal {
  __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
}

interface BoundaryAudit {
  readonly requests: string[];
  readonly responses: string[];
  readonly pending: Promise<void>[];
  readonly detach: () => void;
}

// Tauri serves IPC to the webview as requests to this host.
const IPC_HOST = 'ipc.localhost';
const UNREADABLE = '<unreadable>';
const audits = new WeakMap<Page, BoundaryAudit>();

function ipcCommand(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname === IPC_HOST ? decodeURIComponent(parsed.pathname.slice(1)) : null;
  } catch {
    return null;
  }
}

/**
 * Exercise denied IPC from the real packaged page, then record every IPC request
 * and response until `finishRendererBoundary`. The page's `invoke` is read-only in
 * the webview, so the record is taken from the network, not by wrapping it.
 */
export async function beginRendererBoundary(page: Page): Promise<void> {
  const refused = await page.evaluate(async () => {
    const internals = (globalThis as unknown as RendererBoundaryGlobal).__TAURI_INTERNALS__;
    const cases: [string, unknown][] = [
      ...['tauri://drag-enter', 'tauri://drag-drop'].map((event): [string, unknown] => ['plugin:event|listen', { event, target: { kind: 'Any' }, handler: 0 }]),
      ['plugin:dialog|open', { options: { multiple: true } }],
      ['library_import_source', { request: {} }],
      ['library_import_selection', { request: { selectionToken: '0'.repeat(32) } }],
    ];
    const result: boolean[] = [];
    for (const [command, args] of cases) {
      try { await internals.invoke(command, args); result.push(false); }
      catch (error) {
        result.push(command !== 'library_import_source' || String(error).includes('Command library_import_source not found'));
      }
    }
    return result;
  });
  assert.ok(refused.length === 5 && refused.every(Boolean), 'Renderer boundary accepted a forbidden IPC request.');

  stopRecording(page);
  const requests: string[] = [];
  const responses: string[] = [];
  const pending: Promise<void>[] = [];
  const onRequest = (request: Request) => {
    const command = ipcCommand(request.url());
    if (command === null) return;
    requests.push(JSON.stringify({ command, body: request.postData() ?? '' }));
  };
  const onResponse = (response: Response) => {
    if (ipcCommand(response.url()) === null) return;
    pending.push(response.text().then(
      (text) => { responses.push(text); },
      // A body that cannot be read cannot be shown to be free of paths.
      () => { responses.push(UNREADABLE); },
    ));
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  audits.set(page, {
    requests,
    responses,
    pending,
    detach: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  });
}

export async function finishRendererBoundary(page: Page, fixtureDirectory: string): Promise<void> {
  const audit = audits.get(page);
  assert.ok(audit, 'Renderer boundary audit was not started.');
  try {
    // The import's response may still be in flight when the card appears.
    await Promise.all(audit.pending);
  } finally {
    stopRecording(page);
  }
  assert.ok(!audit.responses.includes(UNREADABLE), 'Renderer boundary could not read an IPC response.');
  const forbidden = fixtureDirectory.toLowerCase().split('\\').join('/');
  const exposed = [...audit.requests, ...audit.responses].some((value) => {
    // Decode the JSON escaping before comparing separators, without persisting payloads.
    const normalized = value.toLowerCase().split('\\\\').join('/').split('\\').join('/');
    return normalized.includes(forbidden);
  });
  assert.ok(!exposed, 'Renderer boundary exposed the fixture directory over IPC.');
  const commands = new Set(audit.requests.map((value) => (JSON.parse(value) as { command: string }).command));
  assert.ok(commands.has('library_select_sources'), 'Renderer boundary did not observe the native picker.');
  assert.ok(commands.has('library_import_selection'), 'Renderer boundary did not observe token import.');
}

function stopRecording(page: Page): void {
  audits.get(page)?.detach();
  audits.delete(page);
}

/** Stop recording on a picker/card failure too. */
export async function cancelRendererBoundary(page: Page): Promise<void> {
  stopRecording(page);
}
