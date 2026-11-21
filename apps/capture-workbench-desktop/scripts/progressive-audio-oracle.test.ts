import assert from 'node:assert/strict';
import test from 'node:test';

import { captureEvents, readLiveCheckpoint, recordingIngestionMetadata, speechWorkerFileNames } from './progressive-audio-oracle.ts';

function delivery(fileName: string, parts?: readonly string[]) {
  return {
    artifacts: [
      {
        fileName,
        ...(parts
          ? { parts: parts.map((name) => ({ fileName: name })) }
          : { url: `https://example.test/${fileName}` }),
      },
    ],
    modelFiles: {},
    unavailableReason: null,
  };
}

const cudaZip = 'capture-engine-speech-recognition-1.0.0-windows-x64.zip';
const cpuZip = 'capture-engine-speech-recognition-cpu-1.0.0-windows-x64.zip';

function catalog(speech: Record<string, unknown>) {
  return {
    requirements: [
      { requirementId: 'text-recognition', ...delivery('capture-engine-ocr.zip') },
      { requirementId: 'speech-recognition', ...speech },
    ],
  };
}

test('the oracle mirror serves the parts of the cuda speech content only', () => {
  const names = speechWorkerFileNames(
    catalog({
      contents: [
        { id: 'cuda', ...delivery(cudaZip, [`${cudaZip}.001`, `${cudaZip}.002`]) },
        { id: 'cpu', ...delivery(cpuZip) },
      ],
    }),
    'cuda',
  );

  assert.deepEqual(names, [`${cudaZip}.001`, `${cudaZip}.002`]);
});

test('the oracle mirror serves a single cuda archive', () => {
  assert.deepEqual(
    speechWorkerFileNames(
      catalog({ contents: [{ id: 'cpu', ...delivery(cpuZip) }, { id: 'cuda', ...delivery(cudaZip) }] }),
      'cuda',
    ),
    [cudaZip],
  );
});

test('the oracle mirror refuses a catalog without a cuda speech worker or with an unsafe name', () => {
  assert.throws(
    () => speechWorkerFileNames(catalog({ contents: [{ id: 'cpu', ...delivery(cpuZip) }] }), 'cuda'),
    /no cuda speech worker/u,
  );
  assert.throws(
    () => speechWorkerFileNames({ requirements: [] }, 'cuda'),
    /no speech recognition requirement/u,
  );
  assert.throws(
    () => speechWorkerFileNames(catalog({ contents: [{ id: 'cuda', ...delivery('../worker.zip') }] }), 'cuda'),
    /unsafe speech worker file/u,
  );
});

test('the oracle mirror selects the cpu worker for a cpu pack', () => {
  assert.deepEqual(speechWorkerFileNames(catalog({
    contents: [{ id: 'cuda', ...delivery(cudaZip) }, { id: 'cpu', ...delivery(cpuZip) }],
  }), 'cpu'), [cpuZip]);
});

test('the oracle reads a split checkpoint frame while the SSE response stays open', { timeout: 1_000 }, async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': heartbeat\r\n\r\nid: 1\r\nevent: checkpoint\r\nda'));
      controller.enqueue(encoder.encode('ta: {"eventType":"checkpoint","partialRevision":3}\r\n\r\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const events = captureEvents(new Response(stream));
  assert.deepEqual(await events.next(), {
    done: false, value: { eventType: 'checkpoint', partialRevision: 3 },
  });
  await events.return(undefined);
  assert.equal(cancelled, true);
});

test('oracle ingestion uses the recording basename and runtime audio type', () => {
  assert.deepEqual(recordingIngestionMetadata('fixtures/synthetic.M4A', Buffer.from('0000ftyp0000')), {
    fileName: 'synthetic.M4A', mediaType: 'audio/mp4',
  });
  assert.deepEqual(recordingIngestionMetadata('fixtures/synthetic.wav', Buffer.from('fLaC')), {
    fileName: 'synthetic.wav', mediaType: 'audio/flac',
  });
  assert.throws(() => recordingIngestionMetadata('fixtures/synthetic.pdf', Buffer.from('%PDF-')),
    /unsupported recording signature/u);
});

