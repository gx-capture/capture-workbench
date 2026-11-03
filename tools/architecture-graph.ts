/**
 * Architecture graph: one normalized JSON picture of the dependencies that
 * the existing rules (Nx tags, import-linter, Sheriff) already constrain, and
 * generated Mermaid diagrams under docs/architecture/ that cannot go stale.
 *
 * The levels are declared in `architecture-graph.config.json` at the repo
 * root (see {@link parseArchitectureConfig}); each has one of four kinds:
 * - `nx`: Nx projects and their dependencies (`nx graph --file`).
 * - `python`: groups of one Python package, collapsed to a module depth, from
 *   the grimp import graph (tools/architecture_graph_python.py).
 * - `typescript`: Sheriff modules, with edges computed from TypeScript imports.
 * - `java`: packages under a base package, collapsed to a depth, with edges
 *   from `import` statements (no JDK needed).
 *
 * Usage (from the repo root):
 *   node tools/architecture-graph.ts            # print the JSON graph
 *   node tools/architecture-graph.ts --write    # regenerate docs/architecture/*.md
 *   node tools/architecture-graph.ts --check    # fail when those files are stale
 *   node tools/architecture-graph.ts --hook     # Claude Code Stop hook (.claude/settings.json)
 *   node tools/architecture-graph.ts --root <dir>  # read another checkout (a PR's base)
 *   node tools/architecture-graph.ts --config <file>  # levels from another config file
 *
 * The tool is copied, not shared, into each repo that uses it (Cert Prep,
 * LAW); it needs only `typescript`, `nx` for an `nx` level, `uv` and
 * tools/architecture_graph_python.py for a `python` level, and for `--hook`
 * tools/dead-code-gate.ts and tools/architecture-exceptions-gate.ts.
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
  statSync,
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
  /** Label shown under a node: its `type:*` tag (projects), group (python) or Sheriff tags (UI modules). */
  tags?: Record<string, string>;
  /**
   * Repo-relative posix path prefix (a directory or a file; `.` is the whole
   * repo) to the node that owns it. A file belongs to the node of its longest
   * matching prefix (see tools/architecture-diff.ts).
   */
  roots?: Record<string, string>;
  /** Short name of the level for the pull request section (config `label`). */
  label?: string;
  /**
   * Which edges cross a boundary: `tag` when the endpoints' tags differ (Nx
   * `type:*`, python groups), `node` when every node is its own group.
   */
  boundary?: 'tag' | 'node';
}

export interface ArchitectureGraph {
  schemaVersion: 1;
  /** Keyed by level id, in config order. */
  levels: Record<string, GraphLevel>;
}

// ---- Config ---------------------------------------------------------------

export const CONFIG_FILE = 'architecture-graph.config.json';
const DOCS_DIRECTORY = 'docs/architecture';

interface LevelConfigBase {
  /** Key of the level in the JSON graph. */
  id: string;
  /** Heading of the generated doc. */
  title: string;
  /** Short name in the pull request section; defaults to `title`. */
  label: string;
  /** File name of the generated doc under docs/architecture/. */
  output: string;
  /** Paragraph under the heading of the generated doc. */
  intro: string;
}

export interface NxLevelConfig extends LevelConfigBase {
  kind: 'nx';
}

export interface PythonLevelConfig extends LevelConfigBase {
  kind: 'python';
  /** Top-level package that grimp reads, e.g. `capture_runtime`. */
  package: string;
  /** Directory that holds the package (put on PYTHONPATH). */
  sourceDir: string;
  /** Working directory of the grimp run. */
  projectDir: string;
  /** Module segments below the package that make one node (1: `pkg.a`). */
  collapseDepth: number;
  /** Optional node (or module prefix) to group name, used as the node's tag. */
  groups?: Record<string, string>;
  /** `uvx --from` requirement that provides grimp and `lint-imports`. */
  importLinter: string;
  /** import-linter contracts that `--hook` runs when the package changes. */
  importLinterConfig?: string;
}

