import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  javaPackagesLevel,
  parseArchitectureConfig,
  parseJavaDeclarations,
  parseSheriffModules,
  projectsLevel,
  pythonModulesLevel,
  renderDocs,
  renderMermaid,
  runCli,
  runHook,
  uiModulesLevel,
} from './architecture-graph.ts';

test('projectsLevel keeps Nx projects, type tags, roots and internal edges, sorted', () => {
  const level = projectsLevel({
    graph: {
      nodes: {
        'capture-ui': {
          data: { tags: ['scope:capture', 'type:lib'], root: 'libs/ui' },
        },
        'capture-app': {
          data: { tags: ['type:app', 'scope:capture'], root: 'apps/app' },
        },
        'capture-e2e': { data: { tags: ['scope:capture'], root: 'apps/e2e' } },
        workspace: { data: { root: '.' } },
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
    nodes: ['capture-app', 'capture-e2e', 'capture-ui', 'workspace'],
    edges: [
      ['capture-app', 'capture-ui'],
      ['capture-e2e', 'capture-app'],
    ],
    tags: { 'capture-app': 'type:app', 'capture-ui': 'type:lib' },
    roots: {
      '.': 'workspace',
      'apps/app': 'capture-app',
      'apps/e2e': 'capture-e2e',
      'libs/ui': 'capture-ui',
    },
    boundary: 'tag',
  });
});

test('projectsLevel labels nodes with the configured tag prefix', () => {
  const level = projectsLevel(
    {
      nodes: {
        web: { data: { tags: ['type:app', 'scope:web'], root: 'apps/web' } },
        engine: { data: { tags: ['scope:desktop'], root: 'apps/engine' } },
        tools: { data: { root: 'tools' } },
      },
      dependencies: { web: [{ target: 'engine' }] },
    },
    'scope:',
  );
  assert.deepEqual(level.tags, { engine: 'scope:desktop', web: 'scope:web' });
});

const pythonReport = {
  package: 'capture_runtime',
  modules: [
    'capture_runtime',
    'capture_runtime.services',
    'capture_runtime.services.jobs',
    'capture_runtime.services.jobs.queue',
    'capture_runtime.ocr_compute',
    'capture_runtime.ocr_compute.engine',
    'capture_runtime.config',
  ],
  edges: [
    ['capture_runtime.services.jobs', 'capture_runtime.ocr_compute.engine'],
    ['capture_runtime.services.jobs', 'capture_runtime.ocr_compute'],
    ['capture_runtime.services.jobs.queue', 'capture_runtime.services'],
    ['capture_runtime.ocr_compute.engine', 'capture_runtime.config'],
    ['capture_runtime.ocr_compute', 'capture_runtime.services.jobs'],
    ['capture_runtime', 'capture_runtime.services'],
  ] as [string, string][],
};
const pythonPackages = new Set([
  'capture_runtime.services',
  'capture_runtime.services.jobs',
  'capture_runtime.ocr_compute',
]);

test('pythonModulesLevel collapses modules to top-level groups, drops self-edges, sorts', () => {
  const level = pythonModulesLevel(pythonReport, {
    collapseDepth: 1,
    sourceDir: 'src',
    isPackage: (module) => pythonPackages.has(module),
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
    roots: {
      'src/capture_runtime/config.py': 'capture_runtime.config',
      'src/capture_runtime/ocr_compute': 'capture_runtime.ocr_compute',
      'src/capture_runtime/services': 'capture_runtime.services',
    },
    boundary: 'node',
  });
});

test('pythonModulesLevel collapses to a deeper level and tags nodes with their group', () => {
  const level = pythonModulesLevel(pythonReport, {
    collapseDepth: 2,
    groups: {
      'capture_runtime.services': 'jobs-context',
      'capture_runtime.ocr_compute': 'ocr-context',
    },
    sourceDir: 'src',
    isPackage: (module) => pythonPackages.has(module),
  });
  assert.deepEqual(level.nodes, [
    'capture_runtime.config',
    'capture_runtime.ocr_compute',
    'capture_runtime.ocr_compute.engine',
    'capture_runtime.services',
    'capture_runtime.services.jobs',
  ]);
  assert.deepEqual(level.edges, [
    ['capture_runtime.ocr_compute', 'capture_runtime.services.jobs'],
    ['capture_runtime.ocr_compute.engine', 'capture_runtime.config'],
    ['capture_runtime.services.jobs', 'capture_runtime.ocr_compute'],
    ['capture_runtime.services.jobs', 'capture_runtime.ocr_compute.engine'],
    ['capture_runtime.services.jobs', 'capture_runtime.services'],
  ]);
  assert.deepEqual(level.tags, {
    'capture_runtime.ocr_compute': 'ocr-context',
    'capture_runtime.ocr_compute.engine': 'ocr-context',
    'capture_runtime.services': 'jobs-context',
    'capture_runtime.services.jobs': 'jobs-context',
  });
  assert.equal(level.boundary, 'tag');
  assert.equal(
    level.roots?.['src/capture_runtime/services/jobs'],
    'capture_runtime.services.jobs',
  );
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

test('parseSheriffModules flattens nested module maps and single-string tags', () => {
  const modules = parseSheriffModules(`
    export const config: SheriffConfig = {
      enableBarrelLess: true,
      modules: {
        'apps/web/src/app': {
          'pages/<page>': ['layer:page'],
          stores: 'layer:store',
          '<context>': { feature: ['context:<context>', 'layer:feature'] },
        },
        'libs/ui/<component>/src': ['layer:shared-ui'],
      },
      depRules: { root: ['layer:*'] },
    };
  `);
  assert.deepEqual(modules, {
    'apps/web/src/app/pages/<page>': ['layer:page'],
    'apps/web/src/app/stores': ['layer:store'],
    'apps/web/src/app/<context>/feature': [
      'context:<context>',
      'layer:feature',
    ],
    'libs/ui/<component>/src': ['layer:shared-ui'],
  });
  assert.throws(
    () =>
      parseSheriffModules(
        'export const config = { modules: { a: () => ["x"] } };',
      ),
    /Unsupported Sheriff `modules` entry/u,
  );
});

test('uiModulesLevel fills <name> placeholders in tags with the matched directory', () => {
  const level = uiModulesLevel({
    modules: {
      'app/<context>/feature': ['context:<context>', 'layer:feature'],
      'app/<context>/data-<kind>': ['context:<context>', 'data:<kind>'],
    },
    sources: {
      'app/practice/feature/page.ts':
        "import { load } from '../data-http/load.ts';",
      'app/practice/data-http/load.ts': 'export const load = 1;',
      'app/practice/other/x.ts': 'export const x = 1;',
    },
    aliases: {},
    sourceRoots: ['app'],
  });
  assert.deepEqual(level.tags, {
    'app/practice/data-http': 'context:practice, data:http',
    'app/practice/feature': 'context:practice, layer:feature',
    root: 'root',
  });
  assert.deepEqual(level.edges, [
    ['app/practice/feature', 'app/practice/data-http'],
  ]);
});

test('uiModulesLevel takes the tags of the first matching pattern, as Sheriff does', () => {
  const level = uiModulesLevel({
    modules: {
      'app/components/ui': ['layer:ui'],
      'app/components/<component>': ['layer:component'],
    },
    sources: {
      'app/components/ui/button.ts': 'export const b = 1;',
      'app/components/card/card.ts': "import { b } from '../ui/button.ts';",
    },
    aliases: {},
  });
  assert.deepEqual(level.tags, {
    'app/components/card': 'layer:component',
    'app/components/ui': 'layer:ui',
  });
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
    sourceRoots: ['lib/src', 'sdk/src', 'shell'],
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
    // A source root that is also a module stays that module.
    roots: {
      'lib/src': 'lib/src',
      'lib/src/components/button': 'lib/src/components/button',
      'lib/src/components/card': 'lib/src/components/card',
      'lib/src/contracts': 'lib/src/contracts',
      'sdk/src': 'sdk/src',
      shell: 'root',
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

const config = parseArchitectureConfig({
  levels: [
    {
      id: 'projects',
      kind: 'nx',
      title: 'Nx projects',
      output: 'projects.md',
      intro: 'Projects.',
    },
    {
      id: 'runtimeContexts',
      kind: 'python',
      title: 'Runtime contexts',
      output: 'runtime-contexts.md',
      intro: 'Runtime.',
      package: 'capture_runtime',
      sourceDir: 'packages/capture-runtime/src',
    },
    {
      id: 'uiModules',
      kind: 'typescript',
      title: 'UI modules',
      output: 'ui-modules.md',
      intro: 'UI.',
      sheriffConfig: 'sheriff.config.ts',
      sourceRoots: ['packages/ui/src'],
    },
  ],
});

test('parseArchitectureConfig fills defaults for each level kind', () => {
  assert.deepEqual(
    config.levels.map((level) => ({ ...level, intro: undefined })),
    [
      {
        id: 'projects',
        kind: 'nx',
        title: 'Nx projects',
        label: 'Nx projects',
        output: 'projects.md',
        intro: undefined,
        tagPrefix: 'type:',
      },
      {
        id: 'runtimeContexts',
        kind: 'python',
        title: 'Runtime contexts',
        label: 'Runtime contexts',
        output: 'runtime-contexts.md',
        intro: undefined,
        package: 'capture_runtime',
        sourceDir: 'packages/capture-runtime/src',
        projectDir: '.',
        collapseDepth: 1,
        importLinter: 'import-linter==2.5.2',
      },
      {
        id: 'uiModules',
        kind: 'typescript',
        title: 'UI modules',
        label: 'UI modules',
        output: 'ui-modules.md',
        intro: undefined,
        sheriffConfig: 'sheriff.config.ts',
        tsconfig: 'tsconfig.base.json',
        sourceRoots: ['packages/ui/src'],
        exclude: [],
      },
    ],
  );
  const java = parseArchitectureConfig({
    levels: [
      {
        id: 'engine',
        kind: 'java',
        title: 'Engine packages',
        label: '引擎套件',
        output: 'engine.md',
        intro: 'Java.',
        sourceRoots: ['engine/src/main/java'],
        basePackage: 'com.example.engine',
        collapseDepth: 2,
      },
    ],
  });
  const inline = parseArchitectureConfig({
    levels: [
      {
        id: 'web',
        kind: 'typescript',
        title: 'Web modules',
        output: 'web.md',
        intro: 'Web.',
        modules: { 'web/src/app/features/<feature>': ['feature'] },
        sourceRoots: ['web/src'],
      },
      {
        id: 'projects',
        kind: 'nx',
        title: 'Nx',
        output: 'projects.md',
        intro: 'Nx.',
        tagPrefix: 'scope:',
      },
    ],
  });
  assert.deepEqual(
    inline.levels[0].kind === 'typescript' && inline.levels[0].modules,
    { 'web/src/app/features/<feature>': ['feature'] },
  );
  assert.equal(
    inline.levels[0].kind === 'typescript' && inline.levels[0].sheriffConfig,
    undefined,
  );
  assert.equal(
    inline.levels[1].kind === 'nx' && inline.levels[1].tagPrefix,
    'scope:',
  );
  assert.equal(java.levels[0].label, '引擎套件');
  assert.equal(
    java.levels[0].kind === 'java' && java.levels[0].collapseDepth,
    2,
  );
});

test('parseArchitectureConfig names the offending key in every error', () => {
  const nx = {
    id: 'projects',
    kind: 'nx',
    title: 'Nx projects',
    output: 'projects.md',
    intro: 'Projects.',
  };
  const python = {
    ...nx,
    id: 'runtime',
    kind: 'python',
    output: 'runtime.md',
    package: 'pkg',
    sourceDir: 'src',
  };
  const cases: [unknown, RegExp][] = [
    [[], /the config must be a JSON object/u],
    [{ levels: [] }, /config\.levels must be a non-empty array/u],
    [{ levels: [nx], extra: 1 }, /config\.extra is not a known key/u],
    [{ levels: [{ ...nx, kind: 'go' }] }, /levels\[0\]\.kind must be one of/u],
    [
      { levels: [{ ...nx, title: '' }] },
      /levels\[0\]\.title must be a non-empty string/u,
    ],
    [
      { levels: [{ ...nx, typo: true }] },
      /levels\[0\]\.typo is not a known key/u,
    ],
    [
      { levels: [{ ...nx, output: 'docs/x.md' }] },
      /levels\[0\]\.output must be a Markdown file name/u,
    ],
    [
      { levels: [{ ...nx, id: '1st' }] },
      /levels\[0\]\.id must be an identifier/u,
    ],
    [
      { levels: [nx, { ...nx, output: 'other.md' }] },
      /levels\[1\]\.id repeats "projects"/u,
    ],
    [
      { levels: [nx, { ...python, output: 'projects.md' }] },
      /levels\[1\]\.output repeats/u,
    ],
    [
      { levels: [{ ...python, sourceDir: '../outside' }] },
      /levels\[0\]\.sourceDir must be a repo-relative path/u,
    ],
    [
      { levels: [{ ...python, sourceDir: 'C:\\src' }] },
      /levels\[0\]\.sourceDir must be a repo-relative path/u,
    ],
    [
      { levels: [{ ...python, package: 'my-pkg' }] },
      /levels\[0\]\.package must be a dotted Python package name/u,
    ],
    [
      { levels: [{ ...python, collapseDepth: 0 }] },
      /levels\[0\]\.collapseDepth must be a positive integer/u,
    ],
    [
      { levels: [{ ...python, groups: { a: 1 } }] },
      /levels\[0\]\.groups\.a must be a non-empty string/u,
    ],
    [
      {
        levels: [
          { ...nx, kind: 'typescript', sheriffConfig: 's.ts', sourceRoots: [] },
        ],
      },
      /levels\[0\]\.sourceRoots must be a non-empty array/u,
    ],
    [
      { levels: [{ ...nx, tagPrefix: 'scope' }] },
      /levels\[0\]\.tagPrefix must be a tag prefix ending in `:`/u,
    ],
    [
      { levels: [{ ...nx, kind: 'typescript', sourceRoots: ['src'] }] },
      /levels\[0\] needs exactly one of `sheriffConfig`, `modules`/u,
    ],
    [
      {
        levels: [
          {
            ...nx,
            kind: 'typescript',
            sheriffConfig: 's.ts',
            modules: { src: ['a'] },
            sourceRoots: ['src'],
          },
        ],
      },
      /levels\[0\] needs exactly one of `sheriffConfig`, `modules`/u,
    ],
    [
      {
        levels: [
          {
            ...nx,
            kind: 'typescript',
            modules: { src: [] },
            sourceRoots: ['src'],
          },
        ],
      },
      /levels\[0\]\.modules\.src must be a non-empty array of strings/u,
    ],
    [
      { levels: [{ ...nx, kind: 'java', sourceRoots: ['src'] }] },
      /levels\[0\]\.basePackage must be a non-empty string/u,
    ],
  ];
  for (const [value, message] of cases) {
    assert.throws(
      () => parseArchitectureConfig(value),
      (error: Error) =>
        error.message.startsWith('architecture-graph.config.json: ') &&
        message.test(error.message),
      `expected ${message}`,
    );
  }
});

test("this repo's architecture-graph.config.json is valid", () => {
  const file = join(
    import.meta.dirname,
    '..',
    'architecture-graph.config.json',
  );
  const parsed = parseArchitectureConfig(
    JSON.parse(readFileSync(file, 'utf8')),
  );
  assert.ok(parsed.levels.length > 0);
});

test('parseJavaDeclarations reads package, static and wildcard imports, not comments or strings', () => {
  const declarations = parseJavaDeclarations(
    [
      '/* package com.fake; */',
      '// import com.fake.Commented;',
      'package com.example.engine.cases ;',
      '',
      'import java.util.List;',
      'import static com.example.engine.shared.Text.trim;',
      'import com.example.engine.evidence.*;',
      'import com.example . engine.shared.Ids;',
      '/*',
      ' * import com.example.engine.hidden.Block;',
      ' */',
      'class Case {',
      '  String a = "import com.example.engine.hidden.Str;";',
      '  String b = """',
      '      import com.example.engine.hidden.Text;',
      '      """;',
      "  char c = '\"';",
      '  String d = "\\" import com.example.engine.hidden.Escaped;";',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(declarations, {
    package: 'com.example.engine.cases',
    imports: [
      'java.util.List',
      'com.example.engine.shared.Text.trim',
      'com.example.engine.evidence',
      'com.example.engine.shared.Ids',
    ],
  });
  assert.deepEqual(parseJavaDeclarations('class Default {}'), {
    package: undefined,
    imports: [],
  });
});

test('javaPackagesLevel collapses packages and resolves static, wildcard and class imports', () => {
  const root = 'engine/src/main/java/com/example/engine';
  const level = javaPackagesLevel({
    basePackage: 'com.example.engine',
    collapseDepth: 1,
    sources: {
      [`${root}/Application.java`]: [
        'package com.example.engine;',
        'import com.example.engine.cases.api.CaseController;',
      ].join('\n'),
      [`${root}/cases/api/CaseController.java`]: [
        'package com.example.engine.cases.api;',
        'import com.example.engine.cases.domain.Case;',
        'import static com.example.engine.shared.Text.trim;',
        '// import com.example.engine.evidence.Exhibit;',
      ].join('\n'),
      [`${root}/cases/domain/Case.java`]: [
        'package com.example.engine.cases.domain;',
        'import com.example.engine.evidence.*;',
        'import org.springframework.stereotype.Service;',
      ].join('\n'),
      [`${root}/evidence/Exhibit.java`]: 'package com.example.engine.evidence;',
      [`${root}/shared/Text.java`]: 'package com.example.engine.shared;',
      'engine/src/main/java/org/other/Outside.java': [
        'package org.other;',
        'import com.example.engine.shared.Text;',
      ].join('\n'),
    },
  });
  assert.deepEqual(level, {
    nodes: [
      'com.example.engine',
      'com.example.engine.cases',
      'com.example.engine.evidence',
      'com.example.engine.shared',
    ],
    edges: [
      ['com.example.engine', 'com.example.engine.cases'],
      ['com.example.engine.cases', 'com.example.engine.evidence'],
      ['com.example.engine.cases', 'com.example.engine.shared'],
    ],
    roots: {
      [root]: 'com.example.engine',
      [`${root}/cases/api`]: 'com.example.engine.cases',
      [`${root}/cases/domain`]: 'com.example.engine.cases',
      [`${root}/evidence`]: 'com.example.engine.evidence',
      [`${root}/shared`]: 'com.example.engine.shared',
    },
  });
  const deeper = javaPackagesLevel({
    basePackage: 'com.example.engine',
    collapseDepth: 2,
    sources: {
      [`${root}/cases/api/A.java`]:
        'package com.example.engine.cases.api;\nimport com.example.engine.cases.domain.B;',
      [`${root}/cases/domain/B.java`]:
        'package com.example.engine.cases.domain;',
    },
  });
  assert.deepEqual(deeper.edges, [
    ['com.example.engine.cases.api', 'com.example.engine.cases.domain'],
  ]);
});

test('renderDocs writes one doc per configured level with its title and intro', () => {
  const docs = renderDocs(graph, config);
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
  assert.match(docs[1].content, /^# Runtime contexts\n\nRuntime\.\n/mu);
  assert.deepEqual(renderDocs(graph, config), docs);
  assert.throws(
    () => renderDocs({ schemaVersion: 1, levels: {} }, config),
    /no level "projects"/u,
  );
});

function fakeIo(files: Map<string, string>) {
  const out = { stdout: '', stderr: '' };
  const configPaths: (string | undefined)[] = [];
  const io = {
    loadConfig: (path: string | undefined) => {
      configPaths.push(path);
      return config;
    },
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
  return { open, out, roots, configPaths };
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
  assert.equal(runCli(['--config'], bad.open), 2);
  assert.match(bad.out.stderr, /Usage:/u);
  assert.deepEqual(bad.configPaths, []);
});

const runtimeLevel = {
  id: 'runtime',
  kind: 'python',
  title: 'Runtime',
  output: 'runtime.md',
  intro: 'Runtime.',
  package: 'capture_runtime',
  sourceDir: 'packages/capture-runtime/src',
  projectDir: 'packages/capture-runtime',
  importLinterConfig: 'packages/capture-runtime/importlinter.toml',
};
const uiLevel = {
  id: 'ui',
  kind: 'typescript',
  title: 'UI',
  output: 'ui.md',
  intro: 'UI.',
  sheriffConfig: 'sheriff.config.ts',
  sourceRoots: ['packages/ui/src'],
};
const hookConfig = parseArchitectureConfig({
  levels: [
    {
      id: 'projects',
      kind: 'nx',
      title: 'Nx',
      output: 'projects.md',
      intro: 'Nx.',
    },
    runtimeLevel,
    // No contracts: the hook never lints this package.
    {
      ...runtimeLevel,
      id: 'client',
      output: 'client.md',
      package: 'client',
      sourceDir: 'packages/client/src',
      importLinterConfig: undefined,
    },
    uiLevel,
  ],
});

function hookChecks(
  results: { docs?: number; exceptions?: number; python?: number } = {},
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
      lintPython: (level: { package: string }) =>
        check(`python:${level.package}`, results.python)(),
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
    assert.equal(runHook(false, changed, hookConfig, checks), 0);
    assert.deepEqual(ran, []);
  }
});

test('runHook stops after one round of feedback', () => {
  const { ran, checks } = hookChecks({ docs: 1 });
  assert.equal(runHook(true, ['tools/a.ts'], hookConfig, checks), 0);
  assert.deepEqual(ran, []);
});

test('runHook runs the docs check and exception gate for TypeScript and config changes', () => {
  for (const changed of [
    ['packages/ui/src/lib/a.ts'],
    ['apps/capture-workbench/project.json'],
    ['tsconfig.base.json'],
    ['packages/ui/eslint-suppressions.json'],
    ['apps/web/.dependency-cruiser-known-violations.json'],
    ['apps/web/.dependency-cruiser.cjs'],
    ['.oxlintrc.json'],
    ['libs/other/importlinter.toml'],
    ['sheriff.config.ts'],
    ['architecture-graph.config.json'],
  ]) {
    const { ran, checks } = hookChecks();
    assert.equal(runHook(false, changed, hookConfig, checks), 0);
    assert.deepEqual(ran, ['docs', 'exceptions']);
  }
});

test("runHook adds a python level's contracts for its sources or importLinterConfig", () => {
  for (const changed of [
    ['packages/capture-runtime/src/capture_runtime/config.py'],
    ['packages\\capture-runtime\\importlinter.toml'],
    ['old.py -> packages/capture-runtime/src/capture_runtime/new.py'],
  ]) {
    const { ran, checks } = hookChecks();
    assert.equal(runHook(false, changed, hookConfig, checks), 0);
    assert.deepEqual(ran, ['docs', 'exceptions', 'python:capture_runtime']);
  }
  for (const changed of [
    ['packages/capture-runtime/tests/unit/test_x.py'],
    ['packages/client/src/client/api.py'],
  ]) {
    const { ran, checks } = hookChecks();
    runHook(false, changed, hookConfig, checks);
    assert.deepEqual(ran, ['docs', 'exceptions']);
  }
});

test('runHook without an nx level counts only files under the configured source paths', () => {
  const config = parseArchitectureConfig({ levels: [runtimeLevel, uiLevel] });
  for (const changed of [['tools/a.ts'], ['scripts/b.py']]) {
    const { ran, checks } = hookChecks();
    assert.equal(runHook(false, changed, config, checks), 0);
    assert.deepEqual(ran, []);
  }
  const { ran, checks } = hookChecks();
  runHook(false, ['packages/ui/src/lib/a.ts'], config, checks);
  assert.deepEqual(ran, ['docs', 'exceptions']);
});

test('runHook reports every failing check with exit 2', () => {
  const { ran, checks } = hookChecks({ exceptions: 1 });
  assert.equal(
    runHook(
      false,
      ['packages/capture-runtime/src/capture_runtime/a.py'],
      hookConfig,
      checks,
    ),
    2,
  );
  assert.deepEqual(ran, ['docs', 'exceptions', 'python:capture_runtime']);
});

test('--root opens the IO for that directory; without it the IO is for this checkout', () => {
  const fake = fakeIo(new Map());
  assert.equal(runCli(['--root', '../base'], fake.open), 0);
  assert.equal(runCli([], fake.open), 0);
  assert.deepEqual(fake.roots, ['../base', undefined]);
  assert.equal(runCli(['--root', 'a', '--root', 'b'], fake.open), 2);
});

test('--config passes its file to the IO; without it the root resolves its own config', () => {
  const fake = fakeIo(new Map());
  assert.equal(
    runCli(['--root', '../base', '--config', 'head.config.json'], fake.open),
    0,
  );
  assert.equal(runCli(['--check'], fake.open), 1);
  assert.deepEqual(fake.configPaths, ['head.config.json', undefined]);
  assert.equal(runCli(['--config', 'a', '--config', 'b'], fake.open), 2);
});
