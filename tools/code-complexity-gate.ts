/** Production-code complexity ratchet. See tools/quality/code-complexity.json. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import {
  changedPaths,
  checkRatchet,
  type Ratchet,
  readHookPayload,
  writeRatchetBaseline,
} from './dead-code-gate.ts';
import {
  compareFindings,
  type ComplexityConfig,
  type Finding,
  parseComplexityConfig,
  parseEslintFindings,
  parseRuffFindings,
  productionFile,
  readRuffDiagnostics,
  sortFindings,
} from './code-complexity-findings.ts';
import {
  applyNestingProbe,
  cargoErrors,
  changesRustFindings,
  clippyFindings,
  readClippyFindings,
} from './code-complexity-rust.ts';

const POLICY = 'tools/quality/code-complexity.json';
const PYTHON_ROOT = 'packages/capture-runtime';
const RUST_CRATES = [
  'packages/capture-sidecar-launcher',
  'apps/capture-workbench-desktop/src-tauri',
];
const SCRIPT = 'tools/code-complexity-gate.ts';
const BASELINE = 'tools/quality/code-complexity-baseline.json';
const JS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

// The synchronous Linter keeps the gate free of Promises, which the workspace
// allows only at approved framework boundaries; the gate reads the files
// itself, so it needs none of the ESLint class's file handling.
function runEslint(
  root: string,
  files: string[],
  thresholds: ComplexityConfig['thresholds']['eslint'],
  readSource: (file: string) => string,
): Finding[] {
  if (!files.length) return [];
  const lineOptions = { skipBlankLines: true, skipComments: true };
  const flatConfig: Linter.Config = {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    rules: {
      'max-lines-per-function': ['warn', { ...lineOptions, max: thresholds['max-lines-per-function'], IIFEs: true }],
      complexity: ['warn', { max: thresholds.complexity, variant: 'modified' }],
      'max-params': ['warn', { max: thresholds['max-params'] }],
      'max-depth': ['warn', { max: thresholds['max-depth'] }],
      'max-lines': ['warn', { ...lineOptions, max: thresholds['max-lines'] }],
    },
  };
  const linter = new Linter({ cwd: root });
  const reports = files.map((file) => {
    const filePath = join(root, file);
    return { filePath, messages: linter.verify(readSource(file), [flatConfig], filePath) };
  });
  return parseEslintFindings(reports, root, readSource);
}

function run(
  command: string,
  args: string[],
  cwd: string,
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostics = command === 'cargo' ? cargoErrors(result.stdout) : result.stdout;
    throw new Error(`${command} ${args[0]} failed (${result.status}):\n${result.stderr}${diagnostics}`);
  }
  return result.stdout;
}

// Ruff's nesting diagnostics can point at a block, and the pylint messages
// do not include the function name. Resolve only the names with Python's AST.
const PYTHON_SYMBOLS = `
import ast, json, sys, tokenize

def symbol_at(node, line, names=()):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        names = (*names, node.name)
    for child in ast.iter_child_nodes(node):
        if not hasattr(child, "lineno"):
            candidate = symbol_at(child, line, names)
            if candidate != names:
                return candidate
        elif child.lineno <= line <= child.end_lineno:
            return symbol_at(child, line, names)
    return names

trees = {}
symbols = []
for file, line in json.load(sys.stdin):
    if file not in trees:
        with tokenize.open(file) as source:
            trees[file] = ast.parse(source.read(), filename=file)
    symbols.append(".".join(symbol_at(trees[file], line)) or "<module>")
print(json.dumps(symbols))
`;

function runRuff(root: string, files: string[], config: ComplexityConfig): Finding[] {
  if (!files.length) return [];
  const cwd = join(root, PYTHON_ROOT);
  const uv = ['run', '--locked', '--python', '3.13'];
  const thresholds = config.thresholds.ruff;
  const args = [
    ...uv, 'ruff', 'check', '--isolated', '--preview', '--ignore-noqa',
    '--select', Object.keys(thresholds).join(','),
    '--config', `lint.mccabe.max-complexity=${thresholds.C901}`,
    '--config', `lint.pylint.max-args=${thresholds.PLR0913}`,
    '--config', `lint.pylint.max-statements=${thresholds.PLR0915}`,
    '--config', `lint.pylint.max-nested-blocks=${thresholds.PLR1702}`,
    '--output-format', 'json', '--no-cache', '--exit-zero', '--',
  ];
  const absolute = files.map((file) => join(root, file));
  const diagnostics: ReturnType<typeof readRuffDiagnostics> = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of absolute) {
    // Leave room for the uv/Ruff arguments and Windows argument quoting.
    if (length + file.length + 3 > 20_000 && batch.length) {
      diagnostics.push(...readRuffDiagnostics(run('uv', [...args, ...batch], cwd), root, config));
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += file.length + 3;
  }
  diagnostics.push(...readRuffDiagnostics(run('uv', [...args, ...batch], cwd), root, config));
  if (!diagnostics.length) return [];
  const locations = diagnostics.map(({ file, line }) => [join(root, file), line]);
  const symbols = JSON.parse(run('uv', [...uv, 'python', '-c', PYTHON_SYMBOLS], cwd, {
    input: JSON.stringify(locations),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })) as string[];
  const byLocation = new Map(diagnostics.map(({ file, line }, i) => [JSON.stringify([file, line]), symbols[i]]));
  // Every location was resolved above; '<module>' is the resolver's own name for none.
  return parseRuffFindings(diagnostics, (file, line) => byLocation.get(JSON.stringify([file, line])) ?? '<module>');
}

function runClippy(
  root: string,
  config: ComplexityConfig,
  readSource: (file: string) => string,
): Finding[] {
  // Outside the checkout, so a killed run leaves nothing in the repository.
  const directory = mkdtempSync(join(tmpdir(), 'code-complexity-clippy-'));
  const clippyConfig = join(directory, 'clippy.toml');
  const thresholds = config.thresholds.clippy;
  const findings: Finding[] = [];
  try {
    for (const crate of RUST_CRATES) {
      const cwd = join(root, crate);
      const manifest = join(cwd, 'Cargo.toml');
      const env = {
        ...process.env,
        CLIPPY_CONF_DIR: directory,
        // The Tauri build script otherwise requires staged runtime binaries.
        // Debug uses the configured dev URL; Clippy needs no bundle assets.
        ...(crate.endsWith('/src-tauri') ? { TAURI_CONFIG: '{"bundle":{"resources":[]}}' } : {}),
      };
      function lint(nesting: number, rules: string[]) {
        writeFileSync(clippyConfig, [
          `too-many-lines-threshold = ${thresholds.too_many_lines}`,
          `too-many-arguments-threshold = ${thresholds.too_many_arguments}`,
          `excessive-nesting-threshold = ${nesting}`,
          '',
        ].join('\n'));
        const output = run('cargo', [
          'clippy', '--locked', '--message-format=json', '--',
          '-A', 'clippy::all',
          // Put the threshold in the compiler arguments as well, to invalidate
          // Cargo's cached diagnostics between probes.
          '--cfg', `code_complexity_thresholds="${thresholds.too_many_lines}_${thresholds.too_many_arguments}_${nesting}"`,
          ...rules.flatMap((rule) => ['--force-warn', `clippy::${rule}`]),
        ], cwd, { env });
        return readClippyFindings(output, root, manifest, config, nesting);
      }
      const base = lint(thresholds.excessive_nesting, Object.keys(thresholds));
      if (base.some(({ rule }) => rule === 'excessive_nesting')) {
        for (let limit = thresholds.excessive_nesting + 1; ; limit += 1) {
          const probe = lint(limit, ['excessive_nesting']);
          if (!probe.some(({ rule }) => rule === 'excessive_nesting')) break;
          applyNestingProbe(base, probe);
        }
      }
      findings.push(...clippyFindings(base, readSource));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return findings;
}

function formatFinding({ tool, rule, file, symbol, value }: Finding): string {
  return `  - [${tool}/${rule}] ${file} :: ${symbol} (${value})`;
}

const TOOLS: readonly Finding['tool'][] = ['eslint', 'ruff', 'clippy'];

/** The tools named by `--without <tool>[,<tool>]` (repeatable), which the run leaves out. */
export function toolsLeftOut(argv: string[]): Finding['tool'][] {
  if (argv.at(-1) === '--without') throw new Error('--without needs a tool name: ' + TOOLS.join(', '));
  const names = argv.flatMap((arg, i) => (argv[i - 1] === '--without' ? arg.split(',') : []));
  return names.map((name) => {
    const tool = TOOLS.find((known) => known === name);
    if (!tool) throw new Error(`--without: unknown tool '${name}' (expected ${TOOLS.join(', ')})`);
    return tool;
  });
}

