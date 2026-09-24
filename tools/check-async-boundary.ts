import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(import.meta.dirname, '..');
const typescript = createRequire(import.meta.url)('typescript');
const sourceRoots = ['apps', 'packages', 'tools'];
const forbiddenPatterns = [
  { name: 'Promise contract', pattern: /Promise\s*</gu },
  { name: 'Promise constructor', pattern: /new\s+Promise\b/gu },
  { name: 'async function', pattern: /\basync\b/gu },
  { name: 'await expression', pattern: /\bawait\b/gu },
  { name: 'firstValueFrom', pattern: /\bfirstValueFrom\b/gu },
  { name: 'lastValueFrom', pattern: /\blastValueFrom\b/gu },
];
const ACCEPTANCE_SCOPE_PATH =
  'apps/capture-workbench-desktop/scripts/acceptance-scope.ts';
const ACCEPTANCE_SCOPE_ALLOWED_IMPORTS = new Set([
  'node:crypto',
  'node:child_process',
  'node:fs/promises',
  'node:path',
  '../../../tools/three-project-acceptance.ts',
  './windows-acceptance-scope-probe.ts',
]);

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
      /\.(?:m?ts)$/u.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

function sourceLine(source, offset) {
  return source.slice(0, offset).split(/\r?\n/u).length;
}

export function acceptanceScopeDependencyFindings(relativePath, source) {
  if (relativePath !== ACCEPTANCE_SCOPE_PATH) return [];
  const findings = [];
  const addFinding = (kind, specifier, offset) => {
    findings.push(
      `${relativePath}:${sourceLine(source, offset)} acceptance scope ${kind} "${specifier}" is not allowed`,
    );
  };

  const sourceFile = typescript.createSourceFile(
    relativePath,
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    findings.push(
      `${relativePath}:1 acceptance scope parse diagnostics (${sourceFile.parseDiagnostics.length})`,
    );
    return findings;
  }

  const moduleSpecifier = (node) =>
    node && typescript.isStringLiteralLike(node)
      ? node.text
      : 'module expression';
  const visit = (node) => {
    if (typescript.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (!ACCEPTANCE_SCOPE_ALLOWED_IMPORTS.has(specifier)) {
        addFinding('static import', specifier, node.getStart(sourceFile));
      }
    } else if (
      typescript.isExportDeclaration(node) &&
      node.moduleSpecifier
    ) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (!ACCEPTANCE_SCOPE_ALLOWED_IMPORTS.has(specifier)) {
        addFinding('static export', specifier, node.getStart(sourceFile));
      }
    } else if (typescript.isImportEqualsDeclaration(node)) {
      const moduleReference = node.moduleReference;
      const specifier =
        typescript.isExternalModuleReference(moduleReference)
          ? moduleSpecifier(moduleReference.expression)
          : 'module expression';
      addFinding('import-equals', specifier, node.getStart(sourceFile));
    } else if (
      typescript.isCallExpression(node) &&
      node.expression.kind === typescript.SyntaxKind.ImportKeyword
    ) {
      const specifier = moduleSpecifier(node.arguments[0]);
      addFinding('dynamic import', specifier, node.getStart(sourceFile));
    } else if (typescript.isIdentifier(node) && node.text === 'require') {
      const parent = node.parent;
      if (typescript.isCallExpression(parent) && parent.expression === node) {
        const specifier = moduleSpecifier(parent.arguments[0]);
        addFinding('require', specifier, node.getStart(sourceFile));
      } else {
        addFinding(
          'require identifier',
          'identifier reference',
          node.getStart(sourceFile),
        );
      }
    }
    typescript.forEachChild(node, visit);
  };
  typescript.forEachChild(sourceFile, visit);
  return findings;
}

