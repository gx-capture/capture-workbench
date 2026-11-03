import './test-temp-root.ts';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  formatException,
  parseArchUnitIgnores,
  parseBoundaryDisables,
  parseDependencyCruiserBaseline,
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

test('parseIgnoreImports reads only the import-linter tables of a pyproject.toml', () => {
  const pyproject = [
    '[project]',
    'name = "backend"',
    'dependencies = [',
    '  "fastapi>=0.124.0,<1.0.0",',
    ']',
    '',
    '[tool.importlinter]',
    'root_package = "app"',
    '',
    '[[tool.importlinter.contracts]]',
    'name = "Contexts are independent"',
    'type = "independence"',
    'modules = ["app.a", "app.b"]',
    'ignore_imports = [',
    '  "app.a.api -> app.b.api",',
    ']',
    '',
    '[tool.ruff]',
    'line-length = 100',
  ].join('\n');
  assert.deepEqual(parseIgnoreImports(pyproject, TOML), [
    `import-linter|Contexts are independent|${TOML}|app.a.api -> app.b.api`,
  ]);
  // Every table header resets the contract name, not only `[[...]]`.
  assert.deepEqual(
    parseIgnoreImports(
      '[project]\nname = "x"\n[tool.importlinter.contract]\nignore_imports = ["a -> b"]\n',
      TOML,
    ),
    [`import-linter||${TOML}|a -> b`],
  );
});

test('parseBoundaryDisables keeps eslint and oxlint directives that name an architecture rule', () => {
  const disable = 'eslint-' + 'disable';
  const oxlint = 'oxlint-' + 'disable';
  const output = [
    `apps/desktop/a.test.ts:1:// ${disable}-next-line @nx/enforce-module-boundaries -- shared temp root.`,
    `apps/desktop/a.test.ts:3:// ${disable}-next-line @nx/enforce-module-boundaries`,
    `libs/ui/store.ts:34:// ${disable}-next-line @softarc/sheriff/dependency-rule, no-console -- W7.`,
    `libs/ui/x.ts:9:/* ${disable} @softarc/sheriff/encapsulation */`,
    `libs/ui/y.ts:5:// ${disable}-next-line no-unsafe-finally`,
    `libs/ui/z.ts:7:const s = '${disable} @nx/enforce-module-boundaries-ish';`,
    `libs/web/store.ts:12:// ${oxlint}-next-line no-console, @nx/enforce-module-boundaries -- R3g.`,
    `libs/web/x.ts:9:/* ${oxlint} @nx/enforce-module-boundaries */`,
  ].join('\n');
  assert.deepEqual(parseBoundaryDisables(output), [
    'eslint|@nx/enforce-module-boundaries|apps/desktop/a.test.ts|eslint-disable',
    'eslint|@nx/enforce-module-boundaries|apps/desktop/a.test.ts|eslint-disable#2',
    'eslint|@softarc/sheriff/dependency-rule|libs/ui/store.ts|eslint-disable',
    'eslint|@softarc/sheriff/encapsulation|libs/ui/x.ts|eslint-disable',
    'oxlint|@nx/enforce-module-boundaries|libs/web/store.ts|oxlint-disable',
    'oxlint|@nx/enforce-module-boundaries|libs/web/x.ts|oxlint-disable',
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

const ARCH_TEST =
  'engine/src/test/java/com/example/SampleArchitectureTest.java';

test('parseArchUnitIgnores keys each ignoreDependency by rule and class pair, skipping comments', () => {
  const source = [
    'package com.example;',
    '',
    'class SampleArchitectureTest {',
    '  @ArchTest',
    '  static final ArchRule layers_follow_direction =',
    '      layeredArchitecture()',
    '          // Still returned by the controller. .ignoreDependency(Old.class, Gone.class)',
    '          .ignoreDependency(OrderController.class, Order.class)',
    '          .ignoreDependency(OrderController.class, Order.Line.class)',
    '          /* .ignoreDependency(Commented.class, Out.class) */',
    '          .ignoreDependency(OrderController.class, Order.class);',
    '',
    '  @ArchTest',
    '  static void reads_through_public_apis(JavaClasses classes) {',
    '    rule()',
    '        .ignoreDependency(',
    '            "com.example.orders.Generator$Context",',
    '            Ledger.class.getName())',
    '        .ignoreDependency(name("a, b"), equivalentTo(X.class))',
    '        .check(classes);',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(parseArchUnitIgnores(source, ARCH_TEST), [
    `archunit|layers_follow_direction|${ARCH_TEST}|OrderController -> Order`,
    `archunit|layers_follow_direction|${ARCH_TEST}|OrderController -> Order#2`,
    `archunit|layers_follow_direction|${ARCH_TEST}|OrderController -> Order.Line`,
    `archunit|reads_through_public_apis|${ARCH_TEST}|com.example.orders.Generator$Context -> Ledger`,
    `archunit|reads_through_public_apis|${ARCH_TEST}|name("a,b") -> equivalentTo(X.class)`,
  ]);
  assert.deepEqual(parseArchUnitIgnores('class Empty {}', ARCH_TEST), []);
});

test('parseDependencyCruiserBaseline resolves paths against the baseline file', () => {
  const violation = {
    type: 'dependency',
    from: 'src/app/features/orders/list.ts',
    to: 'src/app/features/billing/state/billing.store.ts',
    rule: { severity: 'error', name: 'feature-only-through-public-entry' },
  };
  const json = JSON.stringify([
    violation,
    { ...violation, from: 'src\\app\\features\\orders\\list.ts' },
  ]);
  const key =
    'dependency-cruiser|feature-only-through-public-entry|apps/web/src/app/features/orders/list.ts|apps/web/src/app/features/billing/state/billing.store.ts';
  assert.deepEqual(
    parseDependencyCruiserBaseline(
      json,
      'apps/web/.dependency-cruiser-known-violations.json',
    ),
    [key, `${key}#2`],
  );
  assert.deepEqual(parseDependencyCruiserBaseline('[]', 'a/b.json'), []);
});

test('formatException names the file, the rule and what the exception allows', () => {
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
  assert.equal(
    formatException(
      'oxlint|@nx/enforce-module-boundaries|libs/web/x.ts|oxlint-disable#2',
    ),
    '  - [oxlint-disable] libs/web/x.ts :: @nx/enforce-module-boundaries',
  );
  assert.equal(
    formatException(
      `archunit|layers_follow_direction|${ARCH_TEST}|OrderController -> Order#2`,
    ),
    `  - [ArchUnit ignoreDependency] ${ARCH_TEST} :: OrderController -> Order#2 (layers_follow_direction)`,
  );
  assert.equal(
    formatException(
      'dependency-cruiser|feature-only-through-public-entry|apps/web/a.ts|apps/web/b.ts',
    ),
    '  - [dependency-cruiser known violation] apps/web/a.ts :: -> apps/web/b.ts (feature-only-through-public-entry)',
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
