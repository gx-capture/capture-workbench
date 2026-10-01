import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { rejectDuplicateJsonKeys, workspaceRoot } from './release-intent.ts';

export interface VersionOwner {
  readonly path: string;
  readonly label: string;
  readonly pattern: RegExp;
  readonly jsonField?: string;
  readonly tomlSection?: 'project' | 'package';
  readonly xmlProjectVersion?: boolean;
}

const packageVersion = /^([\t ]*version[\t ]*=[\t ]*")([^"\r\n]+)(")/gmu;
const jsonOwner = (path: string, field: string): VersionOwner => ({
  path,
  label: `${path}:${field}`,
  pattern: new RegExp(`("${field}"\\s*:\\s*")([^"\\r\\n]+)(")`, 'gu'),
  jsonField: field,
});

/** Editable owners only. Generated contracts and evidence have their own producers. */
export const RELEASE_VERSION_OWNERS: readonly VersionOwner[] = [
  jsonOwner('release/version.json', 'releaseVersion'),
  jsonOwner('packages/capture-workbench-ui/package.json', 'version'),
  jsonOwner('packages/capture-runtime-client/package.json', 'version'),
  ...[
    'packages/capture-runtime/pyproject.toml',
    'packages/capture-runtime-client-python/pyproject.toml',
    'packages/capture-sidecar-launcher/Cargo.toml',
    'packages/capture-sidecar-launcher/tests/fixtures/activation-probe/Cargo.toml',
    'apps/capture-workbench-desktop/scripts/fixtures/deterministic-runtime/Cargo.toml',
    'apps/capture-workbench-desktop/src-tauri/Cargo.toml',
  ].map((path) => ({
    path,
    label: `${path}:version`,
    pattern: packageVersion,
    tomlSection: path.endsWith('pyproject.toml')
      ? ('project' as const)
      : ('package' as const),
  })),
  jsonOwner(
    'apps/capture-workbench-desktop/src-tauri/tauri.conf.json',
    'version',
  ),
  {
    path: 'packages/capture-runtime-client-java/pom.xml',
    label: 'Java SDK project version',
    xmlProjectVersion: true,
    pattern: /^(\x20{2}<version>)([^<\r\n]+)(<\/version>)/gmu,
  },
  {
    path: 'packages/capture-runtime/src/capture_runtime/constants/versions.py',
    label: 'Python runtime shared version',
    pattern: /^(RUNTIME_VERSION:\s*Final\s*=\s*")([^"\r\n]+)(")/gmu,
  },
  jsonOwner(
    'apps/capture-workbench-desktop/src-tauri/resources/capture-runtime-manifest.example.json',
    'runtimeVersion',
  ),
];

/** Maven indentation is cosmetic: only a direct project/version is an owner. */
function projectVersionRange(content: string): { start: number; end: number } {
  const stack: string[] = [];
  const ranges: { start: number; end: number }[] = [];
  let start: number | undefined;
  const tags = content.matchAll(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:[^>"']|"[^"]*"|'[^']*')*>/gu,
  );
  for (const tag of tags) {
    if (tag[0].startsWith('<!--') || tag[0].startsWith('<?')) continue;
    const name = /^<\/?([\w:.-]+)/u.exec(tag[0])?.[1];
    if (!name) throw new Error('Invalid Maven XML tag.');
    if (tag[0].startsWith('</')) {
      if (stack.at(-1) !== name) throw new Error('Unbalanced Maven XML.');
      if (
        name === 'version' &&
        stack.length === 2 &&
        stack[0] === 'project' &&
        start !== undefined
      ) {
        ranges.push({ start, end: tag.index });
        start = undefined;
      }
      stack.pop();
    } else if (!tag[0].endsWith('/>')) {
      if (name === 'version' && stack.length === 1 && stack[0] === 'project')
        start = tag.index + tag[0].length;
      stack.push(name);
    }
  }
  if (stack.length || ranges.length !== 1)
    throw new Error('Maven requires exactly one direct project/version owner.');
  return ranges[0];
}

export function assertReleaseVersion(version: string): void {
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u.test(
      version,
    )
  ) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

export function readOwner(
  root: string,
  owner: VersionOwner,
): { content: string; version: string; valueStart: number; valueEnd: number } {
  const path = resolve(root, owner.path);
  const canonicalRoot = realpathSync(root);
  const canonicalPath = realpathSync(path);
  if (
    !canonicalPath.startsWith(`${canonicalRoot}${sep}`) ||
    lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isFile()
  ) {
    throw new Error(
      `Version owner is not a regular file within the workspace: ${owner.path}`,
    );
  }
  const content = readFileSync(path, 'utf8');
  if (owner.xmlProjectVersion) {
    const range = projectVersionRange(content);
    const value = content.slice(range.start, range.end);
    const version = value.trim();
    assertReleaseVersion(version);
    const valueStart = range.start + value.indexOf(version);
    return {
      content,
      version,
      valueStart,
      valueEnd: valueStart + version.length,
    };
  }
  let scope = content;
  let offset = 0;
  if (owner.tomlSection) {
    const headers = [
      ...content.matchAll(
        new RegExp(
          `^[\\t ]*\\[${owner.tomlSection}\\][\\t ]*(?:#[^\\r\\n]*)?\\r?$`,
          'gmu',
        ),
      ),
    ];
    if (headers.length !== 1)
      throw new Error(
        `${owner.label} requires exactly one [${owner.tomlSection}] section.`,
      );
    offset = headers[0].index + headers[0][0].length;
    scope = content.slice(offset);
    const nextHeader = scope.search(/^[\t ]*\[/mu);
    if (nextHeader >= 0) scope = scope.slice(0, nextHeader);
  }
  const matches = [...scope.matchAll(owner.pattern)];
  if (matches.length !== 1)
    throw new Error(
      `${owner.label} must have exactly one owner; found ${matches.length}.`,
    );
  const version = matches[0][2];
  assertReleaseVersion(version);
  if (owner.jsonField) {
    rejectDuplicateJsonKeys(content, owner.path);
    const data: unknown = JSON.parse(content);
    if (
      !data ||
      typeof data !== 'object' ||
      (data as Record<string, unknown>)[owner.jsonField] !== version
    ) {
      throw new Error(`Missing top-level owner ${owner.label}.`);
    }
  }
  const valueStart = offset + matches[0].index + matches[0][1].length;
  return {
    content,
    version,
    valueStart,
    valueEnd: valueStart + version.length,
  };
}

export function collectEditableVersions(
  root = workspaceRoot,
): { label: string; value: string }[] {
  return RELEASE_VERSION_OWNERS.map((owner) => ({
    label: owner.label,
    value: readOwner(root, owner).version,
  }));
}
