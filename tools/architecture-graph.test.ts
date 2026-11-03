import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseSheriffModules,
  projectsLevel,
  renderDocs,
  renderMermaid,
  runCli,
  runHook,
  runtimeContextsLevel,
  uiModulesLevel,
} from './architecture-graph.ts';

test('projectsLevel keeps Nx projects, type tags and internal edges, sorted', () => {
  const level = projectsLevel({
    graph: {
      nodes: {
        'capture-ui': { data: { tags: ['scope:capture', 'type:lib'] } },
        'capture-app': { data: { tags: ['type:app', 'scope:capture'] } },
        'capture-e2e': { data: { tags: ['scope:capture'] } },
      },
      dependencies: {
        'capture-ui': [{ target: 'npm:rxjs' }, { target: 'capture-ui' }],
        'capture-app': [{ target: 'capture-ui' }, { target: 'capture-ui' }],
        'capture-e2e': [{ target: 'capture-app' }],
        'npm:rxjs': [{ target: 'capture-ui' }],
      },
    },
  });
  assert.deepEqual(level, {
    nodes: ['capture-app', 'capture-e2e', 'capture-ui'],
    edges: [
      ['capture-app', 'capture-ui'],
      ['capture-e2e', 'capture-app'],
    ],
    tags: { 'capture-app': 'type:app', 'capture-ui': 'type:lib' },
  });
});

test('runtimeContextsLevel collapses modules to top-level groups, drops self-edges, sorts', () => {
  const level = runtimeContextsLevel({
    package: 'capture_runtime',
    modules: [
      'capture_runtime',
      'capture_runtime.services',
      'capture_runtime.services.jobs',
      'capture_runtime.ocr_compute',
      'capture_runtime.ocr_compute.engine',
      'capture_runtime.config',
    ],
    edges: [
      ['capture_runtime.services.jobs', 'capture_runtime.ocr_compute.engine'],
      ['capture_runtime.services.jobs', 'capture_runtime.ocr_compute'],
      ['capture_runtime.services.jobs', 'capture_runtime.services'],
      ['capture_runtime.ocr_compute.engine', 'capture_runtime.config'],
      ['capture_runtime.ocr_compute', 'capture_runtime.services.jobs'],
      ['capture_runtime', 'capture_runtime.services'],
    ],
  });
  assert.deepEqual(level, {
    nodes: [
      'capture_runtime.config',
      'capture_runtime.ocr_compute',
      'capture_runtime.services',
    ],
    edges: [
      ['capture_runtime.ocr_compute', 'capture_runtime.config'],
      ['capture_runtime.ocr_compute', 'capture_runtime.services'],
      ['capture_runtime.services', 'capture_runtime.ocr_compute'],
    ],
  });
});

test('parseSheriffModules reads the modules map without running the config', () => {
  const modules = parseSheriffModules(`
    import { SheriffConfig } from '@softarc/sheriff-core';
    export const config: SheriffConfig = {
      entryPoints: { app: 'src/main.ts' },
      modules: {
        'lib/src': ['ui:public-api'],
        'lib/src/components/<component>': ['ui:component', 'ui:shared'],
      },
      depRules: { root: ['ui:*'] },
    };
  `);
  assert.deepEqual(modules, {
    'lib/src': ['ui:public-api'],
    'lib/src/components/<component>': ['ui:component', 'ui:shared'],
  });
  assert.throws(
    () => parseSheriffModules('export const config = {};'),
    /no `modules`/u,
  );
});

