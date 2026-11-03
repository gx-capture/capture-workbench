/**
 * Architecture graph: one normalized JSON picture of the dependencies that
 * the existing rules (Nx tags, import-linter, Sheriff) already constrain, and
 * generated Mermaid diagrams under docs/architecture/ that cannot go stale.
 *
 * Levels:
 * - `projects`: Nx projects and their dependencies (`nx graph --file`).
 * - `runtimeContexts`: top-level groups of the `capture_runtime` Python
 *   package, from the grimp import graph (tools/architecture_graph_runtime.py).
 * - `uiModules`: Sheriff modules of the Angular UI package and the shell app,
 *   with edges computed from TypeScript imports.
 *
 * Usage (from the repo root):
 *   node tools/architecture-graph.ts            # print the JSON graph
 *   node tools/architecture-graph.ts --write    # regenerate docs/architecture/*.md
 *   node tools/architecture-graph.ts --check    # fail when those files are stale
 *   node tools/architecture-graph.ts --hook     # Claude Code Stop hook (.claude/settings.json)
 *   node tools/architecture-graph.ts --root <dir>  # read another checkout (a PR's base)
 *
 * The graph-building functions are pure; everything that spawns a process or
 * touches the filesystem sits in the "process boundary" section at the end.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { ARCHITECTURE_EXCEPTIONS } from './architecture-exceptions-gate.ts';
import {
  changedPaths,
  checkRatchet,
  readHookPayload,
} from './dead-code-gate.ts';

const ts = createRequire(import.meta.url)(
  'typescript',
) as typeof import('typescript');
type TsNode = import('typescript').Node;

export type Edge = [from: string, to: string];

export interface GraphLevel {
  nodes: string[];
  edges: Edge[];
  /** Label shown under a node: its `type:*` tag (projects) or Sheriff tags (UI modules). */
  tags?: Record<string, string>;
}

export interface ArchitectureGraph {
  schemaVersion: 1;
  levels: {
    projects: GraphLevel;
    runtimeContexts: GraphLevel;
    uiModules: GraphLevel;
  };
}

// ---- Normalization -------------------------------------------------------

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts and de-duplicates nodes and edges and drops self-edges. */
function normalizeLevel(
  nodes: Iterable<string>,
  edges: Iterable<Edge>,
  tags?: Record<string, string>,
): GraphLevel {
  const sortedNodes = [...new Set(nodes)].sort(compare);
  const edgeKeys = new Map<string, Edge>();
  for (const [from, to] of edges) {
    if (from !== to) edgeKeys.set(`${from}\u0000${to}`, [from, to]);
  }
  const sortedEdges = [...edgeKeys.values()].sort(
    (a, b) => compare(a[0], b[0]) || compare(a[1], b[1]),
  );
  const level: GraphLevel = { nodes: sortedNodes, edges: sortedEdges };
  if (tags) {
    level.tags = Object.fromEntries(
      Object.entries(tags).sort(([a], [b]) => compare(a, b)),
    );
  }
  return level;
}

// ---- Level 1: Nx projects -------------------------------------------------

interface NxGraphBody {
  nodes?: Record<string, { data?: { tags?: string[] } }>;
  dependencies?: Record<string, { target: string }[]>;
}

/**
 * Builds the project level from the JSON written by `nx graph --file`.
 * External (npm) nodes and their edges are dropped.
 */
export function projectsLevel(
  nxGraph: NxGraphBody & { graph?: NxGraphBody },
): GraphLevel {
  const body = nxGraph.graph ?? nxGraph;
  const projects = body.nodes ?? {};
  const names = new Set(Object.keys(projects));
  const edges: Edge[] = [];
  for (const [source, dependencies] of Object.entries(
    body.dependencies ?? {},
  )) {
    if (!names.has(source)) continue;
    for (const dependency of dependencies) {
      if (names.has(dependency.target)) edges.push([source, dependency.target]);
    }
  }
  const tags: Record<string, string> = {};
  for (const [name, project] of Object.entries(projects)) {
    const typeTag = project.data?.tags?.find((tag) => tag.startsWith('type:'));
    if (typeTag) tags[name] = typeTag;
  }
  return normalizeLevel(names, edges, tags);
}

