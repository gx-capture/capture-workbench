import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { firstValueFrom, of, throwError } from 'rxjs';

import {
  CLOSE_DEADLINES_AFTER_MS,
  CLOSE_HELPER_SAMPLES_AFTER_MS,
  EXPECTED_CLAIMS,
  LIFECYCLE_CLAIMS,
  SAMPLE_LEAD_MS,
  LIFECYCLE_PHASES,
  TREE_EXIT_BOUND_MS,
  type AppTreeCloseResult,
  type LifecyclePhase,
  type PhaseClaims,
  type PhaseRecord,
  type StoredDocument,
  assertLifecycleEvidence,
  assertNotRedirected,
  claimOwnedDirectory,
  firstRedirectedComponent,
  probePathComponent,
  removeOwnedDirectory,
  isMarkerOfRun,
  isOwnedDirectory,
  uninstallerState,
  earlierRunTreeRecovery,
  keptRunTreeReport,
  recoverySteps,
  type RunRemains,
  mayRemoveRegistryResidue,
  runMarker,
  runTreeDecision,
  uninstallDecision,
  type PathComponent,
  type ProcessProof,
  captureTurns,
  changedFiles,
  closeMeasurements,
  displayMs,
  completeRequestLogEntries,
  fileTimeOf,
  importedInDropOrder,
  isAllCompleted,
  isCompletedCapture,
  isInterruptedRow,
  isNothingLeft,
  isDeleteOfHeldCapture,
  isStoredLinkDeleteRequestedAfterRestart,
  pageCommandsOf,
  isDropAccepted,
  captureOfDocuments,
  hostDeleteIdOf,
  missingClaims,
  runtimeCaptureTurns,
  isOneCaptureWhileHeld,
  isRunningWithLink,
  isTreeObserved,
  libraryWriteOf,
  lifecycleCheckPaths,
  lifecycleEvidence,
  parseAppTreeCloseResult,
  redactLocalPaths,
  runLifecyclePhases,
  storedState,
  treeExits,
} from './installed-capture-lifecycle-checks.ts';
import {
  appTreeCloseArguments,
  appTreeInventoryArguments,
  DROP_HELPER_DEADLINE_MS,
  parseWindowHelperOutput,
  runWindowHelper,
  windowActivateArguments,
  windowDropArguments,
  windowHelperInvocation,
  windowKeyArguments,
} from './installed-native-window.ts';
import { INSTALLED_FIXTURES, fixtureSourceBytes, registryKeysForProduct } from './constants/installed.ts';
import { WEBVIEW2_RUNTIME_VERSION_KEYS, assertWebViewRuntimeInstalled, installedChildEnvironment } from './contracts/installed.ts';
import {
  acquireInstalledProductLock,
  currentUserSid,
  installedProductLockName,
  parseWhoamiUserSid,
  lockHolderAnswer,
  lockTakenMessage,
} from './installed-product-lock.ts';
import { assertInstalledIntoOwnedDirectory, uninstallOwnedInstallation } from './installed-smoke-lifecycle.ts';
import { appRoot } from './stage-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const targetName = 'diagnostic-installed-deterministic-capture-lifecycle';
const commit = 'a'.repeat(40);
// 2026-11-24 00:00 UTC as a Windows FILETIME: above Number.MAX_SAFE_INTEGER.
const appCreated = '134404704000000000';

function runPhases(
  behaviour: Partial<Record<LifecyclePhase, (claims: PhaseClaims) => void>>,
  ran: LifecyclePhase[] = [],
) {
  let time = 0;
  return firstValueFrom(runLifecyclePhases((phase, claims) => {
    ran.push(phase);
    behaviour[phase]?.(claims);
    return of(undefined);
  }, () => (time += 10)));
}

const installer = { fileName: 'Capture Workbench QA Fake Data_0.0.1_x64-setup.exe', bytes: 4_850_000, sha256: 'b'.repeat(64) };

function evidenceFor(phases: PhaseRecord[], build: { installer: typeof installer | null } = { installer }) {
  return lifecycleEvidence({
    sourceCommit: commit,
    sourceTreeClean: true,
    build: { productName: 'Capture Workbench QA Fake Data', runtimeVersion: '0.0.1', installer: build.installer },
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    phases,
  });
}

// ---------- phases and their fail-closed rules ----------

test('the phases run once each in the order of the Desktop App pass', async () => {
  const ran: LifecyclePhase[] = [];
  const records = await runPhases({}, ran);
  assert.deepEqual(ran, [
    'install', 'launch', 'first-run', 'reload-during-capture', 'close-during-capture', 'native-drop', 'close', 'uninstall',
  ]);
  assert.deepEqual(records.map((record) => record.phase), [...LIFECYCLE_PHASES]);
  assert.ok(records.every((record) => record.outcome === 'passed' && record.durationMs === 10));
});

test('a claim that does not hold stops the run, names the claim, and still uninstalls', async () => {
  const ran: LifecyclePhase[] = [];
  const records = await runPhases({
    'reload-during-capture': (claims) => {
      claims.prove('reload.capture-running', true, 'Row processing.', 'F5 on the OCR page');
      claims.prove('reload.window-reloaded', false, 'The page kept its marker.', 'F5 on the OCR page');
    },
  }, ran);
  assert.deepEqual(ran, ['install', 'launch', 'first-run', 'reload-during-capture', 'uninstall']);
  const failed = records.find((record) => record.phase === 'reload-during-capture');
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.failedClaim, 'reload.window-reloaded');
  assert.ok(failed.failure.includes('reload.window-reloaded (F5 on the OCR page)'));
  assert.ok(failed.failure.includes(LIFECYCLE_CLAIMS['reload.window-reloaded']));
  assert.deepEqual(failed.claims.map((claim) => [claim.claim, claim.proven]), [
    ['reload.capture-running', true],
    ['reload.window-reloaded', false],
  ]);
  assert.deepEqual(
    records.filter((record) => record.outcome === 'skipped').map((record) => record.phase),
    ['close-during-capture', 'native-drop', 'close'],
  );
  assert.equal(records.at(-1).outcome, 'passed');
  assert.equal(evidenceFor(records).outcome, 'failed');
});

test('an error inside a step fails the claim the step worked towards', async () => {
  const records = await runPhases({
    launch: (claims) => {
      claims.begin('launch.connected');
      throw new Error('WebView2 CDP endpoint was not ready.');
    },
  });
  const failed = records.find((record) => record.phase === 'launch');
  assert.equal(failed.failedClaim, 'launch.connected');
  assert.ok(failed.failure.startsWith('Phase launch failed. Claim launch.connected not proven:'));
  assert.ok(failed.failure.endsWith('WebView2 CDP endpoint was not ready.'));
  assert.deepEqual(failed.claims, [{
    claim: 'launch.connected', subject: null, proven: false, detail: 'WebView2 CDP endpoint was not ready.',
  }]);
});

test('an error before any claim is named still fails the run', async () => {
  const records = await runPhases({ install: () => { throw new Error('No staged runtime.'); } });
  const failed = records[0];
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.failedClaim, null);
  assert.equal(failed.failure, 'Phase install failed. Failed before naming a claim: No staged runtime.');
  assert.deepEqual(records.map((record) => record.outcome), [
    'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'passed',
  ]);
});

test('cleanup checks every step, reports each one, and fails the run on the first that did not hold', async () => {
  const records = await runPhases({
    uninstall: (claims) => {
      claims.check('uninstall.processes-stopped', true, 'No process.');
      claims.check('uninstall.uninstalled', false, 'Uninstaller exited with status 2.');
      claims.check('uninstall.registry-clean', false, 'A key remained.');
      claims.check('uninstall.run-tree-removed', true, 'Removed.');
      claims.requireAll();
    },
  });
  const uninstall = records.at(-1);
  assert.equal(uninstall.outcome, 'failed');
  assert.equal(uninstall.failedClaim, 'uninstall.uninstalled');
  assert.deepEqual(uninstall.claims.map((claim) => claim.claim), [
    'uninstall.processes-stopped', 'uninstall.uninstalled', 'uninstall.registry-clean', 'uninstall.run-tree-removed',
  ]);
  assert.ok(records.slice(0, -1).every((record) => record.outcome === 'passed'));
  assert.equal(evidenceFor(records).outcome, 'failed');
});

test('a phase keeps what it observed when it fails', async () => {
  const records = await firstValueFrom(runLifecyclePhases((phase, claims) => {
    if (phase !== 'native-drop') return of(undefined);
    claims.observe('drop on the OCR page', { importOrder: ['a.pdf'] });
    return throwError(() => new Error('lost'));
  }));
  assert.deepEqual(records.find((record) => record.phase === 'native-drop').observations, {
    'drop on the OCR page': { importOrder: ['a.pdf'] },
  });
});

// ---------- evidence ----------

/** A run in which the uninstall phase records every expected claim except the given ones. */
function runProvingExpectedClaims(except: readonly string[] = []) {
  return runPhases({
    uninstall: (claims) => {
      for (const { claim, subject } of EXPECTED_CLAIMS) {
        if (!except.includes(`${claim}${subject ? ` (${subject})` : ''}`)) claims.prove(claim, true, 'Proven.', subject ?? undefined);
      }
    },
  });
}

test('evidence of a passed run lists every expected claim, the commit and the installer it ran', async () => {
  const evidence = evidenceFor(await runProvingExpectedClaims());
  assertLifecycleEvidence(evidence);
  assert.equal(evidence.evidenceKind, 'installed-capture-lifecycle');
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.releaseGateSatisfied, false);
  assert.equal(evidence.realEnginesExercised, false);
  assert.equal(evidence.sourceCommit, commit);
  assert.deepEqual(evidence.build.installer, installer);
  assert.equal(evidence.proven.length, EXPECTED_CLAIMS.length);
  assert.ok(evidence.proven.includes('reload.window-reloaded (Ctrl+R on the ASR page)'));
  assert.ok(evidence.proven.includes('drop.all-completed (drop on History)'));
  assert.deepEqual(evidence.failures, []);
});

test('the expected claims cover both reload keys, both closes, all three drop surfaces and the uninstall', () => {
  const subjects = new Set(EXPECTED_CLAIMS.map((expected) => expected.subject));
  for (const subject of [
    'F5 on the OCR page', 'Ctrl+R on the ASR page', 'close during an OCR capture', 'final close',
    'drop on the OCR page', 'drop on the ASR page', 'drop on History',
  ]) assert.ok(subjects.has(subject), subject);
  assert.ok(EXPECTED_CLAIMS.some((expected) => expected.claim === 'uninstall.uninstalled'));
  assert.ok(EXPECTED_CLAIMS.some((expected) => expected.claim === 'install.scoped'));
});

test('a run in which no phase failed still fails when an expected claim or the installer is missing', async () => {
  const missingOne = evidenceFor(await runProvingExpectedClaims(['drop.one-at-a-time (drop on the ASR page)']));
  assertLifecycleEvidence(missingOne);
  assert.equal(missingOne.outcome, 'failed');
  assert.deepEqual(missingOne.failures, ['Missing proven claims: drop.one-at-a-time (drop on the ASR page).']);
  assert.deepEqual(missingClaims(missingOne.phases), ['drop.one-at-a-time (drop on the ASR page)']);

  const nothingProven = evidenceFor(await runPhases({}));
  assert.equal(nothingProven.outcome, 'failed');
  assert.equal(missingClaims(nothingProven.phases).length, EXPECTED_CLAIMS.length);

  const noInstaller = evidenceFor(await runProvingExpectedClaims(), { installer: null });
  assertLifecycleEvidence(noInstaller);
  assert.equal(noInstaller.outcome, 'failed');
  assert.deepEqual(noInstaller.failures, ['The installer\'s name, size and SHA-256 are not known.']);

  assert.throws(() => assertLifecycleEvidence({ ...missingOne, outcome: 'passed' }), /outcome must follow/u);
  assert.throws(() => assertLifecycleEvidence({ ...noInstaller, outcome: 'passed' }), /outcome must follow/u);
});

