import { spawn } from 'node:child_process';
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
import {
  Observable,
  concatMap,
  defer,
  map,
  of,
  finalize,
} from 'rxjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackage = JSON.parse(
  readFileSync(join(repoRoot, 'packages/capture-angular/package.json'), 'utf8'),
);
const archiveName = `gx-capture-workbench-${sourcePackage.version}.tgz`;
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
      throw new Error('Node 24 Corepack is required to run the pnpm 11 fixture.');
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
          '@angular/elements': '22.0.7',
          '@angular/forms': '22.0.7',
          '@angular/platform-browser': '22.0.7',
          '@angular/router': '22.0.7',
          '@gx/capture-workbench': archiveSpec,
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
    `import { bootstrapApplication } from '@angular/platform-browser';\nimport { App } from './app/app';\n\nbootstrapApplication(App).catch((error) => console.error(error));\n`,
  );
  write(
    'src/app/app.ts',
    `import { ChangeDetectionStrategy, Component } from '@angular/core';\nimport { CaptureWorkbenchComponent } from '@gx/capture-workbench';\n\n@Component({\n  selector: 'app-root',\n  imports: [CaptureWorkbenchComponent],\n  template: \`<gx-capture-workbench [config]="{ showRuntimeSetup: false, outputMode: 'text' }" />\`,\n  changeDetection: ChangeDetectionStrategy.OnPush,\n})\nexport class App {}\n`,
  );
  write(
    'src/app/app.spec.ts',
    `import { TestBed } from '@angular/core/testing';\nimport { CAPTURE_DOCUMENT_V1_JSON_SCHEMA, CAPTURE_DOCUMENT_V1_SCHEMA_SHA256, defineCaptureWorkbenchElement } from '@gx/capture-workbench';\nimport { App } from './app';\n\ndescribe('packed capture consumer', () => {\n  it('renders the installed Angular component and exposes the public contracts', async () => {\n    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();\n    const fixture = TestBed.createComponent(App);\n    fixture.detectChanges();\n    expect(fixture.nativeElement.querySelector('gx-capture-workbench')).toBeTruthy();\n    expect(typeof defineCaptureWorkbenchElement).toBe('function');\n    expect(CAPTURE_DOCUMENT_V1_JSON_SCHEMA.$id).toBe('https://github.com/WodenWang820118/capture-workbench/schema/capture-document-v1.schema.json');\n    expect(CAPTURE_DOCUMENT_V1_SCHEMA_SHA256).toBe('da8565b0a4611042f62f96202d0f167ba0923d88e12b9be22832f3ee320920c3');\n  });\n});\n`,
  );

  write(
    'vanilla/index.html',
    '<!doctype html><html><body><capture-workbench></capture-workbench><script type="module" src="/src/main.ts"></script></body></html>\n',
  );
  write(
    'vanilla/src/main.ts',
    `import { defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx/capture-workbench';\n\ndefineCaptureWorkbenchElement().subscribe({\n  next: () => {\n    const capture = document.querySelector('capture-workbench') as CaptureWorkbenchElement;\n    capture.config = { outputMode: 'text', showRuntimeSetup: false };\n    capture.client = null;\n    capture.addEventListener('capture-completed', (event) => console.log(event));\n  },\n  error: (error) => console.error(error),\n});\n`,
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
    `import { createRoot } from 'react-dom/client';\nimport { useEffect, useRef } from 'react';\nimport { defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx/capture-workbench';\n\nfunction App() {\n  const ref = useRef<HTMLElement>(null);\n  useEffect(() => {\n    const capture = ref.current as CaptureWorkbenchElement | null;\n    if (!capture) return;\n    capture.config = { outputMode: 'text', showRuntimeSetup: false };\n    capture.client = null;\n    const onCompleted = (event: Event) => console.log(event);\n    capture.addEventListener('capture-completed', onCompleted);\n    return () => capture.removeEventListener('capture-completed', onCompleted);\n  }, []);\n  return <capture-workbench ref={ref} />;\n}\n\ndefineCaptureWorkbenchElement().subscribe({\n  next: () => createRoot(document.getElementById('root')!).render(<App />),\n  error: (error) => console.error(error),\n});\n`,
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
    `<script setup lang="ts">\nimport { onBeforeUnmount, onMounted, ref } from 'vue';\nimport { type CaptureWorkbenchElement } from '@gx/capture-workbench';\n\nconst capture = ref<HTMLElement | null>(null);\nconst onCompleted = (event: Event) => console.log(event);\nonMounted(() => {\n  const element = capture.value as CaptureWorkbenchElement | null;\n  if (!element) return;\n  element.config = { outputMode: 'text', showRuntimeSetup: false };\n  element.client = null;\n  element.addEventListener('capture-completed', onCompleted);\n});\nonBeforeUnmount(() => capture.value?.removeEventListener('capture-completed', onCompleted));\n</script>\n\n<template><capture-workbench ref="capture" /></template>\n`,
  );
  write(
    'vue/src/main.ts',
    `import { createApp } from 'vue';\nimport { defineCaptureWorkbenchElement } from '@gx/capture-workbench';\nimport App from './App.vue';\n\ndefineCaptureWorkbenchElement().subscribe({\n  next: () => createApp(App).mount('#app'),\n  error: (error) => console.error(error),\n});\n`,
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
                '@gx',
                'capture-workbench',
                'LICENSE',
              ),
            )
          ) {
            throw new Error('Packed Capture Workbench package is missing its MIT LICENSE.');
          }
          return of(undefined);
        }),
      ),
      concatMap(() => runPnpm(['build'])),
      concatMap(() => runPnpm(['test'])),
      concatMap(() => runPnpm(['exec', 'vite', 'build'], 'vanilla')),
      concatMap(() => runPnpm(['exec', 'vite', 'build'], 'react')),
      concatMap(() => runPnpm(['exec', 'vite', 'build'], 'vue')),
      map(() => undefined),
      finalize(cleanup),
    )
    .subscribe({
      next: () =>
        process.stdout.write(
          `Clean Angular, Vanilla, React, and Vue consumers passed with ${archiveName}.\n`,
        ),
      error: (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    });
} catch (error) {
  cleanup();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
