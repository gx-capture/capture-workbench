import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseSheriffModules,
  projectsLevel,
  renderDocs,
  renderMermaid,
  runCli,
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
  return { io, out };
}

test('--check passes after --write and tolerates CRLF checkouts', () => {
  const files = new Map<string, string>();
  assert.equal(runCli(['--write'], fakeIo(files).io), 0);
  assert.equal(files.size, 3);
  const { io, out } = fakeIo(
    new Map(
      [...files].map(([path, content]) => [
        path,
        content.replaceAll('\n', '\r\n'),
      ]),
    ),
  );
  assert.equal(runCli(['--check'], io), 0);
  assert.equal(out.stderr, '');
});

test('--check reports a stale and a missing file with the fix command', () => {
  const files = new Map<string, string>();
  runCli(['--write'], fakeIo(files).io);
  files.set('docs/architecture/projects.md', 'edited by hand\n');
  files.delete('docs/architecture/ui-modules.md');
  const { io, out } = fakeIo(files);
  assert.equal(runCli(['--check'], io), 1);
  assert.match(out.stderr, /docs\/architecture\/projects\.md/u);
  assert.match(out.stderr, /docs\/architecture\/ui-modules\.md/u);
  assert.doesNotMatch(out.stderr, /runtime-contexts/u);
  assert.match(out.stderr, /pnpm run architecture:update/u);
});

test('runCli prints the JSON graph by default and rejects bad usage', () => {
  const { io, out } = fakeIo(new Map());
  assert.equal(runCli([], io), 0);
  assert.deepEqual(JSON.parse(out.stdout), graph);
  const bad = fakeIo(new Map());
  assert.equal(runCli(['--write', '--check'], bad.io), 2);
  assert.equal(runCli(['--nope'], bad.io), 2);
  assert.match(bad.out.stderr, /Usage:/u);
});
