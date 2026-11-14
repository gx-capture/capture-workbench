import '../../../tools/test-temp-root.ts';
import { generateLargeRecording } from './installed-large-recording-fixture.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertLargeRecordingRequests, UPLOAD_CHUNK_BYTES, LARGE_RECORDING_BYTES } from './installed-large-recording.ts';

test('streamed PCM WAV contains a valid header, exact size and deterministic data marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'large-wav-'));
  try {
    const file = join(directory, 'small.wav');
    const fixture = await generateLargeRecording(file, 1024);
    const bytes = await readFile(file);
    assert.equal(bytes.length, 1024);
    assert.equal(fixture.bytes, bytes.length);
    assert.equal(fixture.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
    assert.equal(bytes.toString('ascii', 8, 16), 'WAVEfmt ');
    assert.equal(bytes.readUInt32LE(16), 16);
    assert.equal(bytes.readUInt16LE(20), 1);
    assert.equal(bytes.readUInt16LE(22), 2);
    assert.equal(bytes.readUInt32LE(24), 48000);
    assert.equal(bytes.readUInt32LE(28), 192000);
    assert.equal(bytes.readUInt16LE(32), 4);
    assert.equal(bytes.readUInt16LE(34), 16);
    assert.equal(bytes.toString('ascii', 36, 40), 'data');
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
    const marker = Buffer.from(`CAPTURE_TEXT:${fixture.expectedTexts[0]}`);
    assert.deepEqual(bytes.subarray(44, 44 + marker.length), marker);
    assert.ok(bytes.subarray(44 + marker.length).every((byte) => byte === 0));
    assert.ok(LARGE_RECORDING_BYTES > 50 * 1024 * 1024);
    assert.ok((LARGE_RECORDING_BYTES - 44) / 192000 < 90 * 60);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function requests() {
  const ingestionKey = 'a'.repeat(64);
  const entry = (method: string, route: string, bodyBytes = 100, chunkIndex?: number) =>
    ({ method, route, status: 200, bodyBytes, ingestionKey, chunkIndex });
  return [entry('POST', '/v2/ingestions'),
    ...Array.from({ length: 52 }, (_, n) => entry('PUT', '/v2/ingestions/{ingestionId}/chunks/{chunkIndex}', UPLOAD_CHUNK_BYTES, n)),
    entry('POST', '/v2/ingestions/{ingestionId}/finalize'), entry('POST', '/v2/captures')];
}
test('request log accepts only a complete ordered bounded upload for one ingestion', () => {
  assert.doesNotThrow(() => assertLargeRecordingRequests(requests()));
  const partial = requests();
  partial.splice(3, 50);
  partial[2].bodyBytes = 4;
  assert.doesNotThrow(() => assertLargeRecordingRequests(partial, UPLOAD_CHUNK_BYTES + 4));
  for (const mutate of [
    (rows) => rows.splice(3, 1),
    (rows) => { [rows[1], rows[2]] = [rows[2], rows[1]]; },
    (rows) => rows.splice(-2, 1),
    (rows) => { rows[1].bodyBytes = LARGE_RECORDING_BYTES; },
    (rows) => { rows[1].ingestionKey = 'b'.repeat(64); },
    (rows) => { rows[1].status = 413; },
    (rows) => { rows[1].bodyBytes -= 1; },
  ]) {
    const rows = requests(); mutate(rows);
    assert.throws(() => assertLargeRecordingRequests(rows));
  }
});

test('status polls and deletes may fail while the ordered writes succeed', () => {
  const rows = requests();
  rows.splice(2, 0, { method: 'GET', route: '/v2/captures/{captureId}/partial', status: 409, bodyBytes: 0, ingestionKey: undefined, chunkIndex: undefined });
  rows.push({ method: 'DELETE', route: '/v2/captures/{captureId}', status: 404, bodyBytes: 0, ingestionKey: undefined, chunkIndex: undefined });
  assert.doesNotThrow(() => assertLargeRecordingRequests(rows));
  rows[2].bodyBytes = LARGE_RECORDING_BYTES;
  assert.throws(() => assertLargeRecordingRequests(rows), /Whole-file/u);
});

test('a retried chunk or non-successful write fails the deterministic upload', () => {
  const retried = requests();
  retried.splice(2, 0, { ...retried[1] });
  assert.throws(() => assertLargeRecordingRequests(retried), /request count/u);
  for (const index of [0, 1, 53, 54]) {
    const rows = requests();
    rows[index].status = 409;
    assert.throws(() => assertLargeRecordingRequests(rows), /Upload request failed/u);
  }
});