export interface TypeScriptLevelConfig extends LevelConfigBase {
  kind: 'typescript';
  /** Sheriff config whose `modules` map defines the nodes. */
  sheriffConfig: string;
  /** tsconfig whose `compilerOptions.paths` resolve import aliases. */
  tsconfig: string;
  /** Directories scanned for production `.ts` sources. */
  sourceRoots: string[];
  /** Directory names skipped while scanning. */
  exclude: string[];
}

export interface JavaLevelConfig extends LevelConfigBase {
  kind: 'java';
  /** Directories scanned for `.java` sources, e.g. `src/main/java`. */
  sourceRoots: string[];
  /** Packages outside it are ignored; classes directly in it form its own node. */
  basePackage: string;
  /** Package segments below the base package that make one node. */
  collapseDepth: number;
}

export type LevelConfig =
  | NxLevelConfig
  | PythonLevelConfig
  | TypeScriptLevelConfig
  | JavaLevelConfig;

export interface ArchitectureConfig {
  levels: LevelConfig[];
}

type JsonObject = Record<string, unknown>;

function configError(path: string, message: string): never {
  throw new Error(`${CONFIG_FILE}: ${path} ${message}`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  object: JsonObject,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      configError(
        `${path}.${key}`,
        `is not a known key (expected one of: ${allowed.join(', ')}).`,
      );
    }
  }
}

function readString(
  object: JsonObject,
  key: string,
  path: string,
  fallback?: string,
): string {
  const value = object[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    configError(`${path}.${key}`, 'must be a non-empty string.');
  }
  return value;
}

function readPattern(
  object: JsonObject,
  key: string,
  path: string,
  pattern: RegExp,
  description: string,
): string {
  const value = readString(object, key, path);
  if (!pattern.test(value))
    configError(`${path}.${key}`, `must be ${description}.`);
  return value;
}

const DOTTED_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;

function checkRelativePath(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.trim() !== value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    value.split('/').includes('..')
  ) {
    configError(
      path,
      'must be a repo-relative path with forward slashes and no `..`.',
    );
  }
  return value;
}

function readPath(
  object: JsonObject,
  key: string,
  path: string,
  fallback?: string,
): string {
  return checkRelativePath(object[key] ?? fallback, `${path}.${key}`);
}

/** A path list; without a fallback it is required and must not be empty. */
function readPathList(
  object: JsonObject,
  key: string,
  path: string,
  fallback?: string[],
): string[] {
  const value = object[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Array.isArray(value) || (fallback === undefined && value.length === 0)) {
    configError(`${path}.${key}`, 'must be a non-empty array of paths.');
  }
  return value.map((entry, index) =>
    checkRelativePath(entry, `${path}.${key}[${index}]`),
  );
}

function readOptionalPath(
  object: JsonObject,
  key: string,
  path: string,
): string | undefined {
  return object[key] === undefined
    ? undefined
    : checkRelativePath(object[key], `${path}.${key}`);
}

function readPositiveInteger(
  object: JsonObject,
  key: string,
  path: string,
  fallback: number,
): number {
  const value = object[key] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < 1) {
    configError(`${path}.${key}`, 'must be a positive integer.');
  }
  return value as number;
}

function readStringMap(
  object: JsonObject,
  key: string,
  path: string,
): Record<string, string> | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!isObject(value)) configError(`${path}.${key}`, 'must be an object.');
  for (const entry of Object.keys(value))
    readString(value, entry, `${path}.${key}`);
  return value as Record<string, string>;
}

const COMMON_KEYS = [
  'id',
  'kind',
  'title',
  'label',
  'output',
  'intro',
] as const;

