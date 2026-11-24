import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL_INSTALL_TIMEOUT_MS } from './real-engines-stage-limits.ts';

test('the structuring model installation stage gets 40 minutes, well above the measured installation', () => {
  const measuredInstallationMs = 21.7 * 60_000;
  assert.equal(MODEL_INSTALL_TIMEOUT_MS, 40 * 60_000);
  assert.ok(MODEL_INSTALL_TIMEOUT_MS >= measuredInstallationMs * 1.5);
});