/**
 * Checks or rewrites the baseline. A left-out tool's baseline rows are neither
 * compared nor reported as gone; the baseline is never rewritten from a partial run.
 */
export function runComplexityRatchet(root: string, collect: () => Finding[], argv: string[]): number {
  const leftOut = toolsLeftOut(argv);
  if (argv.includes('--update') && leftOut.length) {
    console.error(`code-complexity gate: --update needs every tool, but this run leaves out ${leftOut.join(', ')}.`);
    return 2;
  }
  const ratchet: Ratchet<Finding> = {
    label: 'code-complexity',
    noun: 'finding',
    baseline: BASELINE,
    script: SCRIPT,
    collect: () => sortFindings(collect()),
    compare: (current, baseline) =>
      compareFindings(current, baseline.filter(({ tool }) => !leftOut.includes(tool))),
    formatKey: formatFinding,
    formatWorsened: (current, previous) => `${formatFinding(current)}, baseline ${previous.value}`,
    fixHint: [
      'Fix: reduce the measured complexity by separating responsibilities or reducing coupling.',
      'Update the baseline after reducing or removing known findings.',
    ],
  };
  return argv.includes('--update')
    ? writeRatchetBaseline(root, ratchet)
    : checkRatchet(root, ratchet, argv.includes('--ci'));
}