function parseLevel(value: unknown, path: string): LevelConfig {
  if (!isObject(value)) configError(path, 'must be an object.');
  const base = {
    id: readPattern(value, 'id', path, /^[A-Za-z][\w-]*$/u, 'an identifier'),
    title: readString(value, 'title', path),
    output: readPattern(
      value,
      'output',
      path,
      /^[\w][\w.-]*\.md$/u,
      'a Markdown file name without directories',
    ),
    intro: readString(value, 'intro', path),
  };
  const common = {
    ...base,
    label: readString(value, 'label', path, base.title),
  };
  const kind = value.kind;
  switch (kind) {
    case 'nx':
      rejectUnknownKeys(value, COMMON_KEYS, path);
      return { ...common, kind };
    case 'python': {
      rejectUnknownKeys(
        value,
        [
          ...COMMON_KEYS,
          'package',
          'sourceDir',
          'projectDir',
          'collapseDepth',
          'groups',
          'importLinter',
          'importLinterConfig',
        ],
        path,
      );
      const groups = readStringMap(value, 'groups', path);
      const contracts = readOptionalPath(value, 'importLinterConfig', path);
      return {
        ...common,
        kind,
        package: readPattern(
          value,
          'package',
          path,
          DOTTED_NAME,
          'a dotted Python package name',
        ),
        sourceDir: readPath(value, 'sourceDir', path),
        projectDir: readPath(value, 'projectDir', path, '.'),
        collapseDepth: readPositiveInteger(value, 'collapseDepth', path, 1),
        ...(groups ? { groups } : {}),
        importLinter: readString(
          value,
          'importLinter',
          path,
          'import-linter==2.5.2',
        ),
        ...(contracts ? { importLinterConfig: contracts } : {}),
      };
    }
    case 'typescript':
      rejectUnknownKeys(
        value,
        [...COMMON_KEYS, 'sheriffConfig', 'tsconfig', 'sourceRoots', 'exclude'],
        path,
      );
      return {
        ...common,
        kind,
        sheriffConfig: readPath(value, 'sheriffConfig', path),
        tsconfig: readPath(value, 'tsconfig', path, 'tsconfig.base.json'),
        sourceRoots: readPathList(value, 'sourceRoots', path),
        exclude: readPathList(value, 'exclude', path, []),
      };
    case 'java':
      rejectUnknownKeys(
        value,
        [...COMMON_KEYS, 'sourceRoots', 'basePackage', 'collapseDepth'],
        path,
      );
      return {
        ...common,
        kind,
        sourceRoots: readPathList(value, 'sourceRoots', path),
        basePackage: readPattern(
          value,
          'basePackage',
          path,
          DOTTED_NAME,
          'a dotted Java package name',
        ),
        collapseDepth: readPositiveInteger(value, 'collapseDepth', path, 1),
      };
    default:
      return configError(
        `${path}.kind`,
        'must be one of "nx", "python", "typescript", "java".',
      );
  }
}

/**
 * Validates the parsed `architecture-graph.config.json` and fills defaults
 * (`label` = `title`, python `projectDir` `.`, `collapseDepth` 1, typescript
 * `tsconfig` `tsconfig.base.json`). Every error names the offending key.
 */
export function parseArchitectureConfig(value: unknown): ArchitectureConfig {
  if (!isObject(value)) configError('the config', 'must be a JSON object.');
  rejectUnknownKeys(value, ['levels'], 'config');
  if (!Array.isArray(value.levels) || value.levels.length === 0) {
    configError('config.levels', 'must be a non-empty array.');
  }
  const levels = value.levels.map((level, index) =>
    parseLevel(level, `levels[${index}]`),
  );
  for (const key of ['id', 'output'] as const) {
    const seen = new Set<string>();
    levels.forEach((level, index) => {
      if (seen.has(level[key])) {
        configError(`levels[${index}].${key}`, `repeats "${level[key]}".`);
      }
      seen.add(level[key]);
    });
  }
  return { levels };
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

// ---- Level kind: nx -------------------------------------------------------

interface NxGraphBody {
  nodes?: Record<string, { data?: { tags?: string[]; root?: string } }>;
  dependencies?: Record<string, { target: string }[]>;
}

/**
 * Builds the project level from the JSON written by `nx graph --file`.
 * External (npm) nodes and their edges are dropped. A file belongs to the
 * project with the longest root containing it, as in Nx.
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
  const roots: Record<string, string> = {};
  for (const [name, project] of Object.entries(projects)) {
    const typeTag = project.data?.tags?.find((tag) => tag.startsWith('type:'));
    if (typeTag) tags[name] = typeTag;
    const root = project.data?.root;
    if (root !== undefined) roots[root === '' ? '.' : root] = name;
  }
  return {
    ...normalizeLevel(names, edges, tags),
    roots: sortedRecord(roots),
    boundary: 'tag',
  };
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => compare(a, b)),
  );
}

/**
 * Drops a root whose nearest ancestor root already maps to the same node;
 * the longest-prefix lookup gives the same answer without it.
 */
function pruneRoots(roots: Map<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [path, node] of roots) {
    let ancestor = posix.dirname(path);
    while (ancestor !== '.' && ancestor !== '/' && !roots.has(ancestor)) {
      ancestor = posix.dirname(ancestor);
    }
    if (roots.get(ancestor) !== node) kept[path] = node;
  }
  return sortedRecord(kept);
}

