/**
 * Architecture diff: the Markdown body of the sticky pull request comment
 * that lists the dependency edges a PR adds and removes, at the three levels
 * of tools/architecture-graph.ts.
 *
 * Usage (from the repo root):
 *   node tools/architecture-diff.ts --base <base.json> --head <head.json>
 *
 * Both files are the default JSON output of tools/architecture-graph.ts. The
 * body starts with a hidden marker so the workflow
 * (.github/workflows/architecture-diff.yml) can find and update its own
 * comment instead of adding a new one on every push.
 *
 * The diff and render functions are pure; reading files and writing stdout
 * sit in the "process boundary" section at the end.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderMermaid,
  type ArchitectureGraph,
  type Edge,
  type GraphLevel,
} from './architecture-graph.ts';

export const COMMENT_MARKER = '<!-- architecture-diff -->';

type LevelName = keyof ArchitectureGraph['levels'];

const LEVEL_TITLES: Record<LevelName, string> = {
  projects: 'Nx 專案',
  runtimeContexts: 'Capture Runtime 上下文',
  uiModules: 'UI 模組',
};

interface LevelDiff {
  level: LevelName;
  added: Edge[];
  removed: Edge[];
  /** Endpoint labels (`type:*` or Sheriff tags), head first, base for nodes the PR removed. */
  tags: Record<string, string>;
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

/** Added and removed edges per level, in the fixed level order. */
export function diffGraphs(
  base: ArchitectureGraph,
  head: ArchitectureGraph,
): LevelDiff[] {
  return (Object.keys(LEVEL_TITLES) as LevelName[]).map((level) => {
    const before = base.levels[level];
    const after = head.levels[level];
    return {
      level,
      added: edgesMissingFrom(before, after),
      removed: edgesMissingFrom(after, before),
      tags: { ...before.tags, ...after.tags },
    };
  });
}

// ---- Markdown -------------------------------------------------------------

function cell(text: string): string {
  return `\`${text.replaceAll('|', '\\|').replaceAll('`', "'")}\``;
}

function edgeRow(
  change: string,
  [from, to]: Edge,
  tags: Record<string, string>,
): string {
  const fromTag = tags[from];
  const toTag = tags[to];
  const tagCell =
    fromTag || toTag ? `${cell(fromTag ?? '')} → ${cell(toTag ?? '')}` : '';
  return `| ${change} | ${cell(from)} | ${cell(to)} | ${tagCell} |`;
}

/** Only the changed edges and their endpoints: added solid, removed dashed. */
function changedEdgesMermaid(diff: LevelDiff): string {
  const nodes = new Set(
    [...diff.added, ...diff.removed].flatMap(([from, to]) => [from, to]),
  );
  const tags = Object.fromEntries(
    [...nodes].flatMap((node) =>
      diff.tags[node] ? [[node, diff.tags[node]]] : [],
    ),
  );
  return renderMermaid(
    {
      nodes: [...nodes].sort(),
      edges: diff.added,
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    },
    diff.removed,
  );
}

function renderLevel(diff: LevelDiff): string[] {
  return [
    `### ${LEVEL_TITLES[diff.level]}`,
    '',
    '| 變動 | 依賴方 | 被依賴方 | 標籤 |',
    '| --- | --- | --- | --- |',
    ...diff.added.map((edge) => edgeRow('新增', edge, diff.tags)),
    ...diff.removed.map((edge) => edgeRow('刪除', edge, diff.tags)),
    '',
    '```mermaid',
    changedEdgesMermaid(diff),
    '```',
    '',
  ];
}

/** The comment body; its first line is always {@link COMMENT_MARKER}. */
export function renderDiffComment(diffs: LevelDiff[]): string {
  const changed = diffs.filter(
    (diff) => diff.added.length > 0 || diff.removed.length > 0,
  );
  if (changed.length === 0) {
    return `${COMMENT_MARKER}\n本 PR 沒有新增或刪除模組依賴。\n`;
  }
  return [
    COMMENT_MARKER,
    '## 架構依賴變動',
    '',
    '`a --> b` 表示 a 依賴 b。圖中只畫有變動的邊：實線是新增，標示 removed 的虛線是刪除。',
    '',
    '| 層級 | 新增的依賴 | 刪除的依賴 |',
    '| --- | --- | --- |',
    ...diffs.map(
      (diff) =>
        `| ${LEVEL_TITLES[diff.level]} | ${diff.added.length} | ${diff.removed.length} |`,
    ),
    '',
    ...changed.flatMap(renderLevel),
  ].join('\n');
}

// ---- CLI ------------------------------------------------------------------

interface CliIo {
  readFile: (path: string) => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE =
  'Usage: node tools/architecture-diff.ts --base <base.json> --head <head.json>\n' +
  '  Both files are the JSON printed by tools/architecture-graph.ts.\n' +
  '  Prints the Markdown body of the pull request comment.\n';

function parseGraph(path: string, text: string): ArchitectureGraph {
  // A file redirected by Windows PowerShell may start with a BOM.
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const graph = JSON.parse(json) as Partial<ArchitectureGraph>;
  if (graph.schemaVersion !== 1 || !graph.levels) {
    throw new Error(`${path} is not an architecture graph (schemaVersion 1).`);
  }
  return graph as ArchitectureGraph;
}

/** Returns the process exit code: 0 ok, 2 bad usage. */
export function runCli(argv: string[], io: CliIo): number {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (
      (flag !== '--base' && flag !== '--head') ||
      !value ||
      options.has(flag)
    ) {
      io.stderr(USAGE);
      return 2;
    }
    options.set(flag, value);
  }
  const basePath = options.get('--base');
  const headPath = options.get('--head');
  if (!basePath || !headPath) {
    io.stderr(USAGE);
    return 2;
  }
  const base = parseGraph(basePath, io.readFile(basePath));
  const head = parseGraph(headPath, io.readFile(headPath));
  io.stdout(renderDiffComment(diffGraphs(base, head)));
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
