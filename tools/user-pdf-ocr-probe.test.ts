import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readJsonObject,
  sanitizeProbeError,
  UserPdfOcrProbeError,
} from './user-pdf-ocr-probe.mts';

const SECRET = 'user-pdf-bearer-secret';

test('probe HTTP errors expose only the allowlisted status and stage', async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        code: 'private_backend_error',
        message: `Bearer ${SECRET}`,
        details: { responseBody: 'complete private response' },
      },
    }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  );

  await assert.rejects(
    readJsonObject(response, 'capture'),
    (error: unknown) => {
      assert.ok(error instanceof UserPdfOcrProbeError);
      assert.deepEqual(error.shape, {
        code: 'http',
        stage: 'capture',
        status: 502,
      });
      assert.equal(error.message, 'Capture Runtime rejected a probe request. stage=capture status=502');
      assert.doesNotMatch(error.message, new RegExp(SECRET, 'u'));
      assert.doesNotMatch(error.message, /complete private response/u);
      return true;
    },
  );
});

test('unexpected probe failures are replaced by a generic safe message', () => {
  const message = sanitizeProbeError(
    new Error(`SSE event contained Authorization: Bearer ${SECRET}`),
  );

  assert.equal(message, 'User PDF OCR probe failed.');
  assert.doesNotMatch(message, new RegExp(SECRET, 'u'));
});