// ---- Level kind: python ---------------------------------------------------

interface ModuleImportReport {
  package: string;
  modules: string[];
  edges: Edge[];
}

interface PythonLevelOptions {
  collapseDepth: number;
  groups?: Record<string, string>;
  /** Directory holding the package; module paths in `roots` start here. */
  sourceDir: string;
  /** Whether a module is a package directory rather than a `.py` file. */
  isPackage: (module: string) => boolean;
}

/** Value of the longest key that equals `name` or is a dotted prefix of it. */
function longestDottedPrefix(
  name: string,
  map: Record<string, string>,
): string | undefined {
  for (let candidate = name; ; ) {
    if (Object.hasOwn(map, candidate)) return map[candidate];
    const dot = candidate.lastIndexOf('.');
    if (dot < 0) return undefined;
    candidate = candidate.slice(0, dot);
  }
}

/**
 * Collapses a grimp module graph to modules `collapseDepth` segments below
 * the package (depth 1: `capture_runtime.services`). The package's own
 * `__init__` is not a node, and imports inside one node are not edges. With
 * `groups`, each node is tagged with the group of its longest matching
 * prefix and an edge crosses a boundary when the groups differ; without it
 * every node is its own group.
 */
export function pythonModulesLevel(
  report: ModuleImportReport,
  options: PythonLevelOptions,
): GraphLevel {
  const prefix = `${report.package}.`;
  const nodeOf = (module: string): string | undefined =>
    module.startsWith(prefix)
      ? `${prefix}${module
          .slice(prefix.length)
          .split('.')
          .slice(0, options.collapseDepth)
          .join('.')}`
      : undefined;
  const nodes = new Set<string>();
  for (const module of report.modules) {
    const node = nodeOf(module);
    if (node) nodes.add(node);
  }
  const edges: Edge[] = [];
  for (const [importer, imported] of report.edges) {
    const from = nodeOf(importer);
    const to = nodeOf(imported);
    if (from && to) edges.push([from, to]);
  }
  const roots: Record<string, string> = {};
  for (const node of nodes) {
    const path = posix.join(options.sourceDir, ...node.split('.'));
    roots[options.isPackage(node) ? path : `${path}.py`] = node;
  }
  let tags: Record<string, string> | undefined;
  if (options.groups) {
    tags = {};
    for (const node of nodes) {
      const group = longestDottedPrefix(node, options.groups);
      if (group !== undefined) tags[node] = group;
    }
  }
  return {
    ...normalizeLevel(nodes, edges, tags),
    roots: sortedRecord(roots),
    boundary: options.groups ? 'tag' : 'node',
  };
}

// ---- Level kind: typescript (Sheriff modules) ------------------------------

const ROOT_MODULE = 'root';

interface UiModuleInput {
  /** The Sheriff `modules` map: path pattern (`<name>` matches one directory) to tags. */
  modules: Record<string, string[]>;
  /** Production TypeScript sources by workspace-relative posix path. */
  sources: Record<string, string>;
  /** `tsconfig` `paths`: import specifier (may contain one `*`) to target files. */
  aliases: Record<string, string[]>;
  /** Scanned directories; files in them outside every module belong to `root`. */
  sourceRoots?: string[];
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
  // A module directory that is also a source root stays that module.
  const roots: Record<string, string> = {};
  if (nodes.has(ROOT_MODULE)) {
    for (const sourceRoot of input.sourceRoots ?? [])
      roots[sourceRoot] = ROOT_MODULE;
  }
  for (const module of moduleTags.keys()) {
    if (nodes.has(module)) roots[module] = module;
  }
  return { ...normalizeLevel(nodes, edges, tags), roots: sortedRecord(roots) };
}

