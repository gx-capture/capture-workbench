import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRealAppDataUnchanged } from './installed-app-data-guard.ts';
import type { AppDataSnapshot } from './installed-app-data-guard.ts';

const absent: AppDataSnapshot = { directoryExists: false, libraryExists: false, index: null };
const present: AppDataSnapshot = {
  directoryExists: true, libraryExists: true, index: { mtimeNs: '123456789', bytes: '200' },
};

test('real app-data guard accepts unchanged absent and existing metadata', () => {
  assert.doesNotThrow(() => assertRealAppDataUnchanged(absent, { ...absent }));
  assert.doesNotThrow(() => assertRealAppDataUnchanged(present, { ...present, index: { ...present.index! } }));
});

test('real app-data guard fails on directory, library, index, mtime or size changes', () => {
  for (const changed of [
    absent,
    { ...absent, directoryExists: true },
    { ...present, libraryExists: false, index: null },
    { ...present, index: null },
    { ...present, index: { mtimeNs: '123456790', bytes: '200' } },
    { ...present, index: { mtimeNs: '123456789', bytes: '201' } },
  ]) {
    assert.throws(() => assertRealAppDataUnchanged(present, changed), /Real product app-data changed/u);
    assert.throws(() => assertRealAppDataUnchanged(changed, present), /Isolation failed/u);
  }
  assert.throws(() => assertRealAppDataUnchanged(absent, { ...absent, directoryExists: true }), /Isolation failed/u);
});