test('evidence never carries local paths or authorization material and lists every phase in order', async () => {
  const records = await runPhases({
    install: () => { throw new Error('ENOENT: no such file, open \'C:\\Users\\someone\\AppData\\x.json\''); },
  });
  const evidence = evidenceFor(records);
  assertLifecycleEvidence(evidence);
  assert.ok(evidence.failures[0].includes('<local path>'));
  assert.ok(!JSON.stringify(evidence).includes('someone'));

  assert.throws(() => assertLifecycleEvidence({ ...evidence, phases: evidence.phases.slice(1) }), /every phase in its order/u);
  assert.throws(() => assertLifecycleEvidence({ ...evidence, phases: [...evidence.phases].reverse() }), /every phase in its order/u);
  assert.throws(() => assertLifecycleEvidence({ ...evidence, sourceCommit: 'main' }), /full source commit/u);
  assert.throws(() => assertLifecycleEvidence({ ...evidence, releaseGateSatisfied: true as unknown as false }), /non-releaseable/u);
  assert.throws(() => assertLifecycleEvidence({ ...evidence, outcome: 'passed' }), /outcome must follow/u);
  assert.throws(() => assertLifecycleEvidence({ ...evidence, disclaimer: 'D:/private/file' }), /absolute Windows paths/u);
  assert.throws(() => assertLifecycleEvidence({ ...evidence, disclaimer: 'Bearer abc' }), /authorization material/u);
});

test('local paths are redacted in every string of a value', () => {
  assert.deepEqual(redactLocalPaths({ a: 'open C:\\run\\temp\\x.json failed', b: ['D:/y z'], c: 3 }), {
    a: 'open <local path> failed', b: ['<local path> z'], c: 3,
  });
});

// ---------- claim conditions over what the check observed ----------

const document = (overrides: Partial<StoredDocument> = {}): StoredDocument => ({
  documentId: 'd1', fileName: 'a.pdf', status: 'processing', stage: 'extracting', captureId: 'capture-1',
  hasRaw: false, createdAtMs: 1, updatedAtMs: 2, ...overrides,
});

const request = (method: string, route: string, status: number, captureId: string | null = null) => ({ method, route, status, captureId });
const remove = (status: number, captureId: string | null) => request('DELETE', '/v2/captures/{captureId}', status, captureId);

test('after a reload the delete must be the host\'s and the runtime\'s delete of the stored capture', () => {
  assert.equal(isDeleteOfHeldCapture([remove(204, 'capture-1')], 'capture-1', ['capture-1']), true);
  assert.equal(isDeleteOfHeldCapture([request('GET', '/v2/health/ready', 200), remove(204, 'capture-1')], 'capture-1', ['capture-1']), true);
  // Another capture, or one the runtime does not hold, does not prove the stored link was deleted.
  assert.equal(isDeleteOfHeldCapture([remove(204, 'capture-2')], 'capture-1', ['capture-2']), false);
  assert.equal(isDeleteOfHeldCapture([remove(404, null)], 'capture-1', ['capture-1']), false);
  assert.equal(isDeleteOfHeldCapture([remove(204, 'capture-1')], 'capture-1', []), false);
  assert.equal(isDeleteOfHeldCapture([remove(204, 'capture-1')], 'capture-1', ['capture-1', 'capture-1']), false);
  assert.equal(isDeleteOfHeldCapture([remove(204, 'capture-1'), request('POST', '/v2/captures', 202)], 'capture-1', ['capture-1']), false);
  assert.equal(isDeleteOfHeldCapture([remove(204, 'capture-1'), request('POST', '/v2/ingestions', 201)], 'capture-1', ['capture-1']), false);
  assert.equal(isDeleteOfHeldCapture([], 'capture-1', ['capture-1']), false);
  assert.equal(isDeleteOfHeldCapture([remove(204, 'capture-1')], null, ['capture-1']), false);
});

test('at the next start the page must have asked the host once for exactly the stored link, and the runtime answered one DELETE with 204 or 404', () => {
  // The new runtime names no capture in a 404; the host request says which one the page asked for.
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(404, null)], 'capture-5', ['capture-5']), true);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(204, 'capture-5')], 'capture-5', ['capture-5']), true);
  // A runtime that deleted another capture does not satisfy the claim, whatever the page named.
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(204, 'capture-9')], 'capture-5', ['capture-5']), false);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(204, null)], 'capture-5', ['capture-5']), false);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(404, null)], 'capture-5', ['capture-9']), false);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(404, null)], 'capture-5', []), false);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(404, null)], 'capture-5', [null]), false);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(503, null)], 'capture-5', ['capture-5']), false);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([remove(404, null), remove(404, null)], 'capture-5', ['capture-5']), false);
  assert.equal(isStoredLinkDeleteRequestedAfterRestart([], 'capture-5', ['capture-5']), false);
  assert.equal(hostDeleteIdOf(JSON.stringify({ input: { id: 'capture-5' } })), 'capture-5');
  assert.equal(hostDeleteIdOf(JSON.stringify({ input: {} })), null);
  assert.equal(hostDeleteIdOf('not json'), null);
});

test('the page\'s host commands are read in the order it sent them: writes, deletes and command names', () => {
  const sent = pageCommandsOf([
    { command: 'runtime_delete_capture', body: JSON.stringify({ input: { id: 'capture-5' } }) },
    { command: 'library_list', body: '{}' },
    { command: 'library_update_capture', body: JSON.stringify({ update: { documentId: 'd1', status: 'processing' } }) },
    { command: 'runtime_delete_capture', body: '' },
    { command: 'library_list', body: '{}' },
  ]);
  assert.deepEqual(sent.deletes, ['capture-5', null]);
  assert.deepEqual(sent.writes, [{ documentId: 'd1', status: 'processing', stage: null, captureId: null, clearCaptureId: false }]);
  assert.deepEqual(sent.commands, ['library_list', 'library_update_capture', 'runtime_delete_capture']);
  assert.deepEqual(pageCommandsOf([]), { writes: [], deletes: [], commands: [] });
});

test('a running capture has a processing row and a stored link; an interrupted row offers only Start again', () => {
  assert.equal(isRunningWithLink({ userStatus: 'processing', restart: 0, cancel: 1 }, document()), true);
  assert.equal(isRunningWithLink({ userStatus: 'processing', restart: 0, cancel: 1 }, document({ captureId: null })), false);
  assert.equal(isRunningWithLink({ userStatus: 'waiting', restart: 0, cancel: 1 }, document()), false);
  assert.equal(isInterruptedRow({ userStatus: 'needs-attention', restart: 1, cancel: 0 }), true);
  assert.equal(isInterruptedRow({ userStatus: 'needs-attention', restart: 1, cancel: 1 }), false);
  assert.equal(isInterruptedRow({ userStatus: 'processing', restart: 0, cancel: 1 }), false);
});

test('nothing was written when every field a write changes is as before', () => {
  assert.equal(storedState(document()), storedState(document({ fileName: 'renamed.pdf' })));
  assert.notEqual(storedState(document()), storedState(document({ updatedAtMs: 3 })));
  assert.notEqual(storedState(document()), storedState(document({ captureId: null })));
  assert.notEqual(storedState(document()), storedState(undefined));
  assert.deepEqual(changedFiles({ 'index.json': { bytes: 5, mtimeMs: 1 } }, { 'index.json': { bytes: 5, mtimeMs: 1 } }), []);
  assert.deepEqual(changedFiles(
    { 'index.json': { bytes: 5, mtimeMs: 1 }, 'old.txt': { bytes: 1, mtimeMs: 1 } },
    { 'index.json': { bytes: 5, mtimeMs: 2 }, 'new.txt': { bytes: 1, mtimeMs: 1 } },
  ), ['index.json', 'new.txt', 'old.txt']);
});

test('Start again completes with one capture, raw text stored, no link, and the end status of its kind', () => {
  const created = [request('POST', '/v2/captures', 202, 'capture-2')];
  const done = { userStatus: 'done', restart: 0, cancel: 0 };
  const ocr = document({ status: 'awaiting_confirmation', captureId: null, hasRaw: true });
  const asr = document({ status: 'completed', captureId: null, hasRaw: true });
  assert.equal(isCompletedCapture('ocr', done, ocr, created), true);
  assert.equal(isCompletedCapture('asr', done, asr, created), true);
  assert.equal(isCompletedCapture('ocr', done, asr, created), false);
  assert.equal(isCompletedCapture('ocr', done, ocr, [...created, ...created]), false);
  // A create that failed, or that names no capture, created nothing.
  assert.equal(isCompletedCapture('ocr', done, ocr, [request('POST', '/v2/captures', 409, 'capture-2')]), false);
  assert.equal(isCompletedCapture('ocr', done, ocr, [request('POST', '/v2/captures', 202)]), false);
  assert.equal(isCompletedCapture('ocr', done, ocr, [request('POST', '/v2/captures', 409), ...created]), true);
  assert.equal(isCompletedCapture('ocr', done, { ...ocr, captureId: 'capture-2' }, created), false);
  assert.equal(isCompletedCapture('ocr', { ...done, userStatus: 'processing' }, ocr, created), false);
});

test('the request log is read up to its last complete line', () => {
  const line = (status: number, captureId?: string) =>
    JSON.stringify({ timestamp: 1, method: 'DELETE', route: '/v2/captures/{captureId}', status, extra: 'x', ...(captureId ? { captureId } : {}) });
  assert.deepEqual(completeRequestLogEntries(`${line(204, 'capture-3')}\n${line(404)}\n{"timestamp":`), [
    { method: 'DELETE', route: '/v2/captures/{captureId}', status: 204, captureId: 'capture-3' },
    { method: 'DELETE', route: '/v2/captures/{captureId}', status: 404, captureId: null },
  ]);
  assert.deepEqual(completeRequestLogEntries('{"partial":'), []);
});

test('a library write is read from its request body', () => {
  assert.deepEqual(
    libraryWriteOf(JSON.stringify({ update: { documentId: 'd1', status: 'processing', stage: 'uploading', clearCaptureId: true } })),
    { documentId: 'd1', status: 'processing', stage: 'uploading', captureId: null, clearCaptureId: true },
  );
  assert.deepEqual(libraryWriteOf('not json'), {
    documentId: null, status: null, stage: null, captureId: null, clearCaptureId: false,
  });
});

const dropped = [
  { name: 'a.pdf', kind: 'ocr' as const },
  { name: 'b.png', kind: 'ocr' as const },
  { name: 'c.wav', kind: 'asr' as const },
];

