import assert from 'node:assert/strict';

export const LARGE_RECORDING_BYTES = 52 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
// The debug fake TCP test takes about 4.2 s for 52 chunks, finalization and capture.
// Allow native copying, WebView interaction, UI polling and slower installed hosts.
export const LARGE_RECORDING_TIMEOUT_MS = 180_000;
export const largeRecordingText = 'Installed large recording words';

export function largeRecordingWavHeader(bytes: number) {
  const marker = Buffer.from(`CAPTURE_TEXT:${largeRecordingText}`);
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 44 + marker.length && bytes % 4 === 0 && bytes < 2 ** 32);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(bytes - 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(192_000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes - 44, 40);
  return { header, marker };
}

interface UploadEntry {
  method: string;
  route: string;
  status: number;
  bodyBytes: number;
  ingestionKey?: string;
  chunkIndex?: number;
}
export function assertLargeRecordingRequests(entries: UploadEntry[], bytes = LARGE_RECORDING_BYTES) {
  assert.ok(entries.every((entry) => Number.isSafeInteger(entry.bodyBytes) && entry.bodyBytes >= 0 && entry.bodyBytes < bytes), 'Whole-file or unmeasured request observed.');
  const writes = entries.filter((entry) => ['POST', 'PUT'].includes(entry.method) &&
    (entry.route.startsWith('/v2/ingestions') || entry.route === '/v2/captures'));
  const count = Math.ceil(bytes / UPLOAD_CHUNK_BYTES);
  // Retries fail: the local fake runtime is deterministic.
  assert.equal(writes.length, count + 3, 'Unexpected upload request count.');
  const key = writes[0]?.ingestionKey;
  assert.match(key ?? '', /^[0-9a-f]{64}$/u);
  const expected = [
    ['POST', '/v2/ingestions'],
    ...Array.from({ length: count }, () => ['PUT', '/v2/ingestions/{ingestionId}/chunks/{chunkIndex}']),
    ['POST', '/v2/ingestions/{ingestionId}/finalize'], ['POST', '/v2/captures'],
  ];
  writes.forEach((entry, index) => {
    assert.deepEqual([entry.method, entry.route], expected[index], 'Upload requests must be ordered.');
    assert.equal(entry.ingestionKey, key, 'Upload must use one ingestion.');
    assert.ok(entry.status >= 200 && entry.status < 300, 'Upload request failed.');
    if (index > 0 && index <= count) {
      assert.equal(entry.chunkIndex, index - 1, 'Missing or out-of-order chunk.');
      assert.equal(entry.bodyBytes, Math.min(UPLOAD_CHUNK_BYTES, bytes - (index - 1) * UPLOAD_CHUNK_BYTES));
    }
  });
}
