import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { node24CorepackCandidates } from './node24-corepack.ts';

test('Node 24 Corepack resolver covers bin-local and Unix global layouts', () => {
  assert.deepEqual(
    node24CorepackCandidates('/opt/hostedtoolcache/node/24.11.1/x64/bin/node'),
    [
      join(
        '/opt/hostedtoolcache/node/24.11.1/x64/bin',
        'node_modules',
        'corepack',
        'dist',
        'corepack.js',
      ),
      join(
        '/opt/hostedtoolcache/node/24.11.1/x64/lib',
        'node_modules',
        'corepack',
        'dist',
        'corepack.js',
      ),
    ],
  );
});