// ---- Level 2: runtime contexts -------------------------------------------

interface ModuleImportReport {
  package: string;
  modules: string[];
  edges: Edge[];
}

/**
 * Collapses a grimp module graph to the direct children of the package (for
 * example `capture_runtime.services`). The package's own `__init__` is not a
 * context, and imports inside one context are not edges.
 */
export function runtimeContextsLevel(report: ModuleImportReport): GraphLevel {
  const prefix = `${report.package}.`;
  const contextOf = (module: string): string | undefined =>
    module.startsWith(prefix)
      ? `${prefix}${module.slice(prefix.length).split('.')[0]}`
      : undefined;
  const nodes: string[] = [];
  for (const module of report.modules) {
    const context = contextOf(module);
    if (context) nodes.push(context);
  }
  const edges: Edge[] = [];
  for (const [importer, imported] of report.edges) {
    const from = contextOf(importer);
    const to = contextOf(imported);
    if (from && to) edges.push([from, to]);
  }
  return normalizeLevel(nodes, edges);
}

// ---- Level 3: UI modules --------------------------------------------------

const ROOT_MODULE = 'root';

interface UiModuleInput {
  /** The Sheriff `modules` map: path pattern (`<name>` matches one directory) to tags. */
  modules: Record<string, string[]>;
  /** Production TypeScript sources by workspace-relative posix path. */
  sources: Record<string, string>;
  /** `tsconfig` `paths`: import specifier (may contain one `*`) to target files. */
  aliases: Record<string, string[]>;
}

function propertyName(name: TsNode): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? name.text
    : undefined;
}

/**
 * Reads the flat `modules` map out of a `sheriff.config.ts` source without
 * executing it (the file imports Sheriff, which a plain Node run cannot load).
 */
