import assert from 'node:assert/strict';
import test from 'node:test';

import { cudaSpeechWorkerFileNames } from './progressive-audio-oracle.ts';

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
      { requirementId: 'windowsml-ocr', ...delivery('capture-engine-ocr.zip') },
      { requirementId: 'speech-recognition', ...speech },
    ],
  };
}

test('the oracle mirror serves the parts of the cuda speech content only', () => {
  const names = cudaSpeechWorkerFileNames(
    catalog({
      contents: [
        { id: 'cuda', ...delivery(cudaZip, [`${cudaZip}.001`, `${cudaZip}.002`]) },
        { id: 'cpu', ...delivery(cpuZip) },
      ],
    }),
  );

  assert.deepEqual(names, [`${cudaZip}.001`, `${cudaZip}.002`]);
});

test('the oracle mirror serves a single cuda archive', () => {
  assert.deepEqual(
    cudaSpeechWorkerFileNames(
      catalog({ contents: [{ id: 'cpu', ...delivery(cpuZip) }, { id: 'cuda', ...delivery(cudaZip) }] }),
    ),
    [cudaZip],
  );
});

test('the oracle mirror refuses a catalog without a cuda speech worker or with an unsafe name', () => {
  assert.throws(
    () => cudaSpeechWorkerFileNames(catalog({ contents: [{ id: 'cpu', ...delivery(cpuZip) }] })),
    /no cuda speech worker/u,
  );
  assert.throws(
    () => cudaSpeechWorkerFileNames({ requirements: [] }),
    /no speech recognition requirement/u,
  );
  assert.throws(
    () => cudaSpeechWorkerFileNames(catalog({ contents: [{ id: 'cuda', ...delivery('../worker.zip') }] })),
    /unsafe speech worker file/u,
  );
});
