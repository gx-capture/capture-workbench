// Local manual runs that install engines or a clean consumer project keep
// their large trees instead of deleting them: deleting tens of thousands of
// small files stalls a Windows development machine, and the deletion is not
// what those runs verify. Each run gets a fresh directory under one root with a
// marker file, and the person removes trees one at a time when the machine is
// idle. GitHub runners keep deleting as before.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEPT_RUN_TREE_MARKER = 'kept-run-tree.json';
export const KEPT_RUN_TREES_ROOT_VARIABLE = 'CAPTURE_KEPT_RUN_TREES_ROOT';
const KEPT_RUN_TREE_REASON = 'Kept by a local run; safe to delete when no run uses it.';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface KeptRunTreeMarker {
  readonly script: string;
  readonly createdAt: string;
  readonly reason: string;
  readonly remove: string;
}

export interface KeptRunTree {
  readonly path: string;
  readonly script: string;
  readonly createdAt: string;
}

// Local verify scripts set CI=true, so only GITHUB_ACTIONS tells a GitHub
// runner apart from this machine.
export function keepsRunTrees(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.GITHUB_ACTIONS !== 'true';
}

export function keptRunTreesRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment[KEPT_RUN_TREES_ROOT_VARIABLE]?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`${KEPT_RUN_TREES_ROOT_VARIABLE} must be an absolute path.`);
    }
    return resolve(configured);
  }
  // Beside the checkout, not inside it, so the paths below stay short.
  return resolve(repositoryRoot, '..', '.kept-run-trees');
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Creates a fresh run directory `<directoryPrefix>-<yyyyMMddHHmmss>` under the
 * kept-trees root, writes its marker, and returns its path. A directory is
 * never reused: a name taken in the same second gets a numeric suffix. Keep
 * `directoryPrefix` short; engine installs below it must stay under the
 * Windows path limit.
 */
export function createKeptRunTree({
  script,
  directoryPrefix,
  environment = process.env,
  now = new Date(),
}: {
  readonly script: string;
  readonly directoryPrefix: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(directoryPrefix)) {
    throw new Error('A kept run tree prefix must be lowercase letters, digits and hyphens.');
  }
  const root = keptRunTreesRoot(environment);
  mkdirSync(root, { recursive: true });
  const base = `${directoryPrefix}-${timestamp(now)}`;
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const path = join(root, attempt === 1 ? base : `${base}-${attempt}`);
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const marker: KeptRunTreeMarker = {
      script,
      createdAt: now.toISOString(),
      reason: KEPT_RUN_TREE_REASON,
      remove: `pnpm run kept-run-trees -- --remove ${path}`,
    };
    writeFileSync(join(path, KEPT_RUN_TREE_MARKER), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return path;
  }
  throw new Error(`Could not create a fresh kept run tree for ${base}.`);
}

function readMarker(treePath: string): KeptRunTreeMarker | undefined {
  const markerPath = join(treePath, KEPT_RUN_TREE_MARKER);
  const metadata = lstatSync(markerPath, { throwIfNoEntry: false });
  if (!metadata?.isFile()) return undefined;
  try {
    const value = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<KeptRunTreeMarker>;
    return typeof value.script === 'string' && typeof value.createdAt === 'string'
      ? (value as KeptRunTreeMarker)
      : undefined;
  } catch {
    return undefined;
  }
}

// Reads only the root and each tree's marker; it never walks a tree.
export function listKeptRunTrees(environment: NodeJS.ProcessEnv = process.env): KeptRunTree[] {
  const root = keptRunTreesRoot(environment);
  if (!existsSync(root)) return [];
  const trees: KeptRunTree[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const marker = readMarker(path);
    if (marker) trees.push({ path, script: marker.script, createdAt: marker.createdAt });
  }
  return trees.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function sameFileName(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Deletes exactly one kept run tree: a real directory directly under the root
 * that holds a valid marker. Anything else, including the root itself, is
 * refused.
 */
export function removeKeptRunTree(path: string, environment: NodeJS.ProcessEnv = process.env): string {
  const root = keptRunTreesRoot(environment);
  const target = resolve(path);
  if (!sameFileName(dirname(target), root) || sameFileName(target, root)) {
    throw new Error(`Refusing to remove ${target}: it is not a kept run tree directly under ${root}.`);
  }
  const metadata = lstatSync(target, { throwIfNoEntry: false });
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing to remove ${target}: it is not a directory.`);
  }
  if (!sameFileName(dirname(realpathSync(target)), realpathSync(root))) {
    throw new Error(`Refusing to remove ${target}: it resolves outside ${root}.`);
  }
  if (!readMarker(target)) {
    throw new Error(`Refusing to remove ${target}: it has no ${KEPT_RUN_TREE_MARKER} marker.`);
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return target;
}

const usage =
  'Usage: pnpm run kept-run-trees -- --list | --remove <path> | --create <script> <directory-prefix>\n';

export function runKeptRunTreesCli(
  argv: readonly string[],
  io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void },
  environment: NodeJS.ProcessEnv = process.env,
): number {
  // pnpm may forward the `--` separator.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  try {
    if (args.length === 1 && args[0] === '--list') {
      const trees = listKeptRunTrees(environment);
      if (trees.length === 0) {
        io.stdout(`No kept run trees under ${keptRunTreesRoot(environment)}.\n`);
      }
      for (const tree of trees) io.stdout(`${tree.path}\t${tree.script}\t${tree.createdAt}\n`);
      return 0;
    }
    if (args.length === 2 && args[0] === '--remove') {
      io.stdout(`Removed ${removeKeptRunTree(args[1], environment)}.\n`);
      return 0;
    }
    // For scripts in other Nx projects, which may not import this module:
    // prints only the new directory's path.
    if (args.length === 3 && args[0] === '--create') {
      io.stdout(`${createKeptRunTree({ script: args[1], directoryPrefix: args[2], environment })}\n`);
      return 0;
    }
    io.stderr(usage);
    return 2;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runKeptRunTreesCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
