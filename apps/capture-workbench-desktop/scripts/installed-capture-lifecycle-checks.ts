// What the installed capture-lifecycle check proves, decided without a window:
// the phase order and its fail-closed rules, each claim's condition over what
// the check observed, and the shape of its evidence. The window work itself is
// in installed-capture-lifecycle.ts.
import {
  type Observable,
  type ObservableInput,
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  from,
  last,
  map,
  of,
  toArray,
} from 'rxjs';

import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { REGISTRY_VIEWS, UNINSTALLER_NAME } from './constants/installed.ts';
import { assertStrictDescendant } from './contracts/installed.ts';
import { assertRedactedEvidence } from './hash-qa-installer.ts';

/**
 * Where one run keeps its files, all below the repository's git-ignored
 * `tmp/`. The run tree is small (the QA build, WebView2 data and the fixture
 * library), so it is removed at the end of a run that proved it may remove
 * it; otherwise it is kept for recovery.
 */
/** The marker file a run writes first into its new run tree. */
const RUN_MARKER_FILE = 'installed-capture-lifecycle-run.json';

export function lifecycleCheckPaths(workspaceRoot: string) {
  const root = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'installed-capture-lifecycle');
  const run = join(root, 'run');
  const paths = {
    root,
    run,
    /** Written first into a new run tree; cleanup removes only a tree with this run's marker. */
    marker: join(run, RUN_MARKER_FILE),
    install: join(run, 'install'),
    webViewData: join(run, 'webview2'),
    appData: join(run, 'appdata'),
    localAppData: join(run, 'localappdata'),
    /** The app's TEMP: the fixture runtime reads its controls and writes its request log here. */
    appTemporary: join(run, 'temp'),
    /** The native library of the QA build (CAPTURE_ACCEPTANCE_APP_DATA_ROOT). */
    library: join(run, 'artifacts', 'appdata'),
    sources: join(run, 'sources'),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (name !== 'root') assertStrictDescendant(root, path, `Capture-lifecycle ${name} path`);
  }
  return paths;
}

/** What the file system says about one path component. */
export type PathComponent =
  | { readonly exists: false }
  | { readonly exists: true; readonly link: boolean; readonly realPath: string };

