import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyzeLevels,
  COMMENT_MARKER,
  MAX_DIAGRAM_NODES,
  nodeForFile,
  parseChangedFiles,
  renderNeighbourhood,
  renderSection,
  runCli,
  SECTION_END,
  SECTION_START,
  selectNeighbourhood,
  spliceSection,
  touchedNodes,
} from './architecture-diff.ts';
import type { ArchitectureGraph, GraphLevel } from './architecture-graph.ts';

type Edge = [string, string];

function level(
  edges: Edge[],
  extra: Partial<GraphLevel> & { extraNodes?: string[] } = {},
): GraphLevel {
  const { extraNodes = [], ...rest } = extra;
  return {
    nodes: [...new Set([...edges.flat(), ...extraNodes])].sort(),
    edges,
    ...rest,
  };
}

const projectRoots = {
  '.': 'workspace',
  'apps/app': 'app',
  'libs/lib': 'lib',
  'libs/lib/nested': 'nested',
  'libs/old-lib': 'old-lib',
  'libs/new-lib': 'new-lib',
};

const uiLevel = level([['root', 'lib/src']], {
  roots: { shell: 'root', 'lib/src': 'lib/src' },
  label: 'UI 模組',
});

const base: ArchitectureGraph = {
  schemaVersion: 1,
  levels: {
    projects: level(
      [
        ['app', 'lib'],
        ['app', 'old-lib'],
      ],
      {
        tags: { app: 'type:app', lib: 'type:lib', 'old-lib': 'type:lib' },
        roots: projectRoots,
        label: 'Nx 專案',
        boundary: 'tag',
        extraNodes: ['workspace'],
      },
    ),
    runtime: level([['rt.services', 'rt.config']], {
      roots: {
        'src/rt/services': 'rt.services',
        'src/rt/config.py': 'rt.config',
      },
      label: 'Runtime 上下文',
      boundary: 'node',
    }),
    ui: uiLevel,
    retired: level([['x', 'y']], { label: '舊層級' }),
  },
};

const head: ArchitectureGraph = {
  schemaVersion: 1,
  levels: {
    projects: level(
      [
        ['app', 'lib'],
        ['app', 'new-lib'],
        ['new-lib', 'lib'],
      ],
      {
        tags: { app: 'type:app', lib: 'type:lib', 'new-lib': 'type:lib' },
        roots: projectRoots,
        label: 'Nx 專案',
        boundary: 'tag',
        extraNodes: ['workspace'],
      },
    ),
    runtime: level(
      [
        ['rt.ocr', 'rt.config'],
        ['rt.services', 'rt.config'],
      ],
      {
        roots: {
          'src/rt/ocr': 'rt.ocr',
          'src/rt/services': 'rt.services',
          'src/rt/config.py': 'rt.config',
        },
        label: 'Runtime 上下文',
        boundary: 'node',
      },
    ),
    ui: uiLevel,
  },
};

test('nodeForFile picks the longest root that is the file or one of its directories', () => {
  const projects = head.levels.projects;
  assert.equal(nodeForFile(projects, 'libs/lib/src/a.ts'), 'lib');
  assert.equal(nodeForFile(projects, 'libs/lib/nested/b.ts'), 'nested');
  assert.equal(nodeForFile(projects, 'libs/library/c.ts'), 'workspace');
  assert.equal(nodeForFile(projects, 'package.json'), 'workspace');
  const runtime = head.levels.runtime;
  assert.equal(nodeForFile(runtime, 'src/rt/config.py'), 'rt.config');
  assert.equal(
    nodeForFile(runtime, 'src/rt/services/jobs/queue.py'),
    'rt.services',
  );
  assert.equal(nodeForFile(runtime, 'src/rt/configuration.py'), undefined);
  assert.equal(nodeForFile({ nodes: [], edges: [] }, 'a.ts'), undefined);
});

