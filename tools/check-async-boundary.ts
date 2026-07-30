import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..');
const sourceRoots = ['apps', 'packages', 'tools'];
const forbiddenPatterns = [
  { name: 'Promise contract', pattern: /Promise\s*</gu },
  { name: 'Promise constructor', pattern: /new\s+Promise\b/gu },
  { name: 'async function', pattern: /\basync\b/gu },
  { name: 'await expression', pattern: /\bawait\b/gu },
  { name: 'firstValueFrom', pattern: /\bfirstValueFrom\b/gu },
  { name: 'lastValueFrom', pattern: /\blastValueFrom\b/gu },
];

function collectTypescriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist'].includes(entry.name)) {
        files.push(...collectTypescriptFiles(path));
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

function exceptionReason(relativePath) {
  if (/^apps[\\/]capture-workbench-e2e[\\/]/u.test(relativePath)) {
    return 'Playwright test API boundary';
  }
  if (relativePath === 'apps/capture-workbench/src/app/app.config.ts') {
    return 'Angular bootstrap provider boundary';
  }
  if (
    relativePath ===
      'apps/capture-workbench-desktop/scripts/real-desktop-ocr-smoke.ts' ||
    relativePath ===
      'apps/capture-workbench-desktop/scripts/real-ollama-smoke.ts'
  ) {
    return 'opt-in real-engine CLI boundary';
  }
  if (
    relativePath ===
    'apps/capture-workbench-desktop/scripts/installed-deterministic-smoke.ts'
  ) {
    return 'installed desktop/release CLI process boundary';
  }
  if (/\.(spec|test)\.ts$/u.test(relativePath)) {
    return 'Angular/Node test-runner boundary';
  }
  if (relativePath === 'tools/clean-angular-consumer-smoke.ts') {
    return 'generated consumer framework fixture boundary';
  }
  if (relativePath === 'tools/local-registry/publish-local-registry.ts') {
    return 'local registry CLI process boundary';
  }
  if (relativePath === 'tools/local-release-consumer-smoke.ts') {
    return 'local release consumer process boundary';
  }
  if (relativePath === 'tools/publish-release.ts') {
    return 'release publication CLI process boundary';
  }
  return undefined;
}

const violations = [];
const approved = [];
for (const sourceRoot of sourceRoots) {
  for (const file of collectTypescriptFiles(resolve(workspaceRoot, sourceRoot))) {
    const relativePath = relative(workspaceRoot, file).replaceAll('\\', '/');
    if (relativePath === 'tools/check-async-boundary.ts') continue;
    const reason = exceptionReason(relativePath);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const forbidden of forbiddenPatterns) {
        forbidden.pattern.lastIndex = 0;
        if (!forbidden.pattern.test(line)) continue;
        const finding = `${relativePath}:${index + 1} ${forbidden.name}`;
        if (reason) approved.push(`${finding} (${reason})`);
        else violations.push(finding);
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Async-boundary violations (Promise/async is allowed only at approved framework boundaries):\n${violations.join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Async-boundary check passed; ${approved.length} approved framework/test boundary occurrence(s).\n`,
  );
}