export function probePathComponent(path: string): PathComponent {
  let link: boolean;
  try {
    // On Windows, lstat reports both symbolic links and junctions as links.
    link = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
  // A link is reported as soon as lstat shows it: resolving a dangling link
  // would make it look like a component that does not exist yet.
  if (link) return { exists: true, link: true, realPath: path };
  return { exists: true, link: false, realPath: realpathSync.native(path) };
}

/**
 * The first component from the workspace root itself down to the target that
 * is a link or junction, or (below the root) resolves anywhere but its own
 * place (any redirecting reparse point), as a workspace-relative path, `.`
 * for the root; null when none is. A link above the workspace root is not this
 * check's concern. Components that do not exist yet end the walk: the check
 * creates them.
 */
export function firstRedirectedComponent(
  workspaceRoot: string,
  target: string,
  probe: (path: string) => PathComponent = probePathComponent,
): string | null {
  const below = assertStrictDescendant(workspaceRoot, target, 'Checked path');
  const workspace = probe(workspaceRoot);
  if (!workspace.exists) throw new Error('The workspace root does not exist.');
  if (workspace.link) return '.';
  const names = relative(workspaceRoot, below).split(sep);
  for (let index = 1; index <= names.length; index += 1) {
    const component = join(workspaceRoot, ...names.slice(0, index));
    const found = probe(component);
    if (!found.exists) return null;
    const expected = join(workspace.realPath, ...names.slice(0, index));
    if (found.link || found.realPath.toLowerCase() !== expected.toLowerCase()) {
      return names.slice(0, index).join('/');
    }
  }
  return null;
}

export function assertNotRedirected(
  workspaceRoot: string,
  target: string,
  probe: (path: string) => PathComponent = probePathComponent,
): void {
  const redirected = firstRedirectedComponent(workspaceRoot, target, probe);
  if (redirected !== null) {
    throw new Error(
      `Refusing to create or remove files: ${redirected === '.' ? 'the workspace root' : redirected} is a symbolic link, junction or other redirecting reparse point. Replace it with a real directory.`,
    );
  }
}

/** A directory this process made, with the identity the file system gave it. */
export interface OwnedDirectory {
  readonly path: string;
  readonly identity: string;
}

function directoryIdentity(path: string): string | null {
  const metadata = lstatSync(path, { bigint: true });
  return metadata.isDirectory() && !metadata.isSymbolicLink() ? `${metadata.dev}:${metadata.ino}` : null;
}

/** Records the identity of a directory right after this process made it. */
export function claimOwnedDirectory(path: string): OwnedDirectory {
  const identity = directoryIdentity(path);
  if (identity === null) throw new Error('A directory this run made is not a real directory.');
  return { path, identity };
}

/**
 * Removes a directory this process made; used by the cleanup phase and by the
 * command line's exit hook alike. It removes only when the path lies below the
 * check's root, no component down to it is redirected, and the directory there
 * is still the one this process made (a real directory with the recorded
 * identity). Otherwise it leaves everything in place and says why.
 */
export function removeOwnedDirectory(
  workspaceRoot: string,
  root: string,
  owned: OwnedDirectory,
): { readonly removed: boolean; readonly detail: string } {
  try {
    assertStrictDescendant(root, owned.path, 'Removed directory');
    assertNotRedirected(workspaceRoot, owned.path);
    let identity: string | null;
    try {
      identity = directoryIdentity(owned.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true, detail: 'It was already gone.' };
      throw error;
    }
    if (identity === null) return { removed: false, detail: 'Left in place: it is no longer a real directory.' };
    if (identity !== owned.identity) return { removed: false, detail: 'Left in place: it is not the directory this run made.' };
    rmSync(owned.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { removed: true, detail: 'Removed.' };
  } catch (error) {
    return { removed: false, detail: `Left in place: ${errorMessage(error)}` };
  }
}

/**
 * Whether the directory is still the one this process made below `root`: the
 * same checks as the removal, without removing anything.
 */
export function isOwnedDirectory(workspaceRoot: string, root: string, owned: OwnedDirectory): boolean {
  try {
    assertStrictDescendant(root, owned.path, 'Owned directory');
    assertNotRedirected(workspaceRoot, owned.path);
    return directoryIdentity(owned.path) === owned.identity;
  } catch {
    return false;
  }
}

/**
 * What the install directory holds of the installation's uninstaller:
 * `present` only for a regular file in a directory no link redirects, and
 * `unverified` when anything else is there or it could not be checked.
 */
export function uninstallerState(workspaceRoot: string, installDirectory: string): 'absent' | 'present' | 'unverified' {
  try {
    assertNotRedirected(workspaceRoot, installDirectory);
    const metadata = lstatSync(join(installDirectory, UNINSTALLER_NAME));
    return metadata.isFile() && !metadata.isSymbolicLink() ? 'present' : 'unverified';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unverified';
  }
}

/** The marker this run writes first into its new run tree. */
export function runMarker(runId: string, pid: number, startedAt: string): string {
  return `${JSON.stringify({ check: 'installed-capture-lifecycle', runId, pid, startedAt })}\n`;
}

export function isMarkerOfRun(contents: string | null, runId: string): boolean {
  if (contents === null) return false;
  try {
    const marker = JSON.parse(contents) as { check?: unknown; runId?: unknown };
    return marker.check === 'installed-capture-lifecycle' && marker.runId === runId;
  } catch {
    return false;
  }
}

/** What proves no process of the run is left: both inventories and the CDP ports. */
export interface ProcessProof {
  /** The cleanup helper's proof: no process runs from the install or temporary directory. */
  readonly ownedRootsEmpty: boolean;
  /** The app-tree inventory: no descendant of the app, process under the run, or WebView2 process of the run. */
  readonly runTreeEmpty: boolean;
  readonly cdpPortsReleased: boolean;
}

export function processProofHolds(proof: ProcessProof | null): boolean {
  return proof !== null && proof.ownedRootsEmpty && proof.runTreeEmpty && proof.cdpPortsReleased;
}

/** The uninstaller runs only on an installation of this run, and only after the full process proof. */
export function uninstallDecision(installationAttempted: boolean, proofBefore: ProcessProof | null): 'nothing-installed' | 'refused' | 'run' {
  if (!installationAttempted) return 'nothing-installed';
  return processProofHolds(proofBefore) ? 'run' : 'refused';
}

/** Registry keys go only after the uninstaller ran and nothing of the run came back. */
export function mayRemoveRegistryResidue(uninstalled: boolean, proofAfter: ProcessProof | null): boolean {
  return uninstalled && processProofHolds(proofAfter);
}

/**
 * The run tree (with the WebView2 profile and, after a failed uninstall, the
 * uninstaller) is removed only when this run made it and every check after
 * the uninstall passed: the process proofs, the installation gone with its
 * registry keys, and the real product app data unchanged. Otherwise it is
 * kept, as recovery material and as the record of what the run wrote, and
 * the reason is reported.
 */
export function runTreeDecision(facts: {
  readonly runTreeCreated: boolean;
  readonly markerOfThisRun: boolean;
  readonly proofBefore: ProcessProof | null;
  readonly installationAttempted: boolean;
  readonly uninstalled: boolean;
  readonly proofAfter: ProcessProof | null;
  readonly registryClean: boolean;
  /** Null when the run never got to snapshot the real app data. */
  readonly realAppDataUnchanged: boolean | null;
}): { readonly remove: boolean; readonly reason: string } {
  if (!facts.runTreeCreated) return { remove: false, reason: 'This run made no run tree.' };
  if (!facts.markerOfThisRun) return { remove: false, reason: 'The run tree does not carry this run\'s marker.' };
  if (!processProofHolds(facts.proofBefore)) return { remove: false, reason: 'The processes of the run were not proven stopped.' };
  if (facts.installationAttempted) {
    if (!facts.uninstalled) return { remove: false, reason: 'The uninstaller did not remove the installation.' };
    if (!processProofHolds(facts.proofAfter)) return { remove: false, reason: 'A process of the run was found after the uninstall.' };
    if (!facts.registryClean) return { remove: false, reason: 'A registry key of the QA build remains.' };
  }
  if (facts.realAppDataUnchanged === false) return { remove: false, reason: 'The real product app data changed during the run.' };
  return { remove: true, reason: 'Every process proof passed, nothing of the installation remains and the real app data is unchanged.' };
}

/**
 * What a person looks at in the run tree an earlier run left. This run did not
 * make it and cannot verify whose it is, so it names nothing to run or delete.
 */
export function earlierRunTreeRecovery(relativeRunPath: string): string {
  return `Look at ${relativeRunPath}/${RUN_MARKER_FILE} (which run made the tree, and when) and at ${relativeRunPath}/install (an installation of the QA build may still be there): `
    + 'this run did not make the tree, so it does not tell you to run anything in it or delete it.';
}

/** A registry key of the QA build in the one registry view it was seen in. */
export interface RemainingRegistryKey {
  readonly key: string;
  readonly view: string;
  /** Whether its install location is this run's install directory; null when it could not be read. */
  readonly installLocationOurs: boolean | null;
}

/** What is still there after cleanup, as far as the run could see. */
export interface RunRemains {
  /** Processes of the run in the last inventory. */
  readonly processes: readonly { readonly pid: number; readonly name: string }[];
  /** Why the last process proof did not hold, when it did not. */
  readonly processProofFailure: string | null;
  /** The run tree carries this run's marker and is still the directory this run made. */
  readonly runTreeOwned: boolean;
  /** The installation's uninstaller in the run tree, as `uninstallerState` found it. */
  readonly uninstaller: 'absent' | 'present' | 'unverified';
  /** Registry keys of the QA build that still exist, per view; null when they could not be read. */
  readonly registryKeys: readonly RemainingRegistryKey[] | null;
  /** Both keys of the QA build, named when the registry could not be read. */
  readonly productKeys: readonly string[];
  readonly realAppDataChanged: boolean;
  /** Why the removal of the run tree itself failed, when everything else was clean. */
  readonly removalFailure: string | null;
}

/**
 * The steps that recover a kept run tree, for exactly what remains, in the
 * order to take them. A step that runs or deletes something is given only for
 * what the run verified as its own: the uninstaller and the tree only while
 * the tree carries this run's marker and is the directory the run made, a
 * registry key only in the view it was seen in and with this run's install
 * directory as its install location. For anything else the step says what to
 * look at and why. Paths are relative to the workspace root; registry keys
 * and process names are not paths.
 */
export function recoverySteps(relativeRunPath: string, remains: RunRemains): string[] {
  const steps: string[] = [];
  const install = `${relativeRunPath}/install`;
  if (remains.processes.length > 0) {
    steps.push(`End the processes of the run that are still there: ${remains.processes.map((process) => `${process.name} (PID ${process.pid})`).join(', ')}.`);
  } else if (remains.processProofFailure !== null) {
    steps.push(`Make sure no process of the run is left; the check could not prove it: ${remains.processProofFailure}`);
  }
  const runUninstaller = remains.runTreeOwned && remains.uninstaller === 'present';
  if (runUninstaller) {
    steps.push(`Run ${install}/${UNINSTALLER_NAME} /S.`);
  } else if (remains.uninstaller !== 'absent') {
    const why = remains.runTreeOwned
      ? 'it is not a regular file in a real directory, or could not be checked'
      : 'the run tree is not proven to be this run\'s';
    steps.push(`Look at ${install}/${UNINSTALLER_NAME}: the check could not verify that it is the uninstaller of this run's installation (${why}), so it does not tell you to run it.`);
  }
  const query = (key: string, view: string) => `reg query "${key}" /reg:${view}`;
  if (remains.registryKeys === null) {
    const queries = remains.productKeys.flatMap((key) => REGISTRY_VIEWS.map((view) => query(key, view)));
    steps.push(`The registry could not be read, so no key is known to be this run's. Look at these keys of the QA build: ${queries.join('; ')}; a key of this run has ${install} as its install location.`);
  } else {
    const ours = remains.registryKeys.filter((key) => key.installLocationOurs === true);
    const unverified = remains.registryKeys.filter((key) => key.installLocationOurs !== true);
    if (ours.length > 0) {
      const deletes = ours.map(({ key, view }) => `reg delete "${key}" /reg:${view} /f`);
      steps.push(`${runUninstaller ? 'After the uninstaller, delete these keys of this run if they are still there' : 'Delete the keys this run\'s installation left'}: ${deletes.join('; ')}.`);
    }
    if (unverified.length > 0) {
      const looks = unverified.map(({ key, view, installLocationOurs }) =>
        `${query(key, view)} (its install location ${installLocationOurs === null ? 'could not be read' : `is not ${install}`})`);
      steps.push(`Look at these keys of the QA build, which may belong to another installation: ${looks.join('; ')}; the check did not verify them as this run's, so it does not tell you to delete them.`);
    }
  }
  if (remains.realAppDataChanged) {
    steps.push(`The real product app data changed during the run: compare it with what ${relativeRunPath} holds${remains.runTreeOwned ? ' before you delete the run tree' : ''}.`);
  }
  if (remains.removalFailure !== null) steps.push(`The run tree could not be removed: ${remains.removalFailure}`);
  if (remains.runTreeOwned) {
    steps.push(`Delete ${relativeRunPath}.`);
  } else {
    steps.push(`Look at ${relativeRunPath} and its marker ${relativeRunPath}/${RUN_MARKER_FILE}: the tree does not carry this run's marker or is no longer the directory this run made, so the check does not tell you to delete it.`);
  }
  return steps;
}

/** What the command line prints about a kept run tree: the only place its absolute path appears. */
export function keptRunTreeReport(workspaceRoot: string, keptRunTree: string | null, recovery: readonly string[]): string[] {
  if (keptRunTree === null) return [];
  return [
    `The run tree was kept: ${resolve(workspaceRoot, keptRunTree)}`,
    `To recover (paths are relative to ${resolve(workspaceRoot)}):`,
    ...recovery.map((step, index) => `  ${index + 1}. ${step}`),
  ];
}

export const LIFECYCLE_PHASES = [
  'install',
  'launch',
  'first-run',
  'reload-during-capture',
  'close-during-capture',
  'native-drop',
  'close',
  'uninstall',
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

/** Phases that still run after an earlier phase failed: they remove what the run installed. */
const PHASES_AFTER_FAILURE: ReadonlySet<LifecyclePhase> = new Set(['uninstall']);

/** A run passes only when every process of the app tree exited within this time after the close message. */
export const TREE_EXIT_BOUND_MS = 1_000;
/** The times after the close message by which no process of the run may be left. */
export const CLOSE_DEADLINES_AFTER_MS = [1_000, 5_000, 15_000] as const;
/**
 * How long before its deadline a snapshot starts. A snapshot shows a process
 * gone only from the time its inventory returned, so it must have returned by
 * the deadline; the inventory takes about 0.2 s.
 */
export const SAMPLE_LEAD_MS = 500;
/**
 * The schedule the close helper takes: one snapshot per deadline. The first
 * one is also the only way a process whose handle could not be opened can be
 * shown gone within the exit bound.
 */
export const CLOSE_HELPER_SAMPLES_AFTER_MS: readonly number[] = CLOSE_DEADLINES_AFTER_MS.map((ms) => ms - SAMPLE_LEAD_MS);

export const LIFECYCLE_CLAIMS = {
  'install.scoped': 'The QA installer installs silently into the run directory, with no earlier QA installation, and its registry entries point there.',
  'launch.connected': 'The installed app starts, its packaged page answers over WebView2 CDP, and the app and its runtime run from the install directory.',
  'first-run.ready': 'First-run setup makes text recognition and speech recognition ready.',
  'reload.capture-running': 'Before the reload key the row shows processing and the stored document holds a capture link.',
  'reload.window-reloaded': 'The reload key sent to the window reloads the packaged page.',
  'reload.row-interrupted': 'After the reload the row shows interrupted, offers Start again and no Cancel, and shows no live transcript.',
  'reload.nothing-written': 'The reload writes nothing: the stored document is unchanged and no library write is sent.',
  'reload.one-runtime-delete': 'After the reload the page asks the host to delete exactly the stored capture link, and the only capture request the runtime gets is one DELETE answered for that capture.',
  'start-again.completes': 'Start again creates exactly one capture, and the row completes with its raw text stored and no capture link.',
  'close.capture-running': 'Before the close message the row shows processing and the stored document holds a capture link.',
  'close.tree-observed': 'Before the close message the app tree holds the app, its runtime and WebView2 processes, and the app root has an open handle.',
  'close.tree-exited': `Every process of the app tree exits within ${TREE_EXIT_BOUND_MS} ms of the close message.`,
  'close.nothing-left': `No process of the run is left by ${CLOSE_DEADLINES_AFTER_MS.map((ms) => `${ms / 1_000} s`).join(', ')} after the close message: for each time, a snapshot started ${SAMPLE_LEAD_MS} ms before it, whose inventory returned by it, holds none.`,
  'next-start.row-interrupted': 'At the next start the row shows interrupted and offers Start again.',
  'next-start.nothing-written': 'The next start writes nothing: no library file changes, and the page, recorded from before its first script, sends no library write.',
  'next-start.stored-link-delete-requested': 'At the next start the page, recorded from before its first script, asks the host once to delete exactly the stored capture link, and the only capture request the new runtime gets is one DELETE, answered 204 or 404.',
  'drop.accepted': 'The native OLE drop of real file paths is released at the drop point over the window of the app and accepted with the Copy effect.',
  'drop.imported-in-order': 'Every dropped file is imported, in the order of the drop.',
  'drop.one-capture-while-held': 'While the first capture is held the runtime has created that capture and no other; the other files wait without a capture link.',
  'drop.one-at-a-time': 'One capture runs at a time, in import order: each document\'s capture starts after the previous one\'s terminal library write, and the runtime creates it (a successful create naming it) only after it answered the previous capture\'s outcome read.',
  'drop.all-completed': 'Every dropped file completes with its raw text stored and no capture link, the runtime created exactly the captures the page linked to them, and each file\'s row on the page shows done.',
  'uninstall.processes-stopped': 'No process of the run remains: none under the install and temporary directories, none in the app tree, no WebView2 process of the run, and every CDP port is released.',
  'uninstall.uninstalled': 'The uninstaller removes the install directory and the uninstall registry key, and no process of the run is found after it.',
  'uninstall.registry-clean': 'No registry key of the QA build remains.',
  'uninstall.real-app-data-unchanged': 'The real product app data is unchanged.',
  'uninstall.run-tree-removed': 'The run directory, which carries this run\'s marker, is removed.',
  'uninstall.check-temp-removed': 'The check\'s own temporary directory is removed.',
} as const;
export type LifecycleClaim = keyof typeof LIFECYCLE_CLAIMS;

export const RELOAD_SUBJECTS = { F5: 'F5 on the OCR page', CtrlR: 'Ctrl+R on the ASR page' } as const;
export const CLOSE_SUBJECTS = { duringCapture: 'close during an OCR capture', final: 'final close' } as const;
export const DROP_SUBJECTS = { ocr: 'drop on the OCR page', asr: 'drop on the ASR page', history: 'drop on History' } as const;

/** Every claim a passing run proves, with its subject where a phase proves it more than once. */
export const EXPECTED_CLAIMS: readonly { readonly claim: LifecycleClaim; readonly subject: string | null }[] = [
  { claim: 'install.scoped', subject: null },
  { claim: 'launch.connected', subject: null },
  { claim: 'first-run.ready', subject: null },
  ...Object.values(RELOAD_SUBJECTS).flatMap((subject) => ([
    'reload.capture-running', 'reload.window-reloaded', 'reload.row-interrupted', 'reload.nothing-written',
    'reload.one-runtime-delete', 'start-again.completes',
  ] as const).map((claim) => ({ claim, subject }))),
  ...([
    'close.capture-running', 'close.tree-observed', 'close.tree-exited', 'close.nothing-left', 'next-start.row-interrupted',
    'next-start.nothing-written', 'next-start.stored-link-delete-requested', 'start-again.completes',
  ] as const).map((claim) => ({ claim, subject: CLOSE_SUBJECTS.duringCapture })),
  ...(['close.tree-observed', 'close.tree-exited', 'close.nothing-left'] as const)
    .map((claim) => ({ claim, subject: CLOSE_SUBJECTS.final })),
  ...Object.values(DROP_SUBJECTS).flatMap((subject) => ([
    'drop.accepted', 'drop.imported-in-order', 'drop.one-capture-while-held', 'drop.one-at-a-time', 'drop.all-completed',
  ] as const).map((claim) => ({ claim, subject }))),
  ...([
    'uninstall.processes-stopped', 'uninstall.uninstalled', 'uninstall.registry-clean',
    'uninstall.real-app-data-unchanged', 'uninstall.run-tree-removed', 'uninstall.check-temp-removed',
  ] as const).map((claim) => ({ claim, subject: null })),
];

/** The expected claims no phase recorded as proven, as `claim (subject)`. */
export function missingClaims(phases: readonly { readonly claims: readonly ClaimRecord[] }[]): string[] {
  const proven = new Set(phases.flatMap((phase) => phase.claims.filter((record) => record.proven)
    .map((record) => `${record.claim}|${record.subject ?? ''}`)));
  return EXPECTED_CLAIMS
    .filter(({ claim, subject }) => !proven.has(`${claim}|${subject ?? ''}`))
    .map(({ claim, subject }) => `${claim}${subject ? ` (${subject})` : ''}`);
}

export class ClaimNotProven extends Error {
  readonly claim: LifecycleClaim;
  readonly detail: string;

  constructor(claim: LifecycleClaim, detail: string, subject?: string) {
    super(`Claim ${claim}${subject ? ` (${subject})` : ''} not proven: ${LIFECYCLE_CLAIMS[claim]} ${detail}`);
    this.name = 'ClaimNotProven';
    this.claim = claim;
    this.detail = detail;
  }
}

export interface ClaimRecord {
  readonly claim: LifecycleClaim;
  readonly subject: string | null;
  readonly proven: boolean;
  readonly detail: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The claims one phase proves, in the order it proves them, and what it observed on the way. */
export class PhaseClaims {
  readonly records: ClaimRecord[] = [];
  readonly observations: Record<string, unknown> = {};
  private pending: { claim: LifecycleClaim; subject: string | null } | null = null;

  /** Keeps an observation for the evidence, also when the phase fails later. */
  observe(key: string, value: unknown): void {
    this.observations[key] = value;
  }

  /** Names the claim the next steps work towards: a failure in them fails this claim. */
  begin(claim: LifecycleClaim, subject?: string): void {
    this.pending = { claim, subject: subject ?? null };
  }

  /** Records the claim, and stops the phase when it does not hold. */
  prove(claim: LifecycleClaim, holds: boolean, detail: string, subject?: string): void {
    this.records.push({ claim, subject: subject ?? null, proven: holds, detail });
    this.pending = null;
    if (!holds) throw new ClaimNotProven(claim, detail, subject);
  }

  /** Records the claim and goes on: cleanup tries every step and reports each one. */
  check(claim: LifecycleClaim, holds: boolean, detail: string, subject?: string): boolean {
    this.records.push({ claim, subject: subject ?? null, proven: holds, detail });
    return holds;
  }

  /** Fails the phase with the first recorded claim that did not hold. */
  requireAll(): void {
    const failed = this.records.find((record) => !record.proven);
    if (failed) throw new ClaimNotProven(failed.claim, failed.detail, failed.subject ?? undefined);
  }

  /** The message of a phase that stopped: always the claim it could not prove. */
  failureOf(error: unknown): { readonly claim: LifecycleClaim | null; readonly message: string } {
    if (error instanceof ClaimNotProven) return { claim: error.claim, message: error.message };
    const pending = this.pending;
    if (!pending) return { claim: null, message: `Failed before naming a claim: ${errorMessage(error)}` };
    this.records.push({ claim: pending.claim, subject: pending.subject, proven: false, detail: errorMessage(error) });
    return {
      claim: pending.claim,
      message: new ClaimNotProven(pending.claim, errorMessage(error), pending.subject ?? undefined).message,
    };
  }
}

export interface PhaseRecord {
  readonly phase: LifecyclePhase;
  readonly outcome: 'passed' | 'failed' | 'skipped';
  readonly durationMs: number | null;
  readonly claims: readonly ClaimRecord[];
  readonly failedClaim: LifecycleClaim | null;
  readonly failure: string | null;
  readonly observations: unknown;
}

/**
 * Runs the phases in their fixed order. After a failed phase the remaining
 * phases are skipped, except those that remove what the run installed; they
 * run whatever happened before, and their own failure fails the run too.
 */
export function runLifecyclePhases(
  run: (phase: LifecyclePhase, claims: PhaseClaims) => ObservableInput<unknown>,
  clock: () => number = Date.now,
): Observable<PhaseRecord[]> {
  let failed = false;
  const observed = (claims: PhaseClaims) =>
    Object.keys(claims.observations).length > 0 ? claims.observations : null;
  return from(LIFECYCLE_PHASES).pipe(
    concatMap((phase) => {
      if (failed && !PHASES_AFTER_FAILURE.has(phase)) {
        return of<PhaseRecord>({
          phase, outcome: 'skipped', durationMs: null, claims: [], failedClaim: null,
          failure: null, observations: null,
        });
      }
      const claims = new PhaseClaims();
      const started = clock();
      return defer(() => from(run(phase, claims))).pipe(
        defaultIfEmpty(null),
        last(),
        map((): PhaseRecord => ({
          phase, outcome: 'passed', durationMs: clock() - started, claims: claims.records,
          failedClaim: null, failure: null, observations: observed(claims),
        })),
        catchError((error) => {
          failed = true;
          const failure = claims.failureOf(error);
          return of<PhaseRecord>({
            phase, outcome: 'failed', durationMs: clock() - started, claims: claims.records,
            failedClaim: failure.claim, failure: `Phase ${phase} failed. ${failure.message}`,
            observations: observed(claims),
          });
        }),
      );
    }),
    toArray(),
  );
}

// ---------- observations and claim conditions ----------

export type QueueKind = 'ocr' | 'asr';

export interface StoredDocument {
  readonly documentId: string;
  readonly fileName: string;
  readonly status: string;
  readonly stage?: string | null;
  readonly captureId?: string | null;
  readonly hasRaw: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RuntimeRequest {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  /**
   * The capture the fixture answered for: the one a successful create issued,
   * or the one a later request reached. The fixture names only a capture it
   * holds, so an answer for a capture it does not know (404) has none.
   */
  readonly captureId: string | null;
}

/** A library write the page sent, in the order the page sent it. */
export interface LibraryWrite {
  readonly documentId: string | null;
  readonly status: string | null;
  readonly stage: string | null;
  readonly captureId: string | null;
  readonly clearCaptureId: boolean;
}

export interface RowView {
  readonly userStatus: string | null;
  readonly restart: number;
  readonly cancel: number;
}

/** The fields of a `library_update_capture` request body (`{ update: {...} }`). */
export function libraryWriteOf(body: string | null): LibraryWrite {
  let update: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body ?? '{}') as { update?: unknown };
    if (typeof parsed.update === 'object' && parsed.update !== null) update = parsed.update as Record<string, unknown>;
  } catch {
    // An unreadable body still counts as a write.
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    documentId: text(update.documentId),
    status: text(update.status),
    stage: text(update.stage),
    captureId: text(update.captureId),
    clearCaptureId: update.clearCaptureId === true,
  };
}

const CAPTURE_DELETE_ROUTE = '/v2/captures/{captureId}';
const TERMINAL_STATUSES = new Set(['completed', 'awaiting_confirmation', 'failed', 'canceled']);

/** The stored status a completed capture of the kind ends in. */
export function completedStatusFor(kind: QueueKind): string {
  // A document waits at the structuring checkpoint the user confirms; a
  // recording is complete at once.
  return kind === 'ocr' ? 'awaiting_confirmation' : 'completed';
}

/**
 * The fixture runtime's request log: one JSON object per line. A line still
 * being written (no newline yet) is not read.
 */
export function completeRequestLogEntries(text: string): RuntimeRequest[] {
  const end = text.lastIndexOf('\n');
  if (end < 0) return [];
  return text.slice(0, end).split('\n').filter((line) => line.trim()).map((line) => {
    const { method, route, status, captureId } = JSON.parse(line) as { method: string; route: string; status: number; captureId?: unknown };
    return { method, route, status, captureId: typeof captureId === 'string' ? captureId : null };
  });
}

export function captureRequests(entries: readonly RuntimeRequest[]): RuntimeRequest[] {
  return entries.filter((entry) => entry.route.startsWith('/v2/captures') || entry.route.startsWith('/v2/ingestions'));
}

const CAPTURE_CREATE_ROUTE = '/v2/captures';
/** The reads the fixture answers 2xx only for a capture that has ended with its output made. */
const CAPTURE_OUTCOME_ROUTES: ReadonlySet<string> = new Set(['/v2/captures/{captureId}/raw', '/v2/captures/{captureId}/result']);

function succeeded(entry: RuntimeRequest): boolean {
  return entry.status >= 200 && entry.status < 300;
}

/** A capture is created only by a successful create that names the capture the fixture issued. */
function isCreation(entry: RuntimeRequest): boolean {
  return entry.method === 'POST' && entry.route === CAPTURE_CREATE_ROUTE && succeeded(entry) && entry.captureId !== null;
}

/** The captures the fixture created, by the ID each successful create named, in order. */
export function createdCaptures(entries: readonly RuntimeRequest[]): string[] {
  return entries.filter(isCreation).map((entry) => entry.captureId as string);
}

export function captureCreates(entries: readonly RuntimeRequest[]): number {
  return createdCaptures(entries).length;
}

export function describeRequests(entries: readonly RuntimeRequest[]): string[] {
  return entries.map((entry) => `${entry.method} ${entry.route} ${entry.status}${entry.captureId ? ` ${entry.captureId}` : ''}`);
}

/** One host command the page sent: the Tauri command and its request body. */
export interface PageRequest {
  readonly command: string;
  readonly body: string;
}

/** What the check reads from the page's host commands, in the order the page sent them. */
export function pageCommandsOf(requests: readonly PageRequest[]): {
  readonly writes: LibraryWrite[];
  /** The capture each `runtime_delete_capture` request named. */
  readonly deletes: (string | null)[];
  readonly commands: string[];
} {
  return {
    writes: requests.filter((request) => request.command === 'library_update_capture').map((request) => libraryWriteOf(request.body)),
    deletes: requests.filter((request) => request.command === 'runtime_delete_capture').map((request) => hostDeleteIdOf(request.body)),
    commands: [...new Set(requests.map((request) => request.command))].sort(),
  };
}

/** The capture a `runtime_delete_capture` request from the page names (`{ input: { id } }`). */
export function hostDeleteIdOf(body: string | null): string | null {
  try {
    const parsed = JSON.parse(body ?? '{}') as { input?: { id?: unknown } };
    return typeof parsed.input?.id === 'string' ? parsed.input.id : null;
  } catch {
    return null;
  }
}

/**
 * After a reload the runtime still holds the capture: the page asked the host
 * to delete exactly the stored link, and the only capture request the runtime
 * got is one DELETE answered for that capture.
 */
export function isDeleteOfHeldCapture(
  entries: readonly RuntimeRequest[],
  storedCaptureId: string | null | undefined,
  hostDeletes: readonly (string | null)[],
): boolean {
  const requests = captureRequests(entries);
  return Boolean(storedCaptureId) &&
    hostDeletes.length === 1 && hostDeletes[0] === storedCaptureId &&
    requests.length === 1 &&
    requests[0].method === 'DELETE' &&
    requests[0].route === CAPTURE_DELETE_ROUTE &&
    requests[0].status === 204 &&
    requests[0].captureId === storedCaptureId;
}

/**
 * At the next start the page asked the host, once, to delete exactly the
 * stored link, and the new runtime got one capture request: a DELETE it
 * answered 204 (naming that capture) or 404 (a new runtime knows no capture
 * and names none). The runtime's log does not say which capture a 404 was
 * asked for; that the host forwards the page's ID is proven at layer 1, in
 * the dev-host journeys.
 */
export function isStoredLinkDeleteRequestedAfterRestart(
  entries: readonly RuntimeRequest[],
  storedCaptureId: string | null | undefined,
  hostDeletes: readonly (string | null)[],
): boolean {
  const requests = captureRequests(entries);
  return Boolean(storedCaptureId) &&
    hostDeletes.length === 1 && hostDeletes[0] === storedCaptureId &&
    requests.length === 1 &&
    requests[0].method === 'DELETE' &&
    requests[0].route === CAPTURE_DELETE_ROUTE &&
    ((requests[0].status === 404 && requests[0].captureId === null) ||
      (requests[0].status === 204 && requests[0].captureId === storedCaptureId));
}

export function isRunningWithLink(row: RowView, stored: StoredDocument | undefined): boolean {
  return row.userStatus === 'processing' && stored?.status === 'processing' && Boolean(stored.captureId);
}

export function isInterruptedRow(row: RowView): boolean {
  return row.userStatus === 'needs-attention' && row.restart === 1 && row.cancel === 0;
}

/** The fields a write would change; equal before and after means nothing was written. */
export function storedState(document: StoredDocument | undefined): string {
  if (!document) return 'missing';
  return JSON.stringify([
    document.status, document.stage ?? null, document.captureId ?? null, document.hasRaw, document.updatedAtMs,
  ]);
}

export function isCompletedCapture(
  kind: QueueKind,
  row: RowView,
  stored: StoredDocument | undefined,
  requests: readonly RuntimeRequest[],
): boolean {
  return row.userStatus === 'done' &&
    stored?.status === completedStatusFor(kind) &&
    stored.hasRaw === true &&
    !stored.captureId &&
    captureCreates(requests) === 1;
}

export interface FileState {
  readonly bytes: number;
  readonly mtimeMs: number;
}

export function changedFiles(
  before: Readonly<Record<string, FileState>>,
  after: Readonly<Record<string, FileState>>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) =>
    before[name]?.bytes !== after[name]?.bytes || before[name]?.mtimeMs !== after[name]?.mtimeMs).sort();
}

export interface DroppedFile {
  readonly name: string;
  readonly kind: QueueKind;
}

/** What the drop helper reported: every file, released over the app's window, taken as a copy. */
export function isDropAccepted(drop: Record<string, unknown>, files: number): boolean {
  return drop.effect === 'Copy' && drop.count === files && drop.released === true && drop.releasedOverApp === true;
}

/**
 * The dropped files' documents in the order they were imported. `added` is in
 * library_list order, which is the index order: newest first, since the
 * library inserts each document at the front. Documents created in the same
 * millisecond are therefore ordered by their reverse list position.
 */
export function importedInDropOrder(
  added: readonly StoredDocument[],
  files: readonly DroppedFile[],
): { readonly holds: boolean; readonly importOrder: string[] } {
  const importOrder = added
    .map((document, listIndex) => ({ document, listIndex }))
    .sort((a, b) => a.document.createdAtMs - b.document.createdAtMs || b.listIndex - a.listIndex)
    .map(({ document }) => document.fileName);
  return {
    holds: importOrder.length === files.length && importOrder.every((name, index) => name === files[index].name),
    importOrder,
  };
}

/**
 * While the first file's capture is held: the runtime created one capture,
 * the one the first file is linked to, and the others wait unlinked.
 */
export function isOneCaptureWhileHeld(
  files: readonly DroppedFile[],
  documents: readonly StoredDocument[],
  rows: readonly RowView[],
  createdWhileHeld: readonly string[],
): boolean {
  const stored = files.map((file) => documents.find((document) => document.fileName === file.name));
  return createdWhileHeld.length === 1 &&
    stored[0]?.status === 'processing' && stored[0]?.captureId === createdWhileHeld[0] &&
    stored.slice(1).every((document) => document?.status === 'queued' && !document.captureId) &&
    rows[0]?.userStatus === 'processing' &&
    rows.slice(1).every((row) => row.userStatus === 'waiting');
}

/**
 * From the library writes the page sent, in order: each document's capture
 * starts (its first `processing` write) only after the previous document's
 * terminal write, in import order.
 */
export function captureTurns(
  writes: readonly LibraryWrite[],
  documentIdsInImportOrder: readonly string[],
): { readonly holds: boolean; readonly turns: { documentId: string; startWrite: number | null; terminalWrite: number | null }[] } {
  const turns = documentIdsInImportOrder.map((documentId) => {
    const startWrite = writes.findIndex((write) => write.documentId === documentId && write.status === 'processing');
    const terminalWrite = writes.findIndex((write, index) =>
      index > startWrite && write.documentId === documentId && TERMINAL_STATUSES.has(write.status ?? ''));
    return {
      documentId,
      startWrite: startWrite < 0 ? null : startWrite,
      terminalWrite: startWrite < 0 || terminalWrite < 0 ? null : terminalWrite,
    };
  });
  const holds = turns.every((turn, index) =>
    turn.startWrite !== null && turn.terminalWrite !== null &&
    (index === 0 || (turns[index - 1].terminalWrite !== null && turn.startWrite > turns[index - 1].terminalWrite)));
  return { holds, turns };
}

/** Each document's capture, from the link the page wrote for it. */
export function captureOfDocuments(writes: readonly LibraryWrite[], documentIds: readonly string[]): (string | null)[] {
  return documentIds.map((documentId) =>
    writes.find((write) => write.documentId === documentId && write.captureId !== null)?.captureId ?? null);
}

/**
 * From the fixture runtime's request log, by capture ID: a capture is created
 * by the successful create that names it, and finished by the first
 * successful read of its outcome (raw text or result) after that, which the
 * fixture answers only once the capture has ended. One capture ran at a time
 * when each document's capture, in import order, was created after the
 * previous one finished.
 */
export function runtimeCaptureTurns(
  entries: readonly RuntimeRequest[],
  captureIdsInImportOrder: readonly (string | null)[],
): {
  readonly holds: boolean;
  readonly turns: { captureId: string | null; created: number | null; finished: number | null; deleted: number | null }[];
} {
  const indexOf = (from: number, matches: (entry: RuntimeRequest) => boolean): number | null => {
    for (let index = from; index < entries.length; index += 1) if (matches(entries[index])) return index;
    return null;
  };
  const turns = captureIdsInImportOrder.map((captureId) => {
    const named = (entry: RuntimeRequest) => captureId !== null && entry.captureId === captureId;
    const created = indexOf(0, (entry) => named(entry) && isCreation(entry));
    const finished = created === null ? null : indexOf(created + 1, (entry) =>
      named(entry) && entry.method === 'GET' && CAPTURE_OUTCOME_ROUTES.has(entry.route) && succeeded(entry));
    const deleted = finished === null ? null : indexOf(finished + 1, (entry) =>
      named(entry) && entry.method === 'DELETE' && entry.route === CAPTURE_DELETE_ROUTE && succeeded(entry));
    return { captureId, created, finished, deleted };
  });
  const distinct = new Set(turns.map((turn) => turn.captureId)).size === turns.length;
  const holds = distinct && turns.every((turn, index) => {
    const previous = index === 0 ? null : turns[index - 1];
    return turn.captureId !== null && turn.created !== null && turn.finished !== null &&
      (previous === null || (previous.finished !== null && turn.created > previous.finished));
  });
  return { holds, turns };
}

export function isAllCompleted(
  files: readonly DroppedFile[],
  documents: readonly StoredDocument[],
  requests: readonly RuntimeRequest[],
  finalRows: readonly RowView[],
  /** Each file's capture, from the link the page wrote for its document. */
  captureIds: readonly (string | null)[],
): boolean {
  const created = createdCaptures(requests);
  return created.length === files.length &&
    captureIds.length === files.length &&
    captureIds.every((captureId, index) => captureId !== null && created[index] === captureId) &&
    finalRows.length === files.length &&
    finalRows.every((row) => row.userStatus === 'done') &&
    files.every((file) => {
      const document = documents.find((candidate) => candidate.fileName === file.name);
      return document?.status === completedStatusFor(file.kind) && document.hasRaw === true && !document.captureId;
    });
}

// ---------- the app tree after the close message ----------

const MAX_FILETIME = (1n << 63n) - 1n;

/**
 * A Windows FILETIME (100 ns since 1601) as the decimal string it travels as:
 * today's values exceed JavaScript's safe integers, so it is never a number.
 */
export function fileTimeOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > MAX_FILETIME) {
    throw new Error('A process creation time must be a positive FILETIME as a decimal string.');
  }
  return value;
}

