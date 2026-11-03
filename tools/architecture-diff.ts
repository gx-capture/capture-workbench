/**
 * Architecture diff: the architecture section of a pull request description.
 * It shows where the PR's changed files sit in each level of
 * tools/architecture-graph.ts (the touched nodes and their direct
 * dependencies) and which dependency edges the PR adds or removes.
 *
 * Usage (from the repo root):
 *   node tools/architecture-diff.ts --base <base.json> --head <head.json> \
 *     --changed-files <file> [--comment]
 *   node tools/architecture-diff.ts --splice-body <body-file> --section <section-file>
 *
 * The first form prints the section, wrapped in {@link SECTION_START} and
 * {@link SECTION_END}; both graphs are the JSON printed by
 * tools/architecture-graph.ts and the changed files are one repo-relative
 * path per line (`git diff --name-only base...head`). With `--comment` it
 * prints the fallback sticky comment instead: {@link COMMENT_MARKER} and the
 * section. The second form prints the description with the section
 * replaced (or appended) and every other byte unchanged.
 * (.github/workflows/architecture-diff.yml runs both.)
 *
 * The diff, render and splice functions are pure; reading files and writing
 * stdout sit in the "process boundary" section at the end.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mermaidIds,
  renderMermaid,
  type ArchitectureGraph,
  type Edge,
  type GraphLevel,
} from './architecture-graph.ts';

export const SECTION_START = '<!-- architecture:start -->';
export const SECTION_END = '<!-- architecture:end -->';
/** First line of the fallback comment, used when the description cannot be updated. */
export const COMMENT_MARKER = '<!-- architecture-diff -->';
/** A level diagram with more nodes keeps only touched nodes and changed edges. */
export const MAX_DIAGRAM_NODES = 40;

interface LevelReport {
  id: string;
  label: string;
  /** Head edges, the context of the touched nodes. */
  edges: Edge[];
  added: Edge[];
  removed: Edge[];
  /** Nodes that own a changed file, in base or head. */
  touched: string[];
  /** Endpoint labels (`type:*`, groups or Sheriff tags), head first, base for removed nodes. */
  tags: Record<string, string>;
  boundary: GraphLevel['boundary'];
}

// ---- Changed files to nodes -------------------------------------------------

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The node owning a repo-relative file: the value of the longest `roots`
 * prefix that is the file itself or one of its directories (`.` matches
 * every file).
 */
export function nodeForFile(
  level: GraphLevel,
  file: string,
): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const [prefix, node] of Object.entries(level.roots ?? {})) {
    const matches =
      prefix === '.' || file === prefix || file.startsWith(`${prefix}/`);
    const length = prefix === '.' ? 0 : prefix.length;
    if (matches && length > bestLength) {
      best = node;
      bestLength = length;
    }
  }
  return best;
}

/** Nodes of either graph that own one of the files, sorted. */
export function touchedNodes(
  base: GraphLevel,
  head: GraphLevel,
  files: readonly string[],
): string[] {
  const known = new Set([...base.nodes, ...head.nodes]);
  const touched = new Set<string>();
  for (const file of files) {
    for (const level of [head, base]) {
      const node = nodeForFile(level, file);
      if (node !== undefined && known.has(node)) touched.add(node);
    }
  }
  return [...touched].sort(compare);
}

// ---- Diff -------------------------------------------------------------------

function edgeKey([from, to]: Edge): string {
  return `${from}\u0000${to}`;
}

/** Edges only in `to`; keeps the sorted order of the normalized graph. */
function edgesMissingFrom(from: GraphLevel, to: GraphLevel): Edge[] {
  const known = new Set(from.edges.map(edgeKey));
  return to.edges.filter((edge) => !known.has(edgeKey(edge)));
}

const EMPTY_LEVEL: GraphLevel = { nodes: [], edges: [] };

/** One report per level: head's level order, then levels only the base has. */
export function analyzeLevels(
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  changedFiles: readonly string[],
): LevelReport[] {
  const ids = [
    ...new Set([...Object.keys(head.levels), ...Object.keys(base.levels)]),
  ];
  return ids.map((id) => {
    const before = base.levels[id] ?? EMPTY_LEVEL;
    const after = head.levels[id] ?? EMPTY_LEVEL;
    return {
      id,
      label: after.label ?? before.label ?? id,
      edges: after.edges,
      added: edgesMissingFrom(before, after),
      removed: edgesMissingFrom(after, before),
      touched: touchedNodes(before, after, changedFiles),
      tags: { ...before.tags, ...after.tags },
      boundary: after.boundary ?? before.boundary,
    };
  });
}