// Tracked files plus new ones not yet added, so a local check sees a new file
// before it is staged; deleted tracked files are dropped by the caller.
function workspaceFiles(root: string): string[] {
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return [...new Set(listed.split('\0').filter(Boolean))];
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (${result.status}):\n${result.stderr}`);
  return result.stdout;
}

// Staged, unstaged and untracked paths (every file of a new directory, both
// sides of a rename, unquoted). The hook adds them to `changedPaths`, whose
// `git status --porcelain` lines name a new directory only as `dir/`.
function uncommittedPaths(root: string): string[] {
  const entries = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its source path.
    if (/[RC]/u.test(entry.slice(0, 2))) paths.push(entries[(i += 1)]);
  }
  return paths;
}

/**
 * Whether a changed path can change a finding: a production source file of a
 * measured language, or an input of the Clippy findings (the gate's own files among them).
 */
export function measuresChange(paths: string[], config: ComplexityConfig): boolean {
  return changesRustFindings(paths) || paths.some((path) =>
    productionFile(path, config) && (JS_FILE.test(path) || path.endsWith('.py') || path.endsWith('.rs')),
  );
}

/**
 * Stop hook decision: nothing when the turn already had a round of feedback
 * (`stop_hook_active`) or changed nothing the gate measures; otherwise the
 * tools to leave out, Clippy unless a changed path can alter its findings.
 */
export function stopHookRun(
  stopHookActive: boolean,
  changed: string[],
  config: ComplexityConfig,
): { leftOut: Finding['tool'][] } | undefined {
  if (stopHookActive) return undefined;
  const paths = changed.map((path) => path.replaceAll('\\', '/'));
  if (!measuresChange(paths, config)) return undefined;
  return { leftOut: changesRustFindings(paths) ? [] : ['clippy'] };
}

const CLIPPY_WHEN_CHANGED = '--clippy-when-changed-since';

/** `--clippy-when-changed-since <ref>`: the ref, if the option is given. */
export function clippyBaseRef(argv: string[]): string | undefined {
  const index = argv.indexOf(CLIPPY_WHEN_CHANGED);
  if (index < 0) return undefined;
  const ref = argv[index + 1];
  if (!ref || ref.startsWith('--')) throw new Error(`${CLIPPY_WHEN_CHANGED} needs a git ref, such as origin/main`);
  return ref;
}

/** The paths in NUL-separated `git diff --name-only -z` output, as git stores them (never quoted). */
export function nulSeparatedPaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/**
 * The Stop hook's exit code for a check that returns the gate's status: 2 for
 * findings, which the model sees and works on; 1 when the check itself fails
 * (a git error, a missing tool, an unreadable diagnostic), with the error on
 * stderr, which the user sees and which does not block the turn.
 */
export function stopHookExit(check: () => number): number {
  try {
    return check() === 0 ? 0 : 2;
  } catch (error) {
    process.stderr.write(`code-complexity gate: ${(error as Error).message}\n`);
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const readSource = (file: string) => readFileSync(join(root, file), 'utf8');
  if (argv.includes('--hook')) {
    const payload = await readHookPayload();
    return stopHookExit(() => {
      const config = parseComplexityConfig(readSource(POLICY));
      // What the other Stop hooks see (uncommitted, or in commits not on the
      // upstream), so a turn that committed its work is still checked.
      const changed = [...changedPaths(root), ...uncommittedPaths(root)];
      const run = stopHookRun(Boolean(payload.stop_hook_active), changed, config);
      if (!run) return 0;
      // Not --ci: a finding that went away must not block the turn.
      return runGate(root, readSource, run.leftOut.length ? ['--without', run.leftOut.join(',')] : []);
    });
  }
  const since = clippyBaseRef(argv);
  if (since !== undefined) {
    // -z: no quoting of unusual paths; --no-renames: a rename lists its old path too.
    const changed = nulSeparatedPaths(git(root, ['diff', '--name-only', '-z', '--no-renames', `${since}...HEAD`]));
    if (!changesRustFindings(changed)) {
      console.log(`code-complexity gate: no change since ${since} can alter the Clippy findings; Clippy is left out.`);
      return runGate(root, readSource, [...argv, '--without', 'clippy']);
    }
  }
  return runGate(root, readSource, argv);
}

function runGate(root: string, readSource: (file: string) => string, argv: string[]): number {
  return runComplexityRatchet(root, () => {
    const leftOut = toolsLeftOut(argv);
    const config = parseComplexityConfig(readSource(POLICY));
    const files = workspaceFiles(root).filter((file) =>
      productionFile(file, config) && existsSync(join(root, file)),
    );
    const runs: Record<Finding['tool'], () => Finding[]> = {
      eslint: () => runEslint(root, files.filter((file) => JS_FILE.test(file)), config.thresholds.eslint, readSource),
      ruff: () => runRuff(root, files.filter((file) => file.endsWith('.py')), config),
      clippy: () => runClippy(root, config, readSource),
    };
    return TOOLS.filter((tool) => !leftOut.includes(tool)).flatMap((tool) => runs[tool]());
  }, argv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