test('dropped files must all be imported, in the order of the drop', () => {
  const added = [
    document({ documentId: 'c', fileName: 'c.wav', createdAtMs: 30 }),
    document({ documentId: 'a', fileName: 'a.pdf', createdAtMs: 10 }),
    document({ documentId: 'b', fileName: 'b.png', createdAtMs: 20 }),
  ];
  assert.deepEqual(importedInDropOrder(added, dropped), { holds: true, importOrder: ['a.pdf', 'b.png', 'c.wav'] });
  assert.equal(importedInDropOrder(added.slice(0, 2), dropped).holds, false);
  assert.equal(importedInDropOrder([{ ...added[0], createdAtMs: 15 }, added[1], added[2]], dropped).holds, false);
});

test('files imported in the same millisecond keep their import order, from the library\'s newest-first list', () => {
  // library_list answers newest first: the last imported file comes first.
  const sameTime = [
    document({ documentId: 'c', fileName: 'c.wav', createdAtMs: 10 }),
    document({ documentId: 'b', fileName: 'b.png', createdAtMs: 10 }),
    document({ documentId: 'a', fileName: 'a.pdf', createdAtMs: 10 }),
  ];
  assert.deepEqual(importedInDropOrder(sameTime, dropped), { holds: true, importOrder: ['a.pdf', 'b.png', 'c.wav'] });
  const swapped = [sameTime[1], sameTime[0], sameTime[2]];
  assert.deepEqual(importedInDropOrder(swapped, dropped), { holds: false, importOrder: ['a.pdf', 'c.wav', 'b.png'] });
});

test('while the first capture is held it is the only one, and the others wait unlinked', () => {
  const held = [
    document({ fileName: 'a.pdf' }),
    document({ fileName: 'b.png', status: 'queued', captureId: null }),
    document({ fileName: 'c.wav', status: 'queued', captureId: null }),
  ];
  const rows = [
    { userStatus: 'processing', restart: 0, cancel: 1 },
    { userStatus: 'waiting', restart: 0, cancel: 1 },
    { userStatus: 'waiting', restart: 0, cancel: 1 },
  ];
  assert.equal(isOneCaptureWhileHeld(dropped, held, rows, ['capture-1']), true);
  assert.equal(isOneCaptureWhileHeld(dropped, held, rows, ['capture-1', 'capture-2']), false);
  assert.equal(isOneCaptureWhileHeld(dropped, held, rows, []), false);
  // The capture the runtime created is not the one the first file is linked to.
  assert.equal(isOneCaptureWhileHeld(dropped, held, rows, ['capture-7']), false);
  assert.equal(isOneCaptureWhileHeld(dropped, [held[0], { ...held[1], captureId: 'capture-2' }, held[2]], rows, ['capture-1']), false);
  assert.equal(isOneCaptureWhileHeld(dropped, held, [rows[0], rows[0], rows[2]], ['capture-1']), false);
});

test('captures take turns: each starts after the previous one\'s terminal write, in import order', () => {
  const write = (documentId: string, status: string) => ({ documentId, status, stage: null, captureId: null, clearCaptureId: false });
  const sequential = [
    write('a', 'processing'), write('a', 'processing'), write('a', 'awaiting_confirmation'),
    write('b', 'processing'), write('b', 'awaiting_confirmation'),
    write('c', 'processing'), write('c', 'completed'),
  ];
  const turns = captureTurns(sequential, ['a', 'b', 'c']);
  assert.equal(turns.holds, true);
  assert.deepEqual(turns.turns.map((turn) => [turn.startWrite, turn.terminalWrite]), [[0, 2], [3, 4], [5, 6]]);

  const overlapping = [write('a', 'processing'), write('b', 'processing'), write('a', 'completed'), write('b', 'completed')];
  assert.equal(captureTurns(overlapping, ['a', 'b']).holds, false);
  const outOfOrder = [write('b', 'processing'), write('b', 'completed'), write('a', 'processing'), write('a', 'completed')];
  assert.equal(captureTurns(outOfOrder, ['a', 'b']).holds, false);
  assert.equal(captureTurns([write('a', 'processing')], ['a']).holds, false);
  assert.equal(captureTurns([], ['a']).holds, false);
});

test('in the runtime\'s own log each capture is created, by its ID, only after the previous one\'s outcome was read', () => {
  const link = (documentId: string, captureId: string) => ({ documentId, status: 'processing', stage: null, captureId, clearCaptureId: false });
  assert.deepEqual(captureOfDocuments([link('a', 'capture-3'), link('b', 'capture-4')], ['a', 'b', 'c']), ['capture-3', 'capture-4', null]);
  const create = (captureId: string | null, status = 202) => request('POST', '/v2/captures', status, captureId);
  const read = (captureId: string, part = 'raw', status = 200) => request('GET', `/v2/captures/{captureId}/${part}`, status, captureId);
  const poll = (captureId: string) => request('GET', '/v2/captures/{captureId}', 200, captureId);
  const sequential = [
    create('capture-3'), poll('capture-3'), read('capture-3'), remove(204, 'capture-3'),
    create('capture-4'), read('capture-4', 'result'),
    // The previous capture's cleanup DELETE may come after the next one starts.
    create('capture-5'), remove(204, 'capture-4'), read('capture-5'),
  ];
  const turns = runtimeCaptureTurns(sequential, ['capture-3', 'capture-4', 'capture-5']);
  assert.equal(turns.holds, true);
  assert.deepEqual(turns.turns.map((turn) => [turn.created, turn.finished, turn.deleted]), [[0, 2, 3], [4, 5, 7], [6, 8, null]]);

  // The next capture was created while the previous one had not finished.
  assert.equal(runtimeCaptureTurns([create('capture-3'), create('capture-4'), read('capture-3'), read('capture-4')], ['capture-3', 'capture-4']).holds, false);
  assert.equal(runtimeCaptureTurns([create('capture-4'), read('capture-4'), create('capture-3'), read('capture-3')], ['capture-3', 'capture-4']).holds, false);
  // A failed read, a status poll or the cleanup DELETE is not the capture's outcome.
  assert.equal(runtimeCaptureTurns([create('capture-3'), read('capture-3', 'raw', 409), remove(204, 'capture-3'), create('capture-4'), read('capture-4')], ['capture-3', 'capture-4']).holds, false);
  assert.equal(runtimeCaptureTurns([create('capture-3'), poll('capture-3'), remove(204, 'capture-3')], ['capture-3']).holds, false);
  // A failed create, a create without a capture ID, or another capture's create does not create this capture.
  assert.equal(runtimeCaptureTurns([create('capture-3', 500), read('capture-3')], ['capture-3']).holds, false);
  assert.equal(runtimeCaptureTurns([create(null), read('capture-3')], ['capture-3']).holds, false);
  assert.equal(runtimeCaptureTurns([create('capture-9'), read('capture-3')], ['capture-3']).holds, false);
  // An outcome read before the create does not finish it.
  assert.equal(runtimeCaptureTurns([read('capture-3'), create('capture-3')], ['capture-3']).holds, false);
  assert.equal(runtimeCaptureTurns([create('capture-3'), read('capture-3')], ['capture-3', null]).holds, false);
  assert.equal(runtimeCaptureTurns([create('capture-3'), read('capture-3')], ['capture-3', 'capture-3']).holds, false);
});

test('every dropped file completes as its kind does, with one capture each, and its row shows done', () => {
  const finished = [
    document({ fileName: 'a.pdf', status: 'awaiting_confirmation', captureId: null, hasRaw: true }),
    document({ fileName: 'b.png', status: 'awaiting_confirmation', captureId: null, hasRaw: true }),
    document({ fileName: 'c.wav', status: 'completed', captureId: null, hasRaw: true }),
  ];
  const ids = ['capture-1', 'capture-2', 'capture-3'];
  const creates = ids.map((id) => request('POST', '/v2/captures', 202, id));
  const done = Array.from({ length: 3 }, () => ({ userStatus: 'done', restart: 0, cancel: 0 }));
  assert.equal(isAllCompleted(dropped, finished, creates, done, ids), true);
  assert.equal(isAllCompleted(dropped, finished, creates.slice(1), done, ids), false);
  assert.equal(isAllCompleted(dropped, [finished[0], finished[1], { ...finished[2], hasRaw: false }], creates, done, ids), false);
  assert.equal(isAllCompleted(dropped, finished, creates, [done[0], done[1], { ...done[2], userStatus: 'processing' }], ids), false);
  assert.equal(isAllCompleted(dropped, finished, creates, done.slice(1), ids), false);
  // The runtime's captures must be the ones the page linked to the files, in order.
  assert.equal(isAllCompleted(dropped, finished, creates, done, ['capture-1', 'capture-3', 'capture-2']), false);
  assert.equal(isAllCompleted(dropped, finished, creates, done, ['capture-1', 'capture-2', null]), false);
  assert.equal(isAllCompleted(dropped, finished, [creates[0], creates[1], request('POST', '/v2/captures', 500)], done, ids), false);
});

// ---------- the app tree after the close message ----------

function closeResult(overrides: Partial<AppTreeCloseResult> = {}): AppTreeCloseResult {
  return {
    closeSentAtUnixMs: 1_000,
    appCreatedFileTime: appCreated,
    beforeClose: [
      { pid: 10, name: 'capture-workbench-desktop.exe', reason: 'app-root', handleOpened: true, exitedAfterCloseMs: 111 },
      { pid: 11, name: 'msedgewebview2.exe', reason: 'descendant', handleOpened: true, exitedAfterCloseMs: 240.5 },
      { pid: 12, name: 'capture-runtime-x86_64-pc-windows-msvc.exe', reason: 'descendant', handleOpened: true, exitedAfterCloseMs: 130 },
    ],
    samples: CLOSE_HELPER_SAMPLES_AFTER_MS.map((afterCloseMs) => ({
      afterCloseMs, startedAfterCloseMs: afterCloseMs + 2, completedAfterCloseMs: afterCloseMs + 310, processes: [],
    })),
    ...overrides,
  };
}

test('the close claims hold when the whole tree exits in time and no sample finds a process', () => {
  const result = closeResult();
  assert.equal(isTreeObserved(result), true);
  assert.equal(treeExits(result).holds, true);
  assert.equal(isNothingLeft(result), true);
  const measured = closeMeasurements(result);
  assert.equal(measured.appRootExitedAfterCloseMs, 111);
  assert.equal(measured.lastTreeProcessExitedAfterCloseMs, 240.5);
  assert.equal(measured.processesWithoutHandle, 0);
  assert.deepEqual(measured.runProcessesAtSample, { '500ms': 0, '4500ms': 0, '14500ms': 0 });
  assert.deepEqual(measured.sampleCompletedAfterCloseMs, { '500ms': 810, '4500ms': 4_810, '14500ms': 14_810 });
});

test('the close claims fail on a late exit, a missing runtime, a missing sample or a process left behind', () => {
  const late = closeResult();
  const slow = { ...late, beforeClose: [late.beforeClose[0], { ...late.beforeClose[1], exitedAfterCloseMs: TREE_EXIT_BOUND_MS + 1 }] };
  assert.equal(treeExits(slow).holds, false);
  // Times are compared as measured: an exit 0.04 ms past the bound is late.
  const barelyLate = { ...late, beforeClose: [late.beforeClose[0], { ...late.beforeClose[1], exitedAfterCloseMs: TREE_EXIT_BOUND_MS + 0.04 }] };
  assert.equal(treeExits(barelyLate).holds, false);
  assert.equal(treeExits({ ...late, beforeClose: [{ ...late.beforeClose[0], exitedAfterCloseMs: TREE_EXIT_BOUND_MS }] }).holds, true);
  assert.equal(displayMs(TREE_EXIT_BOUND_MS + 0.04), '1000');
  assert.equal(displayMs(240.56), '240.6');
  assert.equal(displayMs(null), 'unknown');
  const running = { ...late, beforeClose: [{ ...late.beforeClose[0], exitedAfterCloseMs: null }] };
  assert.equal(treeExits(running).holds, false);
  assert.equal(isTreeObserved({ ...late, beforeClose: late.beforeClose.filter((process) => process.pid !== 12) }), false);
  assert.equal(isTreeObserved({ ...late, beforeClose: late.beforeClose.map((process) => ({ ...process, handleOpened: false })) }), false);
  assert.equal(isNothingLeft({ ...late, samples: late.samples.slice(0, 2) }), false);
  const left = late.samples.map((sample, index) => index === 2
    ? { ...sample, processes: [{ pid: 99, name: 'msedgewebview2.exe', reason: 'run-webview2' as const }] }
    : sample);
  assert.equal(isNothingLeft({ ...late, samples: left }), false);
});