/** Whether an edge crosses the level's boundary (`type:*` tags, groups). */
function crossesBoundary(report: LevelReport, [from, to]: Edge): boolean {
  if (report.boundary === 'node') return true;
  if (report.boundary !== 'tag') return false;
  const fromTag = report.tags[from];
  const toTag = report.tags[to];
  return fromTag !== undefined && toTag !== undefined && fromTag !== toTag;
}

// ---- Neighbourhood ----------------------------------------------------------

interface Neighbourhood {
  nodes: string[];
  /** Head edges to draw solid (unchanged context edges and added edges). */
  edges: Edge[];
  removed: Edge[];
  /** Direct-dependency nodes left out because the diagram was too large. */
  omitted: number;
}

function endpoints(edges: readonly Edge[]): string[] {
  return edges.flatMap(([from, to]) => [from, to]);
}

/**
 * The touched nodes, their direct dependencies one hop up and down (head
 * edges), and the endpoints of every changed edge. Above `maxNodes` only the
 * touched nodes and changed edges remain.
 */
export function selectNeighbourhood(
  report: Pick<LevelReport, 'edges' | 'added' | 'removed' | 'touched'>,
  maxNodes = MAX_DIAGRAM_NODES,
): Neighbourhood {
  const touched = new Set(report.touched);
  const core = new Set([
    ...report.touched,
    ...endpoints(report.added),
    ...endpoints(report.removed),
  ]);
  const addedKeys = new Set(report.added.map(edgeKey));
  const drawn = report.edges.filter(
    (edge) =>
      touched.has(edge[0]) ||
      touched.has(edge[1]) ||
      addedKeys.has(edgeKey(edge)),
  );
  const all = new Set([...core, ...endpoints(drawn)]);
  if (all.size <= maxNodes) {
    return {
      nodes: [...all].sort(compare),
      edges: drawn,
      removed: report.removed,
      omitted: 0,
    };
  }
  return {
    nodes: [...core].sort(compare),
    edges: report.added,
    removed: report.removed,
    omitted: all.size - core.size,
  };
}

// ---- Markdown -------------------------------------------------------------

const TOUCHED_CLASS =
  'classDef touched fill:#fff3bf,stroke:#f08c00,stroke-width:2px,color:#1f2328';
const CROSSING_LINK_STYLE = 'stroke:#d1242f,stroke-width:3px';

/**
 * `a --> b`: a depends on b. Touched nodes use the `touched` class; added
 * edges are solid and labelled `added`, removed ones dashed and labelled
 * `removed`; changed edges that cross the boundary are also labelled
 * `crossing` and drawn thick red.
 */
export function renderNeighbourhood(
  report: LevelReport,
  hood: Neighbourhood,
): string {
  const tags = Object.fromEntries(
    hood.nodes.flatMap((node) =>
      report.tags[node] ? [[node, report.tags[node]]] : [],
    ),
  );
  const lines = [
    renderMermaid({
      nodes: hood.nodes,
      edges: [],
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    }),
  ];
  const ids = mermaidIds(hood.nodes);
  const id = (node: string): string => ids.get(node) as string;
  const addedKeys = new Set(report.added.map(edgeKey));
  const crossing: number[] = [];
  const changedLabel = (change: string, edge: Edge, index: number): string => {
    if (!crossesBoundary(report, edge)) return change;
    crossing.push(index);
    return `${change}, crossing`;
  };
  hood.edges.forEach((edge, index) => {
    const arrow = addedKeys.has(edgeKey(edge))
      ? `-->|${changedLabel('added', edge, index)}|`
      : '-->';
    lines.push(`  ${id(edge[0])} ${arrow} ${id(edge[1])}`);
  });
  hood.removed.forEach((edge, offset) => {
    const label = changedLabel('removed', edge, hood.edges.length + offset);
    lines.push(`  ${id(edge[0])} -.->|${label}| ${id(edge[1])}`);
  });
  const touched = report.touched.filter((node) => ids.has(node));
  if (touched.length > 0) {
    lines.push(
      `  ${TOUCHED_CLASS}`,
      `  class ${touched.map(id).join(',')} touched`,
    );
  }
  if (crossing.length > 0) {
    lines.push(`  linkStyle ${crossing.join(',')} ${CROSSING_LINK_STYLE}`);
  }
  return lines.join('\n');
}

