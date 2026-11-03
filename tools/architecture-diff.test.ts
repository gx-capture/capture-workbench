import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMMENT_MARKER,
  diffGraphs,
  renderDiffComment,
  runCli,
} from './architecture-diff.ts';

type Edge = [string, string];

function graph(levels: {
  projects?: Edge[];
  runtimeContexts?: Edge[];
  uiModules?: Edge[];
  projectTags?: Record<string, string>;
}) {
  const level = (edges: Edge[] = [], tags?: Record<string, string>) => ({
    nodes: [...new Set(edges.flat())].sort(),
    edges,
    ...(tags ? { tags } : {}),
  });
  return {
    schemaVersion: 1 as const,
    levels: {
      projects: level(levels.projects, levels.projectTags),
      runtimeContexts: level(levels.runtimeContexts),
      uiModules: level(levels.uiModules),
    },
  };
}

const base = graph({
  projects: [
    ['app', 'lib'],
    ['app', 'old-lib'],
  ],
  projectTags: { app: 'type:app', lib: 'type:lib', 'old-lib': 'type:lib' },
  runtimeContexts: [['rt.services', 'rt.config']],
  uiModules: [['root', 'lib/src']],
});

const head = graph({
  projects: [
    ['app', 'lib'],
    ['app', 'new-lib'],
  ],
  projectTags: { app: 'type:app', lib: 'type:lib', 'new-lib': 'type:util' },
  runtimeContexts: [
    ['rt.ocr', 'rt.config'],
    ['rt.services', 'rt.config'],
  ],
  uiModules: [['root', 'lib/src']],
});

test('diffGraphs reports added and removed edges per level', () => {
  const diffs = diffGraphs(base, head);
  assert.deepEqual(
    diffs.map(({ level, added, removed }) => ({ level, added, removed })),
    [
      {
        level: 'projects',
        added: [['app', 'new-lib']],
        removed: [['app', 'old-lib']],
      },
      {
        level: 'runtimeContexts',
        added: [['rt.ocr', 'rt.config']],
        removed: [],
      },
      { level: 'uiModules', added: [], removed: [] },
    ],
  );
  // A node the PR removed keeps its base label.
  assert.equal(diffs[0].tags['old-lib'], 'type:lib');
  assert.equal(diffs[0].tags['new-lib'], 'type:util');
});

test('the comment starts with the marker and tabulates each changed level', () => {
  const body = renderDiffComment(diffGraphs(base, head));
  assert.equal(body.split('\n')[0], COMMENT_MARKER);
  assert.equal(COMMENT_MARKER, '<!-- architecture-diff -->');
  assert.match(body, /\| 層級 \| 新增的依賴 \| 刪除的依賴 \|/u);
  assert.match(body, /\| Nx 專案 \| 1 \| 1 \|/u);
  assert.match(body, /\| UI 模組 \| 0 \| 0 \|/u);
  assert.match(
    body,
    /\| 新增 \| `app` \| `new-lib` \| `type:app` → `type:util` \|/u,
  );
  assert.match(
    body,
    /\| 刪除 \| `app` \| `old-lib` \| `type:app` → `type:lib` \|/u,
  );
  assert.match(body, /\| 新增 \| `rt\.ocr` \| `rt\.config` \| {2}\|/u);
  // Unchanged levels get a summary row but no section or diagram.
  assert.doesNotMatch(body, /### UI 模組/u);
  assert.equal(body.match(/```mermaid/gu)?.length, 2);
});

test('the Mermaid diagrams hold only the changed edges, removed ones dashed', () => {
  const body = renderDiffComment(diffGraphs(base, head));
  const diagrams = [...body.matchAll(/```mermaid\n([\s\S]*?)\n```/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(diagrams, [
    [
      'flowchart LR',
      '  n_app["app<br/>type:app"]',
      '  n_new_lib["new-lib<br/>type:util"]',
      '  n_old_lib["old-lib<br/>type:lib"]',
      '  n_app --> n_new_lib',
      '  n_app -. removed .-> n_old_lib',
    ].join('\n'),
    [
      'flowchart LR',
      '  n_rt_config["rt.config"]',
      '  n_rt_ocr["rt.ocr"]',
      '  n_rt_ocr --> n_rt_config',
    ].join('\n'),
  ]);
  // The unchanged app --> lib edge is not drawn.
  assert.doesNotMatch(body, /n_lib\b/u);
});

test('no dependency change gives the marker and one sentence', () => {
  assert.equal(
    renderDiffComment(diffGraphs(base, base)),
    `${COMMENT_MARKER}\n本 PR 沒有新增或刪除模組依賴。\n`,
  );
});

function fakeIo(files: Record<string, string>) {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      readFile: (path: string) => {
        if (!(path in files)) throw new Error(`missing ${path}`);
        return files[path];
      },
      stdout: (text: string) => void (out.stdout += text),
      stderr: (text: string) => void (out.stderr += text),
    },
  };
}

test('runCli reads both graphs (BOM tolerated) and prints the body', () => {
  const { io, out } = fakeIo({
    'base.json': `${String.fromCharCode(0xfeff)}${JSON.stringify(base)}`,
    'head.json': JSON.stringify(head),
  });
  assert.equal(runCli(['--head', 'head.json', '--base', 'base.json'], io), 0);
  assert.equal(out.stdout, renderDiffComment(diffGraphs(base, head)));
  assert.equal(out.stderr, '');
});

test('runCli rejects bad usage and files that are not graphs', () => {
  const { io, out } = fakeIo({ 'x.json': '{"schemaVersion":2}' });
  assert.equal(runCli([], io), 2);
  assert.equal(runCli(['--base', 'x.json'], io), 2);
  assert.equal(runCli(['--base', 'x.json', '--base', 'x.json'], io), 2);
  assert.equal(runCli(['--base', 'x.json', '--nope', 'x.json'], io), 2);
  assert.match(out.stderr, /Usage:/u);
  assert.throws(
    () => runCli(['--base', 'x.json', '--head', 'x.json'], io),
    /x\.json is not an architecture graph/u,
  );
});