test('a process without a handle counts as gone only from the time a snapshot without it returned', () => {
  const base = closeResult();
  const withoutHandle = { pid: 13, name: 'msedgewebview2.exe', reason: 'run-webview2' as const, handleOpened: false, exitedAfterCloseMs: null };
  const goneAtFirst = { ...base, beforeClose: [...base.beforeClose, withoutHandle] };
  const exits = treeExits(goneAtFirst);
  assert.equal(exits.holds, true);
  assert.deepEqual(exits.processes.at(-1), { pid: 13, name: 'msedgewebview2.exe', exitedAfterCloseMs: null, goneBySampleCompletedAfterCloseMs: 810 });
  assert.equal(closeMeasurements(goneAtFirst).processesWithoutHandle, 1);
  // Absent only from the next snapshot, which returned long after the bound: not shown gone within it.
  const stillThereEarly = {
    ...goneAtFirst,
    samples: goneAtFirst.samples.map((sample, index) =>
      index === 0 ? { ...sample, processes: [{ pid: 13, name: 'msedgewebview2.exe', reason: 'run-webview2' as const }] } : sample),
  };
  assert.equal(treeExits(stillThereEarly).holds, false);
  // The early snapshot was scheduled in time but its inventory returned late.
  const lateEarlySample = {
    ...goneAtFirst,
    samples: goneAtFirst.samples.map((sample, index) => (index === 0 ? { ...sample, completedAfterCloseMs: TREE_EXIT_BOUND_MS + 0.04 } : sample)),
  };
  assert.equal(treeExits(lateEarlySample).holds, false);
});

test('a snapshot counts for its deadline only if its inventory returned by the deadline, as measured', () => {
  const base = closeResult();
  // Each snapshot starts early enough to return by its deadline.
  assert.deepEqual([...CLOSE_HELPER_SAMPLES_AFTER_MS], [500, 4_500, 14_500]);
  assert.deepEqual(CLOSE_HELPER_SAMPLES_AFTER_MS.map((ms) => ms + SAMPLE_LEAD_MS), [...CLOSE_DEADLINES_AFTER_MS]);
  CLOSE_DEADLINES_AFTER_MS.forEach((deadline, index) => {
    const late = {
      ...base,
      samples: base.samples.map((sample, at) => (at === index ? { ...sample, completedAfterCloseMs: deadline + 0.04 } : sample)),
    };
    assert.equal(isNothingLeft(late), false, String(deadline));
  });
  const onTheEdge = {
    ...base,
    samples: base.samples.map((sample, index) => ({ ...sample, completedAfterCloseMs: CLOSE_DEADLINES_AFTER_MS[index] })),
  };
  assert.equal(isNothingLeft(onTheEdge), true);
  // A snapshot scheduled at the deadline itself cannot have returned by it.
  const scheduledAtDeadlines = {
    ...base,
    samples: CLOSE_DEADLINES_AFTER_MS.map((afterCloseMs) => ({ afterCloseMs, startedAfterCloseMs: afterCloseMs, completedAfterCloseMs: afterCloseMs + 200, processes: [] })),
  };
  assert.equal(isNothingLeft(scheduledAtDeadlines), false);
});

test('a malformed close result from the helper is refused', () => {
  assert.throws(() => parseAppTreeCloseResult({ ok: true, action: 'inventory', processes: [] }), /unexpected close result/u);
  assert.throws(() => parseAppTreeCloseResult({ ...closeResult(), ok: true, action: 'close', samples: [{ processes: null }] }), /unexpected close result/u);
  assert.throws(
    () => parseAppTreeCloseResult({ ...closeResult(), ok: true, action: 'close', samples: [{ afterCloseMs: 1_000, takenAfterCloseMs: 1_002, processes: [] }] }),
    /unexpected close result/u,
  );
  const unreadableExit = closeResult().beforeClose.map((process) => ({ ...process, exitedAfterCloseMs: '111' as unknown as number }));
  assert.throws(() => parseAppTreeCloseResult({ ...closeResult(), beforeClose: unreadableExit, ok: true, action: 'close' }), /unexpected close result/u);
  assert.equal(parseAppTreeCloseResult({ ...closeResult(), ok: true, action: 'close' }).closeSentAtUnixMs, 1_000);
});

test('a process creation time travels as a decimal FILETIME string, never as a number', () => {
  assert.ok(Number(appCreated) > Number.MAX_SAFE_INTEGER);
  const parsed = parseAppTreeCloseResult(JSON.parse(JSON.stringify({ ...closeResult(), ok: true, action: 'close' })));
  assert.equal(parsed.appCreatedFileTime, appCreated);
  assert.equal(fileTimeOf('9223372036854775807'), '9223372036854775807');
  for (const value of [134404704000000000, '0', '-1', '1e17', '9223372036854775808', '0134404704000000000', '']) {
    assert.throws(() => fileTimeOf(value), /decimal string/u, String(value));
  }
  assert.throws(
    () => parseAppTreeCloseResult({ ...closeResult(), appCreatedFileTime: 134404704000000000 as unknown as string, ok: true, action: 'close' }),
    /decimal string/u,
  );
});

// ---------- the window helpers' arguments and results ----------

const runRoot = join(workspaceRoot, 'tmp', 'check', 'run');

test('keys and activation name the QA app by PID and creation time, and only F5 and Ctrl+R are sent', () => {
  const app = { pid: 4321, createdFileTime: appCreated };
  const identity = ['-AppPid', '4321', '-AppCreatedFileTime', appCreated];
  assert.deepEqual(windowKeyArguments(app, 'F5'), [...identity, '-Action', 'key', '-Key', 'F5']);
  assert.deepEqual(windowKeyArguments(app, 'CtrlR'), [...identity, '-Action', 'key', '-Key', 'CtrlR']);
  assert.deepEqual(windowActivateArguments(app), [...identity, '-Action', 'activate']);
  assert.throws(() => windowKeyArguments(app, 'F6' as 'F5'), /Only F5 and Ctrl\+R/u);
  assert.throws(() => windowKeyArguments({ ...app, pid: 0 }, 'F5'), /positive PID/u);
  assert.throws(() => windowActivateArguments({ ...app, pid: 1.5 }), /positive PID/u);
  assert.throws(() => windowActivateArguments({ ...app, createdFileTime: '' }), /decimal string/u);
});

test('a refusal that may have let input reach another window says so', () => {
  assert.throws(() => parseWindowHelperOutput('{"ok":false,"reason":"foreground-changed-during-input"}', 4), /input may have reached another window\. No further input is sent\./u);
  assert.throws(() => parseWindowHelperOutput('{"ok":false,"reason":"input-not-inserted"}', 4), /input may have reached another window/u);
  assert.throws(() => parseWindowHelperOutput('{"ok":false,"reason":"foreground-not-owned"}', 3), /does not own the foreground window; no input was sent/u);
  assert.throws(() => parseWindowHelperOutput('{"ok":false,"reason":"app-process-changed"}', 3), /no input was sent/u);
  assert.throws(() => parseWindowHelperOutput('{"ok":false,"reason":"button-not-released"}', 3), /may need to be released by hand: click it once/u);
});

test('a drop names only files of the check\'s own sources directory, each once, with a deadline before the caller\'s timeout', () => {
  const sources = join(runRoot, 'sources');
  const app = { pid: 7, createdFileTime: appCreated };
  assert.deepEqual(windowDropArguments(app, [join(sources, 'a.pdf'), join(sources, 'b c.wav')], sources, 60_000), [
    '-AppPid', '7', '-AppCreatedFileTime', appCreated, '-DeadlineMs', String(DROP_HELPER_DEADLINE_MS),
    join(sources, 'a.pdf'), join(sources, 'b c.wav'),
  ]);
  assert.throws(() => windowDropArguments(app, [], sources, 60_000), /at least one file/u);
  assert.throws(() => windowDropArguments(app, [join(runRoot, 'other.pdf')], sources, 60_000), /strict descendant/u);
  assert.throws(() => windowDropArguments(app, ['a.pdf'], sources, 60_000), /absolute path/u);
  assert.throws(() => windowDropArguments(app, [join(sources, 'a\n.pdf')], sources, 60_000), /control characters/u);
  assert.throws(() => windowDropArguments(app, [join(sources, 'a.pdf'), join(sources, 'A.PDF')], sources, 60_000), /each file once/u);
  assert.throws(() => windowDropArguments(app, [join(sources, 'a.pdf')], sources, DROP_HELPER_DEADLINE_MS), /well before the caller/u);
  assert.throws(() => windowDropArguments(app, [join(sources, 'a.pdf')], sources, 60_000, 0), /well before the caller/u);
});

function fakeHelper(script: string, timeoutMs: number, stopGraceMs: number, pressesMouseButton = false) {
  return {
    command: process.execPath,
    args: ['-e', script],
    env: { SystemRoot: process.env.SystemRoot ?? '', Path: process.env.Path ?? process.env.PATH ?? '' },
    timeoutMs,
    stopGraceMs,
    pressesMouseButton,
  };
}

const helperEnvironment = () => {
  const temporary = process.env.TEMP ?? tmpdir();
  return { systemRoot: process.env.SystemRoot || 'C:\\Windows', path: process.env.Path || process.env.PATH || '', temporary, ownedRoot: dirname(temporary) };
};

/** The PID of a process that has ended. */
function endedProcessId(): number {
  const ended = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(ended.status, 0);
  return ended.pid;
}

test('a helper past its timeout is first asked to stop, and stops by itself', async () => {
  const started = Date.now();
  await assert.rejects(
    firstValueFrom(runWindowHelper(fakeHelper(
      "process.stdin.on('data', (d) => { if (String(d).includes('stop')) { console.log(JSON.stringify({ ok: false, reason: 'stop-requested' })); process.exit(3); } }); process.stdin.resume();",
      300,
      10_000,
    ))),
    /timed out after 300 ms; it stopped after the stop request\./u,
  );
  assert.ok(Date.now() - started < 8_000);
});

test('a helper that does not stop after the request is killed after the grace time', async () => {
  await assert.rejects(
    firstValueFrom(runWindowHelper(fakeHelper("setInterval(() => undefined, 1000);", 200, 300))),
    /timed out after 200 ms and was killed after it did not stop within 300 ms\./u,
  );
});