function cell(text: string): string {
  return `\`${text.replaceAll('|', '\\|').replaceAll('`', "'")}\``;
}

function edgeRow(report: LevelReport, change: string, edge: Edge): string {
  const [from, to] = edge;
  const fromTag = report.tags[from];
  const toTag = report.tags[to];
  const tagCell =
    fromTag || toTag ? `${cell(fromTag ?? '')} → ${cell(toTag ?? '')}` : '';
  const crossingCell = crossesBoundary(report, edge) ? '是' : '';
  return `| ${report.label} | ${change} | ${cell(from)} | ${cell(to)} | ${tagCell} | ${crossingCell} |`;
}

function renderLevelDiagram(report: LevelReport): string[] {
  const hood = selectNeighbourhood(report);
  if (hood.nodes.length === 0) return [];
  return [
    `#### ${report.label}`,
    '',
    report.touched.length > 0
      ? `動到：${report.touched.map(cell).join('、')}`
      : '沒有動到的節點，只畫變動的邊。',
    '',
    ...(hood.omitted > 0
      ? [
          `節點超過 ${MAX_DIAGRAM_NODES} 個，只畫動到的節點和變動的邊；省略了 ${hood.omitted} 個直接依賴節點。`,
          '',
        ]
      : []),
    '```mermaid',
    renderNeighbourhood(report, hood),
    '```',
    '',
  ];
}

/**
 * The PR description section, from {@link SECTION_START} to
 * {@link SECTION_END}, without a trailing newline.
 */
export function renderSection(reports: LevelReport[]): string {
  const touchedAny = reports.some((report) => report.touched.length > 0);
  const changed = reports.filter(
    (report) => report.added.length > 0 || report.removed.length > 0,
  );
  if (!touchedAny && changed.length === 0) {
    return [
      SECTION_START,
      '本 PR 沒有改到架構圖上的任何節點，也沒有新增或刪除依賴。',
      SECTION_END,
    ].join('\n');
  }
  return [
    SECTION_START,
    '## 架構',
    '',
    '由 architecture-diff workflow 產生；每次推送都會覆寫這兩個隱藏標記之間的內容，標記以外的描述不受影響。',
    '',
    '### 動到的範圍',
    '',
    '`a --> b` 表示 a 依賴 b。黃底是本 PR 改到的檔案所屬的節點，其餘是它們上下游各一層的直接依賴。標 added 的實線是新增的依賴，標 removed 的虛線是刪除的依賴；標 crossing 的紅色粗線跨越 `type:*` 標籤或上下文。',
    '',
    '| 層級 | 動到的節點 | 新增的依賴 | 刪除的依賴 |',
    '| --- | --- | --- | --- |',
    ...reports.map(
      (report) =>
        `| ${report.label} | ${report.touched.length} | ${report.added.length} | ${report.removed.length} |`,
    ),
    '',
    ...(touchedAny ? [] : ['本 PR 沒有改到架構圖上的任何節點。', '']),
    ...reports.flatMap(renderLevelDiagram),
    '### 依賴變動',
    '',
    ...(changed.length === 0
      ? ['本 PR 沒有新增或刪除模組依賴。']
      : [
          '跨界：兩端的 `type:*` 標籤或上下文不同。',
          '',
          '| 層級 | 變動 | 依賴方 | 被依賴方 | 標籤 | 跨界 |',
          '| --- | --- | --- | --- | --- | --- |',
          ...changed.flatMap((report) => [
            ...report.added.map((edge) => edgeRow(report, '新增', edge)),
            ...report.removed.map((edge) => edgeRow(report, '刪除', edge)),
          ]),
        ]),
    SECTION_END,
  ].join('\n');
}

// ---- Splicing the description ---------------------------------------------

/**
 * Replaces the marked section of a PR description, or appends it after a
 * blank line when the description has none. Every byte outside the markers
 * is kept; the section takes the description's line endings (CRLF when the
 * description has any), so a second splice of the same section is a no-op.
 */
