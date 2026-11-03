import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ArchitectureGraph } from './architecture-graph.ts';
import {
  ISSUES_QUERY,
  PAGE_NAMES,
  parseIssues,
  readyToStart,
  renderPages,
  renderWorkPlan,
  runCli,
} from './wiki-overview.ts';

const REPO = 'acme/widgets';

interface IssueSpec {
  number: number;
  title?: string;
  state?: 'OPEN' | 'CLOSED';
  labels?: string[];
  issueType?: string;
  parent?: number | { repo: string; number: number };
  subIssues?: number;
  blockedBy?: (number | { repo: string; number: number; state: string })[];
}

function url(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

/** One GraphQL issue node; blockers in this repo take their state from `all`. */
function node(spec: IssueSpec, all: IssueSpec[]): unknown {
  const blockers = (spec.blockedBy ?? []).map((blocker) => {
    if (typeof blocker === 'number') {
      const target = all.find((issue) => issue.number === blocker);
      return {
        number: blocker,
        title: target?.title ?? `Issue ${blocker}`,
        url: url(REPO, blocker),
        state: target?.state ?? 'OPEN',
        repository: { nameWithOwner: REPO },
      };
    }
    return {
      number: blocker.number,
      title: `External ${blocker.number}`,
      url: url(blocker.repo, blocker.number),
      state: blocker.state,
      repository: { nameWithOwner: blocker.repo },
    };
  });
  const parent =
    spec.parent === undefined
      ? null
      : typeof spec.parent === 'number'
        ? { number: spec.parent, repository: { nameWithOwner: REPO } }
        : {
            number: spec.parent.number,
            repository: { nameWithOwner: spec.parent.repo },
          };
  return {
    number: spec.number,
    title: spec.title ?? `Issue ${spec.number}`,
    url: url(REPO, spec.number),
    state: spec.state ?? 'OPEN',
    issueType: spec.issueType ? { name: spec.issueType } : null,
    labels: { nodes: (spec.labels ?? []).map((name) => ({ name })) },
    parent,
    subIssues: { totalCount: spec.subIssues ?? 0 },
    blockedBy: { totalCount: blockers.length, nodes: blockers },
  };
}

/** `gh api graphql --paginate --slurp` output: pages of `perPage` issues. */
function slurp(specs: IssueSpec[], perPage = 100): unknown[] {
  const pages: unknown[] = [];
  for (let start = 0; start < specs.length; start += perPage) {
    pages.push({
      data: {
        repository: {
          nameWithOwner: REPO,
          issues: {
            pageInfo: {
              hasNextPage: start + perPage < specs.length,
              endCursor: 'x',
            },
            nodes: specs
              .slice(start, start + perPage)
              .map((spec) => node(spec, specs)),
          },
        },
      },
    });
  }
  return pages;
}

const plan: IssueSpec[] = [
  { number: 1, title: 'Epic: runtime', labels: ['epic'], subIssues: 4 },
  { number: 2, title: 'Done first', state: 'CLOSED', parent: 1 },
  { number: 3, title: 'Blocked by a closed one', parent: 1, blockedBy: [2] },
  { number: 4, title: 'Blocked by an open one', parent: 1, blockedBy: [3, 9] },
  { number: 5, title: 'No blockers', parent: 1 },
  { number: 6, title: 'Epic by type', issueType: 'Epic' },
  { number: 7, title: 'Loose and free', labels: ['bug'] },
  { number: 8, title: 'Loose but blocked', blockedBy: [7] },
  { number: 9, title: 'In another epic', parent: 6 },
  {
    number: 10,
    title: 'Blocked elsewhere',
    blockedBy: [{ repo: 'acme/other', number: 3, state: 'OPEN' }],
  },
  {
    number: 11,
    title: 'Old epic',
    labels: ['Epic'],
    state: 'CLOSED',
    subIssues: 1,
  },
  { number: 12, title: 'Done in old epic', state: 'CLOSED', parent: 11 },
];

const graph: ArchitectureGraph = {
  schemaVersion: 1,
  levels: {
    projects: {
      nodes: ['app', 'lib'],
      edges: [['app', 'lib']],
      tags: { app: 'type:app', lib: 'type:lib' },
      label: 'Nx 專案',
    },
    modules: { nodes: ['a', 'b'], edges: [['b', 'a']] },
  },
};

function section(page: string, heading: string): string {
  const start = page.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const next = page.indexOf('\n## ', start + 1);
  return page.slice(start, next === -1 ? undefined : next);
}

test('the query paginates issues with everything the parser reads', () => {
  assert.match(ISSUES_QUERY, /\$endCursor: String/u);
  assert.match(ISSUES_QUERY, /after: \$endCursor/u);
  assert.match(ISSUES_QUERY, /pageInfo \{ hasNextPage endCursor \}/u);
  // The fixture nodes mirror the query's fields; parsing them proves the fit.
  assert.equal(parseIssues(slurp(plan, 5)).issues.length, plan.length);
});

test('ready-to-start work has only closed blockers and is never an epic', () => {
  const set = parseIssues(slurp(plan, 5));
  assert.deepEqual(
    readyToStart(set).map((issue) => issue.number),
    [3, 5, 7, 9],
  );
});

test('epics come from the epic label, the Epic type or sub-issues', () => {
  const set = parseIssues(
    slurp([
      { number: 1, labels: ['EPIC'] },
      { number: 2, issueType: 'Epic' },
      { number: 3, subIssues: 2 },
      { number: 4 },
    ]),
  );
  assert.deepEqual(
    set.issues.map((issue) => [issue.number, issue.epic]),
    [
      [1, true],
      [2, true],
      [3, true],
      [4, false],
    ],
  );
});

test('the parser rejects query errors and cut-short blocker lists', () => {
  assert.throws(
    () => parseIssues({ errors: [{ message: 'bad' }] }),
    /query failed/u,
  );
  const pages = slurp([{ number: 1, blockedBy: [2] }, { number: 2 }]) as {
    data: {
      repository: {
        issues: { nodes: { blockedBy: { totalCount: number } }[] };
      };
    };
  }[];
  pages[0].data.repository.issues.nodes[0].blockedBy.totalCount = 101;
  assert.throws(() => parseIssues(pages), /more blockers/u);
});

test('the ready table lists issue, title and epic', () => {
  const page = renderWorkPlan(parseIssues(slurp(plan)));
  const ready = section(page, '可以開始的工作');
  const rows = ready.split('\n').filter((line) => line.startsWith('| ['));
  assert.deepEqual(rows, [
    `| [#3](${url(REPO, 3)}) | Blocked by a closed one | [#1](${url(REPO, 1)}) Epic: runtime |`,
    `| [#5](${url(REPO, 5)}) | No blockers | [#1](${url(REPO, 1)}) Epic: runtime |`,
    `| [#7](${url(REPO, 7)}) | Loose and free | — |`,
    `| [#9](${url(REPO, 9)}) | In another epic | [#6](${url(REPO, 6)}) Epic by type |`,
  ]);
});

test('each epic diagram draws open sub-issues with blocked-by edges and click lines', () => {
  const page = renderWorkPlan(parseIssues(slurp(plan)));
  const diagrams = [...page.matchAll(/```mermaid\n([\s\S]*?)\n```/gu)].map(
    (match) => match[1],
  );
  assert.equal(
    diagrams.length,
    2,
    'epics #1 and #6; the closed epic #11 is hidden',
  );
  assert.deepEqual(diagrams[0].split('\n'), [
    'flowchart LR',
    '  n__3["#35;3 Blocked by a closed one"]',
    '  n__4["#35;4 Blocked by an open one"]',
    '  n__5["#35;5 No blockers"]',
    '  n__9["#35;9 In another epic"]',
    '  n__3 --> n__4',
    '  n__9 --> n__4',
    `  click n__3 "${url(REPO, 3)}"`,
    `  click n__4 "${url(REPO, 4)}"`,
    `  click n__5 "${url(REPO, 5)}"`,
    `  click n__9 "${url(REPO, 9)}"`,
    '  classDef ready stroke:#1a7f37,stroke-width:3px',
    '  class n__3,n__5 ready',
    '  classDef external stroke-dasharray:5 5',
    '  class n__9 external',
  ]);
  assert.match(page, /未完成 3 個子 issue；已完成 1 個（未畫出）。/u);
  assert.match(page, /另有 1 個已完成的 epic（未列出）。/u);
  assert.doesNotMatch(diagrams[0], /n__2\b/u, 'closed sub-issues are omitted');
});

test('issues without an epic are listed with their open blockers', () => {
  const page = renderWorkPlan(parseIssues(slurp(plan)));
  const loose = section(page, '不屬於任何 epic 的 issue');
  assert.match(loose, /\| \[#7\]\([^)]+\) \| Loose and free \| 可以開始 \|/u);
  assert.match(loose, /\| \[#8\]\([^)]+\) \| Loose but blocked \| 被 \[#7\]/u);
  assert.match(
    loose,
    /\| \[#10\]\([^)]+\) \| Blocked elsewhere \| 被 \[acme\/other#3\]\(https:\/\/github\.com\/acme\/other\/issues\/3\) 擋住 \|/u,
  );
  assert.doesNotMatch(loose, /#6\]/u, 'epics are not loose issues');
});

test('titles are escaped in Mermaid labels and Markdown cells', () => {
  const title = 'Fix "quotes" [x] <b>|</b> & `tick` #2\nnext';
  const page = renderWorkPlan(
    parseIssues(
      slurp([
        { number: 1, labels: ['epic'], subIssues: 1 },
        { number: 2, title, parent: 1 },
      ]),
    ),
  );
  assert.ok(
    page.includes(
      '  n__2["#35;2 Fix #quot;quotes#quot; [x] #lt;b#gt;|#lt;/b#gt; #amp; #96;tick#96; #35;2 next"]',
    ),
    page,
  );
  assert.ok(
    page.includes(
      '| Fix "quotes" \\[x\\] &lt;b&gt;\\|&lt;/b&gt; &amp; \\`tick\\` #2 next |',
    ),
    page,
  );
});

test('every page starts with the do-not-edit header and a hidden marker', () => {
  const pages = renderPages({
    issues: parseIssues(slurp(plan)),
    graph,
    commit: '0123456789abcdef',
    generatedAt: '2026-11-03T00:00:00.000Z',
  });
  assert.deepEqual(
    pages.map((page) => page.name),
    [PAGE_NAMES.home, PAGE_NAMES.workPlan, PAGE_NAMES.architecture],
  );
  for (const page of pages) {
    const lines = page.content.split('\n');
    assert.equal(lines[0], '> 自動生成，請勿手動編輯。', page.name);
    assert.match(
      lines[1],
      /tools\/wiki-overview\.ts.*\.github\/workflows\/wiki-overview\.yml/u,
    );
    assert.match(page.content, /<!-- 自動生成，請勿手動編輯。.*-->/u);
  }
  const [home, , architecture] = pages;
  assert.match(home.content, /\[\[工作計畫\]\]/u);
  assert.match(home.content, /\[\[架構總覽\]\]/u);
  assert.match(
    home.content,
    /生成時間：2026-11-03T00:00:00\.000Z・來源 commit：\[`0123456`\]\(https:\/\/github\.com\/acme\/widgets\/commit\/0123456789abcdef\)/u,
  );
  assert.match(
    architecture.content,
    /## Nx 專案\n\n```mermaid\nflowchart LR\n {2}n_app\["app<br\/>type:app"\]/u,
  );
  assert.match(architecture.content, /## modules\n/u);
  assert.match(
    architecture.content,
    /\(https:\/\/github\.com\/acme\/widgets\/tree\/HEAD\/docs\/architecture\)/u,
  );
});

test('the output does not depend on input order', () => {
  const render = (specs: IssueSpec[]): string =>
    renderWorkPlan(parseIssues(slurp(specs, 4)));
  assert.equal(render([...plan].reverse()), render(plan));
  assert.equal(render(plan), render(plan));
});

function memoryIo(files: Record<string, string>, now: string) {
  const pages = new Map<string, string>();
  const output: string[] = [];
  let clock = now;
  return {
    pages,
    output,
    setNow: (value: string) => {
      clock = value;
    },
    io: {
      readFile: (path: string) => {
        const content = files[path];
        if (content === undefined) throw new Error(`no ${path}`);
        return content;
      },
      readPage: (directory: string, name: string) =>
        pages.get(`${directory}/${name}`),
      writePage: (directory: string, name: string, content: string) => {
        pages.set(`${directory}/${name}`, content);
      },
      now: () => clock,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    },
  };
}

test('the CLI rewrites pages only when more than the generated time changed', () => {
  const files: Record<string, string> = {
    'issues.json': JSON.stringify(slurp(plan)),
    'graph.json': `\uFEFF${JSON.stringify(graph)}`,
  };
  const memory = memoryIo(files, '2026-11-03T00:00:00.000Z');
  const argv = [
    '--issues',
    'issues.json',
    '--graph',
    'graph.json',
    '--out',
    'wiki',
    '--commit',
    'abcdef0123',
  ];
  assert.equal(runCli(argv, memory.io), 0);
  assert.deepEqual(
    [...memory.pages.keys()],
    ['wiki/Home', 'wiki/工作計畫', 'wiki/架構總覽'],
  );
  const firstHome = memory.pages.get('wiki/Home');

  memory.setNow('2026-11-04T00:00:00.000Z');
  assert.equal(runCli(argv, memory.io), 0);
  assert.equal(
    memory.pages.get('wiki/Home'),
    firstHome,
    'a new time alone is no change',
  );
  assert.match(memory.output.at(-1) ?? '', /up to date/u);

  files['issues.json'] = JSON.stringify(
    slurp(
      plan.map((spec) =>
        spec.number === 3 ? { ...spec, state: 'CLOSED' as const } : spec,
      ),
    ),
  );
  assert.equal(runCli(argv, memory.io), 0);
  assert.match(
    memory.pages.get('wiki/Home') ?? '',
    /2026-11-04/u,
    'a real change refreshes the time too',
  );
  assert.match(memory.output.at(-1) ?? '', /changed: 工作計畫\./u);
});

test('the CLI prints the query and rejects bad usage', () => {
  const memory = memoryIo({}, 'now');
  assert.equal(runCli(['--print-query'], memory.io), 0);
  assert.equal(memory.output.join(''), ISSUES_QUERY);
  assert.equal(runCli(['--issues', 'a.json'], memory.io), 2);
  assert.equal(runCli(['--bogus', 'x'], memory.io), 2);
  assert.equal(memory.pages.size, 0);
});
