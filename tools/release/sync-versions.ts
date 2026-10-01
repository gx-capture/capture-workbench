import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReleaseIntent, workspaceRoot } from './release-intent.ts';
import { verifyNativeLockVersions } from './native-lock-versions.ts';
import {
  RELEASE_VERSION_OWNERS,
  assertReleaseVersion,
  readOwner,
} from './version-owners.ts';
import {
  collectReleaseInventory,
  verifyGeneratedVersions,
} from './version-sources.ts';

export interface VersionChange {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface VersionPlan {
  readonly releaseVersion: string;
  readonly changes: readonly VersionChange[];
  readonly followUp: readonly string[];
}

const FOLLOW_UP = [
  'Refresh Python/Cargo locks using their package managers; preserve external dependency resolutions.',
  'Prepare and verify the model-source snapshot/lock through the existing model approval workflow; never rewrite approval or provenance.',
  'Run pnpm nx run capture-runtime:generate-contracts and the existing engine/profile generators for the selected source lock.',
  'Recompute and review contract/receipt identities from canonical bytes, then run pnpm nx run capture-tools:release-version-check.',
] as const;

/** Validates every owner before returning any writes. No repository scan or replacement of consumer sites. */
export function planReleaseVersion(
  root = workspaceRoot,
  requestedVersion?: string,
): VersionPlan {
  const intent = loadReleaseIntent(root);
  const releaseVersion = requestedVersion ?? intent.releaseVersion;
  assertReleaseVersion(releaseVersion);
  const changes: VersionChange[] = [];
  for (const owner of RELEASE_VERSION_OWNERS) {
    const { content: before, valueStart, valueEnd } = readOwner(root, owner);
    const after = `${before.slice(0, valueStart)}${releaseVersion}${before.slice(valueEnd)}`;
    if (before !== after) changes.push({ path: owner.path, before, after });
  }
  let requiresGeneration = changes.length > 0;
  if (!requiresGeneration) {
    try {
      verifyGeneratedVersions(root, releaseVersion);
      collectReleaseInventory(root);
      verifyNativeLockVersions(root, releaseVersion);
    } catch {
      requiresGeneration = true;
    }
  }
  return {
    releaseVersion,
    changes,
    followUp: requiresGeneration ? FOLLOW_UP : [],
  };
}

/** Rechecks every snapshot before writing; restores our writes on failure. */
export function applyReleaseVersionPlan(
  root: string,
  plan: VersionPlan,
): string[] {
  const expected = planReleaseVersion(root, plan.releaseVersion);
  if (JSON.stringify(expected.changes) !== JSON.stringify(plan.changes)) {
    throw new Error(
      'Version sources changed since planning; regenerate the plan before applying.',
    );
  }
  const written: VersionChange[] = [];
  try {
    for (const change of plan.changes) {
      if (readFileSync(resolve(root, change.path), 'utf8') !== change.before)
        throw new Error(`Version owner changed during apply: ${change.path}`);
      written.push(change);
      writeFileSync(resolve(root, change.path), change.after, 'utf8');
    }
  } catch (error) {
    const failures: string[] = [];
    for (const change of written.reverse()) {
      try {
        writeFileSync(resolve(root, change.path), change.before, 'utf8');
      } catch {
        failures.push(change.path);
      }
    }
    if (failures.length)
      throw new Error(
        `Version update failed and restoration requires attention: ${failures.join(', ')}`,
        { cause: error },
      );
    throw error;
  }
  return plan.changes.map((change) => change.path);
}

/** Previews source owners unless apply is explicit. Check also verifies generated/native declarations. */
export function synchronizeReleaseVersion(
  root = workspaceRoot,
  {
    check = false,
    apply = false,
    version,
  }: { check?: boolean; apply?: boolean; version?: string } = {},
): string[] {
  if (check && apply) throw new Error('Select either check or apply, not both.');
  const plan = planReleaseVersion(root, version);
  if (check) {
    if (plan.changes.length)
      throw new Error(
        `Version owners are not synchronized:\n${plan.changes.map((change) => change.path).join('\n')}`,
      );
    verifyGeneratedVersions(root, plan.releaseVersion);
    collectReleaseInventory(root);
    verifyNativeLockVersions(root, plan.releaseVersion);
    return [];
  }
  return apply === true
    ? applyReleaseVersionPlan(root, plan)
    : plan.changes.map((change) => change.path);
}

export function main(args = process.argv.slice(2)): void {
  let root = workspaceRoot;
  let version: string | undefined;
  let mode: 'apply' | 'plan' | 'check' = 'plan';
  let selectedMode = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--version' || argument === '--root') {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`${argument} requires a value.`);
      if (argument === '--version') version = value;
      else root = resolve(value);
    } else if (
      ['--apply', '--plan', '--dry-run', '--check'].includes(argument)
    ) {
      if (selectedMode)
        throw new Error('Select one of --apply, --plan/--dry-run or --check.');
      selectedMode = true;
      mode =
        argument === '--check'
          ? 'check'
          : argument === '--apply'
            ? 'apply'
            : 'plan';
    } else throw new Error(`Unknown version option: ${argument}`);
  }
  const plan = planReleaseVersion(root, version);
  if (mode === 'check') {
    synchronizeReleaseVersion(root, { check: true, version });
    process.stdout.write(
      `Release version owners and derived declarations match ${plan.releaseVersion}.\n`,
    );
    return;
  }
  if (mode === 'apply') applyReleaseVersionPlan(root, plan);
  process.stdout.write(
    `${JSON.stringify({ mode, releaseVersion: plan.releaseVersion, changedFiles: plan.changes.map((change) => change.path), followUp: plan.followUp, status: mode === 'plan' ? 'planned' : 'version-sources-prepared' }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
