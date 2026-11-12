import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Page } from '@playwright/test';
import { beginRendererBoundary, finishRendererBoundary, cancelRendererBoundary } from './installed-renderer-boundary.ts';

test('renderer boundary probes denied commands and audits the picker and the import from the network', async () => {
  const fixture = configure();
  try {
    await beginRendererBoundary(fixture.page);
    assert.equal(fixture.calls.length, 5);
    assert.deepEqual(fixture.calls.slice(0, 2).map((item) => item.args.event), ['tauri://drag-enter', 'tauri://drag-drop']);
    fixture.ipc('library_select_sources', { request: { kind: 'all' } }, { selections: [{ selectionToken: 'a'.repeat(32), fileName: 'chosen.pdf' }], rejected: [] });
    fixture.ipc('library_import_selection', { request: { selectionToken: 'a'.repeat(32) } }, { documentId: 'b'.repeat(32) });
    await finishRendererBoundary(fixture.page, 'C:\\private-fixtures');
    assert.equal(fixture.listeners(), 0);
  } finally { fixture.restore(); }
});

test('the audit does not depend on replacing the page invoke function, which the webview keeps read-only', async () => {
  const fixture = configure();
  try {
    Object.defineProperty(fixture.target.__TAURI_INTERNALS__, 'invoke', { value: fixture.original, writable: false, configurable: false });
    await beginRendererBoundary(fixture.page);
    assert.equal(fixture.target.__TAURI_INTERNALS__.invoke, fixture.original);
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    fixture.ipc('library_import_selection', {}, {});
    await finishRendererBoundary(fixture.page, 'C:\\private-fixtures');
  } finally { fixture.restore(); }
});

test('a registered legacy command rejecting a malformed input does not pass', async () => {
  const fixture = configure((command) => command === 'library_import_source' ? Promise.reject('invalid args') : undefined);
  try { await assert.rejects(beginRendererBoundary(fixture.page), /accepted a forbidden IPC/u); }
  finally { fixture.restore(); }
});

test('any accepted forbidden request fails the boundary', async () => {
  const fixture = configure((command) => command === 'plugin:event|listen' ? Promise.resolve(1) : undefined);
  try { await assert.rejects(beginRendererBoundary(fixture.page), /accepted a forbidden IPC/u); }
  finally { fixture.restore(); }
});

test('request and response directory leaks fail without including the directory in the error', async () => {
  for (const direction of ['request', 'response']) {
    const fixture = configure();
    try {
      await beginRendererBoundary(fixture.page);
      fixture.ipc(
        'library_select_sources',
        direction === 'request' ? { leaked: 'c:/private-fixtures/chosen.pdf' } : {},
        direction === 'response' ? { leaked: 'C:\\Private-Fixtures\\chosen.pdf' } : { selections: [], rejected: [] },
      );
      fixture.ipc('library_import_selection', { request: { selectionToken: 'a'.repeat(32) } }, {});
      await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), (error: Error) => {
        assert.ok(error.message.includes('exposed the fixture directory'));
        assert.ok(!error.message.includes('Private-Fixtures'));
        return true;
      });
      assert.equal(fixture.listeners(), 0);
    } finally { fixture.restore(); }
  }
});

test('requests to other hosts are not IPC, and an unreadable IPC response fails', async () => {
  const fixture = configure();
  try {
    await beginRendererBoundary(fixture.page);
    fixture.emitRequest('http://tauri.localhost/assets/C:/private-fixtures/app.js', '');
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    fixture.ipc('library_import_selection', {}, {});
    await finishRendererBoundary(fixture.page, 'C:\\private-fixtures');

    await beginRendererBoundary(fixture.page);
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    fixture.ipc('library_import_selection', {}, new Error('body gone'));
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /could not read an IPC response/u);
  } finally { fixture.restore(); }
});

test('an audit without a picker and an import fails, and cancellation always stops recording', async () => {
  const fixture = configure();
  try {
    await beginRendererBoundary(fixture.page);
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /did not observe the native picker/u);
    assert.equal(fixture.listeners(), 0);
    await beginRendererBoundary(fixture.page);
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /did not observe token import/u);
    await beginRendererBoundary(fixture.page);
    await cancelRendererBoundary(fixture.page);
    assert.equal(fixture.listeners(), 0);
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /audit was not started/u);
  } finally { fixture.restore(); }
});

function configure(override?: (command: string) => Promise<unknown> | undefined) {
  const target = globalThis as unknown as {
    __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
  };
  const previous = Object.getOwnPropertyDescriptor(target, '__TAURI_INTERNALS__');
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const original = async (command: string, args: unknown = {}) => {
    calls.push({ command, args: args as Record<string, unknown> });
    const overridden = override?.(command);
    if (overridden) return overridden;
    if (command === 'library_import_source') throw 'Command library_import_source not found';
    if (command.startsWith('plugin:')) throw 'not allowed';
    if (command === 'library_import_selection' && (args as { request?: { selectionToken?: string } }).request?.selectionToken === '0'.repeat(32)) throw 'Selected source is no longer available. Choose it again.';
    return { selections: [], rejected: [] };
  };
  Object.defineProperty(target, '__TAURI_INTERNALS__', { value: { invoke: original }, writable: true, configurable: true });
  const events = new EventEmitter();
  const page = {
    evaluate: async (operation: () => unknown) => operation(),
    on: (name: string, listener: (value: unknown) => void) => { events.on(name, listener); },
    off: (name: string, listener: (value: unknown) => void) => { events.off(name, listener); },
  } as unknown as Page;
  const emitRequest = (url: string, body: string) => {
    events.emit('request', { url: () => url, postData: () => body });
  };
  return { page, target, calls, original, emitRequest,
    // One IPC exchange as the webview's network shows it.
    ipc: (command: string, args: unknown, response: unknown) => {
      const url = `http://ipc.localhost/${encodeURIComponent(command)}`;
      emitRequest(url, JSON.stringify(args));
      events.emit('response', {
        url: () => url,
        text: () => response instanceof Error ? Promise.reject(response) : Promise.resolve(JSON.stringify(response)),
      });
    },
    listeners: () => events.listenerCount('request') + events.listenerCount('response'),
    restore: () => {
      if (previous) Object.defineProperty(target, '__TAURI_INTERNALS__', previous);
      else delete (target as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    },
  };
}