test('only a killed drop helper may have left the mouse button pressed, and the run says so', async () => {
  const never = 'setInterval(() => undefined, 1000);';
  await assert.rejects(
    firstValueFrom(runWindowHelper(fakeHelper(never, 200, 300, true))),
    /was killed after it did not stop within 300 ms\. The left mouse button may need to be released by hand: click it once\.$/u,
  );
  // A helper that presses no button, or stopped by itself (it released the button), gives no such warning.
  await assert.rejects(firstValueFrom(runWindowHelper(fakeHelper(never, 200, 300))), /within 300 ms\.$/u);
  const stops = (reason: string) =>
    `process.stdin.on('data', () => { console.log(JSON.stringify({ ok: false, reason: '${reason}' })); process.exit(3); }); process.stdin.resume();`;
  await assert.rejects(
    firstValueFrom(runWindowHelper(fakeHelper(stops('stop-requested'), 300, 10_000, true))),
    /it stopped after the stop request\.$/u,
  );
  // Windows refused the helper's own release: the helper says so, and the run passes it on.
  await assert.rejects(
    firstValueFrom(runWindowHelper(fakeHelper(stops('button-not-released'), 300, 10_000, true))),
    /it stopped after the stop request\. The drop helper could not release the mouse button it pressed\. The left mouse button may need to be released by hand/u,
  );
  assert.equal(windowHelperInvocation('installed-window-drop.ps1', [], helperEnvironment(), 1_000).pressesMouseButton, true);
  assert.equal(windowHelperInvocation('installed-window-input.ps1', [], helperEnvironment(), 1_000).pressesMouseButton, false);
});

test('the key and drop helpers compile, and refuse a PID that is no longer the QA app before any window or input', { skip: process.platform !== 'win32' }, async () => {
  const gone = { pid: endedProcessId(), createdFileTime: appCreated };
  const sources = join(helperEnvironment().temporary, 'sources');
  for (const [script, args] of [
    ['installed-window-input.ps1', windowKeyArguments(gone, 'F5')],
    ['installed-window-input.ps1', windowActivateArguments(gone)],
    ['installed-window-drop.ps1', windowDropArguments(gone, [join(sources, 'a.pdf')], sources, 60_000)],
  ] as const) {
    await assert.rejects(
      firstValueFrom(runWindowHelper(windowHelperInvocation(script, args, helperEnvironment(), 60_000))),
      /The QA app's PID no longer belongs to the process the check started; no input was sent\./u,
      script,
    );
  }
});

test('a drop counts only when every file was released over the window of the app and taken as a copy', () => {
  const drop = { effect: 'Copy', count: 3, released: true, releasedOverApp: true };
  assert.equal(isDropAccepted(drop, 3), true);
  assert.equal(isDropAccepted({ ...drop, releasedOverApp: false }, 3), false);
  assert.equal(isDropAccepted({ ...drop, released: false }, 3), false);
  assert.equal(isDropAccepted({ ...drop, effect: 'None' }, 3), false);
  assert.equal(isDropAccepted(drop, 2), false);
});

test('a helper that answers in time is read as before', async () => {
  assert.deepEqual(
    await firstValueFrom(runWindowHelper(fakeHelper("console.log(JSON.stringify({ ok: true, action: 'key' }));", 30_000, 1_000))),
    { ok: true, action: 'key' },
  );
});

test('the close helper takes rising samples and a WebView2 directory inside the run', () => {
  const webView = join(runRoot, 'webview2');
  assert.deepEqual(appTreeCloseArguments({ appPid: 9, runRoot, webViewDataDirectory: webView, sampleAfterMs: CLOSE_HELPER_SAMPLES_AFTER_MS }), [
    '-Action', 'close', '-RunRoot', runRoot, '-WebViewDataDirectory', webView, '-AppPid', '9', '-SampleAfterMs', '500,4500,14500',
  ]);
  for (const sampleAfterMs of [[], [5_000, 1_000], [0], [1_000, 1_000], [70_000]]) {
    assert.throws(() => appTreeCloseArguments({ appPid: 9, runRoot, webViewDataDirectory: webView, sampleAfterMs }), /rising whole milliseconds/u);
  }
  assert.throws(
    () => appTreeCloseArguments({ appPid: 9, runRoot, webViewDataDirectory: join(workspaceRoot, 'webview2'), sampleAfterMs: [1_000] }),
    /strict descendant/u,
  );
  assert.deepEqual(appTreeInventoryArguments({ runRoot, webViewDataDirectory: webView }), [
    '-Action', 'inventory', '-RunRoot', runRoot, '-WebViewDataDirectory', webView,
  ]);
  assert.deepEqual(appTreeInventoryArguments({ runRoot, webViewDataDirectory: webView, app: { pid: 9, createdFileTime: appCreated } }), [
    '-Action', 'inventory', '-RunRoot', runRoot, '-WebViewDataDirectory', webView, '-AppPid', '9', '-AppCreatedFileTime', appCreated,
  ]);
  assert.throws(() => appTreeInventoryArguments({ runRoot, webViewDataDirectory: webView, app: { pid: 9, createdFileTime: '0' } }), /creation time/u);
  assert.deepEqual(appTreeInventoryArguments({ runRoot, webViewDataDirectory: webView, app: { pid: 9 } }), [
    '-Action', 'inventory', '-RunRoot', runRoot, '-WebViewDataDirectory', webView, '-AppPid', '9',
  ]);
});

test('a helper runs by its path next to the scripts, with a minimal environment and TEMP inside the check', () => {
  const temporary = join(runRoot, 'check-temp');
  const invocation = windowHelperInvocation('installed-window-input.ps1', ['-AppPid', '1'], {
    systemRoot: 'C:\\Windows', path: 'C:\\Windows\\System32', temporary, ownedRoot: runRoot,
  }, 30_000);
  assert.equal(invocation.command, join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(invocation.args, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', join(appRoot, 'scripts', 'installed-window-input.ps1'), '-AppPid', '1',
  ]);
  assert.deepEqual(invocation.env, { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', TEMP: temporary, TMP: temporary });
  assert.throws(() => windowHelperInvocation('installed-window-input.ps1', [], {
    systemRoot: 'C:\\Windows', path: '', temporary: tmpdir(), ownedRoot: runRoot,
  }, 30_000), /strict descendant/u);
  assert.throws(() => windowHelperInvocation('installed-window-input.ps1', [], {
    systemRoot: 'C:\\Windows', path: '', temporary, ownedRoot: runRoot,
  }, 0), /positive timeout/u);
});

test('a helper result is its last JSON line, and a refusal names only the helper\'s reason', () => {
  assert.deepEqual(parseWindowHelperOutput('noise\n{"ok":true,"action":"key"}\r\n', 0), { ok: true, action: 'key' });
  assert.throws(() => parseWindowHelperOutput('{"ok":false,"reason":"drag-did-not-start"}', 3), /refused: drag-did-not-start\./u);
  assert.throws(() => parseWindowHelperOutput('{"ok":false,"reason":"C:\\\\private"}', 3), /refused: unknown\./u);
  assert.throws(() => parseWindowHelperOutput('Get-Process : Cannot find a process', 1), /status 1 without a result/u);
  assert.throws(() => parseWindowHelperOutput('{"ok":true}', 1), /ended with status 1/u);
});

test('the window helpers parse in Windows PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const helpers = (await readdir(join(appRoot, 'scripts'))).filter((name) => name.endsWith('.ps1'));
  assert.deepEqual(helpers.sort(), ['installed-app-tree.ps1', 'installed-window-drop.ps1', 'installed-window-input.ps1']);
  const parser = [
    '$failed = 0',
    'foreach ($path in $args) {',
    '  $tokens = $null; $errors = $null',
    '  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)',
    '  foreach ($e in $errors) { Write-Output ($path + \':\' + $e.Extent.StartLineNumber + \' \' + $e.Message); $failed = 1 }',
    '}',
    'exit $failed',
  ].join('\n');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const result = spawnSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& { ${parser} }`, ...helpers.map((name) => join(appRoot, 'scripts', name))],
    { encoding: 'utf8', env: { SystemRoot: systemRoot, Path: process.env.Path || process.env.PATH || '' }, windowsHide: true, timeout: 60_000 },
  );
  assert.equal(result.error, undefined, `Windows PowerShell could not run the parser: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stdout);
});

test('the app-tree inventory of a run without processes is an empty list', { skip: process.platform !== 'win32' }, async () => {
  const temporary = process.env.TEMP ?? tmpdir();
  const missingRun = join(temporary, 'no-such-run');
  const result = await firstValueFrom(runWindowHelper(windowHelperInvocation(
    'installed-app-tree.ps1',
    appTreeInventoryArguments({ runRoot: missingRun, webViewDataDirectory: join(missingRun, 'webview2') }),
    { systemRoot: process.env.SystemRoot || 'C:\\Windows', path: process.env.Path || process.env.PATH || '', temporary, ownedRoot: dirname(temporary) },
    60_000,
  )));
  assert.deepEqual(result, { ok: true, action: 'inventory', appCreatedFileTime: null, processes: [] });
});

// ---------- what the run may create and remove ----------

function fakeFileSystem(entries: Record<string, PathComponent>) {
  return (path: string): PathComponent => entries[path.toLowerCase()] ?? { exists: false };
}

test('a path component that is a link, a junction or resolves elsewhere is refused before anything is created', () => {
  const root = 'C:\\work\\repo';
  const target = 'C:\\work\\repo\\tmp\\check\\run';
  const real = (path: string, realPath = path): PathComponent => ({ exists: true, link: false, realPath });
  const base = {
    'c:\\work\\repo': real('C:\\work\\repo'),
    'c:\\work\\repo\\tmp': real('C:\\work\\repo\\tmp'),
  };
  assert.equal(firstRedirectedComponent(root, target, fakeFileSystem(base)), null);
  assert.equal(firstRedirectedComponent(root, target, fakeFileSystem({
    ...base, 'c:\\work\\repo\\tmp\\check': { exists: true, link: true, realPath: 'C:\\elsewhere' },
  })), 'tmp/check');
  assert.equal(firstRedirectedComponent(root, target, fakeFileSystem({
    ...base, 'c:\\work\\repo\\tmp': real('C:\\work\\repo\\tmp', 'D:\\mounted'),
  })), 'tmp');
  // A workspace that itself lives behind a link is fine; only what is below it counts.
  assert.equal(firstRedirectedComponent(root, target, fakeFileSystem({
    'c:\\work\\repo': real('C:\\work\\repo', 'E:\\real\\repo'),
    'c:\\work\\repo\\tmp': real('C:\\work\\repo\\tmp', 'e:\\REAL\\repo\\tmp'),
  })), null);
  assert.throws(
    () => assertNotRedirected(root, target, fakeFileSystem({ ...base, 'c:\\work\\repo\\tmp': { exists: true, link: true, realPath: 'X:\\x' } })),
    /tmp is a symbolic link, junction or other redirecting reparse point/u,
  );
  assert.throws(() => firstRedirectedComponent(root, 'C:\\other', fakeFileSystem(base)), /strict descendant/u);
});

/**
 * A workspace of its own in the temp directory, with the check's root in it.
 * The test removes it, and the directories named beside it, when it ends.
 */
function temporaryWorkspace(t: TestContext) {
  const workspace = mkdtempSync(join(tmpdir(), 'lifecycle-workspace-'));
  const elsewhere = `${workspace}-elsewhere`;
  const link = `${workspace}-link`;
  // The link goes first, so removing the workspace never goes through it.
  t.after(() => { for (const path of [link, elsewhere, workspace]) rmSync(path, { recursive: true, force: true }); });
  const root = join(workspace, 'tmp', 'check');
  mkdirSync(root, { recursive: true });
  return { workspace, root, elsewhere, link };
}