export function spliceSection(body: string, section: string): string {
  const trimmed = section.replace(/\r?\n$/u, '');
  if (
    !trimmed.startsWith(SECTION_START) ||
    !trimmed.endsWith(SECTION_END) ||
    trimmed.split(SECTION_START).length !== 2 ||
    trimmed.split(SECTION_END).length !== 2
  ) {
    throw new Error(
      `The section must start with ${SECTION_START} and end with ${SECTION_END}, once each.`,
    );
  }
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const block = trimmed.replace(/\r?\n/gu, eol);
  const start = body.indexOf(SECTION_START);
  if (start >= 0) {
    const end = body.indexOf(SECTION_END, start + SECTION_START.length);
    if (end < 0) {
      throw new Error(
        `The description has ${SECTION_START} without ${SECTION_END} after it; fix the markers by hand.`,
      );
    }
    return body.slice(0, start) + block + body.slice(end + SECTION_END.length);
  }
  if (body === '') return block;
  return `${body}${body.endsWith('\n') ? eol : eol + eol}${block}`;
}

// ---- CLI ------------------------------------------------------------------

interface CliIo {
  readFile: (path: string) => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE =
  'Usage:\n' +
  '  node tools/architecture-diff.ts --base <base.json> --head <head.json> --changed-files <file> [--comment]\n' +
  '    Prints the PR description section (with --comment: the fallback comment).\n' +
  '    Both graphs are the JSON printed by tools/architecture-graph.ts; the changed\n' +
  '    files are one repo-relative path per line (git diff --name-only base...head).\n' +
  '  node tools/architecture-diff.ts --splice-body <body-file> --section <section-file>\n' +
  '    Prints the description with the section replaced or appended.\n';

const VALUE_FLAGS = [
  '--base',
  '--head',
  '--changed-files',
  '--splice-body',
  '--section',
] as const;

function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseGraph(path: string, text: string): ArchitectureGraph {
  // A file redirected by Windows PowerShell may start with a BOM.
  const graph = JSON.parse(withoutBom(text)) as Partial<ArchitectureGraph>;
  if (graph.schemaVersion !== 1 || !graph.levels) {
    throw new Error(`${path} is not an architecture graph (schemaVersion 1).`);
  }
  return graph as ArchitectureGraph;
}

/** One path per line; blank lines dropped, Windows separators normalized. */
export function parseChangedFiles(text: string): string[] {
  return withoutBom(text)
    .split(/\r?\n/u)
    .map((line) => line.trim().replaceAll('\\', '/'))
    .filter((line) => line !== '');
}

function parseArgs(
  argv: string[],
): { options: Map<string, string>; comment: boolean } | undefined {
  const options = new Map<string, string>();
  let comment = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--comment' && !comment) {
      comment = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !(VALUE_FLAGS as readonly string[]).includes(flag) ||
      !value ||
      options.has(flag)
    ) {
      return undefined;
    }
    options.set(flag, value);
    index += 1;
  }
  return { options, comment };
}

/** Returns the process exit code: 0 ok, 2 bad usage. */
export function runCli(argv: string[], io: CliIo): number {
  const parsed = parseArgs(argv);
  const flags = [...(parsed?.options.keys() ?? [])].sort().join(' ');
  if (parsed && !parsed.comment && flags === '--section --splice-body') {
    const body = io.readFile(parsed.options.get('--splice-body') as string);
    const section = withoutBom(
      io.readFile(parsed.options.get('--section') as string),
    );
    io.stdout(spliceSection(body, section));
    return 0;
  }
  if (!parsed || flags !== '--base --changed-files --head') {
    io.stderr(USAGE);
    return 2;
  }
  const read = (flag: string): [string, string] => {
    const path = parsed.options.get(flag) as string;
    return [path, io.readFile(path)];
  };
  const base = parseGraph(...read('--base'));
  const head = parseGraph(...read('--head'));
  const changedFiles = parseChangedFiles(read('--changed-files')[1]);
  const section = renderSection(analyzeLevels(base, head, changedFiles));
  io.stdout(
    parsed.comment ? `${COMMENT_MARKER}\n${section}\n` : `${section}\n`,
  );
  return 0;
}

// ---- Process boundary --------------------------------------------------------

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runCli(process.argv.slice(2), {
      readFile: (path) => readFileSync(path, 'utf8'),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch (error) {
    process.stderr.write(`architecture-diff: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
