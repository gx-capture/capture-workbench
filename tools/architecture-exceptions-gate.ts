/**
 * Architecture exception ratchet. The boundary rules (import-linter in
 * packages/capture-runtime/importlinter.toml, Sheriff and
 * `@nx/enforce-module-boundaries` in ESLint) each have an escape hatch, and
 * DDD decision D5 lets the known exceptions only shrink. This gate freezes
 * them in `tools/quality/architecture-exceptions-baseline.json` with the
 * dead-code gate's semantics: a new exception fails; with `--ci` a baseline
 * entry that no longer occurs fails too, fixed by `--update`.
 *
 * Exceptions:
 * - `import-linter`: each `ignore_imports` entry, per contract.
 * - `eslint`: each inline `eslint-disable*` directive that names an
 *   architecture rule.
 * - `eslint-suppressions`: each suppressed occurrence of an architecture rule
 *   in an ESLint bulk-suppressions file (`eslint --suppress-rule`).
 *
 * The cross-context private-name imports have their own two-way ratchet in
 * packages/capture-runtime/tests/unit/test_architecture_private_imports.py.
 *
 * Usage (from the repo root):
 *   node tools/architecture-exceptions-gate.ts            # check
 *   node tools/architecture-exceptions-gate.ts --ci       # check; a stale baseline fails too
 *   node tools/architecture-exceptions-gate.ts --update   # rewrite the baseline
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkRatchet,
  numbered,
  type Ratchet,
  writeRatchetBaseline,
} from './dead-code-gate.ts';

const IMPORT_LINTER_CONFIGS = ['packages/capture-runtime/importlinter.toml'];

/** ESLint rules that enforce architecture boundaries. */
const ARCHITECTURE_RULE =
  /^(?:@nx\/enforce-module-boundaries|@softarc\/sheriff\/.+)$/;

const SOURCE_PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.mts',
  '*.cts',
  '*.js',
  '*.mjs',
  '*.cjs',
];

/** This gate and its test name the directives in their own text. */
const SELF_PATHSPEC = ':(exclude)tools/architecture-exceptions-gate*';

const QUOTED = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

/**
 * Reads every `ignore_imports` entry of an import-linter TOML config as
 * `import-linter|<contract name>|<file>|<import>`. A line parser is enough
 * for the config we write (one key per line, arrays one string per line or
 * inline) and avoids a TOML dependency.
 */
export function parseIgnoreImports(toml: string, file: string): string[] {
  const keys: string[] = [];
  let contract = '';
  let inIgnore = false;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inIgnore = false;
      if (line.startsWith('[[')) contract = '';
      continue;
    }
    let values = line;
    if (!inIgnore) {
      const name = /^name\s*=\s*(.*)$/.exec(line);
      if (name) {
        contract = quotedStrings(name[1])[0] ?? contract;
        continue;
      }
      const ignore = /^ignore_imports\s*=\s*\[(.*)$/.exec(line);
      if (!ignore) continue;
      inIgnore = true;
      values = ignore[1];
    }
    const close = values.indexOf(']');
    for (const entry of quotedStrings(
      close === -1 ? values : values.slice(0, close),
    )) {
      keys.push(`import-linter|${contract}|${file}|${entry}`);
    }
    if (close !== -1) inIgnore = false;
  }
  return numbered(keys).sort();
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((match) => match[1] ?? match[2]);
}

const DISABLE_DIRECTIVE =
  /eslint-disable(?:-next-line|-line)?\s+(?<rules>.*?)\s*(?:--|\*\/|$)/;

/**
 * Parses `git grep -n` output of `eslint-disable*` lines into one
 * `eslint|<rule>|<file>|eslint-disable` key per architecture rule a
 * directive names. Line numbers are dropped so edits that only shift lines
 * are not new; a second directive in the same file gets an ordinal.
 */
