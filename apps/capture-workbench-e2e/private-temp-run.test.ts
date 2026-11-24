import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { devServerSocketDirectory } from './private-temp-run.ts';

const shortRoot = 'C:\\Users\\dev\\AppData\\Local\\Temp\\capture-test-a1B2c3';
const longRoot = `C:\\Users\\${'a-long-profile-name'.repeat(3)}\\AppData\\Local\\Temp\\capture-test-a1B2c3`;

test('by default the dev server sockets go to a directory in the private root', () => {
  assert.equal(devServerSocketDirectory(shortRoot, undefined, 'win32'), join(shortRoot, 'nx'));
});

test('a private root too long for an Nx socket stops the run and names NX_SOCKET_DIR', () => {
  assert.throws(
    () => devServerSocketDirectory(longRoot, undefined, 'win32'),
    (error: unknown) =>
      error instanceof Error && error.message.includes('Set NX_SOCKET_DIR to a short directory'),
  );
});

test('a configured NX_SOCKET_DIR is kept, also when the private root is too long', () => {
  assert.equal(devServerSocketDirectory(longRoot, 'C:\\nx-sockets', 'win32'), 'C:\\nx-sockets');
  assert.equal(devServerSocketDirectory(shortRoot, 'C:\\nx-sockets', 'win32'), 'C:\\nx-sockets');
});

test('an empty NX_SOCKET_DIR counts as not set', () => {
  assert.equal(devServerSocketDirectory(shortRoot, '', 'win32'), join(shortRoot, 'nx'));
});