// ---- Level kind: java ------------------------------------------------------

interface JavaDeclarations {
  /** The `package` declaration, or undefined for the default package. */
  package: string | undefined;
  /** Imported names: `a.b.C`, `a.b` for `a.b.*`, `a.b.C.m` for a static import. */
  imports: string[];
}

/** End index (exclusive) of a quoted literal that starts at `start`. */
function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + quote.length;
  while (index < source.length) {
    if (source[index] === '\\') index += 2;
    else if (source.startsWith(quote, index)) return index + quote.length;
    else if (quote.length === 1 && source[index] === '\n') return index;
    else index += 1;
  }
  return index;
}

/** The source with comments, string, text-block and char literals blanked out. */
function stripJavaCommentsAndLiterals(source: string): string {
  let result = '';
  let index = 0;
  while (index < source.length) {
    let end: number | undefined;
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index);
      end = newline < 0 ? source.length : newline;
    } else if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      end = close < 0 ? source.length : close + 2;
    } else if (source.startsWith('"""', index)) {
      end = skipQuoted(source, index, '"""');
    } else if (source[index] === '"' || source[index] === "'") {
      end = skipQuoted(source, index, source[index]);
    }
    if (end === undefined) {
      result += source[index];
      index += 1;
    } else {
      result += ' ';
      index = end;
    }
  }
  return result;
}

const JAVA_NAME = String.raw`[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*`;
const JAVA_PACKAGE = new RegExp(
  String.raw`\bpackage\s+(${JAVA_NAME})\s*;`,
  'u',
);
const JAVA_IMPORT = new RegExp(
  String.raw`\bimport\s+(?:static\s+)?(${JAVA_NAME})(?:\s*\.\s*\*)?\s*;`,
  'gu',
);

/**
 * Reads the `package` and `import` declarations of a Java source, including
 * static and wildcard imports. Comments and literals are blanked out first,
 * so an import inside a comment or a string is not a dependency.
 */
export function parseJavaDeclarations(source: string): JavaDeclarations {
  const code = stripJavaCommentsAndLiterals(source);
  const compact = (name: string): string => name.replace(/\s+/gu, '');
  const packageMatch = JAVA_PACKAGE.exec(code);
  return {
    package: packageMatch ? compact(packageMatch[1]) : undefined,
    imports: [...code.matchAll(JAVA_IMPORT)].map((match) => compact(match[1])),
  };
}

interface JavaLevelInput {
  /** `.java` sources by repo-relative posix path. */
  sources: Record<string, string>;
  basePackage: string;
  collapseDepth: number;
}

/**
 * Package-to-package edges from Java imports. A node is the base package
 * plus up to `collapseDepth` more segments; classes directly in the base
 * package form the base package's node. An import resolves to the longest
 * package declared in the sources that prefixes it, so `a.b.C`, `a.b.*` and
 * `static a.b.C.m` all point at package `a.b`; imports of other packages
 * (libraries, the JDK) are ignored. A file belongs to the node of its
 * declared package; `roots` maps each source directory to that node.
 */
export function javaPackagesLevel(input: JavaLevelInput): GraphLevel {
  const base = input.basePackage;
  const nodeOf = (pkg: string | undefined): string | undefined => {
    if (pkg === base) return base;
    if (!pkg?.startsWith(`${base}.`)) return undefined;
    const rest = pkg.slice(base.length + 1).split('.');
    return `${base}.${rest.slice(0, input.collapseDepth).join('.')}`;
  };
  const files = Object.entries(input.sources).map(([path, source]) => ({
    path,
    ...parseJavaDeclarations(source),
  }));
  const declared: Record<string, string> = {};
  for (const file of files) {
    if (file.package && nodeOf(file.package)) {
      declared[file.package] = file.package;
    }
  }
  const nodes = new Set<string>();
  const edges: Edge[] = [];
  const roots = new Map<string, string>();
  for (const file of files) {
    const from = nodeOf(file.package);
    if (!from) continue;
    nodes.add(from);
    roots.set(posix.dirname(file.path), from);
    for (const name of file.imports) {
      const to = nodeOf(longestDottedPrefix(name, declared));
      if (to) edges.push([from, to]);
    }
  }
  return { ...normalizeLevel(nodes, edges), roots: pruneRoots(roots) };
}

