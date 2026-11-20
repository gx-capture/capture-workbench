import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  PROGRESSIVE_AUDIO_ENV,
  PROGRESSIVE_AUDIO_ORACLE_ENV,
  progressiveAudioPaths,
  requirePrivateDirectory,
} from './real-engines-inputs.ts';

test('progressive recording and oracle are either both absent or both non-empty', () => {
  assert.equal(progressiveAudioPaths({}), undefined);
  assert.deepEqual(progressiveAudioPaths({
    [PROGRESSIVE_AUDIO_ENV]: ' synthetic.wav ',
    [PROGRESSIVE_AUDIO_ORACLE_ENV]: ' synthetic.json ',
  }), { audioPath: 'synthetic.wav', oraclePath: 'synthetic.json' });
  for (const env of [
    { [PROGRESSIVE_AUDIO_ENV]: 'synthetic.wav' },
    { [PROGRESSIVE_AUDIO_ORACLE_ENV]: 'synthetic.json' },
    { [PROGRESSIVE_AUDIO_ENV]: '', [PROGRESSIVE_AUDIO_ORACLE_ENV]: 'synthetic.json' },
    { [PROGRESSIVE_AUDIO_ENV]: ' ' },
  ]) {
    assert.throws(() => progressiveAudioPaths(env),
      new RegExp(`${PROGRESSIVE_AUDIO_ENV} and ${PROGRESSIVE_AUDIO_ORACLE_ENV}`, 'u'));
  }
});

test('private directory validation refuses workspace paths before they are created', () => {
  const workspace = realpathSync.native(resolve(import.meta.dirname, '../../..'));
  for (const path of [workspace, join(workspace, 'apps'), join(workspace, 'synthetic-missing', 'child')]) {
    assert.throws(() => requirePrivateDirectory(path, workspace, 'Engine cache'),
      /Engine cache must be outside the workspace/u);
  }
  assert.throws(() => requirePrivateDirectory('relative', workspace, 'Temp'), /must be an absolute/u);
  const parent = dirname(workspace);
  const sibling = join(parent, 'synthetic-private-smoke');
  assert.equal(requirePrivateDirectory(sibling, workspace, 'App data'), sibling);
});