test('touchedNodes maps files per level through head and base roots', () => {
  const files = [
    'libs/new-lib/index.ts',
    'libs/old-lib/index.ts', // deleted: only the base owns it
    'src/rt/ocr/engine.py',
    'shell/main.ts',
    'README.md',
  ];
  assert.deepEqual(
    touchedNodes(base.levels.projects, head.levels.projects, files),
    ['new-lib', 'old-lib', 'workspace'],
  );
  assert.deepEqual(
    touchedNodes(base.levels.runtime, head.levels.runtime, files),
    ['rt.ocr'],
  );
  assert.deepEqual(
    touchedNodes({ nodes: [], edges: [] }, head.levels.ui, files),
    ['root'],
  );
  // A root whose node is not in either graph (no files of it were scanned) is ignored.
  assert.deepEqual(
    touchedNodes(base.levels.projects, head.levels.projects, [
      'libs/lib/nested/x.ts',
    ]),
    [],
  );
});

test('analyzeLevels diffs edges per level in head order, then base-only levels', () => {
  const reports = analyzeLevels(base, head, ['apps/app/main.ts']);
  assert.deepEqual(
    reports.map(({ id, label, added, removed, touched }) => ({
      id,
      label,
      added,
      removed,
      touched,
    })),
    [
      {
        id: 'projects',
        label: 'Nx 專案',
        added: [
          ['app', 'new-lib'],
          ['new-lib', 'lib'],
        ],
        removed: [['app', 'old-lib']],
        touched: ['app'],
      },
      {
        id: 'runtime',
        label: 'Runtime 上下文',
        added: [['rt.ocr', 'rt.config']],
        removed: [],
        touched: [],
      },
      { id: 'ui', label: 'UI 模組', added: [], removed: [], touched: [] },
      {
        id: 'retired',
        label: '舊層級',
        added: [],
        removed: [['x', 'y']],
        touched: [],
      },
    ],
  );
  // A node the PR removed keeps its base label.
  assert.equal(reports[0].tags['old-lib'], 'type:lib');
});

test('selectNeighbourhood keeps touched nodes, one hop up and down, and changed edges', () => {
  const edges: Edge[] = [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['e', 'b'],
    ['x', 'y'],
  ];
  const hood = selectNeighbourhood({
    edges,
    touched: ['b'],
    added: [['x', 'y']],
    removed: [['b', 'z']],
  });
  assert.deepEqual(hood, {
    nodes: ['a', 'b', 'c', 'e', 'x', 'y', 'z'],
    edges: [
      ['a', 'b'],
      ['b', 'c'],
      ['e', 'b'],
      ['x', 'y'],
    ],
    removed: [['b', 'z']],
    omitted: 0,
  });
});

test(`selectNeighbourhood above ${MAX_DIAGRAM_NODES} nodes keeps touched nodes and changed edges only`, () => {
  const dependents: Edge[] = Array.from(
    { length: MAX_DIAGRAM_NODES },
    (_, i) => [`user${String(i).padStart(2, '0')}`, 'hub'],
  );
  const report = {
    edges: [...dependents, ['hub', 'new'] as Edge],
    touched: ['hub'],
    added: [['hub', 'new'] as Edge],
    removed: [['hub', 'gone'] as Edge],
  };
  const hood = selectNeighbourhood(report);
  assert.deepEqual(hood, {
    nodes: ['gone', 'hub', 'new'],
    edges: [['hub', 'new']],
    removed: [['hub', 'gone']],
    omitted: MAX_DIAGRAM_NODES,
  });
  assert.equal(
    selectNeighbourhood(report, 100).nodes.length,
    MAX_DIAGRAM_NODES + 3,
  );
});

test('renderNeighbourhood highlights touched nodes, labels changes and marks crossing edges', () => {
  const [projects] = analyzeLevels(base, head, ['libs/new-lib/index.ts']);
  const crossing = {
    ...projects,
    tags: { ...projects.tags, app: 'type:lib', lib: 'type:util' },
  };
  assert.equal(
    renderNeighbourhood(crossing, selectNeighbourhood(crossing)),
    [
      'flowchart LR',
      '  n_app["app<br/>type:lib"]',
      '  n_lib["lib<br/>type:util"]',
      '  n_new_lib["new-lib<br/>type:lib"]',
      '  n_old_lib["old-lib<br/>type:lib"]',
      '  n_app -->|added| n_new_lib',
      '  n_new_lib -->|added, crossing| n_lib',
      '  n_app -.->|removed| n_old_lib',
      '  classDef touched fill:#fff3bf,stroke:#f08c00,stroke-width:2px,color:#1f2328',
      '  class n_new_lib touched',
      '  linkStyle 1 stroke:#d1242f,stroke-width:3px',
    ].join('\n'),
  );
});