// ---- Mermaid and generated docs ------------------------------------------

/** Stable, unique Mermaid node ids in node order. */
export function mermaidIds(nodes: string[]): Map<string, string> {
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

/**
 * Text that is safe inside a quoted Mermaid label (`id["..."]`): the
 * characters Mermaid or its HTML labels would interpret become entity codes
 * (`#` first, since every code starts with it), and line breaks and runs of
 * whitespace become one space. tools/wiki-overview.ts uses it for issue titles.
 */
export function mermaidLabel(text: string): string {
  return text
    .replaceAll('#', '#35;')
    .replaceAll('"', '#quot;')
    .replaceAll('&', '#amp;')
    .replaceAll('<', '#lt;')
    .replaceAll('>', '#gt;')
    .replaceAll('`', '#96;')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A `flowchart LR` diagram; `a --> b` means a depends on b. Output order
 * follows the sorted level. Node ids come from {@link mermaidIds}, so a caller
 * can append its own edge lines (tools/architecture-diff.ts).
 */
export function renderMermaid(level: GraphLevel): string {
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

/** One doc per configured level, in config order. */
export function renderDocs(
  graph: ArchitectureGraph,
  config: ArchitectureConfig,
): GeneratedDoc[] {
  return config.levels.map((level) => {
    const graphLevel = graph.levels[level.id];
    if (!graphLevel) {
      throw new Error(`The graph has no level "${level.id}".`);
    }
    return {
      path: `${DOCS_DIRECTORY}/${level.output}`,
      content: renderDoc(level.title, level.intro, graphLevel),
    };
  });
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
  /** Reads and validates the config: `--config <file>`, else the root's own. */
  loadConfig: (path: string | undefined) => ArchitectureConfig;
  collectGraph: (config: ArchitectureConfig) => ArchitectureGraph;
  readDoc: (path: string) => string | undefined;
  writeDoc: (path: string, content: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE =
  'Usage: node tools/architecture-graph.ts [--write | --check | --hook] [--root <dir>] [--config <file>]\n' +
  '  (no flag)        print the architecture graph as JSON\n' +
  '  --write          regenerate docs/architecture/*.md\n' +
  '  --check          exit 1 when docs/architecture/*.md are stale\n' +
  '  --hook           Claude Code Stop hook: --check, the exception gate and the\n' +
  "                   python levels' import-linter contracts, after relevant changes\n" +
  '  --root <dir>     read the workspace at <dir> instead of this checkout\n' +
  '                   (it needs its own node_modules for nx)\n' +
  `  --config <file>  read the levels from <file> instead of <root>/${CONFIG_FILE}\n`;

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
  let configPath: string | undefined;
  let usageError = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') write = true;
    else if (arg === '--check') check = true;
    else if (arg === '--root' && root === undefined && argv[index + 1]) {
      index += 1;
      root = argv[index];
    } else if (
      arg === '--config' &&
      configPath === undefined &&
      argv[index + 1]
    ) {
      index += 1;
      configPath = argv[index];
    } else usageError = true;
  }
  const io = openIo(root);
  if (usageError || (write && check)) {
    io.stderr(USAGE);
    return 2;
  }
  const config = io.loadConfig(configPath);
  const graph = io.collectGraph(config);
  if (!write && !check) {
    io.stdout(`${JSON.stringify(graph, null, 2)}\n`);
    return 0;
  }
  const docs = renderDocs(graph, config);
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

/** Config files that can move a diagram or add a boundary exception. */
const ARCHITECTURE_CONFIG_CHANGE =
  /(?:^|\/)(?:package|project|nx|tsconfig[^/]*|[^/]*eslint-suppressions)\.json$|(?:^|\/)importlinter\.toml$/u;
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|py|java)$/u;

interface HookChecks {
  checkDocs: () => number;
  checkExceptions: () => number;
  /** The import-linter contracts of one python level. */
  lintPython: (level: PythonLevelConfig) => number;
}

function isUnder(path: string, directory: string): boolean {
  return (
    directory === '.' || path === directory || path.startsWith(`${directory}/`)
  );
}

/**
 * Repo-relative paths from `git status --porcelain` lines or names: both
 * sides of a rename, quotes and Windows separators removed.
 */
function hookPaths(changed: string[]): string[] {
  return changed
    .flatMap((entry) => entry.split(' -> '))
    .map((path) =>
      path
        .trim()
        .replace(/^"(.*)"$/u, '$1')
        .replaceAll('\\', '/'),
    )
    .filter((path) => path !== '');
}

/**
 * Whether a changed path can affect the architecture: the config, a rule or
 * workspace config file, or a source file the levels read. An `nx` level
 * covers every source file of the workspace; otherwise only files under the
 * configured source directories count.
 */
function isArchitectureChange(
  path: string,
  config: ArchitectureConfig,
): boolean {
  const configFiles = new Set<string>([CONFIG_FILE]);
  const sourceDirectories: string[] = [];
  for (const level of config.levels) {
    if (level.kind === 'nx') sourceDirectories.push('.');
    if (level.kind === 'python') {
      sourceDirectories.push(level.sourceDir);
      if (level.importLinterConfig) configFiles.add(level.importLinterConfig);
    }
    if (level.kind === 'typescript') {
      sourceDirectories.push(...level.sourceRoots);
      configFiles.add(level.sheriffConfig).add(level.tsconfig);
    }
    if (level.kind === 'java') sourceDirectories.push(...level.sourceRoots);
  }
  return (
    configFiles.has(path) ||
    ARCHITECTURE_CONFIG_CHANGE.test(path) ||
    (SOURCE_FILE.test(path) &&
      sourceDirectories.some((directory) => isUnder(path, directory)))
  );
}

/**
 * Stop hook decision. Nothing runs unless the turn changed a path that can
 * affect the architecture (`changed` comes from the dead-code gate's
 * `changedPaths`); then the docs check and the exception gate run, plus the
 * import-linter contracts of each python level (with `importLinterConfig`)
 * whose Python sources or contracts changed. The Sheriff and Nx rules run
 * with each project's `lint`, which is too slow for the hook. Exit 2 shows
 * stderr to the model; `stop_hook_active` means it already had one round of
 * feedback, so it may stop (no loops).
 */
export function runHook(
  stopHookActive: boolean,
  changed: string[],
  config: ArchitectureConfig,
  checks: HookChecks,
): number {
  if (stopHookActive) return 0;
  const paths = hookPaths(changed);
  if (!paths.some((path) => isArchitectureChange(path, config))) return 0;
  const results = [checks.checkDocs(), checks.checkExceptions()];
  for (const level of config.levels) {
    if (
      level.kind === 'python' &&
      level.importLinterConfig !== undefined &&
      paths.some(
        (path) =>
          path === level.importLinterConfig ||
          (path.endsWith('.py') && isUnder(path, level.sourceDir)),
      )
    ) {
      results.push(checks.lintPython(level));
    }
  }
  return results.every((result) => result === 0) ? 0 : 2;
}

// ---- Process boundary: spawning tools and touching the filesystem ----------

/** This checkout: its tools/ run against `--root`, which may be an older tree without them. */
const workspaceRoot = resolve(import.meta.dirname, '..');
const PYTHON_GRAPH_SCRIPT = join(
  workspaceRoot,
  'tools',
  'architecture_graph_python.py',
);

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

/** Reads a UTF-8 text file; a file written by Windows PowerShell may start with a BOM. */
function readText(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function loadConfig(file: string): ArchitectureConfig {
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing. Add it, or pass --config <file> to read the levels from another file.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(readText(file));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return parseArchitectureConfig(json);
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

function collectPython(root: string, level: PythonLevelConfig): GraphLevel {
  const sourceDir = join(root, level.sourceDir);
  const output = runChecked(
    `grimp graph of ${level.package}`,
    'uvx',
    [
      '--from',
      level.importLinter,
      'python',
      PYTHON_GRAPH_SCRIPT,
      level.package,
    ],
    {
      cwd: join(root, level.projectDir),
      env: {
        ...process.env,
        PYTHONPATH: sourceDir,
        PYTHONIOENCODING: 'utf-8',
      },
    },
  );
  return pythonModulesLevel(JSON.parse(output), {
    collapseDepth: level.collapseDepth,
    ...(level.groups ? { groups: level.groups } : {}),
    sourceDir: level.sourceDir,
    isPackage: (module) =>
      statSync(join(sourceDir, ...module.split('.')), {
        throwIfNoEntry: false,
      })?.isDirectory() ?? false,
  });
}

/** Files under `sourceRoots` whose name passes `include`, by repo-relative posix path. */
function collectSources(
  root: string,
  sourceRoots: string[],
  exclude: readonly string[],
  include: (name: string) => boolean,
): Record<string, string> {
  const sources: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!exclude.includes(entry.name)) visit(path);
      } else if (entry.isFile() && include(entry.name)) {
        sources[path] = readFileSync(join(root, path), 'utf8');
      }
    }
  };
  for (const sourceRoot of sourceRoots) visit(sourceRoot);
  return sources;
}

function collectTypeScript(
  root: string,
  level: TypeScriptLevelConfig,
): GraphLevel {
  const tsconfig = JSON.parse(readText(join(root, level.tsconfig))) as {
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
    modules: parseSheriffModules(readText(join(root, level.sheriffConfig))),
    sources: collectSources(
      root,
      level.sourceRoots,
      level.exclude,
      (name) =>
        name.endsWith('.ts') && !/\.(?:d|spec|test|e2e)\.ts$/u.test(name),
    ),
    aliases,
    sourceRoots: level.sourceRoots,
  });
}