test('the chain from the workspace root itself down to the run tree is refused at the first link, dangling or not', (t) => {
  const { workspace, root, elsewhere, link: linkedWorkspace } = temporaryWorkspace(t);
  const run = join(root, 'run');
  // The run tree does not exist yet: the check creates it.
  assert.equal(firstRedirectedComponent(workspace, run), null);
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, run, 'junction');
  assert.equal(firstRedirectedComponent(workspace, run), 'tmp/check/run');
  // A dangling link is still a link, not a directory that does not exist yet.
  rmSync(elsewhere, { recursive: true });
  assert.deepEqual(probePathComponent(run), { exists: true, link: true, realPath: run });
  assert.throws(() => assertNotRedirected(workspace, run), /tmp\/check\/run is a symbolic link, junction/u);
  assert.equal(existsSync(elsewhere), false);

  symlinkSync(workspace, linkedWorkspace, 'junction');
  assert.throws(
    () => assertNotRedirected(linkedWorkspace, join(linkedWorkspace, 'tmp', 'other', 'run')),
    /the workspace root is a symbolic link, junction/u,
  );
});

test('a directory of the run is removed only while its path and identity prove it is the one the run made', (t) => {
  const { workspace, root } = temporaryWorkspace(t);
  const make = (name: string) => {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'made-by-the-run.txt'), 'x');
    return claimOwnedDirectory(join(root, name));
  };
  const outside = join(workspace, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep');

  const owned = make('check-temp-a');
  assert.deepEqual(removeOwnedDirectory(workspace, root, owned), { removed: true, detail: 'Removed.' });
  assert.equal(existsSync(owned.path), false);
  assert.deepEqual(removeOwnedDirectory(workspace, root, owned), { removed: true, detail: 'It was already gone.' });

  // Another directory took its place.
  const replaced = make('check-temp-b');
  renameSync(replaced.path, join(root, 'moved-away'));
  mkdirSync(replaced.path);
  writeFileSync(join(replaced.path, 'keep.txt'), 'keep');
  assert.deepEqual(removeOwnedDirectory(workspace, root, replaced), {
    removed: false, detail: 'Left in place: it is not the directory this run made.',
  });
  assert.equal(existsSync(join(replaced.path, 'keep.txt')), true);

  // A junction took its place.
  const linked = make('check-temp-c');
  rmSync(linked.path, { recursive: true });
  symlinkSync(outside, linked.path, 'junction');
  assert.match(removeOwnedDirectory(workspace, root, linked).detail, /^Left in place: .*tmp\/check\/check-temp-c is a symbolic link, junction/u);

  // A parent became a junction while the run went on: what the cleanup phase and the exit hook both refuse.
  const redirectedRoot = join(workspace, 'tmp', 'redirected');
  symlinkSync(outside, redirectedRoot, 'junction');
  mkdirSync(join(outside, 'check-temp-d'));
  writeFileSync(join(outside, 'check-temp-d', 'keep.txt'), 'keep');
  const behindLink = claimOwnedDirectory(join(redirectedRoot, 'check-temp-d'));
  const refused = removeOwnedDirectory(workspace, redirectedRoot, behindLink);
  assert.equal(refused.removed, false);
  assert.match(refused.detail, /tmp\/redirected is a symbolic link, junction/u);

  // A path outside the check's root.
  assert.match(removeOwnedDirectory(workspace, root, claimOwnedDirectory(outside)).detail, /strict descendant/u);
  for (const kept of [join(outside, 'keep.txt'), join(outside, 'check-temp-d', 'keep.txt')]) assert.equal(existsSync(kept), true, kept);
  assert.throws(() => claimOwnedDirectory(linked.path), /not a real directory/u);

  // Recovery asks the same without removing: only the directory the run made, where it made it, is its own.
  const intact = make('check-temp-e');
  assert.equal(isOwnedDirectory(workspace, root, intact), true);
  for (const notOwned of [replaced, linked, behindLink, owned]) assert.equal(isOwnedDirectory(workspace, root, notOwned), false, notOwned.path);
  assert.equal(isOwnedDirectory(workspace, root, claimOwnedDirectory(outside)), false);
  assert.equal(existsSync(join(intact.path, 'made-by-the-run.txt')), true);
});

test('an uninstaller counts as present only as a regular file in a directory no link redirects', (t) => {
  const { workspace, root } = temporaryWorkspace(t);
  const install = join(root, 'install');
  assert.equal(uninstallerState(workspace, install), 'absent');
  mkdirSync(install);
  assert.equal(uninstallerState(workspace, install), 'absent');
  mkdirSync(join(install, 'uninstall.exe'));
  assert.equal(uninstallerState(workspace, install), 'unverified');
  rmSync(join(install, 'uninstall.exe'), { recursive: true });
  writeFileSync(join(install, 'uninstall.exe'), 'x');
  assert.equal(uninstallerState(workspace, install), 'present');
  // The install directory redirected to another one that holds an uninstaller.
  const other = join(workspace, 'other-install');
  mkdirSync(other);
  writeFileSync(join(other, 'uninstall.exe'), 'x');
  const redirected = join(root, 'redirected-install');
  symlinkSync(other, redirected, 'junction');
  assert.equal(uninstallerState(workspace, redirected), 'unverified');
});

test('only a run tree that carries this run\'s marker counts as this run\'s', () => {
  const marker = runMarker('run-1', 4321, '2026-11-24T00:00:00.000Z');
  assert.equal(isMarkerOfRun(marker, 'run-1'), true);
  assert.equal(isMarkerOfRun(marker, 'run-2'), false);
  assert.equal(isMarkerOfRun(JSON.stringify({ check: 'other', runId: 'run-1' }), 'run-1'), false);
  assert.equal(isMarkerOfRun('not json', 'run-1'), false);
  assert.equal(isMarkerOfRun(null, 'run-1'), false);
});

const proven: ProcessProof = { ownedRootsEmpty: true, runTreeEmpty: true, cdpPortsReleased: true };
const webViewLeft: ProcessProof = { ...proven, runTreeEmpty: false };

test('the uninstaller runs only on this run\'s installation and only after both inventories are empty', () => {
  assert.equal(uninstallDecision(false, null), 'nothing-installed');
  assert.equal(uninstallDecision(true, proven), 'run');
  assert.equal(uninstallDecision(true, webViewLeft), 'refused');
  assert.equal(uninstallDecision(true, { ...proven, ownedRootsEmpty: false }), 'refused');
  assert.equal(uninstallDecision(true, { ...proven, cdpPortsReleased: false }), 'refused');
  assert.equal(uninstallDecision(true, null), 'refused');
});

test('registry keys are removed only after the uninstall and a clean process proof after it', () => {
  assert.equal(mayRemoveRegistryResidue(true, proven), true);
  assert.equal(mayRemoveRegistryResidue(false, proven), false);
  assert.equal(mayRemoveRegistryResidue(true, webViewLeft), false);
  assert.equal(mayRemoveRegistryResidue(true, null), false);
});

test('the run tree is removed only when every check after the uninstall passed; otherwise it is kept', () => {
  const removable = {
    runTreeCreated: true, markerOfThisRun: true, proofBefore: proven, installationAttempted: true,
    uninstalled: true, proofAfter: proven, registryClean: true, realAppDataUnchanged: true,
  };
  assert.equal(runTreeDecision(removable).remove, true);
  assert.equal(runTreeDecision({ ...removable, installationAttempted: false, uninstalled: false, proofAfter: null, registryClean: false, realAppDataUnchanged: null }).remove, true);
  for (const [change, reason] of [
    [{ runTreeCreated: false }, /made no run tree/u],
    [{ markerOfThisRun: false }, /marker/u],
    [{ proofBefore: webViewLeft }, /not proven stopped/u],
    [{ uninstalled: false }, /uninstaller did not remove/u],
    [{ proofAfter: webViewLeft }, /after the uninstall/u],
    [{ registryClean: false }, /registry key/u],
    [{ realAppDataUnchanged: false }, /real product app data changed/u],
  ] as const) {
    const decision = runTreeDecision({ ...removable, ...change });
    assert.equal(decision.remove, false, JSON.stringify(change));
    assert.match(decision.reason, reason);
  }
  // A tree this run did not make: what to look at, nothing to run or delete.
  assert.equal(
    earlierRunTreeRecovery('tmp/x/run'),
    'Look at tmp/x/run/installed-capture-lifecycle-run.json (which run made the tree, and when) and at tmp/x/run/install (an installation of the QA build may still be there): '
      + 'this run did not make the tree, so it does not tell you to run anything in it or delete it.',
  );
  assert.doesNotMatch(earlierRunTreeRecovery('tmp/x/run'), /uninstall\.exe \/S|^Delete|reg delete/u);
});

test('the recovery steps of a kept run tree name exactly what remains', () => {
  const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QA';
  const productKey = 'HKCU\\Software\\github\\QA';
  const nothing: RunRemains = {
    processes: [], processProofFailure: null, runTreeOwned: true, uninstaller: 'absent', registryKeys: [],
    productKeys: [uninstallKey, productKey], realAppDataChanged: false, removalFailure: null,
  };
  // The uninstaller ran and removed the installation, but a WebView2 process and the product key are left:
  // no step asks for an uninstaller that is gone.
  assert.deepEqual(recoverySteps('tmp/x/run', {
    ...nothing, processes: [{ pid: 4242, name: 'msedgewebview2.exe' }], processProofFailure: 'Processes of the run: 1.',
    registryKeys: [{ key: productKey, view: '64', installLocationOurs: true }],
  }), [
    'End the processes of the run that are still there: msedgewebview2.exe (PID 4242).',
    `Delete the keys this run's installation left: reg delete "${productKey}" /reg:64 /f.`,
    'Delete tmp/x/run.',
  ]);
  // The uninstaller never ran: it is still in the tree, and its keys go after it, each in the view it was seen in.
  assert.deepEqual(recoverySteps('tmp/x/run', {
    ...nothing, uninstaller: 'present',
    registryKeys: [{ key: uninstallKey, view: '32', installLocationOurs: true }, { key: productKey, view: '64', installLocationOurs: true }],
  }), [
    'Run tmp/x/run/install/uninstall.exe /S.',
    `After the uninstaller, delete these keys of this run if they are still there: reg delete "${uninstallKey}" /reg:32 /f; reg delete "${productKey}" /reg:64 /f.`,
    'Delete tmp/x/run.',
  ]);
  // The registry could not be read: only what to look at, in both views.
  assert.deepEqual(recoverySteps('tmp/x/run', { ...nothing, processProofFailure: 'CDP ports: 9222 in use', registryKeys: null, realAppDataChanged: true }), [
    'Make sure no process of the run is left; the check could not prove it: CDP ports: 9222 in use',
    `The registry could not be read, so no key is known to be this run's. Look at these keys of the QA build: reg query "${uninstallKey}" /reg:64; reg query "${uninstallKey}" /reg:32; reg query "${productKey}" /reg:64; reg query "${productKey}" /reg:32; a key of this run has tmp/x/run/install as its install location.`,
    'The real product app data changed during the run: compare it with what tmp/x/run holds before you delete the run tree.',
    'Delete tmp/x/run.',
  ]);
  assert.deepEqual(recoverySteps('tmp/x/run', { ...nothing, removalFailure: 'Left in place: EBUSY' }), [
    'The run tree could not be removed: Left in place: EBUSY',
    'Delete tmp/x/run.',
  ]);
});