test('uiModulesLevel computes module edges from imports of an in-memory module map', () => {
  const level = uiModulesLevel({
    modules: {
      'lib/src': ['ui:public-api'],
      'lib/src/components/<component>': ['ui:component'],
      'lib/src/contracts': ['ui:contract'],
      'sdk/src': ['sdk'],
    },
    sources: {
      'lib/src/index.ts': "export * from './components/button/button.ts';",
      'lib/src/components/button/button.ts': [
        "import { Contract } from '../../contracts/contract.ts';",
        "import { Card } from '../card/card.ts';",
        "import { local } from './local.ts';",
        "import '@angular/core';",
      ].join('\n'),
      'lib/src/components/button/local.ts': 'export const local = 1;',
      'lib/src/components/card/card.ts': [
        "import { Client } from '@gx/sdk';",
        "import type { Contract } from '../../contracts/contract';",
        "export const lazy = () => import('@gx/sdk');",
      ].join('\n'),
      'lib/src/contracts/contract.ts': 'export interface Contract {}',
      'sdk/src/index.ts': 'export class Client {}',
      'shell/main.ts': "import { Button } from '@gx/ui';",
    },
    aliases: {
      '@gx/sdk': ['sdk/src/index.ts'],
      '@gx/ui': ['lib/src/index.ts'],
    },
  });
  assert.deepEqual(level, {
    nodes: [
      'lib/src',
      'lib/src/components/button',
      'lib/src/components/card',
      'lib/src/contracts',
      'root',
      'sdk/src',
    ],
    edges: [
      ['lib/src', 'lib/src/components/button'],
      ['lib/src/components/button', 'lib/src/components/card'],
      ['lib/src/components/button', 'lib/src/contracts'],
      ['lib/src/components/card', 'lib/src/contracts'],
      ['lib/src/components/card', 'sdk/src'],
      ['root', 'lib/src'],
    ],
    tags: {
      'lib/src': 'ui:public-api',
      'lib/src/components/button': 'ui:component',
      'lib/src/components/card': 'ui:component',
      'lib/src/contracts': 'ui:contract',
      root: 'root',
      'sdk/src': 'sdk',
    },
  });
});

test('renderMermaid is stable and keeps ids unique', () => {
  const level = {
    nodes: ['app', 'lib-a', 'lib_a'],
    edges: [
      ['app', 'lib-a'],
      ['app', 'lib_a'],
    ] as [string, string][],
    tags: { app: 'type:app', 'lib-a': 'type:lib' },
  };
  const expected = [
    'flowchart LR',
    '  n_app["app<br/>type:app"]',
    '  n_lib_a["lib-a<br/>type:lib"]',
    '  n_lib_a_2["lib_a"]',
    '  n_app --> n_lib_a',
    '  n_app --> n_lib_a_2',
  ].join('\n');
  assert.equal(renderMermaid(level), expected);
  assert.equal(renderMermaid(level), expected);
});

test('renderMermaid draws removed edges dashed and labelled after the level edges', () => {
  const level = {
    nodes: ['app', 'lib', 'old'],
    edges: [['app', 'lib']] as [string, string][],
  };
  assert.equal(
    renderMermaid(level, [['app', 'old']]),
    [
      'flowchart LR',
      '  n_app["app"]',
      '  n_lib["lib"]',
      '  n_old["old"]',
      '  n_app --> n_lib',
      '  n_app -. removed .-> n_old',
    ].join('\n'),
  );
});

const graph = {
  schemaVersion: 1 as const,
  levels: {
    projects: {
      nodes: ['a', 'b'],
      edges: [['a', 'b']] as [string, string][],
      tags: { a: 'type:app', b: 'type:lib' },
    },
    runtimeContexts: {
      nodes: ['capture_runtime.config', 'capture_runtime.services'],
      edges: [['capture_runtime.services', 'capture_runtime.config']] as [
        string,
        string,
      ][],
    },
    uiModules: {
      nodes: ['root'],
      edges: [] as [string, string][],
      tags: { root: 'root' },
    },
  },
};