function collectJava(root: string, level: JavaLevelConfig): GraphLevel {
  return javaPackagesLevel({
    sources: collectSources(root, level.sourceRoots, [], (name) =>
      name.endsWith('.java'),
    ),
    basePackage: level.basePackage,
    collapseDepth: level.collapseDepth,
  });
}

function collectLevel(root: string, level: LevelConfig): GraphLevel {
  switch (level.kind) {
    case 'nx':
      return collectProjects(root);
    case 'python':
      return collectPython(root, level);
    case 'typescript':
      return collectTypeScript(root, level);
    case 'java':
      return collectJava(root, level);
  }
}

function collectGraph(
  root: string,
  config: ArchitectureConfig,
): ArchitectureGraph {
  const levels: Record<string, GraphLevel> = {};
  for (const level of config.levels) {
    levels[level.id] = { ...collectLevel(root, level), label: level.label };
  }
  return { schemaVersion: 1, levels };
}

function processIo(root: string): CliIo {
  return {
    loadConfig: (path) =>
      loadConfig(path === undefined ? join(root, CONFIG_FILE) : resolve(path)),
    collectGraph: (config) => collectGraph(root, config),
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

/** Runs a python level's import-linter contracts with the pinned `uvx` tool. */
function lintPythonContracts(root: string, level: PythonLevelConfig): number {
  const contracts = level.importLinterConfig as string;
  const result = spawnSync(
    'uvx',
    [
      '--from',
      level.importLinter,
      'lint-imports',
      '--config',
      join(root, contracts),
    ],
    {
      cwd: join(root, level.projectDir),
      env: {
        ...process.env,
        PYTHONPATH: join(root, level.sourceDir),
        PYTHONIOENCODING: 'utf-8',
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(
      `lint-imports could not start (uvx): ${result.error.message}`,
    );
  }
  if (result.status === 0) return 0;
  // The model reads this output: drop the colour codes import-linter prints.
  process.stderr.write(
    stripVTControlCharacters(
      `import-linter contracts of ${level.package} failed (${contracts}):\n${result.stdout}${result.stderr}\n`,
    ),
  );
  return 1;
}

async function runAsStopHook(root: string): Promise<number> {
  const payload = await readHookPayload();
  return runHook(
    Boolean(payload.stop_hook_active),
    changedPaths(root),
    loadConfig(join(root, CONFIG_FILE)),
    {
      checkDocs: () => runCli(['--check'], () => processIo(root)),
      checkExceptions: () => checkRatchet(root, ARCHITECTURE_EXCEPTIONS, false),
      lintPython: (level) => lintPythonContracts(root, level),
    },
  );
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