const checkpointEvent = {
  eventType: 'checkpoint', coveredUntilMs: 310_000, partialRevision: 3, durationMs: 600_000,
};
const snapshot = { captureId: 'synthetic-id', revision: 3, coveredUntilMs: 310_000 };

function checkpointOptions(...events: object[]) {
  return {
    response: Promise.resolve(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))),
    signal: new AbortController().signal,
    captureId: snapshot.captureId,
    readPartial: async () => snapshot,
    readCapture: async () => ({ status: 'extracting' }),
  };
}

test('oracle reads the matching revision while extraction is active', async () => {
  assert.deepEqual(await readLiveCheckpoint(checkpointOptions({ eventType: 'progress' }, checkpointEvent)), {
    snapshot, durationMs: checkpointEvent.durationMs,
  });
});

test('oracle rejects extraction finishing or failing before the checkpoint', async () => {
  await assert.rejects(readLiveCheckpoint(checkpointOptions({
    eventType: 'checkpoint', stage: 'awaiting_structuring',
  })), /finished before a live five-minute checkpoint/u);
  await assert.rejects(readLiveCheckpoint(checkpointOptions({
    eventType: 'failed', error: { code: 'synthetic_failure' },
  })), /extraction failed: code=synthetic_failure/u);
  await assert.rejects(readLiveCheckpoint(checkpointOptions({ eventType: 'cancelled' })),
    /extraction stopped \(cancelled\): code=unknown/u);
});

test('oracle reports a capture that failed or was cancelled at the checkpoint read, not a missed revision', async () => {
  for (const [status, pattern] of [
    ['failed', /extraction failed: code=synthetic_failure/u],
    ['cancelled', /extraction stopped \(cancelled\): code=synthetic_failure/u],
  ] as const) {
    for (const readPartial of [
      async () => ({ ...snapshot, revision: 4 }),
      async () => { throw new Error('synthetic partial unavailable'); },
    ]) {
      const rejection = readLiveCheckpoint({
        ...checkpointOptions(checkpointEvent),
        readPartial,
        readCapture: async () => ({ status, error: { code: 'synthetic_failure' } }),
      });
      await assert.rejects(rejection, pattern);
      await assert.rejects(rejection, (error: Error) => !/missed/u.test(error.message));
    }
  }
});

test('oracle reports a missed revision if the snapshot advanced or extraction finished', async () => {
  await assert.rejects(readLiveCheckpoint({
    ...checkpointOptions(checkpointEvent),
    readPartial: async () => ({ ...snapshot, revision: 4 }),
  }), /missed the live checkpoint revision: the partial is at revision 4/u);
  await assert.rejects(readLiveCheckpoint({
    ...checkpointOptions(checkpointEvent),
    readCapture: async () => ({ status: 'awaiting_structuring' }),
  }), /missed the live checkpoint revision: the capture moved on to awaiting_structuring/u);
  await assert.rejects(readLiveCheckpoint({
    ...checkpointOptions(checkpointEvent),
    readPartial: async () => { throw new Error('synthetic partial unavailable'); },
    readCapture: async () => ({ status: 'completed' }),
  }), /missed the live checkpoint revision: the capture moved on to completed/u);
});

test('oracle checks the capture id separately from the revision', async () => {
  await assert.rejects(readLiveCheckpoint({
    ...checkpointOptions(checkpointEvent),
    readPartial: async () => ({ ...snapshot, captureId: 'another-capture' }),
  }), /partial belongs to another capture/u);
});

test('oracle passes on a partial read error while extraction is still active', async () => {
  await assert.rejects(readLiveCheckpoint({
    ...checkpointOptions(checkpointEvent),
    readPartial: async () => { throw new Error('synthetic partial unavailable'); },
  }), /^Error: synthetic partial unavailable$/u);
});

test('oracle enforces its deadline even when the stream stays open', { timeout: 1000 }, async () => {
  const deadline = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    pull() { deadline.abort(); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readLiveCheckpoint({
    ...checkpointOptions(),
    response: Promise.resolve(new Response(stream)),
    signal: deadline.signal,
  }), /live checkpoint deadline expired/u);
  assert.equal(cancelled, true);
});