export function parseSheriffModules(source: string): Record<string, string[]> {
  const file = ts.createSourceFile(
    'sheriff.config.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let modules: Record<string, string[]> | undefined;
  const visit = (node: TsNode): void => {
    if (modules) return;
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'modules' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      modules = {};
      for (const property of node.initializer.properties) {
        const key = ts.isPropertyAssignment(property)
          ? propertyName(property.name)
          : undefined;
        if (
          key === undefined ||
          !ts.isPropertyAssignment(property) ||
          !ts.isArrayLiteralExpression(property.initializer) ||
          !property.initializer.elements.every((tag) =>
            ts.isStringLiteralLike(tag),
          )
        ) {
          throw new Error(
            'Unsupported Sheriff `modules` entry; expected "path": ["tag", ...].',
          );
        }
        modules[key] = property.initializer.elements.map(
          (tag) => (tag as import('typescript').StringLiteralLike).text,
        );
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!modules)
    throw new Error('sheriff.config.ts has no `modules` object literal.');
  return modules;
}

/** Module specifiers of every static import, re-export, `require` and `import()`. */
function importSpecifiers(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const add = (node: TsNode | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: TsNode): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      add(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function patternMatches(pattern: string, directory: string): boolean {
  const patternSegments = pattern.split('/');
  const directorySegments = directory.split('/');
  return (
    patternSegments.length === directorySegments.length &&
    patternSegments.every(
      (segment, index) =>
        (segment.startsWith('<') && segment.endsWith('>')) ||
        segment === directorySegments[index],
    )
  );
}

/** Directories that hold at least one source file, with every ancestor. */
function sourceDirectories(files: string[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = posix.dirname(file);
    while (
      directory !== '.' &&
      directory !== '/' &&
      !directories.has(directory)
    ) {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  return directories;
}

function aliasTargets(
  specifier: string,
  aliases: Record<string, string[]>,
): string[] {
  if (Object.hasOwn(aliases, specifier)) return aliases[specifier];
  for (const [pattern, targets] of Object.entries(aliases)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      const matched = specifier.slice(
        prefix.length,
        specifier.length - suffix.length,
      );
      return targets.map((target) => target.replace('*', matched));
    }
  }
  return [];
}

function resolveSourceFile(
  base: string,
  files: Set<string>,
): string | undefined {
  const normalized = posix.normalize(base);
  const withoutJs = normalized.replace(/\.js$/u, '');
  return [
    normalized,
    `${withoutJs}.ts`,
    `${normalized}.ts`,
    `${normalized}/index.ts`,
  ].find((candidate) => files.has(candidate));
}

/**
 * Module-to-module edges from TypeScript imports. A file belongs to the
 * deepest Sheriff module directory containing it, or to `root` when none does.
 * Imports that resolve to no scanned source file (npm packages) are ignored.
 */
export function uiModulesLevel(input: UiModuleInput): GraphLevel {
  const files = Object.keys(input.sources);
  const fileSet = new Set(files);

  const moduleTags = new Map<string, string[]>();
  for (const directory of sourceDirectories(files)) {
    for (const [pattern, tags] of Object.entries(input.modules)) {
      if (patternMatches(pattern, directory)) {
        moduleTags.set(directory, [
          ...(moduleTags.get(directory) ?? []),
          ...tags,
        ]);
      }
    }
  }

  const moduleOf = (file: string): string => {
    let directory = posix.dirname(file);
    while (directory !== '.' && directory !== '/') {
      if (moduleTags.has(directory)) return directory;
      directory = posix.dirname(directory);
    }
    return ROOT_MODULE;
  };

  const edges: Edge[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file, input.sources[file])) {
      const target = specifier.startsWith('.')
        ? resolveSourceFile(posix.join(posix.dirname(file), specifier), fileSet)
        : aliasTargets(specifier, input.aliases)
            .map((candidate) => resolveSourceFile(candidate, fileSet))
            .find((resolved) => resolved !== undefined);
      if (target) edges.push([moduleOf(file), moduleOf(target)]);
    }
  }

  const nodes = new Set(files.map(moduleOf));
  const tags: Record<string, string> = {};
  for (const node of nodes) {
    tags[node] =
      node === ROOT_MODULE
        ? ROOT_MODULE
        : (moduleTags.get(node) ?? []).join(', ');
  }
  return normalizeLevel(nodes, edges, tags);
}

// ---- Mermaid and generated docs ------------------------------------------

function mermaidIds(nodes: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const node of nodes) {
    const base = `n_${node.replace(/[^A-Za-z0-9]+/gu, '_')}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}_${suffix}`;
    used.add(id);
    ids.set(node, id);
  }
  return ids;
}

function mermaidLabel(text: string): string {
  return text.replaceAll('"', '#quot;');
}

/**
 * A `flowchart LR` diagram; `a --> b` means a depends on b. Output order
 * follows the sorted level. `removed` edges (the PR diff comment) are drawn
 * dashed and labelled after the level's own edges.
 */
export function renderMermaid(
  level: GraphLevel,
  removed: readonly Edge[] = [],
): string {
  const ids = mermaidIds(level.nodes);
  const idOf = (node: string): string => {
    const id = ids.get(node);
    if (!id)
      throw new Error(`Edge endpoint "${node}" is not a node of the level.`);
    return id;
  };
  const lines = ['flowchart LR'];
  for (const node of level.nodes) {
    const tag = level.tags?.[node];
    const label = tag
      ? `${mermaidLabel(node)}<br/>${mermaidLabel(tag)}`
      : mermaidLabel(node);
    lines.push(`  ${idOf(node)}["${label}"]`);
  }
  for (const [from, to] of level.edges) {
    lines.push(`  ${idOf(from)} --> ${idOf(to)}`);
  }
  for (const [from, to] of removed) {
    lines.push(`  ${idOf(from)} -. removed .-> ${idOf(to)}`);
  }
  return lines.join('\n');
}

const GENERATED_NOTICE =
  '<!-- Generated by tools/architecture-graph.ts --write. Do not edit by hand. -->';

interface GeneratedDoc {
  path: string;
  content: string;
}

function renderDoc(title: string, intro: string, level: GraphLevel): string {
  return [
    GENERATED_NOTICE,
    `# ${title}`,
    '',
    intro,
    '',
    '```mermaid',
    renderMermaid(level),
    '```',
    '',
  ].join('\n');
}

export function renderDocs(graph: ArchitectureGraph): GeneratedDoc[] {
  return [
    {
      path: 'docs/architecture/projects.md',
      content: renderDoc(
        'Nx projects',
        'Each node is an Nx project, labelled with its `type:*` tag. An arrow `a --> b` means project `a` depends on project `b` (from `nx graph`).',
        graph.levels.projects,
      ),
    },
    {
      path: 'docs/architecture/runtime-contexts.md',
      content: renderDoc(
        'Capture Runtime contexts',
        'Each node is a top-level group of the `capture_runtime` Python package. An arrow `a --> b` means a module in `a` imports a module in `b` (from grimp); imports inside one group are not drawn.',
        graph.levels.runtimeContexts,
      ),
    },
    {
      path: 'docs/architecture/ui-modules.md',
      content: renderDoc(
        'UI modules',
        'Each node is a Sheriff module of the Angular UI package, the shell app, or the runtime client SDK, labelled with its Sheriff tags; `root` holds files outside every module. An arrow `a --> b` means a TypeScript file in `a` imports a file in `b`.',
        graph.levels.uiModules,
      ),
    },
  ];
}

function normalizeLineEndings(text: string | undefined): string | undefined {
  return text?.replaceAll('\r\n', '\n');
}

/** Paths of generated docs whose stored content differs from the regenerated one (or is missing). */
function staleDocs(
  docs: GeneratedDoc[],
  readDoc: (path: string) => string | undefined,
): string[] {
  return docs
    .filter((doc) => normalizeLineEndings(readDoc(doc.path)) !== doc.content)
    .map((doc) => doc.path);
}

function staleMessage(paths: string[]): string {
  return [
    `Architecture docs are stale: ${paths.join(', ')}.`,
    'Run `pnpm run architecture:update` and commit the result.',
  ].join('\n');
}

// ---- CLI ------------------------------------------------------------------

interface CliIo {
  collectGraph: () => ArchitectureGraph;
  readDoc: (path: string) => string | undefined;
  writeDoc: (path: string, content: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE =
  'Usage: node tools/architecture-graph.ts [--write | --check | --hook] [--root <dir>]\n' +
  '  (no flag)     print the architecture graph as JSON\n' +
  '  --write       regenerate docs/architecture/*.md\n' +
  '  --check       exit 1 when docs/architecture/*.md are stale\n' +
  '  --hook        Claude Code Stop hook: --check, the exception gate and the\n' +
  '                runtime import-linter contracts, only after relevant changes\n' +
  '  --root <dir>  read the workspace at <dir> instead of this checkout\n' +
  '                (it needs its own node_modules for nx)\n';

/**
 * Returns the process exit code: 0 ok, 1 stale docs, 2 bad usage. `openIo`
 * receives the `--root` value, or undefined for this checkout.
 */
export function runCli(
  argv: string[],
  openIo: (root: string | undefined) => CliIo,
): number {
  let write = false;
  let check = false;
  let root: string | undefined;
  let usageError = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') write = true;
    else if (arg === '--check') check = true;
    else if (arg === '--root' && root === undefined && argv[index + 1]) {
      index += 1;
      root = argv[index];
    } else usageError = true;
  }
  const io = openIo(root);
  if (usageError || (write && check)) {
    io.stderr(USAGE);
    return 2;
  }
  const graph = io.collectGraph();
  if (!write && !check) {
    io.stdout(`${JSON.stringify(graph, null, 2)}\n`);
    return 0;
  }
  const docs = renderDocs(graph);
  if (write) {
    for (const doc of docs) io.writeDoc(doc.path, doc.content);
    io.stdout(`Wrote ${docs.length} architecture docs.\n`);
    return 0;
  }
  const stale = staleDocs(docs, io.readDoc);
  if (stale.length > 0) {
    io.stderr(`${staleMessage(stale)}\n`);
    return 1;
  }
  io.stdout('Architecture docs are up to date.\n');
  return 0;
}

// ---- Claude Code Stop hook -------------------------------------------------

/** Changed paths that can move a diagram or add a boundary exception. */
const ARCHITECTURE_CHANGE =
  /\.(?:ts|tsx|mts|cts|js|mjs|cjs|py)$|(?:^|\/)(?:package|project|nx|tsconfig[^/]*|[^/]*eslint-suppressions)\.json$|(?:^|\/)importlinter\.toml$/u;

/** Changed paths that the runtime's import-linter contracts check. */
const RUNTIME_RULES_CHANGE =
  /(?:^|\s)packages\/capture-runtime\/(?:src\/.+\.py|importlinter\.toml)$/u;

interface HookChecks {
  checkDocs: () => number;
  checkExceptions: () => number;
  lintRuntime: () => number;
}

/**
 * Stop hook decision. Nothing runs unless the turn changed a path that can
 * affect the architecture (`changed` comes from the dead-code gate's
 * `changedPaths`); then the docs check and the exception gate run, plus the
 * runtime import-linter contracts when runtime Python or its rules changed.
 * The Sheriff and Nx rules run with each project's `lint`, which is too slow
 * for the hook. Exit 2 shows stderr to the model; `stop_hook_active` means it
 * already had one round of feedback, so it may stop (no loops).
 */
export function runHook(
  stopHookActive: boolean,
  changed: string[],
  checks: HookChecks,
): number {
  if (stopHookActive) return 0;
  const paths = changed.map((path) => path.trim().replaceAll('\\', '/'));
  if (!paths.some((path) => ARCHITECTURE_CHANGE.test(path))) return 0;
  const results = [checks.checkDocs(), checks.checkExceptions()];
  if (paths.some((path) => RUNTIME_RULES_CHANGE.test(path))) {
    results.push(checks.lintRuntime());
  }
  return results.every((result) => result === 0) ? 0 : 2;
}

// ---- Process boundary: spawning tools and touching the filesystem ----------

/** This checkout: its tools/ run against `--root`, which may be an older tree without them. */
const workspaceRoot = resolve(import.meta.dirname, '..');
const RUNTIME_GRAPH_SCRIPT = join(
  workspaceRoot,
  'tools',
  'architecture_graph_runtime.py',
);

/** Sources scanned for UI module edges; the SDK is a Sheriff module the UI imports. */
const UI_SOURCE_ROOTS = [
  'packages/capture-workbench-ui/src',
  'apps/capture-workbench/src',
  'packages/capture-runtime-client/src',
];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'testing']);
const RUNTIME_PYTHONPATH = 'packages/capture-runtime/src';
const IMPORT_LINTER = 'import-linter==2.5.2';

function runChecked(
  what: string,
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): string {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `${what} could not start (${command}): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${what} failed with status ${result.status}:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function nxBinary(root: string): string {
  // Resolve the bin from nx's own package.json: its location moved between majors.
  const nxPackage = join(root, 'node_modules', 'nx', 'package.json');
  if (!existsSync(nxPackage)) {
    throw new Error(
      `nx is not installed (${nxPackage} is missing). Run \`pnpm install\` first.`,
    );
  }
  return join(
    dirname(nxPackage),
    JSON.parse(readFileSync(nxPackage, 'utf8')).bin.nx,
  );
}

