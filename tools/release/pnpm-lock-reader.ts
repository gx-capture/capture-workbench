import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface LockEntry {
  key: string;
  dependencies: readonly [string, string][];
}

function unquoteYamlKey(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseYamlMapping(line: string): [string, string] | undefined {
  const match = line.match(
    /^\s{6}(?:'([^']+)'|"([^"]+)"|([^:]+)):\s*(.*?)\s*$/u,
  );
  if (!match) return undefined;
  return [match[1] ?? match[2] ?? match[3].trim(), match[4]];
}

function parseLockSection(
  lock: string,
  section: 'packages' | 'snapshots',
): LockEntry[] {
  const lines = lock.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line === `${section}:`);
  if (sectionIndex < 0)
    throw new Error(`Missing ${section} section in pnpm-lock.yaml.`);
  const entries: LockEntry[] = [];
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z][^:]*:\s*$/u.test(line)) break;
    const entryMatch = line.match(
      /^\x20{2}(?:'([^']+)'|"([^"]+)"|([^:\s][^:]*)):\s*(.*)$/u,
    );
    if (!entryMatch) continue;
    const key = unquoteYamlKey(entryMatch[1] ?? entryMatch[2] ?? entryMatch[3]);
    const dependencies: [string, string][] = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child];
      if (/^\x20{2}(?:'[^']+'|"[^"]+"|[^:\s][^:]*):\s*/u.test(childLine)) break;
      if (
        /^\x20{4}(?:dependencies|optionalDependencies):\s*$/u.test(childLine)
      ) {
        for (
          let dependencyLine = child + 1;
          dependencyLine < lines.length;
          dependencyLine += 1
        ) {
          const dependency = parseYamlMapping(lines[dependencyLine]);
          if (dependency) {
            dependencies.push(dependency);
            continue;
          }
          if (
            lines[dependencyLine].trim() !== '' &&
            !/^\s{6}/u.test(lines[dependencyLine])
          ) {
            break;
          }
        }
      }
    }
    entries.push({ key, dependencies });
  }
  if (entries.length === 0)
    throw new Error(`Missing entries in ${section} section of pnpm-lock.yaml.`);
  return entries;
}

function parseImporterReferences(lock: string): readonly [string, string][] {
  const lines = lock.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line === 'importers:');
  if (sectionIndex < 0)
    throw new Error('Missing importers section in pnpm-lock.yaml.');
  const references: [string, string][] = [];
  let inDependencySection = false;
  let dependency: string | undefined;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === 'packages:') break;
    if (/^\x20{2}[^\s]/u.test(line)) {
      inDependencySection = false;
      dependency = undefined;
      continue;
    }
    if (
      /^\x20{4}(?:dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$/u.test(
        line,
      )
    ) {
      inDependencySection = true;
      dependency = undefined;
      continue;
    }
    if (!inDependencySection) continue;
    const dependencyMatch = line.match(
      /^\s{6}(?:'([^']+)'|"([^"]+)"|([^:\s][^:]*)):\s*$/u,
    );
    if (dependencyMatch) {
      dependency =
        dependencyMatch[1] ?? dependencyMatch[2] ?? dependencyMatch[3];
      continue;
    }
    const versionMatch = line.match(/^\s{8}version:\s*(.*?)\s*$/u);
    if (versionMatch && dependency) {
      references.push([dependency, versionMatch[1]]);
      dependency = undefined;
    }
  }
  return references;
}

function withoutPeerSuffix(key: string): string {
  const peerStart = key.indexOf('(');
  return peerStart < 0 ? key : key.slice(0, peerStart);
}

function assertPnpmLockGraphClosed(lock: string, sourcePath: string): void {
  if (!/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/mu.test(lock)) {
    throw new Error(`Unsupported pnpm lockfile version in ${sourcePath}.`);
  }
  const packages = parseLockSection(lock, 'packages');
  const snapshots = parseLockSection(lock, 'snapshots');
  const packageBaseKeys = new Set(
    packages.map((entry) => withoutPeerSuffix(entry.key)),
  );
  const snapshotKeys = new Set(snapshots.map((entry) => entry.key));
  const snapshotBaseKeys = new Set(
    snapshots.map((entry) => withoutPeerSuffix(entry.key)),
  );
  const assertReference = (
    dependency: string,
    reference: string,
    owner: string,
  ): void => {
    const value = unquoteYamlKey(reference);
    if (
      value === '' ||
      value.startsWith('workspace:') ||
      value.startsWith('link:') ||
      value.startsWith('file:') ||
      value.startsWith('catalog:') ||
      value.startsWith('patch:') ||
      value === '*' ||
      value === '^' ||
      value === '~'
    )
      return;
    const snapshotKey = `${dependency}@${value}`;
    const packageBase = withoutPeerSuffix(snapshotKey);
    if (!packageBaseKeys.has(packageBase) || !snapshotKeys.has(snapshotKey)) {
      throw new Error(
        `Missing pnpm package/snapshot for ${dependency}@${value} referenced by ${owner} in ${sourcePath}.`,
      );
    }
  };
  for (const entry of packages) {
    if (!snapshotBaseKeys.has(entry.key)) {
      throw new Error(
        `Missing pnpm snapshot for package ${entry.key} in ${sourcePath}.`,
      );
    }
  }
  for (const entry of snapshots) {
    for (const [dependency, reference] of entry.dependencies) {
      assertReference(dependency, reference, entry.key);
    }
  }
  for (const [dependency, reference] of parseImporterReferences(lock)) {
    assertReference(dependency, reference, 'importer');
  }
}

export function readPnpmLock(
  root: string,
  sourcePath: string,
): { specifiers: string[]; resolved: string[] } {
  const lock = readFileSync(resolve(root, sourcePath), 'utf8');
  assertPnpmLockGraphClosed(lock, sourcePath);
  const specifiers = [
    ...lock.matchAll(
      /^\s*['"]?(?:@nx\/[^'"]+|nx)['"]?:\s*\n?\n\s+specifier:\s+([0-9]+\.[0-9]+\.[0-9]+)/gmu,
    ),
  ].map((match) => match[1]);
  const resolved = [
    ...lock.matchAll(
      /(?:['"]?@nx\/[A-Za-z0-9_-]+|['"]?nx)@([0-9]+\.[0-9]+\.[0-9]+)/gu,
    ),
  ].map((match) => match[1]);
  return { specifiers, resolved };
}