export interface AppTreeProcess {
  readonly pid: number;
  readonly name: string;
  readonly reason: 'app-root' | 'descendant' | 'under-run-root' | 'run-webview2';
}

export interface AppTreeCloseResult {
  readonly closeSentAtUnixMs: number;
  readonly appCreatedFileTime: string;
  readonly beforeClose: readonly (AppTreeProcess & {
    readonly handleOpened: boolean;
    /** Exact and not rounded: the kernel's exit time read from a handle opened before the message. */
    readonly exitedAfterCloseMs: number | null;
  })[];
  readonly samples: readonly {
    /** When the snapshot was scheduled to start. */
    readonly afterCloseMs: number;
    readonly startedAfterCloseMs: number;
    /** When its inventory returned, not rounded: from then on the snapshot shows what was gone. */
    readonly completedAfterCloseMs: number;
    readonly processes: readonly AppTreeProcess[];
  }[];
}

export function parseAppTreeCloseResult(value: Record<string, unknown>): AppTreeCloseResult {
  const result = value as unknown as AppTreeCloseResult;
  if (
    value.action !== 'close' ||
    !Number.isSafeInteger(result.closeSentAtUnixMs) ||
    !Array.isArray(result.beforeClose) ||
    !Array.isArray(result.samples) ||
    result.samples.some((sample) =>
      !Array.isArray(sample.processes) ||
      !Number.isFinite(sample.completedAfterCloseMs) ||
      !Number.isFinite(sample.startedAfterCloseMs)) ||
    result.beforeClose.some((process) => process.exitedAfterCloseMs !== null && !Number.isFinite(process.exitedAfterCloseMs))
  ) {
    throw new Error('The app tree helper returned an unexpected close result.');
  }
  fileTimeOf(result.appCreatedFileTime);
  return result;
}

