import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRealAppDataUnchanged } from './installed-app-data-guard.ts';
import type { AppDataSnapshot } from './installed-app-data-guard.ts';

const absent: AppDataSnapshot = { directoryExists: false, libraryExists: false, index: null };
const present: AppDataSnapshot = {
  directoryExists: true, libraryExists: true, index: { mtimeNs: '123456789', bytes: '200' },
};
const withoutLibrary: AppDataSnapshot = { directoryExists: true, libraryExists: false, index: null };
const emptyLibrary: AppDataSnapshot = { directoryExists: true, libraryExists: true, index: null };

test('real app-data guard accepts unchanged absent and existing metadata', () => {
  for (const use of ['isolated', 'product'] as const) {
    assert.doesNotThrow(() => assertRealAppDataUnchanged(absent, { ...absent }, use));
    assert.doesNotThrow(() => assertRealAppDataUnchanged(present, { ...present, index: { ...present.index! } }, use));
  }
});

test('an isolated app fails the guard on directory, library, index, mtime or size changes', () => {
  for (const changed of [
    absent,
    { ...absent, directoryExists: true },
    { ...present, libraryExists: false, index: null },
    { ...present, index: null },
    { ...present, index: { mtimeNs: '123456790', bytes: '200' } },
    { ...present, index: { mtimeNs: '123456789', bytes: '201' } },
  ]) {
    assert.throws(() => assertRealAppDataUnchanged(present, changed, 'isolated'), /Real product app-data changed/u);
    assert.throws(() => assertRealAppDataUnchanged(changed, present, 'isolated'), /Isolation failed/u);
  }
  assert.throws(() => assertRealAppDataUnchanged(absent, { ...absent, directoryExists: true }, 'isolated'), /Isolation failed/u);
});

test('the release app may create the product app-data and its library where there was none', () => {
  for (const [before, after] of [
    [absent, withoutLibrary],
    [absent, emptyLibrary],
    [absent, present],
    [withoutLibrary, emptyLibrary],
    [emptyLibrary, present],
  ] as const) {
    assert.doesNotThrow(() => assertRealAppDataUnchanged(before, after, 'product'));
  }
});

test('the release app fails the guard when existing app-data is removed or its library index changes', () => {
  for (const after of [
    absent,
    withoutLibrary,
    emptyLibrary,
    { ...present, index: { mtimeNs: '123456790', bytes: '200' } },
    { ...present, index: { mtimeNs: '123456789', bytes: '201' } },
  ]) {
    assert.throws(
      () => assertRealAppDataUnchanged(present, after, 'product'),
      /an existing directory, library or library index was removed or modified/u,
    );
  }
  assert.throws(() => assertRealAppDataUnchanged(emptyLibrary, withoutLibrary, 'product'), /removed or modified/u);
  assert.throws(() => assertRealAppDataUnchanged(withoutLibrary, absent, 'product'), /removed or modified/u);
});
