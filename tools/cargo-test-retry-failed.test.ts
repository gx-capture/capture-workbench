import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseFailedTests,
  passedTestCount,
} from './cargo-test-retry-failed.ts';

test('parses failed test names from the cargo failure summary', () => {
  const output = [
    'test a::ok ... ok',
    '',
    'failures:',
    '',
    '---- launcher::tests::x stdout ----',
    'panicked',
    '',
    'failures:',
    '    launcher::tests::x',
    '    launcher::tests::y',
    '',
    'test result: FAILED. 1 passed; 2 failed',
    '',
  ].join('\r\n');
  assert.deepEqual(parseFailedTests(output), [
    'launcher::tests::x',
    'launcher::tests::y',
  ]);
});

test('counts passed tests across every test binary', () => {
  const output =
    'test result: ok. 1 passed; 0 failed\ntest result: ok. 0 passed; 0 failed\n';
  assert.equal(passedTestCount(output), 1);
  assert.equal(passedTestCount('test result: ok. 0 passed; 0 failed\n'), 0);
});
