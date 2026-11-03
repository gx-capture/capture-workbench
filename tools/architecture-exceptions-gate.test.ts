import './test-temp-root.ts';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  formatException,
  parseBoundaryDisables,
  parseEslintSuppressions,
  parseIgnoreImports,
} from './architecture-exceptions-gate.ts';
import {
  checkRatchet,
  type Ratchet,
  writeRatchetBaseline,
} from './dead-code-gate.ts';

const TOML = 'packages/runtime/importlinter.toml';

test('parseIgnoreImports keys every ignore_imports entry by contract, multi-line and inline', () => {
  const toml = [
    '[tool.importlinter]',
    'root_package = "app"',
    '',
    '[[tool.importlinter.contracts]]',
    'name = "Platform does not depend on engines"',
    'type = "forbidden"',
    'source_modules = ["app.config"]',
    '# Known before the refactor.',
    'ignore_imports = [',
    '  "app.config -> app.ocr",',
    "  'app.clock -> app.ocr',",
    '  # "app.commented -> app.out",',
    ']',
    '',
    '[[tool.importlinter.contracts]]',
    'name = "Engines are independent"',
    'ignore_imports = ["app.ocr -> app.asr", "app.ocr -> app.asr"]',
    '',
    '[[tool.importlinter.contracts]]',
    'name = "No exceptions here"',
    'forbidden_modules = ["app.web"]',
  ].join('\r\n');
  assert.deepEqual(parseIgnoreImports(toml, TOML), [
    `import-linter|Engines are independent|${TOML}|app.ocr -> app.asr`,
    `import-linter|Engines are independent|${TOML}|app.ocr -> app.asr#2`,
    `import-linter|Platform does not depend on engines|${TOML}|app.clock -> app.ocr`,
    `import-linter|Platform does not depend on engines|${TOML}|app.config -> app.ocr`,
  ]);
  assert.deepEqual(parseIgnoreImports('', TOML), []);
});

test('parseBoundaryDisables keeps only directives that name an architecture rule', () => {
  const disable = 'eslint-' + 'disable';
  const output = [
    `apps/desktop/a.test.ts:1:// ${disable}-next-line @nx/enforce-module-boundaries -- shared temp root.`,
    `apps/desktop/a.test.ts:3:// ${disable}-next-line @nx/enforce-module-boundaries`,
    `libs/ui/store.ts:34:// ${disable}-next-line @softarc/sheriff/dependency-rule, no-console -- W7.`,
    `libs/ui/x.ts:9:/* ${disable} @softarc/sheriff/encapsulation */`,
    `libs/ui/y.ts:5:// ${disable}-next-line no-unsafe-finally`,
    `libs/ui/z.ts:7:const s = '${disable} @nx/enforce-module-boundaries-ish';`,
  ].join('\n');
  assert.deepEqual(parseBoundaryDisables(output), [
    'eslint|@nx/enforce-module-boundaries|apps/desktop/a.test.ts|eslint-disable',
    'eslint|@nx/enforce-module-boundaries|apps/desktop/a.test.ts|eslint-disable#2',
    'eslint|@softarc/sheriff/dependency-rule|libs/ui/store.ts|eslint-disable',
    'eslint|@softarc/sheriff/encapsulation|libs/ui/x.ts|eslint-disable',
  ]);
  assert.deepEqual(parseBoundaryDisables(''), []);
});

test('parseEslintSuppressions turns each suppressed architecture violation into a key', () => {
  const json = JSON.stringify({
    'src/a.ts': {
      '@softarc/sheriff/dependency-rule': { count: 2 },
      'no-console': { count: 5 },
    },
    'src\\b.ts': { '@nx/enforce-module-boundaries': { count: 1 } },
  });
  assert.deepEqual(
    parseEslintSuppressions(json, 'packages/ui/eslint-suppressions.json'),
    [
      'eslint-suppressions|@nx/enforce-module-boundaries|packages/ui/src/b.ts|suppressed',
      'eslint-suppressions|@softarc/sheriff/dependency-rule|packages/ui/src/a.ts|suppressed',
      'eslint-suppressions|@softarc/sheriff/dependency-rule|packages/ui/src/a.ts|suppressed#2',
    ],
  );
});

test('formatException names the file, the rule and, for import-linter, the import', () => {
  assert.equal(
    formatException(
      `import-linter|Engines are independent|${TOML}|app.ocr -> app.asr`,
    ),
    `  - [ignore_imports] ${TOML} :: app.ocr -> app.asr (Engines are independent)`,
  );
  assert.equal(
    formatException(
      'eslint|@softarc/sheriff/encapsulation|libs/ui/x.ts|eslint-disable#2',
    ),
    '  - [eslint-disable] libs/ui/x.ts :: @softarc/sheriff/encapsulation',
  );
});

function fakeRatchet(keys: { current: string[] }): Ratchet {
  return {
    label: 'architecture-exceptions',
    noun: 'exception',
    baseline: 'baseline.json',
    script: 'tools/architecture-exceptions-gate.ts',
    collect: () => keys.current,
    formatKey: (key) => `  - ${key}`,
    fixHint: ['Fix: follow the rule.'],
  };
}

function captureConsole<T>(run: () => T): { result: T; stderr: string } {
  const original = console.error;
  const originalLog = console.log;
  let stderr = '';
  console.error = (text: string) => void (stderr += `${text}\n`);
  console.log = () => undefined;
  try {
    return { result: run(), stderr };
  } finally {
    console.error = original;
    console.log = originalLog;
  }
}

test('the ratchet fails on a new exception and, with --ci, on a vanished one until --update', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'architecture-exceptions-'));
  const keys = {
    current: ['import-linter|C|f|a -> b', 'eslint|r|x.ts|eslint-disable'],
  };
  const ratchet = fakeRatchet(keys);
  captureConsole(() => writeRatchetBaseline(repoRoot, ratchet));
  assert.deepEqual(
    JSON.parse(readFileSync(join(repoRoot, 'baseline.json'), 'utf8')),
    ['import-linter|C|f|a -> b', 'eslint|r|x.ts|eslint-disable'],
  );
  assert.equal(
    captureConsole(() => checkRatchet(repoRoot, ratchet, true)).result,
    0,
  );

  keys.current = [...keys.current, 'import-linter|C|f|a -> c'];
  const added = captureConsole(() => checkRatchet(repoRoot, ratchet, false));
  assert.equal(added.result, 1);
  assert.match(
    added.stderr,
    /1 new exception\(s\)[\s\S]*a -> c[\s\S]*Fix: follow the rule\./u,
  );

  keys.current = ['import-linter|C|f|a -> b'];
  assert.equal(
    captureConsole(() => checkRatchet(repoRoot, ratchet, false)).result,
    0,
  );
  const stale = captureConsole(() => checkRatchet(repoRoot, ratchet, true));
  assert.equal(stale.result, 1);
  assert.match(
    stale.stderr,
    /node tools\/architecture-exceptions-gate\.ts --update/u,
  );

  captureConsole(() => writeRatchetBaseline(repoRoot, ratchet));
  assert.equal(
    captureConsole(() => checkRatchet(repoRoot, ratchet, true)).result,
    0,
  );
});

test('a missing baseline treats every exception as new', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'architecture-exceptions-'));
  const ratchet = fakeRatchet({ current: ['eslint|r|x.ts|eslint-disable'] });
  assert.equal(
    captureConsole(() => checkRatchet(repoRoot, ratchet, false)).result,
    1,
  );
});
