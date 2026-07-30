import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { Observable, concatMap, defer, finalize, from, map, of } from 'rxjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackage = JSON.parse(
  readFileSync(join(repoRoot, 'packages/capture-angular/package.json'), 'utf8'),
);
const archiveName = `${sourcePackage.name.replace(/^@/u, '').replace('/', '-')}-${sourcePackage.version}.tgz`;
const archivePath = join(repoRoot, 'dist', 'packs', archiveName);
// Keep the isolated virtual store path short enough for Windows package paths.
const fixtureBase = resolve(repoRoot, '..', '.cw-clean');
mkdirSync(fixtureBase, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureBase, 'c-'));
const corepackCli = join(
  dirname(process.execPath),
  'node_modules',
  'corepack',
  'dist',
  'corepack.js',
);
function write(relativePath, contents) {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function run(command, args, cwd = fixtureRoot) {
  return new Observable((subscriber) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      shell: false,
      stdio: 'inherit',
    });
    const onError = (error) => subscriber.error(error);
    child.once('error', onError);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        subscriber.next(undefined);
        subscriber.complete();
        return;
      }
      subscriber.error(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
    return () => {
      child.off('error', onError);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
  });
}

function runPnpm(args, relativeCwd = '') {
  return defer(() => {
    if (!existsSync(corepackCli)) {
      throw new Error(
        'Node 24 Corepack is required to run the pnpm 11 fixture.',
      );
    }
    return run(
      process.execPath,
      [corepackCli, 'pnpm', ...args],
      join(fixtureRoot, relativeCwd),
    );
  });
}

