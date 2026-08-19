import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

export interface AcceptanceProjectPlan {
  readonly project: 'capture-workbench' | 'cert-prep' | 'law-prep';
  readonly cwd: string;
  readonly target: string;
  readonly artifactRoot: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function buildAcceptancePlan(
  workspaceRoot: string,
  runId: string,
  recordVideo: boolean,
): AcceptanceProjectPlan[] {
  assertSafeRunId(runId);
  const root = resolve(workspaceRoot);
  const projects = [
    { project: 'capture-workbench' as const, cwd: join(root, 'capture-workbench'), nx: 'capture-workbench-desktop' },
    { project: 'cert-prep' as const, cwd: join(root, 'cert-prep'), nx: 'cert-prep-desktop' },
    { project: 'law-prep' as const, cwd: join(root, 'gx.law-prep'), nx: 'law-prep-web-e2e' },
  ];
  return projects.map(({ project, cwd, nx }) => ({
    project,
    cwd,
    target: `${nx}:acceptance-real${recordVideo ? '-recorded' : ''}`,
    artifactRoot: join(cwd, 'output', 'playwright', project, runId),
    environment: {
      ...process.env,
      E2E_ACCEPTANCE_RUN_ID: runId,
      E2E_RECORD_VIDEO: recordVideo ? '1' : '0',
      E2E_ARTIFACT_ROOT: join(cwd, 'output', 'playwright', project, runId),
    },
  }));
}

async function main(): Promise<void> {
  const captureRoot = resolve(import.meta.dirname, '..');
  const siblingRoot = resolve(captureRoot, '..');
  const runId = process.env.E2E_ACCEPTANCE_RUN_ID?.trim() || `run-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`;
  assertSafeRunId(runId);
  const recordVideo = process.argv.includes('--recorded');
  const plan = buildAcceptancePlan(siblingRoot, runId, recordVideo);
  const results: Array<{ project: string; status: string; manifest: string; exitCode: number }> = [];

  for (const item of plan) {
    process.stdout.write(`\n=== ${item.project} ${item.target} ===\n`);
    const result = spawnSync(
      'corepack',
      ['pnpm', 'nx', 'run', item.target],
      { cwd: item.cwd, env: item.environment, stdio: 'inherit', shell: true, windowsHide: false },
    );
    const exitCode = result.error ? 1 : result.status ?? 1;
    const manifestPath = join(item.artifactRoot, 'acceptance-manifest.json');
    const manifest = await readManifest(manifestPath);
    const childValid = await validateChildManifest(manifest, item, runId, recordVideo);
    results.push({
      project: item.project,
      status: childValid ? 'completed' : typeof manifest?.status === 'string' ? manifest.status : 'missing',
      manifest: relative(captureRoot, manifestPath).replaceAll('\\', '/'),
      exitCode,
    });
    if (exitCode !== 0 || !childValid) break;
  }

  const aggregateRoot = join(captureRoot, 'output', 'playwright', 'three-projects', runId);
  await mkdir(aggregateRoot, { recursive: true });
  const status = results.length === plan.length && results.every((result) => result.exitCode === 0 && result.status === 'completed')
    ? 'completed'
    : 'failed';
  const aggregate = {
    schemaVersion: 1,
    runId,
    recordVideo,
    status,
    projects: results,
  };
  await writeFile(join(aggregateRoot, 'three-projects-manifest.json'), `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  process.exitCode = status === 'completed' ? 0 : 1;
}

async function readManifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const serialized = JSON.stringify(parsed);
    if (/Bearer\s+[^<\s]+|[A-Za-z]:[\\/]|\/(?:Users|private|home|software-dev)\//u.test(serialized)) {
      throw new Error(`Acceptance manifest contains an unredacted secret or absolute path: ${path}`);
    }
    return parsed;
  } catch (error) {
    process.stderr.write(`Acceptance manifest unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

export async function validateChildManifest(
  manifest: { status?: unknown; [key: string]: unknown } | undefined,
  item: AcceptanceProjectPlan,
  runId: string,
  recordVideo: boolean,
): Promise<boolean> {
  if (!manifest || manifest.status !== 'completed') return false;
  if (manifest.schemaVersion !== 1) return false;
  if (manifest.project !== item.project || manifest.runId !== runId || manifest.recordVideo !== recordVideo) return false;
  const fixture = manifest.fixture;
  if (!fixture || typeof fixture !== 'object') return false;
  const fixtureRecord = fixture as Record<string, unknown>;
  if (typeof fixtureRecord.name !== 'string' || !fixtureRecord.name.trim() ||
    typeof fixtureRecord.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(fixtureRecord.sha256)) return false;
  const cleanup = manifest.cleanup;
  if (!cleanup || typeof cleanup !== 'object' || !Object.values(cleanup as Record<string, unknown>).every((value) => value === true)) return false;
  for (const key of ['errors', 'consoleErrors', 'pageErrors']) {
    if (!Array.isArray(manifest[key]) || (manifest[key] as unknown[]).length !== 0) return false;
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) return false;
  const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
  for (const artifact of artifacts) {
    if (typeof artifact.path !== 'string' || !artifact.path || artifact.path.startsWith('/') ||
      /^[A-Za-z]:/u.test(artifact.path) || artifact.path.split('/').includes('..') ||
      typeof artifact.bytes !== 'number' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
      typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) return false;
    const absolutePath = resolve(item.artifactRoot, artifact.path);
    const inside = relative(resolve(item.artifactRoot), absolutePath);
    if (!inside || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      /^[A-Za-z]:/u.test(inside)) return false;
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size !== artifact.bytes) return false;
    const digest = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
    if (digest !== artifact.sha256) return false;
  }
  if (!artifacts.some((artifact) => artifact.kind === 'screenshot')) return false;
  if (recordVideo && !artifacts.some((artifact) => artifact.kind === 'video' && typeof artifact.path === 'string' && artifact.path.endsWith('.webm'))) return false;
  return true;
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(runId)) {
    throw new Error('E2E_ACCEPTANCE_RUN_ID must be a safe non-empty run ID.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