test('renderSection with nothing touched and no change is one line between the markers', () => {
  assert.equal(
    renderSection(analyzeLevels(head, head, [])),
    `${SECTION_START}\n本 PR 沒有改到架構圖上的任何節點，也沒有新增或刪除依賴。\n${SECTION_END}`,
  );
});

test('renderSection draws touched levels even without a dependency change', () => {
  const section = renderSection(analyzeLevels(head, head, ['src/rt/ocr/a.py']));
  assert.ok(section.startsWith(`${SECTION_START}\n## 架構\n`));
  assert.ok(section.endsWith(`\n${SECTION_END}`));
  assert.match(section, /### 動到的範圍/u);
  assert.match(section, /\| Runtime 上下文 \| 1 \| 0 \| 0 \|/u);
  assert.match(section, /#### Runtime 上下文\n\n動到：`rt\.ocr`/u);
  // The repo-wide Nx root owns every file too.
  assert.match(section, /#### Nx 專案\n\n動到：`workspace`/u);
  assert.equal(section.match(/```mermaid/gu)?.length, 2);
  assert.match(section, /### 依賴變動\n\n本 PR 沒有新增或刪除模組依賴。\n/u);
});

test('renderSection tabulates every changed edge with tags and boundary crossings', () => {
  const section = renderSection(
    analyzeLevels(base, head, ['apps/app/main.ts']),
  );
  assert.match(
    section,
    /\| 層級 \| 變動 \| 依賴方 \| 被依賴方 \| 標籤 \| 跨界 \|/u,
  );
  assert.match(
    section,
    /\| Nx 專案 \| 新增 \| `app` \| `new-lib` \| `type:app` → `type:lib` \| 是 \|/u,
  );
  assert.match(
    section,
    /\| Nx 專案 \| 新增 \| `new-lib` \| `lib` \| `type:lib` → `type:lib` \| {2}\|/u,
  );
  assert.match(section, /\| Nx 專案 \| 刪除 \| `app` \| `old-lib` \|/u);
  // Every runtime edge joins two groups.
  assert.match(
    section,
    /\| Runtime 上下文 \| 新增 \| `rt\.ocr` \| `rt\.config` \| {2}\| 是 \|/u,
  );
  // Levels with changed edges but no touched node still get a diagram.
  assert.match(
    section,
    /#### Runtime 上下文\n\n沒有動到的節點，只畫變動的邊。/u,
  );
  assert.doesNotMatch(section, /#### UI 模組/u);
});

const SECTION = `${SECTION_START}\nnew\n${SECTION_END}`;

test('spliceSection replaces only the marked section and is idempotent', () => {
  const body = `Author intro\n\n${SECTION_START}\nold\n${SECTION_END}\n\nAuthor footer ${SECTION_END}`;
  const spliced = spliceSection(body, `${SECTION}\n`);
  assert.equal(
    spliced,
    `Author intro\n\n${SECTION}\n\nAuthor footer ${SECTION_END}`,
  );
  assert.equal(spliceSection(spliced, SECTION), spliced);
});

test('spliceSection appends after a blank line when the section is absent', () => {
  assert.equal(spliceSection('Summary', SECTION), `Summary\n\n${SECTION}`);
  assert.equal(spliceSection('Summary\n', SECTION), `Summary\n\n${SECTION}`);
  assert.equal(spliceSection('', SECTION), SECTION);
  const appended = spliceSection('Summary', SECTION);
  assert.equal(spliceSection(appended, SECTION), appended);
});

test('spliceSection keeps CRLF descriptions byte-identical outside the markers', () => {
  const body = `Intro\r\n\r\n${SECTION_START}\r\nold\r\n${SECTION_END}\r\n- [ ] item\r\n`;
  const spliced = spliceSection(body, SECTION);
  assert.equal(
    spliced,
    `Intro\r\n\r\n${SECTION_START}\r\nnew\r\n${SECTION_END}\r\n- [ ] item\r\n`,
  );
  assert.equal(spliceSection(spliced, SECTION), spliced);
  assert.equal(
    spliceSection('Intro\r\nmore', SECTION),
    `Intro\r\nmore\r\n\r\n${SECTION_START}\r\nnew\r\n${SECTION_END}`,
  );
});

test('spliceSection refuses unbalanced markers and malformed sections', () => {
  assert.throws(
    () => spliceSection(`Intro\n${SECTION_START}\nauthor text`, SECTION),
    /without <!-- architecture:end --> after it/u,
  );
  assert.throws(() => spliceSection('Intro', 'no markers'), /must start with/u);
  assert.throws(
    () => spliceSection('Intro', `${SECTION}\n${SECTION}`),
    /once each/u,
  );
});

test('parseChangedFiles drops blank lines and normalizes separators', () => {
  assert.deepEqual(
    parseChangedFiles(`${String.fromCharCode(0xfeff)}a/b.ts\r\n\r\nc\\d.py\n`),
    ['a/b.ts', 'c/d.py'],
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

const graphFiles = {
  'base.json': `${String.fromCharCode(0xfeff)}${JSON.stringify(base)}`,
  'head.json': JSON.stringify(head),
  'changed.txt': 'apps/app/main.ts\n',
};

test('runCli prints the section, or the fallback comment with --comment', () => {
  const expected = renderSection(
    analyzeLevels(base, head, ['apps/app/main.ts']),
  );
  const section = fakeIo(graphFiles);
  assert.equal(
    runCli(
      [
        '--head',
        'head.json',
        '--changed-files',
        'changed.txt',
        '--base',
        'base.json',
      ],
      section.io,
    ),
    0,
  );
  assert.equal(section.out.stdout, `${expected}\n`);
  const comment = fakeIo(graphFiles);
  assert.equal(
    runCli(
      [
        '--base',
        'base.json',
        '--head',
        'head.json',
        '--changed-files',
        'changed.txt',
        '--comment',
      ],
      comment.io,
    ),
    0,
  );
  assert.equal(comment.out.stdout, `${COMMENT_MARKER}\n${expected}\n`);
  assert.equal(COMMENT_MARKER, '<!-- architecture-diff -->');
});

test('runCli --splice-body prints the new description without adding a newline', () => {
  const { io, out } = fakeIo({
    'body.md': 'Author text\r\n',
    'section.md': `${SECTION}\n`,
  });
  assert.equal(
    runCli(['--splice-body', 'body.md', '--section', 'section.md'], io),
    0,
  );
  assert.equal(
    out.stdout,
    `Author text\r\n\r\n${SECTION_START}\r\nnew\r\n${SECTION_END}`,
  );
});

test('runCli rejects bad usage and files that are not graphs', () => {
  const { io, out } = fakeIo({ 'x.json': '{"schemaVersion":2}', 'c.txt': '' });
  assert.equal(runCli([], io), 2);
  assert.equal(runCli(['--base', 'x.json', '--head', 'x.json'], io), 2);
  assert.equal(runCli(['--base', 'x.json', '--base', 'x.json'], io), 2);
  assert.equal(runCli(['--base', 'x.json', '--nope', 'x.json'], io), 2);
  assert.equal(runCli(['--splice-body', 'b.md'], io), 2);
  assert.equal(
    runCli(['--splice-body', 'b.md', '--section', 's.md', '--comment'], io),
    2,
  );
  assert.equal(
    runCli(['--splice-body', 'b.md', '--section', 's.md', '--base', 'x'], io),
    2,
  );
  assert.match(out.stderr, /Usage:/u);
  assert.throws(
    () =>
      runCli(
        ['--base', 'x.json', '--head', 'x.json', '--changed-files', 'c.txt'],
        io,
      ),
    /x\.json is not an architecture graph/u,
  );
});