test('renderDocs starts each file with the generated notice and ends with a newline', () => {
  const docs = renderDocs(graph);
  assert.deepEqual(
    docs.map((doc) => doc.path),
    [
      'docs/architecture/projects.md',
      'docs/architecture/runtime-contexts.md',
      'docs/architecture/ui-modules.md',
    ],
  );
  for (const doc of docs) {
    assert.equal(
      doc.content.split('\n')[0],
      '<!-- Generated by tools/architecture-graph.ts --write. Do not edit by hand. -->',
    );
    assert.match(doc.content, /```mermaid\nflowchart LR\n/u);
    assert.ok(doc.content.endsWith('```\n'));
  }
  assert.deepEqual(renderDocs(graph), docs);
});

function fakeIo(files: Map<string, string>) {
  const out = { stdout: '', stderr: '' };
  const io = {
    collectGraph: () => graph,
    readDoc: (path: string) => files.get(path),
    writeDoc: (path: string, content: string) => void files.set(path, content),
    stdout: (text: string) => void (out.stdout += text),
    stderr: (text: string) => void (out.stderr += text),
  };
  const roots: (string | undefined)[] = [];
  const open = (root: string | undefined) => {
    roots.push(root);
    return io;
  };
  return { open, out, roots };
}

test('--check passes after --write and tolerates CRLF checkouts', () => {
  const files = new Map<string, string>();
  assert.equal(runCli(['--write'], fakeIo(files).open), 0);
  assert.equal(files.size, 3);
  const { open, out } = fakeIo(
    new Map(
      [...files].map(([path, content]) => [
        path,
        content.replaceAll('\n', '\r\n'),
      ]),
    ),
  );
  assert.equal(runCli(['--check'], open), 0);
  assert.equal(out.stderr, '');
});

test('--check reports a stale and a missing file with the fix command', () => {
  const files = new Map<string, string>();
  runCli(['--write'], fakeIo(files).open);
  files.set('docs/architecture/projects.md', 'edited by hand\n');
  files.delete('docs/architecture/ui-modules.md');
  const { open, out } = fakeIo(files);
  assert.equal(runCli(['--check'], open), 1);
  assert.match(out.stderr, /docs\/architecture\/projects\.md/u);
  assert.match(out.stderr, /docs\/architecture\/ui-modules\.md/u);
  assert.doesNotMatch(out.stderr, /runtime-contexts/u);
  assert.match(out.stderr, /pnpm run architecture:update/u);
});

test('runCli prints the JSON graph by default and rejects bad usage', () => {
  const { open, out } = fakeIo(new Map());
  assert.equal(runCli([], open), 0);
  assert.deepEqual(JSON.parse(out.stdout), graph);
  const bad = fakeIo(new Map());
  assert.equal(runCli(['--write', '--check'], bad.open), 2);
  assert.equal(runCli(['--nope'], bad.open), 2);
  assert.equal(runCli(['--root'], bad.open), 2);
  assert.match(bad.out.stderr, /Usage:/u);
});

function hookChecks(
  results: { docs?: number; exceptions?: number; runtime?: number } = {},
) {
  const ran: string[] = [];
  const check =
    (name: string, result = 0) =>
    () => {
      ran.push(name);
      return result;
    };
  return {
    ran,
    checks: {
      checkDocs: check('docs', results.docs),
      checkExceptions: check('exceptions', results.exceptions),
      lintRuntime: check('runtime', results.runtime),
    },
  };
}

test('runHook skips everything when no architecture-relevant path changed', () => {
  for (const changed of [
    [],
    ['docs/a.md', 'README.md'],
    ['apps/web/a.component.html'],
  ]) {
    const { ran, checks } = hookChecks({ docs: 1 });
    assert.equal(runHook(false, changed, checks), 0);
    assert.deepEqual(ran, []);
  }
});

test('runHook stops after one round of feedback', () => {
  const { ran, checks } = hookChecks({ docs: 1 });
  assert.equal(runHook(true, ['tools/a.ts'], checks), 0);
  assert.deepEqual(ran, []);
});

test('runHook runs the docs check and exception gate for TypeScript and config changes', () => {
  for (const changed of [
    ['packages/ui/src/lib/a.ts'],
    ['apps/capture-workbench/project.json'],
    ['tsconfig.base.json'],
    ['packages/ui/eslint-suppressions.json'],
  ]) {
    const { ran, checks } = hookChecks();
    assert.equal(runHook(false, changed, checks), 0);
    assert.deepEqual(ran, ['docs', 'exceptions']);
  }
});

test('runHook adds the runtime contracts for runtime Python or importlinter.toml changes', () => {
  for (const changed of [
    ['packages/capture-runtime/src/capture_runtime/config.py'],
    ['packages\\capture-runtime\\importlinter.toml'],
    ['old.py -> packages/capture-runtime/src/capture_runtime/new.py'],
  ]) {
    const { ran, checks } = hookChecks();
    assert.equal(runHook(false, changed, checks), 0);
    assert.deepEqual(ran, ['docs', 'exceptions', 'runtime']);
  }
  const tests = hookChecks();
  runHook(
    false,
    ['packages/capture-runtime/tests/unit/test_x.py'],
    tests.checks,
  );
  assert.deepEqual(tests.ran, ['docs', 'exceptions']);
});

test('runHook reports every failing check with exit 2', () => {
  const { ran, checks } = hookChecks({ exceptions: 1 });
  assert.equal(
    runHook(
      false,
      ['packages/capture-runtime/src/capture_runtime/a.py'],
      checks,
    ),
    2,
  );
  assert.deepEqual(ran, ['docs', 'exceptions', 'runtime']);
});

test('--root opens the IO for that directory; without it the IO is for this checkout', () => {
  const fake = fakeIo(new Map());
  assert.equal(runCli(['--root', '../base'], fake.open), 0);
  assert.equal(runCli([], fake.open), 0);
  assert.deepEqual(fake.roots, ['../base', undefined]);
  assert.equal(runCli(['--root', 'a', '--root', 'b'], fake.open), 2);
});
