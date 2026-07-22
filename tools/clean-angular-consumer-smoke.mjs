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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackage = JSON.parse(
  readFileSync(join(repoRoot, 'packages/capture-angular/package.json'), 'utf8'),
);
const archiveName = `wodenwang820118-capture-angular-${sourcePackage.version}.tgz`;
const archivePath = join(repoRoot, 'dist', 'packs', archiveName);
// Keep the isolated virtual store path short enough for Windows package paths.
const fixtureBase = resolve(repoRoot, '..', '.cw-clean');
mkdirSync(fixtureBase, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureBase, 'c-'));
const pnpmCli = resolvePnpmCli();

function resolvePnpmCli() {
  const candidates = [
    process.env.npm_execpath,
    process.env.APPDATA
      ? join(
          process.env.APPDATA,
          'npm',
          'node_modules',
          'pnpm',
          'bin',
          'pnpm.cjs',
        )
      : undefined,
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function write(relativePath, contents) {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: fixtureRoot,
      env: { ...process.env, CI: 'true' },
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

async function runPnpm(args) {
  if (pnpmCli) {
    await run(process.execPath, [pnpmCli, ...args]);
    return;
  }
  if (process.platform === 'win32') {
    throw new Error('Unable to resolve the pnpm CLI entry point on Windows.');
  }
  await run('pnpm', args);
}

try {
  const archiveSpec = `file:${archivePath.replaceAll('\\', '/')}`;
  write(
    'package.json',
    `${JSON.stringify(
      {
        name: 'capture-angular-clean-consumer',
        version: '0.0.0',
        private: true,
        packageManager: 'pnpm@10.33.2',
        scripts: { build: 'ng build', test: 'ng test --watch=false' },
        dependencies: {
          '@angular/common': '21.2.18',
          '@angular/compiler': '21.2.18',
          '@angular/core': '21.2.18',
          '@angular/forms': '21.2.18',
          '@angular/platform-browser': '21.2.18',
          '@angular/router': '21.2.18',
          rxjs: '7.8.2',
          tslib: '2.8.1',
        },
        devDependencies: {
          '@angular/build': '21.2.19',
          '@angular/cli': '21.2.19',
          '@angular/compiler-cli': '21.2.18',
          jsdom: '28.1.0',
          prettier: '3.9.5',
          typescript: '5.9.3',
          vitest: '4.1.10',
        },
      },
      null,
      2,
    )}\n`,
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
    `import { ChangeDetectionStrategy, Component } from '@angular/core';\nimport { CaptureWorkbenchComponent } from '@wodenwang820118/capture-angular';\n\n@Component({\n  selector: 'app-root',\n  imports: [CaptureWorkbenchComponent],\n  template: \`<capture-workbench [config]="{ showRuntimeSetup: false, outputMode: 'text' }" />\`,\n  changeDetection: ChangeDetectionStrategy.OnPush,\n})\nexport class App {}\n`,
  );
  write(
    'src/app/app.spec.ts',
    `import { TestBed } from '@angular/core/testing';\nimport { CAPTURE_DOCUMENT_V1_JSON_SCHEMA, CAPTURE_DOCUMENT_V1_SCHEMA_SHA256 } from '@wodenwang820118/capture-angular';\nimport { App } from './app';\n\ndescribe('packed capture consumer', () => {\n  it('renders the installed component and exposes the canonical schema', async () => {\n    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();\n    const fixture = TestBed.createComponent(App);\n    fixture.detectChanges();\n    expect(fixture.nativeElement.querySelector('capture-workbench')).toBeTruthy();\n    expect(CAPTURE_DOCUMENT_V1_JSON_SCHEMA.$id).toBe('https://github.com/WodenWang820118/capture-workbench/schema/capture-document-v1.schema.json');\n    expect(CAPTURE_DOCUMENT_V1_SCHEMA_SHA256).toBe('da8565b0a4611042f62f96202d0f167ba0923d88e12b9be22832f3ee320920c3');\n  });\n});\n`,
  );

  await runPnpm(['install', '--ignore-workspace', '--no-frozen-lockfile']);
  await runPnpm(['add', archiveSpec, '--save-exact', '--ignore-workspace']);
  await runPnpm(['build']);
  await runPnpm(['test']);
  process.stdout.write(`Clean Angular consumer passed with ${archiveName}.\n`);
} finally {
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
