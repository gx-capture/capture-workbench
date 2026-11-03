/**
 * Architecture exception ratchet. Each boundary rule has an escape hatch, and
 * the known exceptions may only shrink. This gate freezes them in
 * `tools/quality/architecture-exceptions-baseline.json` with the dead-code
 * gate's semantics: a new exception fails; with `--ci` a baseline entry that
 * no longer occurs fails too, fixed by `--update`.
 *
 * Exceptions:
 * - `import-linter`: each `ignore_imports` entry, per contract, of the
 *   import-linter configs listed below (an `importlinter.toml` or the
 *   `[tool.importlinter]` tables of a pyproject.toml).
 * - `eslint` / `oxlint`: each inline `eslint-disable*` or `oxlint-disable*`
 *   directive that names an architecture rule.
 * - `eslint-suppressions`: each suppressed occurrence of an architecture rule
 *   in an ESLint bulk-suppressions file (`eslint --suppress-rule`).
 * - `archunit`: each `.ignoreDependency(origin, target)` of an ArchUnit
 *   rule, per rule.
 * - `dependency-cruiser`: each known violation in the dependency-cruiser
 *   baselines listed below (`depcruise --ignore-known` skips them).
 *
 * The tool is copied, not shared, into each repo that uses it (Capture
 * Workbench, Cert Prep, LAW). The copies are identical apart from the file
 * extension, the import paths it implies, and the repo config block below.
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

// ---- Repo config -----------------------------------------------------------
// The cross-context private-name imports have their own two-way ratchet in
// packages/capture-runtime/tests/unit/test_architecture_private_imports.py.

const IMPORT_LINTER_CONFIGS = ['packages/capture-runtime/importlinter.toml'];

const DEPENDENCY_CRUISER_BASELINES: string[] = [];

// ---- Shared by every copy --------------------------------------------------

/** Lint rules that enforce architecture boundaries. */
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
 * inline) and avoids a TOML dependency. In a pyproject.toml the contracts
 * are `[[tool.importlinter.contracts]]` tables; a table header resets the
 * contract name, so `[project]`'s `name` never labels an entry.
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
      contract = '';
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
  /(?<tool>eslint|oxlint)-disable(?:-next-line|-line)?\s+(?<rules>.*?)\s*(?:--|\*\/|$)/;

/**
 * Parses `git grep -n` output of `eslint-disable*` / `oxlint-disable*` lines
 * into one `<tool>|<rule>|<file>|<tool>-disable` key per architecture rule a
 * directive names. Line numbers are dropped so edits that only shift lines
 * are not new; a second directive in the same file gets an ordinal.
 */
export function parseBoundaryDisables(gitGrepOutput: string): string[] {
  const keys: string[] = [];
  for (const line of gitGrepOutput.split(/\r?\n/)) {
    const match = /^(?<file>[^:]+):\d+:(?<text>.*)$/.exec(line);
    if (!match?.groups) continue;
    const directive = DISABLE_DIRECTIVE.exec(match.groups.text)?.groups;
    if (!directive) continue;
    for (const rule of directive.rules.split(',').map((part) => part.trim())) {
      if (ARCHITECTURE_RULE.test(rule)) {
        keys.push(
          `${directive.tool}|${rule}|${match.groups.file}|${directive.tool}-disable`,
        );
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

/** End index (exclusive) of the string or char literal starting at `start`. */
function literalEnd(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    index += source[index] === '\\' ? 2 : 1;
  }
  return index + 1;
}

/** The Java source with comments blanked out; string literals are kept. */
function stripJavaComments(source: string): string {
  let result = '';
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index);
      index = newline < 0 ? source.length : newline;
      result += ' ';
    } else if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 2;
      result += ' ';
    } else if (source[index] === '"' || source[index] === "'") {
      const end = literalEnd(source, index);
      result += source.slice(index, end);
      index = end;
    } else {
      result += source[index];
      index += 1;
    }
  }
  return result;
}

/** The text inside the parenthesis at `open` and the index of its match. */
function balancedArguments(
  code: string,
  open: number,
): { text: string; end: number } {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'") {
      index = literalEnd(code, index) - 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return { text: code.slice(open + 1, index), end: index };
    }
  }
  return { text: code.slice(open + 1), end: code.length };
}

/** Splits call arguments at top-level commas. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") index = literalEnd(text, index) - 1;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** `Foo.class`, `Foo.class.getName()` and `"a.b.Foo"` all name `Foo`'s class. */
function className(argument: string): string {
  return argument
    .replace(/\s+/gu, '')
    .replace(/\.class(?:\.getName\(\))?$/u, '')
    .replace(/^"(.*)"$/u, '$1');
}

