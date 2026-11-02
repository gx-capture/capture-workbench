import assert from 'node:assert/strict';
import test from 'node:test';

import { exactKeys, requireFullSha, requireSha256 } from './evidence-values.ts';

test('exactKeys accepts the same keys in any order', () => {
  assert.doesNotThrow(() => exactKeys({ b: 1, a: 2 }, ['a', 'b'], 'Record'));
});

test('exactKeys rejects missing, extra and different keys', () => {
  const message = 'Record fields are not canonical.';
  assert.throws(() => exactKeys({ a: 1 }, ['a', 'b'], 'Record'), { message });
  assert.throws(() => exactKeys({ a: 1, b: 2 }, ['a'], 'Record'), { message });
  assert.throws(() => exactKeys({ a: 1, c: 2 }, ['a', 'b'], 'Record'), {
    message,
  });
});

test('requireSha256 returns lowercase 64-hex digests and rejects the rest', () => {
  const digest = 'a1'.repeat(32);
  assert.equal(requireSha256(digest, 'Digest'), digest);
  for (const bad of [
    digest.toUpperCase(),
    digest.slice(1),
    `${digest}0`,
    5,
    null,
  ]) {
    assert.throws(() => requireSha256(bad, 'Digest'), {
      message: 'Digest must be a lowercase SHA-256 digest.',
    });
  }
});

test('requireFullSha returns lowercase 40-hex SHAs and rejects the rest', () => {
  const sha = 'b2'.repeat(20);
  assert.equal(requireFullSha(sha, 'Commit'), sha);
  for (const bad of [
    sha.toUpperCase(),
    sha.slice(1),
    `${sha}0`,
    5,
    undefined,
  ]) {
    assert.throws(() => requireFullSha(bad, 'Commit'), {
      message: 'Commit must be a full lowercase Git SHA.',
    });
  }
});
