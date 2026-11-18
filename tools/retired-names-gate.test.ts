import './test-temp-root.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { collectRetiredNames, parseRetiredNames, runRetiredNamesGate } from './retired-names-gate.ts';

function entry(name: string, match = 'word') {
  return { name, match, replacement: 'CurrentLabel', allowed: [] };
}

test('matches words and literal substrings with the requested case sensitivity', () => {
  const entries = parseRetiredNames(JSON.stringify([
    entry('OldLabel'),
    entry('old.marker', 'substring'),
    entry('oldEngine', 'substring-ignore-case'),
  ]));
  const file = 'example.txt';
  const source = 'OldLabel NewOldLabel OldLabelExtra OldLabel_ oldlabel éOldLabel (OldLabel) prefixOld. Marker oldXmarker prefixold.markerSuffix prefixOLDENGINESuffix';
  assert.deepEqual(collectRetiredNames([file], entries, () => source), [
    JSON.stringify(['OldLabel', file]),
    JSON.stringify(['OldLabel', file]) + '#2',
    JSON.stringify(['old.marker', file]),
    JSON.stringify(['oldEngine', file]),
  ]);
});

test('matches paths and contents, skips allowed globs, and reads each candidate once', () => {
  const entries = parseRetiredNames(JSON.stringify([
    { ...entry('OldLabel'), allowed: [{ glob: 'history/**/*.md', reason: 'Records the original decision' }] },
    entry('OtherLabel'),
  ]));
  const file = 'docs/architecture/OldLabel.md';
  const reads: string[] = [];
  const keys = collectRetiredNames([file, file, 'history/OldLabel.md', 'history/nested/OldLabel.md'], entries, (path) => {
    reads.push(path);
    return 'OldLabel OtherLabel';
  });
  assert.deepEqual(reads, [file, 'history/OldLabel.md', 'history/nested/OldLabel.md']);
  assert.deepEqual(keys, [
    JSON.stringify(['OldLabel', file]),
    JSON.stringify(['OldLabel', file]) + '#2',
    JSON.stringify(['OtherLabel', file]),
    JSON.stringify(['OtherLabel', 'history/OldLabel.md']),
    JSON.stringify(['OtherLabel', 'history/nested/OldLabel.md']),
  ]);
});

test('rejects malformed entries with the name in the error', () => {
  for (const invalid of [
    entry('OldLabel', 'regex'),
    { ...entry('OldLabel'), replacement: '' },
    { ...entry('OldLabel'), allowed: [{ glob: '*.md', reason: '' }] },
  ]) {
    assert.throws(() => parseRetiredNames(JSON.stringify([invalid])), /entry "OldLabel"/u);
  }
});

test('numbered findings ratchet and only CI fails on a vanished occurrence', () => {
  const root = mkdtempSync(join(tmpdir(), 'retired-names-'));
  const baseline = 'tools/quality/retired-names-baseline.json';
  const file = 'tools/quality/other-baseline.json';
  const put = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  put('tools/quality/retired-names.json', JSON.stringify([entry('OldLabel')]));
  put(file, 'OldLabel');
  put('CHANGELOG.md', 'OldLabel');
  put('package/uv.lock', 'OldLabel');
  put('OldLabel.bin', Buffer.from('OldLabel\0'));
  const files = [file, 'CHANGELOG.md', 'package/uv.lock', 'OldLabel.bin', 'deleted.txt'];
  const stderr: string[] = [];
  const error = console.error;
  const log = console.log;
  console.error = (message: string) => { stderr.push(message); };
  console.log = () => undefined;
  const run = (...args: string[]): number => runRetiredNamesGate(root, args, files);
  try {
    assert.equal(run('--update'), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, baseline), 'utf8')), [JSON.stringify(['OldLabel', file])]);
    assert.equal(run('--ci'), 0);
    put(file, '\nOldLabel\n');
    assert.equal(run('--ci'), 0);
    put(file, 'OldLabel OldLabel');
    assert.equal(run(), 1);
    assert.match(stderr.at(-1) ?? '', /1 new finding[\s\S]*other-baseline\.json.*OldLabel.*CurrentLabel/u);
    put(file, 'CurrentLabel');
    assert.equal(run(), 0);
    assert.equal(run('--ci'), 1);
    assert.equal(run('--update'), 0);
    assert.equal(run('--ci'), 0);
  } finally {
    console.error = error;
    console.log = log;
  }
});