test('recovery names nothing to run or delete that the run did not verify as its own', () => {
  const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QA';
  const productKey = 'HKCU\\Software\\github\\QA';
  const destructive = /uninstall\.exe \/S|reg delete|^Delete /u;
  const remains: RunRemains = {
    processes: [], processProofFailure: null, runTreeOwned: true, uninstaller: 'present', registryKeys: [],
    productKeys: [uninstallKey, productKey], realAppDataChanged: true, removalFailure: null,
  };
  // The tree lost this run's marker or was replaced: its uninstaller and the tree are only to be looked at.
  const notOurTree = recoverySteps('tmp/x/run', { ...remains, runTreeOwned: false });
  assert.deepEqual(notOurTree, [
    'Look at tmp/x/run/install/uninstall.exe: the check could not verify that it is the uninstaller of this run\'s installation (the run tree is not proven to be this run\'s), so it does not tell you to run it.',
    'The real product app data changed during the run: compare it with what tmp/x/run holds.',
    'Look at tmp/x/run and its marker tmp/x/run/installed-capture-lifecycle-run.json: the tree does not carry this run\'s marker or is no longer the directory this run made, so the check does not tell you to delete it.',
  ]);
  // Our tree, but something other than a regular file where the uninstaller belongs.
  assert.deepEqual(recoverySteps('tmp/x/run', { ...remains, uninstaller: 'unverified', realAppDataChanged: false }), [
    'Look at tmp/x/run/install/uninstall.exe: the check could not verify that it is the uninstaller of this run\'s installation (it is not a regular file in a real directory, or could not be checked), so it does not tell you to run it.',
    'Delete tmp/x/run.',
  ]);
  // Keys whose install location is another directory or could not be read are only to be looked at, in their view;
  // the key of this run is still deleted, after the uninstaller.
  const keys = recoverySteps('tmp/x/run', {
    ...remains, realAppDataChanged: false,
    registryKeys: [
      { key: uninstallKey, view: '64', installLocationOurs: false },
      { key: productKey, view: '32', installLocationOurs: null },
      { key: productKey, view: '64', installLocationOurs: true },
    ],
  });
  assert.deepEqual(keys, [
    'Run tmp/x/run/install/uninstall.exe /S.',
    `After the uninstaller, delete these keys of this run if they are still there: reg delete "${productKey}" /reg:64 /f.`,
    `Look at these keys of the QA build, which may belong to another installation: reg query "${uninstallKey}" /reg:64 (its install location is not tmp/x/run/install); reg query "${productKey}" /reg:32 (its install location could not be read); the check did not verify them as this run's, so it does not tell you to delete them.`,
    'Delete tmp/x/run.',
  ]);
  for (const step of [...notOurTree, ...recoverySteps('tmp/x/run', { ...remains, runTreeOwned: false, uninstaller: 'unverified', registryKeys: null })]) {
    assert.doesNotMatch(step, destructive, step);
  }
});

test('evidence names a kept run tree and its recovery by relative paths; only the command line prints the absolute one', async () => {
  const steps = ['Run tmp/x/run/install/uninstall.exe /S.', 'Delete tmp/x/run.'];
  const evidence = lifecycleEvidence({
    sourceCommit: commit, sourceTreeClean: true,
    build: { productName: 'Capture Workbench QA Fake Data', runtimeVersion: '0.0.1', installer },
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
    phases: await runPhases({ uninstall: (claims) => { claims.check('uninstall.run-tree-removed', false, 'Kept.'); claims.requireAll(); } }),
    keptRunTree: 'tmp/x/run',
    recovery: [...steps, 'The run tree could not be removed: EBUSY: C:\\work\\repo\\tmp\\x\\run'],
  });
  assertLifecycleEvidence(evidence);
  assert.equal(evidence.keptRunTree, 'tmp/x/run');
  assert.deepEqual(evidence.recovery, [...steps, 'The run tree could not be removed: EBUSY: <local path>']);
  assert.deepEqual(keptRunTreeReport('C:\\work\\repo', 'tmp/x/run', steps), [
    'The run tree was kept: C:\\work\\repo\\tmp\\x\\run',
    'To recover (paths are relative to C:\\work\\repo):',
    '  1. Run tmp/x/run/install/uninstall.exe /S.',
    '  2. Delete tmp/x/run.',
  ]);
  assert.deepEqual(keptRunTreeReport('C:\\work\\repo', null, []), []);
  assert.deepEqual(evidenceFor(await runPhases({})).recovery, []);
});

// ---------- one lock for every installed QA check ----------

test('the product lock is one pipe per user and product, the same in every worktree', () => {
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const name = installedProductLockName('Capture Workbench QA Fake Data', sid);
  assert.notEqual(name, installedProductLockName('Capture Workbench', sid));
  assert.notEqual(name, installedProductLockName('Capture Workbench QA Fake Data', 'S-1-5-21-1111111111-2222222222-3333333333-1002'));
  assert.match(name, /^\\\\\.\\pipe\\capture-installed-check-[0-9a-f]{32}$/u);
  assert.throws(() => installedProductLockName(' ', sid), /product name/u);
  assert.throws(() => installedProductLockName('P', 'DOMAIN\\someone'), /user's SID/u);
});

test('the user of the lock is the SID Windows gives for the access token, not a name from the environment', { skip: process.platform !== 'win32' }, () => {
  assert.equal(parseWhoamiUserSid(`"desktop\\someone","${'S-1-5-21-1-2-3-1001'}"\r\n`), 'S-1-5-21-1-2-3-1001');
  for (const answer of ['', 'desktop\\someone', '"desktop\\someone","not a sid"', 'ERROR: S-1-5-21-1-2-3-1001 unknown']) {
    assert.throws(() => parseWhoamiUserSid(answer), /SID could not be read, so the installed product lock is not taken/u, answer);
  }
  // Any authority, as the parser reads it: a Microsoft Entra account's SID starts with S-1-12-.
  assert.equal(parseWhoamiUserSid('"azuread\\someone","S-1-12-1-1-2-3-4"'), 'S-1-12-1-1-2-3-4');
  const sid = currentUserSid();
  assert.equal(parseWhoamiUserSid(`"desktop\\someone","${sid}"`), sid);
  assert.doesNotThrow(() => installedProductLockName('P', sid));
});

/**
 * The first complete line a child writes to its stdout. Fails when the child
 * closes its output first or no line comes within the time.
 */
function firstLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const finish = (outcome: { line: string } | { error: Error }) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('close', onClose);
      child.off('error', onError);
      if ('line' in outcome) resolvePromise(outcome.line);
      else reject(outcome.error);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const end = output.indexOf('\n');
      if (end >= 0) finish({ line: output.slice(0, end).replace(/\r$/u, '') });
    };
    // 'close' comes after the child's output ended, so a line written just before the exit is still read.
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ error: new Error(`The child ended (${code ?? signal}) before it wrote a complete line.`) });
    const onError = (error: Error) => finish({ error });
    const timer = setTimeout(() => finish({ error: new Error(`The child wrote no complete line within ${timeoutMs} ms.`) }), timeoutMs);
    child.stdout?.on('data', onData);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

test('a readiness line is read whole, and a child that ends first or stays silent fails in time', async () => {
  const node = (script: string) => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  assert.equal(await firstLine(node('process.stdout.write("rea"); setTimeout(() => process.stdout.write("dy\\r\\nmore"), 50)'), 5_000), 'ready');
  await assert.rejects(firstLine(node('process.stdout.write("half"); process.exit(3)'), 5_000), /ended \(3\) before it wrote a complete line/u);
  const silent = node('setTimeout(() => undefined, 30_000)');
  try {
    const started = Date.now();
    await assert.rejects(firstLine(silent, 200), /no complete line within 200 ms/u);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    silent.kill();
    if (silent.exitCode === null && silent.signalCode === null) await once(silent, 'exit');
  }
});

test('two processes of one account started with different environments contend for the same lock', { skip: process.platform !== 'win32' }, async () => {
  const product = `QA lock test ${randomUUID()}`;
  // A second Node process whose USERDOMAIN and USERNAME differ from this one's.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', [
    'import { firstValueFrom } from "rxjs";',
    'const { acquireInstalledProductLock } = await import(process.argv[1]);',
    'const lock = await firstValueFrom(acquireInstalledProductLock(process.argv[2], "smoke-installed-deterministic"));',
    'process.stdout.write(lock.name + "\\n");',
    'process.stdin.on("end", () => process.exit(0));',
    'process.stdin.resume();',
  ].join('\n'), pathToFileURL(join(appRoot, 'scripts', 'installed-product-lock.ts')).href, product], {
    cwd: workspaceRoot,
    env: { ...process.env, USERDOMAIN: 'ANOTHER-DOMAIN', USERNAME: 'someone-else' },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  try {
    assert.equal(await firstLine(holder, 30_000), installedProductLockName(product));
    await assert.rejects(
      firstValueFrom(acquireInstalledProductLock(product, 'diagnostic-installed-deterministic-capture-lifecycle')),
      (error: Error) => error.message.includes(`smoke-installed-deterministic (process ${holder.pid}, started `),
    );
  } finally {
    holder.stdin.end();
    if (holder.exitCode === null) await once(holder, 'exit');
  }
  // Windows freed the pipe with the holder's process.
  const next = await firstValueFrom(acquireInstalledProductLock(product, 'diagnostic-installed-deterministic-capture-lifecycle'));
  await firstValueFrom(next.release());
});

test('a second check finds the lock taken and is told which check and process hold it', { skip: process.platform !== 'win32' }, async () => {
  const name = `\\\\.\\pipe\\capture-installed-check-test-${randomUUID()}`;
  const first = await firstValueFrom(acquireInstalledProductLock('QA product', 'smoke-installed-deterministic', name));
  try {
    await assert.rejects(
      firstValueFrom(acquireInstalledProductLock('QA product', 'diagnostic-installed-deterministic-capture-lifecycle', name)),
      (error: Error) => error.message.includes('Another installed QA check holds the lock for "QA product"')
        && error.message.includes(`smoke-installed-deterministic (process ${process.pid}, started `),
    );
  } finally {
    await firstValueFrom(first.release());
  }
  const second = await firstValueFrom(acquireInstalledProductLock('QA product', 'diagnostic-installed-deterministic-capture-lifecycle', name));
  await firstValueFrom(second.release());
  await firstValueFrom(second.release());
});

test('the refusal names the holder only from a well-formed answer', () => {
  assert.match(lockTakenMessage('P', lockHolderAnswer('check-a', 42, '2026-11-24T00:00:00.000Z')), /check-a \(process 42, started 2026-11-24T00:00:00\.000Z\)/u);
  assert.match(lockTakenMessage('P', null), /: another process\./u);
  assert.match(lockTakenMessage('P', '{"check":1}'), /: another process\./u);
  assert.match(lockTakenMessage('P', 'garbage'), /: another process\./u);
});

// ---------- WebView2 before the installer ----------