export function isTreeObserved(result: AppTreeCloseResult): boolean {
  const before = result.beforeClose;
  return before.some((process) => process.reason === 'app-root' && process.handleOpened) &&
    before.some((process) => /^capture-runtime/iu.test(process.name)) &&
    before.some((process) => process.name.toLowerCase() === 'msedgewebview2.exe');
}

/**
 * Each process that was there before the message, and when it was gone: from
 * its handle's exit time where the handle opened; otherwise from the time the
 * inventory of the first snapshot it no longer appears in returned. A process
 * counts as gone within the bound only by an observation that ended within
 * it; the times are compared as measured, not rounded.
 */
export function treeExits(result: AppTreeCloseResult): {
  readonly holds: boolean;
  readonly processes: { pid: number; name: string; exitedAfterCloseMs: number | null; goneBySampleCompletedAfterCloseMs: number | null }[];
} {
  const processes = result.beforeClose.map((process) => ({
    pid: process.pid,
    name: process.name,
    exitedAfterCloseMs: process.handleOpened ? process.exitedAfterCloseMs : null,
    goneBySampleCompletedAfterCloseMs: process.handleOpened
      ? null
      : result.samples.find((sample) => !sample.processes.some((candidate) => candidate.pid === process.pid))?.completedAfterCloseMs ?? null,
  }));
  const holds = processes.every((process) =>
    (process.exitedAfterCloseMs !== null && process.exitedAfterCloseMs <= TREE_EXIT_BOUND_MS) ||
    (process.goneBySampleCompletedAfterCloseMs !== null && process.goneBySampleCompletedAfterCloseMs <= TREE_EXIT_BOUND_MS));
  return { holds, processes };
}

