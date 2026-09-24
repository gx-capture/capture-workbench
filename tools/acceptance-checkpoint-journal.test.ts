import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readAcceptanceManifestTolerant, type AcceptanceManifestReadResult } from './acceptance-contract.ts';
import {
  ACCEPTANCE_CHECKPOINT_IDS, ACCEPTANCE_CHECKPOINT_STAGES, hasMandatoryCheckpointCoverage,
  openAcceptanceCheckpointWriter, readAcceptanceCheckpointJournal, writeAcceptanceTerminal,
} from './acceptance-checkpoint-journal.ts';
const checkpoints = ACCEPTANCE_CHECKPOINT_STAGES.map((stage, i) => [stage, ACCEPTANCE_CHECKPOINT_IDS[i]] as const);
const request = (eventRoot: string) => ({ eventRoot, project: 'capture-workbench', runId: 'run-1' });
const cleanup = { producer: 'completed' as const, outerScope: 'not-applicable' as const };
const manifest = (good = true, status: 'completed' | 'failed' = 'completed'): AcceptanceManifestReadResult => ({ status: 'valid', sourceManifestSha256: 'a'.repeat(64), manifest: { status, cleanup: { app: good, sidecar: good, cdpPort: good, temporaryAppData: good, ownedPids: good, ownedListeners: good, ownedWorkers: good }, artifacts: [{}] } as never });
async function temp(): Promise<string> { return mkdtemp(join(tmpdir(), 'acceptance-journal-')); }
async function complete(root: string): Promise<void> { const writer = await openAcceptanceCheckpointWriter(request(root)); for (const [stage, id] of checkpoints) { await writer.begin(stage, id); await writer.complete(stage, id); } }
async function terminal(root: string, changes: Record<string, unknown> = {}) { const journal = await readAcceptanceCheckpointJournal(request(root)); return writeAcceptanceTerminal({ ...request(root), child: { status: 0, error: false }, journal, manifest: manifest(), outerScope: 'not-applicable', ...changes } as never); }

test('complete ordered journal derives pass without caller coverage fields', async () => {
  const root = await temp(); await complete(root); const journal = await readAcceptanceCheckpointJournal(request(root));
  assert.equal(journal.status, 'valid-complete'); assert.equal(hasMandatoryCheckpointCoverage(journal.state), true);
  const result = await terminal(root); assert.equal(result.terminal.phase1Verdict, 'pass'); assert.equal(result.terminal.primaryAcceptanceFailure, null); assert.equal(result.terminal.artifactCount, 1);
  const published = await readFile(join(root, 'public', 'acceptance-terminal-v1.json'));
  assert.deepEqual(JSON.parse(published.toString()), result.terminal);
  assert.equal(published.toString(), `${JSON.stringify(result.terminal)}\n`);
  await rm(root, { recursive: true, force: true });
});

test('incomplete, failed, and cleanup-only observations cannot forge a pass', async () => {
  const root = await temp(); const writer = await openAcceptanceCheckpointWriter(request(root)); await writer.begin('launch', 'desktop-process'); await writer.complete('launch', 'desktop-process');
  let result = await terminal(root); assert.equal(result.terminal.primaryAcceptanceFailure?.code, 'acceptance_failed'); await rm(root, { recursive: true, force: true });
  const failed = await temp(); await complete(failed); result = await terminal(failed, { child: { status: 0, error: true }, manifest: manifest(false) }); assert.equal(result.terminal.primaryAcceptanceFailure?.code, 'acceptance_failed'); await rm(failed, { recursive: true, force: true });
  const failedStatus = await temp(); await complete(failedStatus); result = await terminal(failedStatus, { manifest: manifest(false, 'failed') }); assert.equal(result.terminal.primaryAcceptanceFailure?.code, 'acceptance_failed'); await rm(failedStatus, { recursive: true, force: true });
  const cleanupRoot = await temp(); await complete(cleanupRoot); result = await terminal(cleanupRoot, { manifest: manifest(false) }); assert.deepEqual(result.terminal.primaryAcceptanceFailure, { code: 'cleanup_failed', stage: null, checkpointId: null }); await rm(cleanupRoot, { recursive: true, force: true });
});

test('typed OCR failure wins over later cleanup failure', async () => {
  const root = await temp(); const writer = await openAcceptanceCheckpointWriter(request(root));
  for (const [stage, id] of checkpoints.slice(0, 3)) { await writer.begin(stage, id); await writer.complete(stage, id); }
  await writer.begin('ocr_compute', 'compute-preflight'); await writer.fail('ocr_compute', 'compute-preflight');
  const result = await terminal(root, { manifest: manifest(false), outerScope: 'failed' }); assert.deepEqual(result.terminal.primaryAcceptanceFailure, { code: 'ocr_gpu_failed', stage: 'ocr_compute', checkpointId: 'compute-preflight' }); await rm(root, { recursive: true, force: true });
});

test('journal entries and active records reject unknown fields without public leakage', async () => {
  for (const value of [
    { schemaVersion: 1, kind: 'checkpoint-journal', project: 'capture-workbench', runId: 'run-1', sequence: 0, entries: [], active: [{ stage: 'launch', checkpointId: 'desktop-process', token: 'secret' }] },
    { schemaVersion: 1, kind: 'checkpoint-journal', project: 'capture-workbench', runId: 'run-1', sequence: 1, entries: [{ seq: 1, stage: 'launch', checkpointId: 'desktop-process', state: 'started', code: 'checkpoint_started', token: 'secret' }], active: [{ stage: 'launch', checkpointId: 'desktop-process' }] },
  ]) {
    const root = await temp(); await mkdir(join(root, 'private'), { recursive: true }); await writeFile(join(root, 'private', 'checkpoint-journal-v1.json'), JSON.stringify(value));
    const observation = await readAcceptanceCheckpointJournal(request(root)); assert.equal(observation.status, 'invalid'); const result = await terminal(root); assert.equal(result.terminal.primaryAcceptanceFailure?.code, 'acceptance_failed'); assert.deepEqual(result.terminal.checkpointSequence, []); await rm(root, { recursive: true, force: true });
  }
});

test('readable malformed manifest keeps its bytes hash; missing stays null', async () => {
  const root = await temp(); const path = join(root, 'acceptance-manifest.json'); await writeFile(path, '{ malformed');
  const context = { project: 'capture-workbench', runId: 'run-1', recordVideo: false, artifactRoot: root, validateTerminalManifest: () => true, validateChildManifest: async () => true };
  const malformed = await readAcceptanceManifestTolerant(context); assert.equal(malformed.status, 'missing-or-invalid'); assert.equal(malformed.sourceManifestSha256?.length, 64); await rm(root, { recursive: true, force: true });
  const missingRoot = await temp(); const missing = await readAcceptanceManifestTolerant({ ...context, artifactRoot: missingRoot }); assert.equal(missing.sourceManifestSha256, null); await rm(missingRoot, { recursive: true, force: true });
});

test('terminal publication failure leaves no public terminal', async () => {
  const root = await temp(); await complete(root); await writeFile(join(root, 'public'), 'blocking-file');
  await assert.rejects(() => terminal(root), /AcceptanceCheckpointJournalError|terminal_publication_failed/u); assert.equal(await readFile(join(root, 'public'), 'utf8'), 'blocking-file'); await rm(root, { recursive: true, force: true });
});