test('the installer runs only when a WebView2 Runtime is installed for the machine or the user', () => {
  assert.deepEqual(WEBVIEW2_RUNTIME_VERSION_KEYS.map((entry) => entry.key), [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  ]);
  assert.deepEqual(
    assertWebViewRuntimeInstalled([
      { scope: 'per-machine', version: undefined },
      { scope: 'per-machine', version: '0.0.0.0' },
      { scope: 'per-user', version: ' 131.0.2903.112 ' },
    ]),
    { scope: 'per-user', version: '131.0.2903.112' },
  );
  // A registration for this user alone is enough, also after malformed machine-wide values.
  assert.deepEqual(
    assertWebViewRuntimeInstalled([
      { scope: 'per-machine', version: 'installing' },
      { scope: 'per-machine', version: '131' },
      { scope: 'per-user', version: '131.0.2903.112' },
    ]),
    { scope: 'per-user', version: '131.0.2903.112' },
  );
  assert.equal(assertWebViewRuntimeInstalled([{ scope: 'per-machine', version: '131.0' }]).version, '131.0');
  // What `[version]$version -gt [version]'0.0.0.0'` accepts: leading zeros of any length, Int32 components.
  for (const version of ['1.00000000000', '00000000000131.0.2903.112', '0.0.0.1', '0.0.1', '0.1', '2147483647.0', '0.0.0.000000000001']) {
    assert.equal(assertWebViewRuntimeInstalled([{ scope: 'per-machine', version }]).version, version, version);
  }
  for (const versions of [
    [], [undefined], [''], ['0.0.0.0'], ['  '], ['0.0'], ['0.00000000000'], ['000.000.000.000'],
    ['2147483648.0'], ['1.99999999999999999999999'], ['1.0.0.0.0'], ['1.'], ['.1'], ['1,0'], ['1.0e3'], ['0x1.0'],
    // Not versions: the installer would still install the runtime.
    ['installing'], ['131'], ['131.0.2903.112.5'], ['131.0.x.112'], ['-1.0.0.0'], ['131..2903.112'], ['131.0.2903.99999999999'], ['v131.0.2903.112'],
  ]) {
    assert.throws(
      () => assertWebViewRuntimeInstalled(versions.map((version) => ({ scope: 'per-machine', version }))),
      /WebView2 Runtime is not installed.*Install the Evergreen WebView2 Runtime from https:\/\/developer\.microsoft\.com\/microsoft-edge\/webview2\//su,
    );
  }
});

// ---------- run layout and the shared installed-check functions ----------

test('a run keeps every file below the repository\'s tmp directory', () => {
  const paths = lifecycleCheckPaths(workspaceRoot);
  assert.equal(paths.root, join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'installed-capture-lifecycle'));
  for (const [name, path] of Object.entries(paths)) {
    if (name !== 'root') assert.ok(path.startsWith(`${paths.root}\\`) || path.startsWith(`${paths.root}/`), name);
  }
  assert.ok(paths.appTemporary.startsWith(paths.run));
  assert.ok(paths.library.startsWith(paths.run));
});

test('an installer or system tool gets only allowlisted variables and an owned TEMP', () => {
  const owned = join(runRoot, 'temp');
  const environment = installedChildEnvironment(
    { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'x', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' },
    owned,
    runRoot,
  );
  assert.deepEqual(environment, { PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', TEMP: owned, TMP: owned });
  assert.throws(() => installedChildEnvironment({}, tmpdir(), runRoot), /strict descendant/u);
});

test('the QA build\'s registry keys name its own product', () => {
  assert.deepEqual(registryKeysForProduct('Capture Workbench QA Fake Data'), {
    productRegistryKey: 'HKCU\\Software\\github\\Capture Workbench QA Fake Data',
    uninstallRegistryKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Capture Workbench QA Fake Data',
  });
});

test('fixture sources carry their text in the form the fixture runtime reads', () => {
  assert.equal(fixtureSourceBytes('pdf', ['one', 'two']).toString('utf8'), '%PDF-1.7\nCAPTURE_TEXT:one\ftwo');
  assert.deepEqual([...fixtureSourceBytes('image', ['words']).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(fixtureSourceBytes('image', ['words']).subarray(8).toString('utf8'), 'CAPTURE_TEXT:words');
  assert.equal(fixtureSourceBytes('recording', ['a', 'b']).subarray(12).toString('utf8'), 'CAPTURE_TEXT:a|b');
  assert.equal(fixtureSourceBytes('recording', ['a']).subarray(0, 12).toString('latin1'), 'RIFF\0\0\0\0WAVE');
  assert.throws(() => fixtureSourceBytes('image', ['a', 'b']), /one for an image/u);
  assert.throws(() => fixtureSourceBytes('pdf', []), /one or more/u);
  assert.equal(INSTALLED_FIXTURES[0].buffer.toString('utf8'), '%PDF-1.7\nCAPTURE_TEXT:Installed PDF page one\fInstalled PDF page two');
});

test('an installation counts as owned only when its executable and registry point into the owned directory', async () => {
  const install = join(runRoot, 'install');
  const calls: string[] = [];
  await firstValueFrom(assertInstalledIntoOwnedDirectory(
    { assertOwnedRegularFile: (root: string, candidate: string) => { calls.push(`file ${candidate}`); return of(candidate); } },
    { assertInstalledRegistryPointsToOwnedDirectory: (directory: string) => { calls.push(`registry ${directory}`); return of(undefined); } },
    install,
  ));
  assert.deepEqual(calls, [`file ${join(install, 'capture-workbench-desktop.exe')}`, `registry ${install}`]);
});

test('an installation whose uninstaller and executable are both gone only waits for its registry key to go', async () => {
  const install = join(runRoot, 'no-such-install');
  const calls: string[] = [];
  const state = await firstValueFrom(uninstallOwnedInstallation({
    lifecycle: {
      assertOwnedRegularFile: () => { calls.push('file'); return of(''); },
      runCheckedExecutable: () => { calls.push('run'); return of(undefined); },
    },
    registry: {
      assertInstalledRegistryPointsToOwnedDirectory: () => { calls.push('registry'); return of(undefined); },
      waitForInstalledDirectoryRemoval: () => { calls.push('wait'); return of({ uninstallKeyRemoved: true, productKeyRetained: false }); },
    },
    smokeRoot: runRoot,
    installDirectory: install,
    environment: {},
    timeoutMs: 1_000,
  }));
  assert.deepEqual(calls, ['wait']);
  assert.deepEqual(state, { uninstallKeyRemoved: true, productKeyRetained: false });
});

// ---------- the Nx target ----------

test('the target builds the QA installer first and runs the check\'s command line', async () => {
  const project = JSON.parse(await readFile(join(appRoot, 'project.json'), 'utf8'));
  const target = project.targets[targetName];
  assert.deepEqual(target.dependsOn, ['build-nsis-deterministic']);
  assert.equal(target.cache, false);
  assert.equal(target.executor, 'nx:run-commands');
  assert.equal(target.options.command, 'node apps/capture-workbench-desktop/scripts/installed-capture-lifecycle-cli.ts');
  assert.deepEqual(target.outputs, ['{workspaceRoot}/tmp/capture-workbench-desktop/installed-capture-lifecycle']);
});

/** The Nx targets one shell command runs: `nx run project:target`, and `-t`/`--targets` lists of run-many and affected. */
function nxTargetsInCommand(command: string): string[] {
  const targets: string[] = [];
  const words = command.split(/\s+/u).filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 'nx') continue;
    const verb = words[index + 1];
    if (verb === 'run' && words[index + 2]?.includes(':')) targets.push(words[index + 2].split(':')[1]);
    if (verb === 'run-many' || verb === 'affected') {
      for (let option = index + 2; option < words.length && words[option] !== '&&'; option += 1) {
        const word = words[option].replaceAll('"', '');
        const list = word === '-t' || word === '--targets'
          ? words[option + 1]?.replaceAll('"', '')
          : word.startsWith('--targets=') ? word.slice('--targets='.length) : undefined;
        if (list) targets.push(...list.split(','));
      }
    }
  }
  return targets;
}

/** The Nx targets the `verify` scripts run, following `pnpm run` into other scripts. */
function targetsOfVerifyScripts(scripts: Record<string, string>): Set<string> {
  const targets = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || scripts[name] === undefined) return;
    seen.add(name);
    for (const command of scripts[name].split('&&')) {
      for (const target of nxTargetsInCommand(command)) targets.add(target);
      const nested = command.match(/\bpnpm run ([\w:-]+)/u);
      if (nested) visit(nested[1]);
    }
  };
  for (const name of Object.keys(scripts).filter((candidate) => candidate === 'verify' || candidate.startsWith('verify:'))) visit(name);
  return targets;
}

/** Every dependsOn entry in a set of targets, as the target name it names. */
function dependedOnTargets(targets: Record<string, { dependsOn?: unknown[] }>): string[] {
  return Object.values(targets).flatMap((target) => (target.dependsOn ?? []).map((entry) => {
    if (typeof entry === 'string') return entry.replace(/^\^/u, '').split(':').at(-1);
    return typeof (entry as { target?: unknown }).target === 'string' ? (entry as { target: string }).target : '';
  }));
}

test('the verify scripts do not run the target, and no target depends on it', async () => {
  const manifest = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const verified = targetsOfVerifyScripts(manifest.scripts);
  // The parser sees the real list, so its silence about the target means something.
  for (const known of ['lint', 'test-scripts', 'typecheck-scripts']) assert.ok(verified.has(known), `verify scripts: ${known}`);
  assert.ok(!verified.has(targetName), 'a verify script runs the target');

  // No target depends on it: the resolved targets of its own project, and the
  // configured targets of every other project and the workspace defaults.
  const nxManifest = createRequire(import.meta.url).resolve('nx/package.json');
  const nxBin = join(dirname(nxManifest), (JSON.parse(await readFile(nxManifest, 'utf8')) as { bin: { nx: string } }).bin.nx);
  // Plugins load in the Nx process itself: isolated plugin workers outlive it
  // for a moment and keep files in the test's temp root from being removed.
  const environment: NodeJS.ProcessEnv = { ...process.env, NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' };
  delete environment.NX_WORKSPACE_ROOT_PATH;
  const shown = spawnSync(process.execPath, [nxBin, 'show', 'project', 'capture-workbench-desktop', '--json'], {
    cwd: workspaceRoot, encoding: 'utf8', env: environment, timeout: 180_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(shown.error, undefined, `nx show project could not run: ${shown.error?.message}`);
  assert.equal(shown.status, 0, shown.stderr);
  const resolved = JSON.parse(shown.stdout.slice(shown.stdout.indexOf('{'))) as { targets: Record<string, { dependsOn?: unknown[] }> };
  assert.deepEqual(resolved.targets[targetName].dependsOn, ['build-nsis-deterministic']);
  const dependedOn = new Set(dependedOnTargets(resolved.targets));
  for (const directory of ['apps', 'packages']) {
    for (const project of await readdir(join(workspaceRoot, directory))) {
      const configuration = await readFile(join(workspaceRoot, directory, project, 'project.json'), 'utf8').catch(() => null);
      if (configuration) for (const target of dependedOnTargets(JSON.parse(configuration).targets ?? {})) dependedOn.add(target);
    }
  }
  const tools = JSON.parse(await readFile(join(workspaceRoot, 'tools', 'project.json'), 'utf8'));
  for (const target of dependedOnTargets(tools.targets ?? {})) dependedOn.add(target);
  const workspace = JSON.parse(await readFile(join(workspaceRoot, 'nx.json'), 'utf8'));
  for (const target of dependedOnTargets(workspace.targetDefaults ?? {})) dependedOn.add(target);
  assert.ok(dependedOn.has('build-nsis-deterministic'));
  assert.ok(!dependedOn.has(targetName), 'a target depends on the capture-lifecycle check');
});
