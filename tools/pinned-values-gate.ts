/** Current release/artifact literals in tests are a ratchet, never a second source. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRatchet, writeRatchetBaseline, type Ratchet } from './dead-code-gate.ts';

const ARTIFACT_SOURCES = [
  {
    kind: 'contract-set-sha256',
    file: 'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
  },
  {
    kind: 'document-schema-sha256',
    file: 'packages/capture-runtime-client/src/private/generated-contracts.ts',
    pattern: /CAPTURE_DOCUMENT_SCHEMA_SHA256\s*=\s*"([a-f0-9]{64})"/u,
  },
  {
    kind: 'contract-schema-sha256',
    file: 'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
    pattern: /"schemaSha256"\s*:\s*"([a-f0-9]{64})"/gu,
  },
];

const EXCLUDED_FILES = new Set([
  'release/version.json', // Release intent owns the current version.
  'tools/release/version-sources.ts', // Release inventory records the contract identity.
  'packages/capture-runtime/src/capture_runtime/release.py', // Runtime release schema identity.
  'packages/capture-runtime-client/src/contracts.ts', // Public SDK contract identity.
  'packages/capture-runtime-client-python/src/capture_runtime_client/contracts.py', // Python SDK identity.
  'packages/capture-runtime-client-python/src/capture_runtime_client/private/generated_models.py', // Generated wire models.
  'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.toml', // Version owner maintained by sync-versions.
  'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.lock', // Generated lock version maintained by sync-versions.
  ...ARTIFACT_SOURCES.map(({ file }) => file), // Recorded/generated artifact sources.
]);

interface Finding {
  key: string;
  file: string;
  line: number;
  kind: string;
}

function scannedFile(file: string): boolean {
  return /\.(?:test|spec|e2e)\.ts$/u.test(file) ||
    /(?:^|\/)tests\/.*\.(?:py|ts)$/u.test(file) ||
    /^(?:apps\/capture-workbench-desktop\/scripts\/fixtures\/|apps\/capture-workbench-e2e\/src\/|test-fixtures\/|packages\/.*\/tests\/fixtures\/)/u.test(file) ||
    /^(?:apps\/.*\/src-tauri\/src\/|packages\/capture-sidecar-launcher\/src\/).*\.rs$/u.test(file);
}

export function trackedFiles(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed with status ${result.status}:\n${result.stderr}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

/** Inventory injection keeps behaviour tests independent of git and the checkout. */
export function collectPinnedValues(repoRoot: string, files: string[]): Finding[] {
  const read = (file: string): string => readFileSync(resolve(repoRoot, file), 'utf8');
  const intent = JSON.parse(read('release/version.json')) as { releaseVersion: string };
  const values = new Map<string, string>([[intent.releaseVersion, 'release-version']]);
  for (const { kind, file, pattern } of ARTIFACT_SOURCES) {
    const content = read(file);
    const hashes = pattern
      ? [...content.matchAll(new RegExp(pattern.source, 'gu'))].map((match) => match[1])
      : [content.trim()];
    if (hashes.length === 0 || hashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) {
      throw new Error(`Cannot read ${kind} from ${file}`);
    }
    for (const hash of hashes) if (!values.has(hash)) values.set(hash, kind);
  }
  const findings: Finding[] = [];
  for (const file of [...new Set(files)].sort()) {
    if (EXCLUDED_FILES.has(file) || !scannedFile(file)) continue;
    const source = read(file);
    const rust = file.endsWith('.rs');
    const rustTestRegion = rust &&
      /^(?:apps\/.*\/src-tauri\/src\/|packages\/capture-sidecar-launcher\/src\/)/u.test(file);
    const start = rustTestRegion ? source.search(/#\[cfg\(test\)\]/u) : 0;
    if (start < 0) continue;
    const python = file.endsWith('.py');
    // Consume comments and complete literals together, ignoring quoted comment text.
    const tokens = python
      ? /#[^\n]*|("""|''')[\s\S]*?\1|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gu
      : rust
        ? /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"/gu
        : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu;
    const counts = new Map<string, number>();
    for (const match of source.slice(start).matchAll(tokens)) {
      const token = match[0];
      if (!['"', "'", '`'].includes(token[0])) continue;
      const width = python && (token.startsWith('"""') || token.startsWith("'''")) ? 3 : 1;
      const content = token.slice(width, -width).replace(
        /\\(?:u\{([a-f0-9]+)\}|u([a-f0-9]{4})|x([a-f0-9]{2})|([\s\S]))/giu,
        (_escape, braced: string, unicode: string, hex: string, character: string) =>
          braced || unicode || hex ? String.fromCodePoint(parseInt(braced || unicode || hex, 16)) : character,
      );
      const kind = values.get(content);
      if (!kind) continue;
      const ordinal = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, ordinal);
      findings.push({
        key: `${kind}|${file}|${ordinal}`, file, kind,
        line: source.slice(0, start + match.index).split('\n').length,
      });
    }
  }
  return findings;
}

export function runPinnedValuesGate(
  repoRoot: string, argv: string[], files?: string[],
): number {
  const findings = collectPinnedValues(repoRoot, files ?? trackedFiles(repoRoot));
  const byKey = new Map(findings.map((finding) => [finding.key, finding]));
  const ratchet: Ratchet = {
    label: 'pinned-values', noun: 'finding',
    baseline: 'tools/quality/pinned-values-baseline.json',
    script: 'tools/pinned-values-gate.ts',
    collect: () => findings.map(({ key }) => key).sort(),
    formatKey: (key) => {
      const finding = byKey.get(key);
      const [kind, file] = key.split('|');
      return `  - [${kind}] ${file}${finding ? `:${finding.line}` : ''}`;
    },
    fixHint: ['Fix: import RELEASE_VERSION / the generated constant, or use an obviously synthetic value.'],
  };
  return argv.includes('--update')
    ? writeRatchetBaseline(repoRoot, ratchet)
    : checkRatchet(repoRoot, ratchet, argv.includes('--ci'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPinnedValuesGate(resolve(import.meta.dirname, '..'), process.argv.slice(2));
}