export function parseBoundaryDisables(gitGrepOutput: string): string[] {
  const keys: string[] = [];
  for (const line of gitGrepOutput.split(/\r?\n/)) {
    const match = /^(?<file>[^:]+):\d+:(?<text>.*)$/.exec(line);
    if (!match?.groups) continue;
    const rules = DISABLE_DIRECTIVE.exec(match.groups.text)?.groups?.rules;
    for (const rule of (rules ?? '').split(',').map((part) => part.trim())) {
      if (ARCHITECTURE_RULE.test(rule)) {
        keys.push(`eslint|${rule}|${match.groups.file}|eslint-disable`);
      }
    }
  }
  return numbered(keys).sort();
}

/**
 * Reads an ESLint bulk-suppressions file (`{ file: { rule: { count } } }`,
 * paths relative to the suppressions file) into one
 * `eslint-suppressions|<rule>|<file>|suppressed` key per suppressed
 * occurrence of an architecture rule, so a raised count is a new key.
 */
export function parseEslintSuppressions(
  json: string,
  suppressionsFile: string,
): string[] {
  const directory = posix.dirname(suppressionsFile);
  const suppressions = JSON.parse(json) as Record<
    string,
    Record<string, { count?: number }>
  >;
  const keys: string[] = [];
  for (const [file, rules] of Object.entries(suppressions)) {
    const path = posix.normalize(
      posix.join(directory, file.replace(/\\/g, '/')),
    );
    for (const [rule, { count = 0 }] of Object.entries(rules)) {
      if (!ARCHITECTURE_RULE.test(rule)) continue;
      for (let index = 0; index < count; index += 1) {
        keys.push(`eslint-suppressions|${rule}|${path}|suppressed`);
      }
    }
  }
  return numbered(keys).sort();
}

const KIND_LABEL: Record<string, string> = {
  'import-linter': 'ignore_imports',
  eslint: 'eslint-disable',
  'eslint-suppressions': 'eslint bulk suppression',
};

export function formatException(key: string): string {
  const [kind, rule, file, name] = key.split('|');
  const what = kind === 'import-linter' ? `${name} (${rule})` : rule;
  return `  - [${KIND_LABEL[kind] ?? kind}] ${file} :: ${what}`;
}

function gitLines(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  // git grep exits 1 when nothing matches.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git ${args[0]} failed with status ${result.status}:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function collect(repoRoot: string): string[] {
  const importLinter = IMPORT_LINTER_CONFIGS.flatMap((file) =>
    parseIgnoreImports(readFileSync(join(repoRoot, file), 'utf8'), file),
  );
  // --untracked so a directive in a new, not yet added file counts too.
  const disables = parseBoundaryDisables(
    gitLines(repoRoot, [
      'grep',
      '-n',
      '--untracked',
      '-E',
      'eslint-disable.*(@nx/enforce-module-boundaries|@softarc/sheriff/)',
      '--',
      ...SOURCE_PATHSPECS,
      SELF_PATHSPEC,
    ]),
  );
  const suppressions = gitLines(repoRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '*eslint-suppressions.json',
  ])
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((file) =>
      parseEslintSuppressions(readFileSync(join(repoRoot, file), 'utf8'), file),
    );
  return [...importLinter, ...disables, ...suppressions].sort();
}

export const ARCHITECTURE_EXCEPTIONS: Ratchet = {
  label: 'architecture-exceptions',
  noun: 'exception',
  baseline: 'tools/quality/architecture-exceptions-baseline.json',
  script: 'tools/architecture-exceptions-gate.ts',
  collect,
  formatKey: formatException,
  fixHint: [
    'Fix: make the import follow the rule (move the code to the context or',
    'module that owns it, or depend on its public API). Never add a new',
    'exception to the baseline; a rule that is wrong changes in its config',
    '(importlinter.toml, sheriff.config.ts, eslint depConstraints) with a',
    'decision record.',
  ],
};

export function main(argv: string[]): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (argv.includes('--update')) {
    return writeRatchetBaseline(repoRoot, ARCHITECTURE_EXCEPTIONS);
  }
  return checkRatchet(repoRoot, ARCHITECTURE_EXCEPTIONS, argv.includes('--ci'));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
