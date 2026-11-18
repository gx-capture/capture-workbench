/** Retired names in tracked text and paths are a line-number-free ratchet. */
import { lstatSync, readFileSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedPaths,
  checkRatchet,
  numbered,
  readHookPayload,
  type Ratchet,
  writeRatchetBaseline,
} from './dead-code-gate.ts';
import { trackedFiles } from './pinned-values-gate.ts';

const LIST = 'tools/quality/retired-names.json';
const BASELINE = 'tools/quality/retired-names-baseline.json';
const SCRIPT = 'tools/retired-names-gate.ts';
const EXCLUDED = new Set([LIST, BASELINE, SCRIPT, 'tools/retired-names-gate.test.ts', 'CHANGELOG.md']);
const LOCK_FILE = /(?:^|\/)(?:[^/]+\.lock|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb|packages\.lock\.json|skills-lock\.json)$/u;

interface RetiredName {
  name: string;
  match: 'word' | 'substring' | 'substring-ignore-case';
  replacement: string;
  allowed: { glob: string; reason: string }[];
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseRetiredNames(json: string): RetiredName[] {
  const list: unknown = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error(`${LIST} must contain an array`);
  const names = new Set<string>();
  return (list as unknown[]).map((entry, index) => {
    const row = entry as Partial<RetiredName> | null;
    const label = typeof row?.name === 'string' ? JSON.stringify(row.name) : `at index ${index}`;
    const invalid = (detail: string): Error => new Error(`${LIST}: entry ${label} ${detail}`);
    if (!row || !nonempty(row.name)) throw invalid('needs a nonempty name');
    if (names.has(row.name)) throw invalid('duplicates a name');
    if (row.match !== 'word' && row.match !== 'substring' && row.match !== 'substring-ignore-case') {
      throw invalid('has an invalid match mode');
    }
    if (!nonempty(row.replacement)) throw invalid('needs a nonempty replacement');
    if (!Array.isArray(row.allowed) || row.allowed.some((rule) =>
      !rule || !nonempty(rule.glob) || !nonempty(rule.reason))) {
      throw invalid('needs an allowed array with a glob and reason for each rule');
    }
    names.add(row.name);
    return { name: row.name, match: row.match, replacement: row.replacement, allowed: row.allowed };
  });
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf16le = new TextDecoder('utf-16le', { fatal: true });
const utf16be = new TextDecoder('utf-16be', { fatal: true });

function readTrackedText(path: string): string | undefined {
  // Unstaged deletions and non-regular entries have no working-tree text.
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
  const bytes = readFileSync(path);
  const bom = bytes.subarray(0, 2).toString('hex');
  const decoder = bom === 'fffe' ? utf16le : bom === 'feff' ? utf16be : utf8;
  try {
    const source = decoder.decode(bytes);
    return source.includes('\0') ? undefined : source;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

export function collectRetiredNames(
  files: string[],
  entries: RetiredName[],
  read: (file: string) => string | undefined,
): string[] {
  const patterns = entries.map((entry) => {
    const literal = entry.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = entry.match === 'word'
      ? `(?<![\\p{ID_Continue}$])${literal}(?![\\p{ID_Continue}$])`
      : literal;
    return { entry, regex: new RegExp(pattern, entry.match === 'substring-ignore-case' ? 'giu' : 'gu') };
  });
  const keys: string[] = [];
  for (const file of new Set(files)) {
    if (EXCLUDED.has(file) || LOCK_FILE.test(file)) continue;
    const source = read(file);
    if (source === undefined) continue;
    for (const { entry, regex } of patterns) {
      if (entry.match !== 'substring-ignore-case' && !file.includes(entry.name) && !source.includes(entry.name)) {
        continue;
      }
      if (entry.allowed.some(({ glob }) => matchesGlob(file, glob))) continue;
      const key = JSON.stringify([entry.name, file]);
      for (const input of [file, source]) {
        while (regex.test(input)) keys.push(key);
      }
    }
  }
  return numbered(keys).sort();
}

export function runRetiredNamesGate(repoRoot: string, argv: string[], files?: string[]): number {
  const entries = parseRetiredNames(readFileSync(resolve(repoRoot, LIST), 'utf8'));
  const replacements = new Map(entries.map(({ name, replacement }) => [name, replacement]));
  const ratchet: Ratchet = {
    label: 'retired-names',
    noun: 'finding',
    baseline: BASELINE,
    script: SCRIPT,
    collect: () => collectRetiredNames(
      files ?? trackedFiles(repoRoot), entries, (file) => readTrackedText(resolve(repoRoot, file)),
    ),
    formatKey: (key) => {
      const [name, file] = JSON.parse(key.replace(/#\d+$/u, '')) as [string, string];
      return `  - ${file} :: ${name} → ${replacements.get(name) ?? 'removed from the retired names list'}`;
    },
    fixHint: ['Fix: use the replacement or remove the retired reference.'],
  };
  return argv.includes('--update')
    ? writeRatchetBaseline(repoRoot, ratchet)
    : checkRatchet(repoRoot, ratchet, argv.includes('--ci'));
}

async function main(repoRoot: string, argv: string[]): Promise<number> {
  if (!argv.includes('--hook')) return runRetiredNamesGate(repoRoot, argv);
  const payload = await readHookPayload();
  if (payload.stop_hook_active || changedPaths(repoRoot).length === 0) return 0;
  return runRetiredNamesGate(repoRoot, []) === 0 ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(resolve(import.meta.dirname, '..'), process.argv.slice(2));
}