function exceptionReason(relativePath) {
  if (/^packages[\\/]capture-runtime-client[\\/]src[\\/]/u.test(relativePath)) {
    return 'framework-neutral Capture Runtime SDK transport boundary';
  }
  if (
    relativePath ===
    'packages/capture-workbench-ui/src/lib/http-capture-client.ts'
  ) {
    return 'RxJS adapter over the framework-neutral Capture Runtime SDK boundary';
  }
  if (
    relativePath === 'tools/assemble-java-sdk-candidate.ts' ||
    relativePath === 'tools/verify-java-sdk-candidate.ts'
  ) {
    return 'Java SDK candidate tooling process boundary';
  }
  if (/^apps[\\/]capture-workbench-e2e[\\/]/u.test(relativePath)) {
    return 'Playwright test API boundary';
  }
  if (/^packages[\\/]capture-runtime[\\/]tests[\\/]e2e[\\/]/u.test(relativePath)) {
    return 'Capture Runtime local/online package E2E boundary';
  }
  if (relativePath === 'apps/capture-workbench/src/app/app.config.ts') {
    return 'Angular bootstrap provider boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/acceptance-nsis.ts') {
    return 'NSIS acceptance packaging process boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/acceptance-orchestration.ts') {
    return 'desktop acceptance orchestration process boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/build-acceptance-nsis.ts') {
    return 'NSIS acceptance installer build process boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/build-practical-installer.ts') {
    return 'practical side-by-side NSIS installer build process boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/practical-installed-ocr.ts') {
    return 'opt-in practical installed OCR process boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/local-candidate-model.ts') {
    return 'local candidate model asset process boundary';
  }
  if (
    relativePath ===
    'apps/capture-workbench-desktop/scripts/filesystem-authority.ts'
  ) {
    return 'canonical filesystem-authority live-probe deep module';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/ocr-semantic-evidence.ts') {
    return 'real OCR semantic evidence CLI boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/real-jpeg-acceptance-coordinator.ts') {
    return 'real JPEG acceptance process boundary';
  }
  if (relativePath === 'tools/acceptance-checkpoint-journal.ts') {
    return 'acceptance checkpoint journal filesystem boundary';
  }
  if (relativePath === 'tools/python-candidate-index.ts') {
    return 'Python candidate artifact index CLI boundary';
  }
  if (relativePath === 'tools/windows-built-in-process-resolver.ts') {
    return 'Windows process observation CLI boundary';
  }
  if (
    relativePath ===
      'apps/capture-workbench-desktop/scripts/real-desktop-ocr-smoke.ts' ||
    relativePath ===
      'apps/capture-workbench-desktop/scripts/real-ollama-smoke.ts' ||
    relativePath ===
      'apps/capture-workbench-desktop/scripts/real-media-smoke.ts' ||
      relativePath ===
        'apps/capture-workbench-desktop/scripts/real-media-model-smoke.ts' ||
      relativePath ===
      'apps/capture-workbench-desktop/scripts/progressive-audio-oracle.ts'
  ) {
    return 'opt-in real-engine CLI boundary';
  }
  if (
    relativePath ===
    'apps/capture-workbench-desktop/scripts/local-candidate-worker-mirror.ts'
  ) {
    return 'local runtime candidate OCR worker mirror process boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/real-ocr-result-assertions.ts') {
    return 'opt-in real-engine CLI boundary';
  }
  if (relativePath === 'apps/capture-workbench-desktop/scripts/acceptance-real.ts') {
    return 'opt-in real-engine process boundary';
  }
  // This exact acceptance I/O orchestration seam owns filesystem and OS probes;
  // neighboring desktop scripts and all product/runtime/client source stay checked.
  if (
    relativePath ===
    'apps/capture-workbench-desktop/scripts/acceptance-scope.ts'
  ) {
    return 'acceptance scope filesystem and process-observation boundary';
  }
  if (
    relativePath ===
    'apps/capture-workbench-desktop/scripts/windows-acceptance-scope-probe.ts'
  ) {
    return 'Windows acceptance process/listener observation deep module';
  }
  if (relativePath === 'tools/acceptance-contract.ts') {
    return 'acceptance artifact and process boundary';
  }
  if (relativePath === 'tools/three-project-acceptance.ts') {
    return 'acceptance process boundary';
  }
  if (relativePath === 'tools/user-pdf-ocr-probe.ts') {
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
  if (relativePath === 'tools/capture-boundary-doctor.ts') {
    return 'read-only local boundary diagnostics CLI';
  }
  if (relativePath === 'tools/local-release-consumer-smoke.ts') {
    return 'local release consumer process boundary';
  }
  if (relativePath === 'tools/runtime-web-component-e2e.ts') {
    return 'packaged runtime Web Component E2E process boundary';
  }
  if (relativePath === 'tools/verify-release-candidate.ts') {
    return 'release candidate verification CLI process boundary';
  }
  if (relativePath === 'tools/assemble-release-candidate.ts') {
    return 'release candidate assembly CLI process boundary';
  }
  if (relativePath === 'tools/assemble-package-candidate.ts') {
    return 'package candidate assembly CLI process boundary';
  }
  if (relativePath === 'tools/verify-package-candidate.ts') {
    return 'package candidate verification CLI process boundary';
  }
  if (relativePath === 'tools/verify-package-candidate-binding.ts') {
    return 'package candidate binding verification CLI process boundary';
  }
  if (relativePath === 'tools/assemble-runtime-candidate.ts') {
    return 'runtime candidate assembly CLI process boundary';
  }
  if (relativePath === 'tools/verify-runtime-candidate.ts') {
    return 'runtime candidate verification CLI process boundary';
  }
  if (relativePath === 'tools/create-runtime-github-release.ts') {
    return 'runtime GitHub Release publication CLI process boundary';
  }
  if (relativePath === 'tools/verify-runtime-candidate-binding.ts') {
    return 'runtime candidate binding verification CLI process boundary';
  }
  if (relativePath === 'tools/create-contract-snapshot.ts') {
    return 'contract snapshot generation CLI process boundary';
  }
  if (relativePath === 'tools/contract-impact.ts') {
    return 'contract impact classification CLI process boundary';
  }
  if (relativePath === 'tools/classify-release-contract.ts') {
    return 'release contract classification CLI process boundary';
  }
  if (relativePath === 'tools/record-candidate-verification.ts') {
    return 'candidate verification report CLI process boundary';
  }
  if (relativePath === 'tools/consumer-gate.ts') {
    return 'consumer gate contract verifier boundary';
  }
  if (relativePath === 'tools/run-consumer-gates.ts') {
    return 'consumer gate dispatch and polling CLI process boundary';
  }
  if (relativePath === 'tools/verify-promotion-evidence.ts') {
    return 'promotion evidence verification CLI process boundary';
  }
  if (relativePath === 'tools/publish-npm-candidate.ts') {
    return 'npm candidate publication CLI process boundary';
  }
  if (relativePath === 'tools/publish-crate-candidate.ts') {
    return 'crates.io candidate publication CLI process boundary';
  }
  if (relativePath === 'tools/record-pypi-candidate.ts') {
    return 'PyPI candidate ledger CLI process boundary';
  }
  if (relativePath === 'tools/verify-registry-ledgers.ts') {
    return 'registry ledger verification CLI process boundary';
  }
  if (relativePath === 'tools/create-github-release.ts') {
    return 'GitHub Release publication CLI process boundary';
  }
  if (relativePath === 'tools/audit-release-tag.ts') {
    return 'release tag audit CLI process boundary';
  }
  if (relativePath === 'tools/create-promotion-ledger.ts') {
    return 'promotion ledger CLI process boundary';
  }
  if (relativePath === 'tools/create-release-manifest.ts') {
    return 'immutable release manifest CLI process boundary';
  }
  if (relativePath === 'tools/update-release-index.ts') {
    return 'release index transition CLI process boundary';
  }
  return undefined;
}

function runAsyncBoundaryCheck() {
  const violations = [];
  const approved = [];
  for (const sourceRoot of sourceRoots) {
    for (const file of collectTypescriptFiles(
      resolve(workspaceRoot, sourceRoot),
    )) {
      const relativePath = relative(workspaceRoot, file).replaceAll('\\', '/');
      if (relativePath === 'tools/check-async-boundary.ts') continue;
      const reason = exceptionReason(relativePath);
      const source = readFileSync(file, 'utf8');
      violations.push(...acceptanceScopeDependencyFindings(relativePath, source));
      const lines = source.split(/\r?\n/u);
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
  return { approved, violations };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { approved, violations } = runAsyncBoundaryCheck();
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
}