/**
 * Each deadline has its snapshot, scheduled the lead time before it, that
 * holds no process of the run and whose inventory returned by the deadline. A
 * snapshot that returned later, by however little, fails its deadline.
 */
export function isNothingLeft(result: AppTreeCloseResult): boolean {
  return CLOSE_DEADLINES_AFTER_MS.every((deadline) => {
    const sample = result.samples.find((candidate) => candidate.afterCloseMs === deadline - SAMPLE_LEAD_MS);
    return sample !== undefined &&
      sample.processes.length === 0 &&
      sample.completedAfterCloseMs <= deadline;
  });
}

/** A measured time for a message: one decimal. Claims compare the measured value, never this one. */
export function displayMs(value: number | null): string {
  return value === null ? 'unknown' : String(Math.round(value * 10) / 10);
}

/** The numbers a close measured, each with how it was measured. */
export function closeMeasurements(result: AppTreeCloseResult) {
  const exits = treeExits(result).processes;
  const exact = exits.map((process) => process.exitedAfterCloseMs).filter((value): value is number => value !== null);
  return {
    appRootExitedAfterCloseMs: result.beforeClose.find((process) => process.reason === 'app-root')?.exitedAfterCloseMs ?? null,
    lastTreeProcessExitedAfterCloseMs: exact.length > 0 ? Math.max(...exact) : null,
    exitMethod: 'Exit time from GetProcessTimes on a handle opened to each process before the close message; exact, relative to the time the message was posted.',
    processesWithoutHandle: exits.filter((process) => process.exitedAfterCloseMs === null).length,
    goneBySampleMethod: 'For a process without a handle: the time the inventory of the first snapshot it was absent from returned.',
    runProcessesAtSample: Object.fromEntries(
      result.samples.map((sample) => [`${sample.afterCloseMs}ms`, sample.processes.length]),
    ),
    sampleCompletedAfterCloseMs: Object.fromEntries(
      result.samples.map((sample) => [`${sample.afterCloseMs}ms`, sample.completedAfterCloseMs]),
    ),
    sampleMethod: `One CIM process snapshot per deadline, all from the same helper process, each started ${SAMPLE_LEAD_MS} ms before its deadline; it counts only if its inventory returned by the deadline. Times are as measured, not rounded.`,
    processes: exits,
  };
}

