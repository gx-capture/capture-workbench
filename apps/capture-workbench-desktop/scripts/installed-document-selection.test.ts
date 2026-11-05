import assert from 'node:assert/strict';
import test from 'node:test';
import { newDocumentId } from './installed-document-selection.ts';

test('selects the new matching document independently of card order and stale failures', () => {
  assert.equal(newDocumentId(['stale-failed', 'other'], ['new-capture', 'stale-failed']), 'new-capture');
  assert.equal(newDocumentId(['stale-failed'], ['stale-failed', 'new-capture']), 'new-capture');
  assert.equal(newDocumentId(['stale-failed'], ['stale-failed']), undefined);
  assert.equal(newDocumentId([], []), undefined);
  assert.equal(newDocumentId([], ['', 'new-capture', 'new-capture']), 'new-capture');
});

test('refuses an ambiguous import instead of selecting an arbitrary card', () => {
  assert.throws(() => newDocumentId(['old'], ['new-one', 'old', 'new-two']), /multiple new/u);
});
