import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPackagedWorkbenchUrl,
} from './packaged-workbench-page.ts';

test('packaged page lookup accepts every route of the packaged app and nothing else', () => {
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/'), true);
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/ocr'), true);
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/history'), true);
  assert.equal(isPackagedWorkbenchUrl('about:blank'), false);
  assert.equal(isPackagedWorkbenchUrl('http://localhost:4200/history'), false);
  assert.equal(isPackagedWorkbenchUrl('not a url'), false);
});