// ---------- evidence ----------

export const LIFECYCLE_EVIDENCE_KIND = 'installed-capture-lifecycle';

function installerIdentityKnown(installer: { readonly fileName: string; readonly bytes: number; readonly sha256: string } | null): boolean {
  return installer !== null &&
    typeof installer.fileName === 'string' && installer.fileName.endsWith('_x64-setup.exe') &&
    Number.isSafeInteger(installer.bytes) && installer.bytes > 0 &&
    /^[0-9a-f]{64}$/u.test(installer.sha256);
}

const LOCAL_PATH = /[A-Za-z]:[\\/][^\s"'<>|]*/gu;

/** Every string in the value with local absolute paths (from error messages) replaced. */
export function redactLocalPaths<T>(value: T): T {
  if (typeof value === 'string') return value.replace(LOCAL_PATH, '<local path>') as T;
  if (Array.isArray(value)) return value.map((item) => redactLocalPaths(item)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactLocalPaths(item)])) as T;
  }
  return value;
}

export function lifecycleEvidence({
  sourceCommit,
  sourceTreeClean,
  build,
  startedAt,
  finishedAt,
  phases,
  keptRunTree = null,
  recovery = [],
}: {
  readonly sourceCommit: string;
  readonly sourceTreeClean: boolean;
  readonly build: {
    readonly productName: string;
    readonly runtimeVersion: string;
    readonly installer: { readonly fileName: string; readonly bytes: number; readonly sha256: string } | null;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly phases: readonly PhaseRecord[];
  /** The workspace-relative run tree cleanup kept for recovery, or null. */
  readonly keptRunTree?: string | null;
  /** The recovery steps for a kept run tree, with workspace-relative paths only. */
  readonly recovery?: readonly string[];
}) {
  const phasesPassed = phases.length === LIFECYCLE_PHASES.length && phases.every((phase) => phase.outcome === 'passed');
  const missing = missingClaims(phases);
  const installerKnown = installerIdentityKnown(build.installer);
  // A run passes only with the installer's identity and every expected claim
  // proven, not merely when no phase failed.
  const passed = phasesPassed && missing.length === 0 && installerKnown;
  const completeness = [
    ...(phasesPassed && missing.length > 0 ? [`Missing proven claims: ${missing.join('; ')}.`] : []),
    ...(phasesPassed && !installerKnown ? ['The installer\'s name, size and SHA-256 are not known.'] : []),
  ];
  return {
    evidenceKind: LIFECYCLE_EVIDENCE_KIND,
    releaseGateSatisfied: false,
    realEnginesExercised: false,
    outcome: passed ? 'passed' : 'failed',
    sourceCommit,
    sourceTreeClean,
    build,
    startedAt,
    finishedAt,
    proven: passed
      ? phases.flatMap((phase) => phase.claims.filter((claim) => claim.proven).map((claim) =>
          `${claim.claim}${claim.subject ? ` (${claim.subject})` : ''}`))
      : [],
    failures: redactLocalPaths([...phases.filter((phase) => phase.failure).map((phase) => phase.failure), ...completeness]),
    keptRunTree,
    recovery: redactLocalPaths([...recovery]),
    phases: redactLocalPaths(phases),
    disclaimer: 'Installed the fixture-runtime QA build in an isolated scope. Real OCR, speech recognition and structuring were not exercised. The source commit is the checkout at run time; the installer was built from it by the target\'s build dependency.',
  };
}

export function assertLifecycleEvidence(evidence: ReturnType<typeof lifecycleEvidence>): void {
  if (
    evidence.evidenceKind !== LIFECYCLE_EVIDENCE_KIND ||
    evidence.releaseGateSatisfied !== false ||
    evidence.realEnginesExercised !== false
  ) {
    throw new Error('Capture-lifecycle evidence must keep its kind and stay non-releaseable.');
  }
  if (!/^[0-9a-f]{40}$/u.test(evidence.sourceCommit)) {
    throw new Error('Capture-lifecycle evidence needs the full source commit.');
  }
  const order = evidence.phases.map((phase) => phase.phase);
  if (order.length !== LIFECYCLE_PHASES.length || order.some((phase, index) => phase !== LIFECYCLE_PHASES[index])) {
    throw new Error('Capture-lifecycle evidence must list every phase in its order.');
  }
  const complete = evidence.phases.every((phase) => phase.outcome === 'passed') &&
    missingClaims(evidence.phases).length === 0 &&
    installerIdentityKnown(evidence.build.installer);
  if ((evidence.outcome === 'passed') !== complete) {
    throw new Error('Capture-lifecycle evidence outcome must follow its phases, its claims and its installer.');
  }
  if (/[A-Za-z]:[\\/]/u.test(JSON.stringify(evidence))) {
    throw new Error('Capture-lifecycle evidence must not contain absolute Windows paths.');
  }
  assertRedactedEvidence(evidence);
}