/**
 * A daemon that nx starts here inherits our output pipes on Windows, so a
 * piped run or the Stop hook would wait for it to exit (never). Without the
 * daemon nx computes the graph in a few seconds.
 */
const NX_ENV = { ...process.env, NX_DAEMON: 'false' };

function collectProjects(root: string): GraphLevel {
  const nxBin = nxBinary(root);
  const directory = mkdtempSync(join(tmpdir(), 'architecture-graph-'));
  try {
    const file = join(directory, 'graph.json');
    runChecked(
      'nx graph',
      process.execPath,
      [nxBin, 'graph', `--file=${file}`],
      { cwd: root, env: NX_ENV },
    );
    return projectsLevel(JSON.parse(readFileSync(file, 'utf8')));
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

function collectRuntimeContexts(root: string): GraphLevel {
  const output = runChecked(
    'grimp runtime graph',
    'uvx',
    ['--from', IMPORT_LINTER, 'python', RUNTIME_GRAPH_SCRIPT],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: join(root, RUNTIME_PYTHONPATH),
        PYTHONIOENCODING: 'utf-8',
      },
    },
  );
  return runtimeContextsLevel(JSON.parse(output));
}

function collectSources(root: string): Record<string, string> {
  const sources: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !/\.(?:d|spec|test|e2e)\.ts$/u.test(entry.name)
      ) {
        sources[path] = readFileSync(join(root, path), 'utf8');
      }
    }
  };
  for (const sourceRoot of UI_SOURCE_ROOTS) visit(sourceRoot);
  return sources;
}