function cleanup() {
  const resolvedFixture = resolve(fixtureRoot);
  const relativeFixture = relative(resolve(fixtureBase), resolvedFixture);
  if (
    !relativeFixture ||
    relativeFixture === '..' ||
    relativeFixture.startsWith(`..${sep}`) ||
    isAbsolute(relativeFixture)
  ) {
    throw new Error(
      `Refusing to remove unexpected fixture path: ${resolvedFixture}`,
    );
  }
  rmSync(resolvedFixture, { recursive: true, force: true });
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a browser-smoke port.'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

async function waitForPreview(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Vite preview did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`,
  );
}

function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
}

async function browserSmoke(name, cwd, outDir, verify) {
  const port = await freePort();
  const viteCli = join(
    fixtureRoot,
    'node_modules',
    'vite',
    'bin',
    'vite.js',
  );
  const child = spawn(
    process.execPath,
    [
      viteCli,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
      ...(outDir ? ['--outDir', outDir] : []),
    ],
    {
      cwd,
      env: { ...process.env, CI: 'true' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const url = `http://127.0.0.1:${port}/`;
  let browser;
  try {
    await waitForPreview(url);
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(url);
    try {
      await verify(page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${name} browser smoke failed: ${message}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`,
        { cause: error },
      );
    }
    process.stdout.write(`Packed ${name} browser smoke passed.\n`);
  } finally {
    await browser?.close();
    stopProcessTree(child);
  }
}

async function runBrowserSmokes() {
  await browserSmoke(
    'Angular Web Component',
    fixtureRoot,
    'dist/consumer/browser',
    async (page) => {
      await page.waitForFunction(() => window.__captureReady === true);
      await page.locator('capture-workbench input[type=file]').setInputFiles({
        name: 'fixture.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nfixture'),
      });
      await page.waitForFunction(() => window.__captureCompleted === true);
      const state = await page.evaluate(() => ({
        defined: customElements.get('capture-workbench') !== undefined,
        shadow:
          document
            .querySelector('capture-workbench')
            ?.querySelector('gx-capture-workbench')?.shadowRoot !== null,
        detail: window.__captureDetail,
      }));
      if (!state.defined || !state.shadow || state.detail?.document?.sourceText !== 'page one') {
        throw new Error('Angular packed Web Component lifecycle was not completed.');
      }
    },
  );
  await browserSmoke('Vanilla', join(fixtureRoot, 'vanilla'), undefined, async (page) => {
    await page.waitForFunction(() => window.__captureReady === true);
    const state = await page.evaluate(() => window.__captureState);
    if (
      !state?.defined ||
      !state.shadow ||
      !state.configured ||
      !state.clientPropertyOnly ||
      !state.stylesIsolated ||
      !state.eventBubbles ||
      !state.eventComposed
    ) {
      throw new Error(`Vanilla Web Component state failed: ${JSON.stringify(state)}`);
    }
  });
  for (const framework of ['react', 'vue']) {
    await browserSmoke(framework, join(fixtureRoot, framework), undefined, async (page) => {
      await page.waitForFunction(() => window.__captureReady === true);
      const state = await page.evaluate(() => window.__captureState);
      if (!state?.mounted || !state?.configured || !state?.listenerRemoved || state.defineCount !== 1) {
        throw new Error(`${framework} Web Component mount state failed: ${JSON.stringify(state)}`);
      }
    });
  }
}

try {
  const archiveSpec = `file:${archivePath.replaceAll('\\', '/')}`;
  write(
    'package.json',
    `${JSON.stringify(
      {
        name: 'capture-workbench-clean-consumer',
        version: '0.0.0',
        private: true,
        packageManager: 'pnpm@11.15.1',
        engines: { node: '>=24.0.0', pnpm: '>=11.0.0' },
        scripts: { build: 'ng build', test: 'ng test --watch=false' },
        dependencies: {
          '@angular/common': '22.0.7',
          '@angular/compiler': '22.0.7',
          '@angular/core': '22.0.7',
          '@angular/forms': '22.0.7',
          '@angular/platform-browser': '22.0.7',
          '@angular/router': '22.0.7',
          '@gx-capture/capture-workbench': archiveSpec,
          rxjs: '7.8.2',
          tslib: '2.8.1',
        },
        devDependencies: {
          '@angular/build': '22.0.7',
          '@angular/cli': '22.0.7',
          '@angular/compiler-cli': '22.0.7',
          '@vitejs/plugin-react': '5.1.1',
          '@vitejs/plugin-vue': '6.0.8',
          '@types/react': '19.2.8',
          '@types/react-dom': '19.2.3',
          jsdom: '28.1.0',
          prettier: '3.9.5',
          react: '19.2.8',
          'react-dom': '19.2.8',
          typescript: '6.0.3',
          vitest: '4.1.10',
          vite: '7.3.6',
          vue: '3.5.40',
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    'pnpm-workspace.yaml',
    `engineStrict: true
allowBuilds:
  '@parcel/watcher': true
  '@swc/core': true
  esbuild: true
  less: false
  lmdb: true
  msgpackr-extract: true
  nx: true
`,
  );
  write(
    'angular.json',
    `${JSON.stringify(
      {
        $schema: './node_modules/@angular/cli/lib/config/schema.json',
        version: 1,
        cli: { packageManager: 'pnpm' },
        newProjectRoot: 'projects',
        projects: {
          consumer: {
            projectType: 'application',
            root: '',
            sourceRoot: 'src',
            prefix: 'app',
            architect: {
              build: {
                builder: '@angular/build:application',
                options: {
                  browser: 'src/main.ts',
                  tsConfig: 'tsconfig.app.json',
                  assets: [{ glob: '**/*', input: 'public' }],
                  styles: ['src/styles.css'],
                },
                configurations: {
                  production: {
                    budgets: [
                      {
                        type: 'initial',
                        maximumWarning: '500kB',
                        maximumError: '1MB',
                      },
                      {
                        type: 'anyComponentStyle',
                        maximumWarning: '4kB',
                        maximumError: '8kB',
                      },
                    ],
                    outputHashing: 'all',
                  },
                  development: {
                    optimization: false,
                    extractLicenses: false,
                    sourceMap: true,
                  },
                },
                defaultConfiguration: 'production',
              },
              test: { builder: '@angular/build:unit-test' },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    'tsconfig.json',
    `${JSON.stringify(
      {
        compileOnSave: false,
        compilerOptions: {
          strict: true,
          noImplicitOverride: true,
          noPropertyAccessFromIndexSignature: true,
          noImplicitReturns: true,
          noFallthroughCasesInSwitch: true,
          skipLibCheck: true,
          isolatedModules: true,
          experimentalDecorators: true,
          importHelpers: true,
          target: 'ES2022',
          module: 'preserve',
        },
        angularCompilerOptions: {
          enableI18nLegacyMessageIdFormat: false,
          strictInjectionParameters: true,
          strictInputAccessModifiers: true,
          strictTemplates: true,
        },
        files: [],
        references: [
          { path: './tsconfig.app.json' },
          { path: './tsconfig.spec.json' },
        ],
      },
      null,
      2,
    )}\n`,
  );
  write(
    'tsconfig.app.json',
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: { outDir: './out-tsc/app', types: [] },
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.spec.ts'],
      },
      null,
      2,
    )}\n`,
  );
  write(
    'tsconfig.spec.json',
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: {
          outDir: './out-tsc/spec',
          types: ['vitest/globals'],
        },
        include: ['src/**/*.d.ts', 'src/**/*.spec.ts'],
      },
      null,
      2,
    )}\n`,
  );
  write(
    'src/index.html',
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Capture Angular Consumer</title><base href="/"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><app-root></app-root></body></html>\n',
  );
  write('public/.gitkeep', '');
  write('src/styles.css', 'body { font-family: sans-serif; }\n');
  write(
    'src/main.ts',
    `import { bootstrapApplication } from '@angular/platform-browser';\nimport { firstValueFrom } from 'rxjs';\nimport { defineCaptureWorkbenchElement } from '@gx-capture/capture-workbench';\nimport { App } from './app/app';\n\nawait firstValueFrom(defineCaptureWorkbenchElement());\nawait bootstrapApplication(App);\n`,
  );
  write(
    'src/app/fake-client.ts',
    `import type { CaptureClient } from '@gx-capture/capture-workbench';\nimport { of } from 'rxjs';\n\nconst source = { sha256: 'a'.repeat(64), fileName: 'fixture.pdf', mediaType: 'application/pdf', bytes: 16 };\nconst raw = { schemaVersion: '1', diagnosticOnly: true, source, segments: [{ segmentId: 'segment-1', order: 0, locator: { kind: 'page', page: 1 }, text: 'page one' }], sourceText: 'page one', extractionEngine: { engine: 'windowsml', model: 'ocr-v1', digest: \`sha256:\${'b'.repeat(64)}\` }, warnings: [], createdAt: '2026-07-29T00:00:00Z' };\nconst document = { schemaVersion: '1', source, rawSegments: raw.segments, blocks: [{ blockId: 'block-1', order: 0, sourceSegmentId: 'segment-1', type: 'paragraph', locator: { kind: 'page', page: 1 }, sourceText: 'page one', targetText: 'page one' }], sourceText: 'page one', targetText: 'page one', extractionEngine: raw.extractionEngine, structuringEngine: { engine: 'ollama', model: 'fixture', digest: \`sha256:\${'c'.repeat(64)}\` }, warnings: [], createdAt: raw.createdAt, completedAt: '2026-07-29T00:00:01Z' };\nconst job = { captureId: 'capture-1', status: 'completed', stage: 'completed', structuringMode: 'runtime', progress: 1, source, createdAt: raw.createdAt, updatedAt: raw.createdAt };\nexport const fakeClient = {\n  getReady: () => of({ ready: true, service: 'capture-runtime', runtimeVersion: '0.3.4', apiVersion: '1.0', captureDocumentSchemaVersion: '1', capabilities: { captureKinds: ['pdf', 'image', 'audio'], structuringModes: ['runtime', 'host'], supportsCancellation: true, supportsRawDiagnostics: true, maxUploadBytes: 50 * 1024 * 1024 } }),\n  getRequirements: () => of([]), startInstallation: () => of({}), listInstallations: () => of([]), getInstallation: () => of({}), cancelInstallation: () => of({}),\n  createCapture: () => of(job), getCapture: () => of(job), cancelCapture: () => of({ ...job, status: 'cancelled', stage: 'cancelled' }),\n  getRaw: () => of(raw), getResult: () => of(document), commitStructuredResult: () => of(job), reportStructuringFailure: () => of(job), deleteCapture: () => of(undefined),\n} as unknown as CaptureClient;\n`,
  );
  write(
    'src/app/direct-app.ts',
    `import { ChangeDetectionStrategy, Component } from '@angular/core';\nimport { CaptureWorkbenchComponent, provideCaptureWorkbenchInputs } from '@gx-capture/capture-workbench';\n\n@Component({ selector: 'direct-app', imports: [CaptureWorkbenchComponent], providers: [provideCaptureWorkbenchInputs({ config: () => ({ showRuntimeSetup: false }) })], template: \`<gx-capture-workbench />\`, changeDetection: ChangeDetectionStrategy.OnPush })\nexport class DirectApp {}\n`,
  );
  write(
    'src/app/app.ts',
    `import { AfterViewInit, ChangeDetectionStrategy, Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';\nimport type { CaptureWorkbenchElement } from '@gx-capture/capture-workbench';\nimport { fakeClient } from './fake-client';\n\ndeclare global { interface Window { __captureReady?: boolean; __captureCompleted?: boolean; __captureDetail?: any; } }\n@Component({ selector: 'app-root', schemas: [CUSTOM_ELEMENTS_SCHEMA], template: \`<capture-workbench output-mode="text"></capture-workbench>\`, changeDetection: ChangeDetectionStrategy.OnPush })\nexport class App implements AfterViewInit {\n  ngAfterViewInit(): void {\n    const capture = document.querySelector('capture-workbench') as CaptureWorkbenchElement;\n    capture.config = { showRuntimeSetup: false, pollIntervalMs: 0 };\n    capture.client = fakeClient;\n    capture.addEventListener('capture-completed', (event) => { window.__captureDetail = (event as CustomEvent).detail; window.__captureCompleted = true; });\n    window.__captureReady = true;\n  }\n}\n`,
  );
  write(
    'src/app/app.spec.ts',
    `import { TestBed } from '@angular/core/testing';\nimport { CAPTURE_DOCUMENT_V1_JSON_SCHEMA, CAPTURE_DOCUMENT_V1_SCHEMA_SHA256, defineCaptureWorkbenchElement } from '@gx-capture/capture-workbench';\nimport { DirectApp } from './direct-app';\n\ndescribe('packed capture consumer', () => {\n  it('renders the installed direct Angular component and exposes public contracts', async () => {\n    await TestBed.configureTestingModule({ imports: [DirectApp] }).compileComponents();\n    const fixture = TestBed.createComponent(DirectApp);\n    fixture.detectChanges();\n    expect(fixture.nativeElement.querySelector('gx-capture-workbench')).toBeTruthy();\n    expect(typeof defineCaptureWorkbenchElement).toBe('function');\n    expect(CAPTURE_DOCUMENT_V1_JSON_SCHEMA.$id).toBe('https://github.com/gx-capture/capture-workbench/schema/capture-document-v1.schema.json');\n    expect(CAPTURE_DOCUMENT_V1_SCHEMA_SHA256).toBe('2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2');\n  });\n});\n`,
  );

  write(
    'vanilla/index.html',
    '<!doctype html><html><head><style>#outside-button{padding:3px;border:2px solid rgb(1,2,3);background:rgb(4,5,6)}#outside-paragraph{margin:7px}.error{color:rgb(8,9,10)}</style></head><body><button id="outside-button">Outside</button><p id="outside-paragraph">Outside</p><div class="error" id="outside-error">Outside</div><capture-workbench output-mode="text" multiple></capture-workbench><script type="module" src="/src/main.ts"></script></body></html>\n',
  );
  write(
    'vanilla/src/main.ts',
    `import { createCaptureWorkbenchCustomEvent, defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx-capture/capture-workbench';\nimport { fakeClient } from '../../src/app/fake-client';\n\ndeclare global { interface Window { __captureReady?: boolean; __captureState?: any; } }\nconst sentinelIds = ['outside-button', 'outside-paragraph', 'outside-error'];\nconst snapshot = () => sentinelIds.map((id) => { const style = getComputedStyle(document.getElementById(id)!); return [style.padding, style.border, style.backgroundColor, style.margin, style.color]; });\nconst before = snapshot();\nconst capture = document.querySelector('capture-workbench') as CaptureWorkbenchElement;\nlet eventBubbles = false;\nlet eventComposed = false;\ndocument.addEventListener('capture-completed', (event) => { eventBubbles = event.bubbles; eventComposed = event.composed; }, { once: true });\nawait new Promise<void>((resolve, reject) => defineCaptureWorkbenchElement().subscribe({ next: () => resolve(), error: reject }));\nawait customElements.whenDefined('capture-workbench');\ncapture.config = { showRuntimeSetup: false, pollIntervalMs: 0 };\ncapture.client = fakeClient;\ncapture.dispatchEvent(createCaptureWorkbenchCustomEvent('capture-completed', { taskId: 'fixture', document: {} as never }));\nawait new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));\nconst inner = capture.querySelector('gx-capture-workbench');\nwindow.__captureState = { defined: customElements.get('capture-workbench') !== undefined, shadow: inner?.shadowRoot !== null, configured: capture.config.showRuntimeSetup === false && inner?.shadowRoot?.querySelector('input[type=file]')?.hasAttribute('multiple') === true, clientPropertyOnly: capture.client === fakeClient && !capture.hasAttribute('client'), stylesIsolated: JSON.stringify(before) === JSON.stringify(snapshot()), eventBubbles, eventComposed };\nwindow.__captureReady = true;\n`,
  );
  write(
    'vanilla/vite.config.ts',
    `import { defineConfig } from 'vite';\nexport default defineConfig({ build: { outDir: 'dist', emptyOutDir: true } });\n`,
  );

  write(
    'react/index.html',
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  );
  write(
    'react/src/main.tsx',
    `import { createRoot } from 'react-dom/client';\nimport { useEffect, useRef } from 'react';\nimport { defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx-capture/capture-workbench';\n\ndeclare global { namespace JSX { interface IntrinsicElements { 'capture-workbench': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>; } } interface Window { __captureReady?: boolean; __captureState?: any; } }\nfunction App() {\n  const ref = useRef<HTMLElement>(null);\n  useEffect(() => {\n    const capture = ref.current as CaptureWorkbenchElement | null;\n    if (!capture) return;\n    capture.config = { outputMode: 'text', showRuntimeSetup: false };\n    let calls = 0;\n    const onCompleted = () => { calls += 1; };\n    capture.addEventListener('capture-completed', onCompleted);\n    capture.dispatchEvent(new CustomEvent('capture-completed'));\n    capture.removeEventListener('capture-completed', onCompleted);\n    capture.dispatchEvent(new CustomEvent('capture-completed'));\n    window.__captureState = { mounted: capture.isConnected, configured: capture.config.outputMode === 'text', listenerRemoved: calls === 1, defineCount: customElements.get('capture-workbench') ? 1 : 0 };\n    window.__captureReady = true;\n  }, []);\n  return <capture-workbench ref={ref} />;\n}\n\nawait new Promise<void>((resolve, reject) => defineCaptureWorkbenchElement().subscribe({ next: () => resolve(), error: reject }));\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
  );
  write(
    'react/vite.config.ts',
    `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], build: { outDir: 'dist', emptyOutDir: true } });\n`,
  );

  write(
    'vue/index.html',
    '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>\n',
  );
  write(
    'vue/src/App.vue',
    `<script setup lang="ts">\nimport { onMounted, ref } from 'vue';\nimport { type CaptureWorkbenchElement } from '@gx-capture/capture-workbench';\n\ndeclare global { interface Window { __captureReady?: boolean; __captureState?: any; } }\nconst capture = ref<HTMLElement | null>(null);\nonMounted(() => {\n  const element = capture.value as CaptureWorkbenchElement | null;\n  if (!element) return;\n  element.config = { outputMode: 'text', showRuntimeSetup: false };\n  let calls = 0;\n  const onCompleted = () => { calls += 1; };\n  element.addEventListener('capture-completed', onCompleted);\n  element.dispatchEvent(new CustomEvent('capture-completed'));\n  element.removeEventListener('capture-completed', onCompleted);\n  element.dispatchEvent(new CustomEvent('capture-completed'));\n  window.__captureState = { mounted: element.isConnected, configured: element.config.outputMode === 'text', listenerRemoved: calls === 1, defineCount: customElements.get('capture-workbench') ? 1 : 0 };\n  window.__captureReady = true;\n});\n</script>\n\n<template><capture-workbench ref="capture" /></template>\n`,
  );
  write(
    'vue/src/main.ts',
    `import { createApp } from 'vue';\nimport { defineCaptureWorkbenchElement } from '@gx-capture/capture-workbench';\nimport App from './App.vue';\n\nawait new Promise<void>((resolve, reject) => defineCaptureWorkbenchElement().subscribe({ next: () => resolve(), error: reject }));\ncreateApp(App).mount('#app');\n`,
  );
  write(
    'vue/vite.config.ts',
    `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\nexport default defineConfig({ plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'capture-workbench' } } })], build: { outDir: 'dist', emptyOutDir: true } });\n`,
  );

  runPnpm(['install', '--no-frozen-lockfile'])
    .pipe(
      concatMap(() =>
        defer(() => {
          if (
            !existsSync(
              join(
                fixtureRoot,
                'node_modules',
                '@gx-capture',
                'capture-workbench',
                'LICENSE',
              ),
            )
          ) {
            throw new Error(
              'Packed Capture Workbench package is missing its MIT LICENSE.',
            );
          }
          for (const hostEntry of [
            'vanilla/src/main.ts',
            'react/src/main.tsx',
            'vue/src/main.ts',
          ]) {
            const source = readFileSync(join(fixtureRoot, hostEntry), 'utf8');
            if (
              source.includes("from '@angular/elements'") ||
              source.includes("from '@angular/compiler'") ||
              source.includes("import '@angular/compiler'")
            ) {
              throw new Error(
                `${hostEntry} must use only the public Capture Workbench element API.`,
              );
            }
          }
          return of(undefined);
        }),
      ),
      concatMap(() => runPnpm(['build'])),
      concatMap(() => runPnpm(['test'])),
      concatMap(() => runPnpm(['exec', 'vite', 'build'], 'vanilla')),
      concatMap(() => runPnpm(['exec', 'vite', 'build'], 'react')),
      concatMap(() => runPnpm(['exec', 'vite', 'build'], 'vue')),
      concatMap(() => defer(() => from(runBrowserSmokes()))),
      map(() => undefined),
      finalize(cleanup),
    )
    .subscribe({
      next: () =>
        process.stdout.write(
          `Clean Angular, Vanilla, React, and Vue consumers passed with ${archiveName}.\n`,
        ),
      error: (error) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    });
} catch (error) {
  cleanup();
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
