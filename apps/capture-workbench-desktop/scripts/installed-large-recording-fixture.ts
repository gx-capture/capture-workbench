import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  LARGE_RECORDING_BYTES,
  LARGE_RECORDING_TIMEOUT_MS,
  largeRecordingText,
  largeRecordingWavHeader,
} from './installed-large-recording.ts';

export function generateLargeRecording(path: string, bytes = LARGE_RECORDING_BYTES) {
  const { header, marker } = largeRecordingWavHeader(bytes);
  const hash = createHash('sha256');
  function* content() {
    for (const block of [header, marker]) {
      hash.update(block);
      yield block;
    }
    const padding = Buffer.alloc(64 * 1024);
    for (let remaining = bytes - 44 - marker.length; remaining > 0;) {
      const block = padding.subarray(0, Math.min(remaining, padding.length));
      hash.update(block);
      yield block;
      remaining -= block.length;
    }
  }
  return pipeline(Readable.from(content()), createWriteStream(path, { flags: 'wx' })).then(() => ({
    sourceKind: 'audio',
    fileName: 'installed-large-recording.wav',
    mimeType: 'audio/wav',
    bytes,
    sha256: hash.digest('hex'),
    locatorKind: 'time',
    expectedSegments: 1,
    expectedTexts: [largeRecordingText],
    completionTimeoutMs: LARGE_RECORDING_TIMEOUT_MS,
  }));
}

export function readLargeRecordingRequests(path: string) {
  return readFile(path, 'utf8').then((log) =>
    log.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
  );
}
