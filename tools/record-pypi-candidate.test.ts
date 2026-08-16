import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProjects, projectArtifacts } from './record-pypi-candidate.ts';

test('PyPI record lane can select one project without accepting the other package', () => {
  assert.deepEqual(parseProjects('capture-runtime-client'), [
    'capture-runtime-client',
  ]);
  assert.deepEqual(
    projectArtifacts(
      [
        'capture_runtime_client-0.4.1-py3-none-any.whl',
        'capture_runtime_client-0.4.1.tar.gz',
        'capture_structuring-0.4.1-py3-none-any.whl',
        'capture_structuring-0.4.1.tar.gz',
      ],
      'capture-runtime-client',
    ),
    [
      'capture_runtime_client-0.4.1-py3-none-any.whl',
      'capture_runtime_client-0.4.1.tar.gz',
    ],
  );
  assert.throws(
    () => parseProjects('capture-runtime-client,capture-runtime-client'),
    /invalid/u,
  );
});
