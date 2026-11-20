import '../../../tools/test-temp-root.ts';

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  PROGRESSIVE_AUDIO_ENV,
  PROGRESSIVE_AUDIO_ORACLE_ENV,
  progressiveAudioPaths,
  requirePrivateDirectory,
  requireMatchingProgressiveSpeech,
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

test('private directory validation refuses a junction into the workspace and a different-case path', {
  skip: process.platform !== 'win32',
}, () => {
  const workspace = join(tmpdir(), 'SyntheticWorkspace');
  mkdirSync(workspace);
  const junction = join(tmpdir(), 'outside-alias');
  symlinkSync(workspace, junction, 'junction');
  for (const path of [join(junction, 'missing'), join(tmpdir(), 'syntheticworkspace', 'missing')]) {
    assert.throws(() => requirePrivateDirectory(path, workspace, 'Temp'), /must be outside the workspace/u);
  }
});

test('progressive capture preflight requires matching pack, device and model', () => {
  const extraction = { device: 'cuda', model: 'synthetic-model' };
  const oracle = { speechPack: 'cuda', extraction };
  requireMatchingProgressiveSpeech(oracle, 'cuda', extraction);
  assert.throws(() => requireMatchingProgressiveSpeech(oracle, 'cpu', extraction), /cpu pack, cuda device/u);
  assert.throws(() => requireMatchingProgressiveSpeech(oracle, 'cuda', { ...extraction, device: 'cpu' }),
    /cuda pack, cpu device/u);
  assert.throws(() => requireMatchingProgressiveSpeech(oracle, 'cuda', { ...extraction, model: 'another-model' }),
    /another-model/u);
  assert.throws(() => requireMatchingProgressiveSpeech(oracle, 'cuda', undefined), /unknown device/u);
});
