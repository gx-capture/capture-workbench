import assert from 'node:assert/strict';
import test from 'node:test';

import { captureEvents, speechWorkerFileNames } from './progressive-audio-oracle.ts';

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