const ARCH_RULE_DECLARATION =
  /\bstatic\s+(?:final\s+ArchRule\s+(\w+)\s*=|void\s+(\w+)\s*\()/gu;

/**
 * Reads every `.ignoreDependency(origin, target)` of an ArchUnit test as
 * `archunit|<rule>|<file>|<origin> -> <target>`, where the rule is the
 * `@ArchTest` field or method the call belongs to. Commented-out calls do
 * not count; calls with other argument shapes (predicates) keep their
 * compacted argument text.
 */
export function parseArchUnitIgnores(source: string, file: string): string[] {
  const code = stripJavaComments(source);
  const rules = [...code.matchAll(ARCH_RULE_DECLARATION)].map((match) => ({
    index: match.index,
    name: match[1] ?? match[2],
  }));
  const keys: string[] = [];
  const call = /\.\s*ignoreDependency\s*\(/gu;
  for (let match = call.exec(code); match; match = call.exec(code)) {
    const start = match.index;
    const { text, end } = balancedArguments(code, start + match[0].length - 1);
    call.lastIndex = end;
    const rule =
      rules.filter((candidate) => candidate.index < start).at(-1)?.name ?? '';
    const args = splitArguments(text).map(className);
    const what =
      args.length === 2 ? `${args[0]} -> ${args[1]}` : args.join(', ');
    keys.push(`archunit|${rule}|${file}|${what}`);
  }
  return numbered(keys).sort();
}

interface DependencyCruiserViolation {
  from: string;
  to: string;
  rule: { name: string };
}

/**
 * Reads a dependency-cruiser known-violations file (`depcruise --output-type
 * baseline`; paths relative to the file's directory) into one
 * `dependency-cruiser|<rule>|<from>|<to>` key per violation, with
 * repo-relative paths.
 */
export function parseDependencyCruiserBaseline(
  json: string,
  baselineFile: string,
): string[] {
  const directory = posix.dirname(baselineFile);
  const repoPath = (path: string): string =>
    posix.normalize(posix.join(directory, path.replace(/\\/g, '/')));
  const violations = JSON.parse(json) as DependencyCruiserViolation[];
  return numbered(
    violations.map(
      (violation) =>
        `dependency-cruiser|${violation.rule.name}|${repoPath(violation.from)}|${repoPath(violation.to)}`,
    ),
  ).sort();
}

const KIND_LABEL: Record<string, string> = {
  archunit: 'ArchUnit ignoreDependency',
  'import-linter': 'ignore_imports',
  'dependency-cruiser': 'dependency-cruiser known violation',
  eslint: 'eslint-disable',
  oxlint: 'oxlint-disable',
  'eslint-suppressions': 'eslint bulk suppression',
};

/** Kinds whose key ends in a fixed marker rather than what is allowed. */
const RULE_ONLY_KINDS = new Set(['eslint', 'oxlint', 'eslint-suppressions']);

export function formatException(key: string): string {
  const [kind, rule, file, name] = key.split('|');
  const what = RULE_ONLY_KINDS.has(kind)
    ? rule
    : kind === 'dependency-cruiser'
      ? `-> ${name} (${rule})`
      : `${name} (${rule})`;
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

function readRepoFile(repoRoot: string, file: string): string {
  return readFileSync(join(repoRoot, file), 'utf8');
}

/** Tracked and untracked (not ignored) files matching a pathspec. */
function repoFiles(repoRoot: string, args: string[]): string[] {
  return gitLines(repoRoot, args).split(/\r?\n/).filter(Boolean);
}

function collect(repoRoot: string): string[] {
  const importLinter = IMPORT_LINTER_CONFIGS.flatMap((file) =>
    parseIgnoreImports(readRepoFile(repoRoot, file), file),
  );
  const dependencyCruiser = DEPENDENCY_CRUISER_BASELINES.flatMap((file) =>
    parseDependencyCruiserBaseline(readRepoFile(repoRoot, file), file),
  );
  // --untracked / --others so an exception in a new, not yet added file
  // counts too.
  const archUnit = repoFiles(repoRoot, [
    'grep',
    '-l',
    '--untracked',
    '-F',
    'ignoreDependency',
    '--',
    '*.java',
  ]).flatMap((file) =>
    parseArchUnitIgnores(readRepoFile(repoRoot, file), file),
  );
  const disables = parseBoundaryDisables(
    gitLines(repoRoot, [
      'grep',
      '-n',
      '--untracked',
      '-E',
      '(eslint|oxlint)-disable.*(@nx/enforce-module-boundaries|@softarc/sheriff/)',
      '--',
      ...SOURCE_PATHSPECS,
      SELF_PATHSPEC,
    ]),
  );
  const suppressions = repoFiles(repoRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '*eslint-suppressions.json',
  ]).flatMap((file) =>
    parseEslintSuppressions(readRepoFile(repoRoot, file), file),
  );
  return [
    ...archUnit,
    ...importLinter,
    ...dependencyCruiser,
    ...disables,
    ...suppressions,
  ].sort();
}

export const ARCHITECTURE_EXCEPTIONS: Ratchet = {
  label: 'architecture-exceptions',
  noun: 'exception',
  baseline: 'tools/quality/architecture-exceptions-baseline.json',
  script: 'tools/architecture-exceptions-gate.ts',
  collect,
  formatKey: formatException,
  fixHint: [
    'Fix: make the dependency follow the rule (move the code to the context',
    'or module that owns it, or depend on its public API). Never add a new',
    'exception to the baseline (an ignore_imports entry, lint disable or',
    'suppression, ignoreDependency or known dependency-cruiser violation); a',
    'rule that is wrong changes in its own config with a decision record.',
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