function collectUiModules(root: string): GraphLevel {
  const tsconfig = JSON.parse(
    readFileSync(join(root, 'tsconfig.base.json'), 'utf8'),
  ) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const aliases = Object.fromEntries(
    Object.entries(tsconfig.compilerOptions?.paths ?? {}).map(
      ([specifier, targets]) => [
        specifier,
        targets.map((target) => posix.normalize(target)),
      ],
    ),
  );
  return uiModulesLevel({
    modules: parseSheriffModules(
      readFileSync(join(root, 'sheriff.config.ts'), 'utf8'),
    ),
    sources: collectSources(root),
    aliases,
  });
}

function collectGraph(root: string): ArchitectureGraph {
  return {
    schemaVersion: 1,
    levels: {
      projects: collectProjects(root),
      runtimeContexts: collectRuntimeContexts(root),
      uiModules: collectUiModules(root),
    },
  };
}

function processIo(root: string): CliIo {
  return {
    collectGraph: () => collectGraph(root),
    readDoc: (path) => {
      const file = join(root, path);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    },
    writeDoc: (path, content) => {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

/** Runs the runtime's import-linter contracts through Nx (cached when unchanged). */
function lintRuntimeArchitecture(root: string): number {
  const result = spawnSync(
    process.execPath,
    [
      nxBinary(root),
      'run',
      'capture-runtime:lint-architecture',
      '--outputStyle=static',
    ],
    { cwd: root, env: NX_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return 0;
  // The model reads this output: drop the colour codes import-linter prints.
  process.stderr.write(
    stripVTControlCharacters(
      `capture-runtime:lint-architecture failed (contracts in packages/capture-runtime/importlinter.toml):\n${result.stdout}${result.stderr}\n`,
    ),
  );
  return 1;
}

async function runAsStopHook(root: string): Promise<number> {
  const payload = await readHookPayload();
  return runHook(Boolean(payload.stop_hook_active), changedPaths(root), {
    checkDocs: () => runCli(['--check'], () => processIo(root)),
    checkExceptions: () => checkRatchet(root, ARCHITECTURE_EXCEPTIONS, false),
    lintRuntime: () => lintRuntimeArchitecture(root),
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const argv = process.argv.slice(2);
  try {
    process.exitCode = argv.includes('--hook')
      ? await runAsStopHook(workspaceRoot)
      : runCli(argv, (root) =>
          processIo(root === undefined ? workspaceRoot : resolve(root)),
        );
  } catch (error) {
    process.stderr.write(`architecture-graph: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
