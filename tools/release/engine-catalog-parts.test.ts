import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogDeliveries } from './engine-catalog-parts.ts';

const artifacts = [{ fileName: 'capture-engine-speech-recognition.zip' }];
const modelFiles = { entryPoint: 'model' };

test('catalogDeliveries yields one legacy delivery', () => {
  const [delivery] = catalogDeliveries({
    requirementId: 'speech-recognition',
    artifacts,
    modelFiles,
    unavailableReason: null,
  });
  assert.equal(delivery?.requirementId, 'speech-recognition');
  assert.equal(delivery?.contentId, undefined);
  assert.equal(delivery?.artifacts, artifacts);
  assert.equal(delivery?.modelFiles, modelFiles);
  assert.equal(delivery?.unavailableReason, null);
});

test('catalogDeliveries yields a legacy delivery that only publishes artifacts', () => {
  const [delivery] = catalogDeliveries({
    requirementId: 'speech-recognition',
    artifacts,
  });
  assert.equal(delivery?.contentId, undefined);
  assert.equal(delivery?.artifacts, artifacts);
  assert.equal(delivery?.modelFiles, undefined);
});

test('catalogDeliveries yields each content in catalog order', () => {
  const cudaFiles = { entryPoint: 'model', files: ['cuda'] };
  const cpuFiles = { entryPoint: 'model', files: ['cpu'] };
  const cpuArtifacts = [{ fileName: 'capture-engine-speech-recognition-cpu.zip' }];
  const deliveries = catalogDeliveries({
    requirementId: 'speech-recognition',
    contents: [
      {
        id: 'cuda',
        artifacts,
        modelFiles: cudaFiles,
        unavailableReason: null,
      },
      {
        id: 'cpu',
        artifacts: cpuArtifacts,
        modelFiles: cpuFiles,
        unavailableReason: null,
      },
    ],
  });
  assert.deepEqual(
    deliveries.map((item) => item.contentId),
    ['cuda', 'cpu'],
  );
  assert.equal(deliveries[0]?.requirementId, 'speech-recognition');
  assert.equal(deliveries[1]?.requirementId, 'speech-recognition');
  assert.equal(deliveries[0]?.artifacts, artifacts);
  assert.equal(deliveries[0]?.modelFiles, cudaFiles);
  assert.equal(deliveries[1]?.artifacts, cpuArtifacts);
  assert.equal(deliveries[1]?.modelFiles, cpuFiles);
});

const invalidRequirements: ReadonlyArray<
  readonly [string, { readonly [key: string]: unknown }]
> = [
  [
    'both shapes',
    {
      requirementId: 'speech-recognition',
      contents: [],
      artifacts,
      modelFiles,
      unavailableReason: null,
    },
  ],
  ['empty contents', { requirementId: 'speech-recognition', contents: [] }],
  [
    'unknown content id',
    {
      requirementId: 'speech-recognition',
      contents: [{ id: 'gpu', artifacts, modelFiles, unavailableReason: null }],
    },
  ],
  [
    'repeated content id',
    {
      requirementId: 'speech-recognition',
      contents: [
        { id: 'cuda', artifacts, modelFiles, unavailableReason: null },
        { id: 'cuda', artifacts, modelFiles, unavailableReason: null },
      ],
    },
  ],
];

for (const [label, requirement] of invalidRequirements) {
  test(`catalogDeliveries rejects ${label}`, () => {
    assert.throws(() => catalogDeliveries(requirement), /invalid/u);
  });
}
