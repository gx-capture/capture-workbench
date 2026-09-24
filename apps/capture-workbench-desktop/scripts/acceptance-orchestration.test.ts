import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCaptureWorkbenchAcceptanceOrchestration } from './acceptance-orchestration.ts';
import { waitForChildClose } from './acceptance-real.ts';
import { finalizeDesktopTeardown } from './real-desktop-ocr-smoke.ts';
const project = 'capture-workbench' as const, runId = 'run-1';
const journalModule = pathToFileURL(resolve('tools/acceptance-checkpoint-journal.ts')).href, contractModule = pathToFileURL(resolve('tools/acceptance-contract.ts')).href;
const proof = JSON.parse('{"schemaVersion":"1","selectionProof":{"identity":{"adapterClass":"dedicated","adapterLuid":"00000000000000aa","vendorId":"10de","deviceId":"2204","subsystemId":"00000001","revision":"01","description":"test GPU","identitySha256":"c759f89c24eedb109d5a6031f8b6c6c621ae837af0283a4037ccb3b40be61efb"},"highPerformanceRank":0,"dmlDeviceId":0,"adapterMapSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","planSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"pipelineConstruction":{"pre":{"adapterLuid":"00000000000000aa","adapterMapSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","factoryCurrent":true},"post":{"adapterLuid":"00000000000000aa","adapterMapSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","factoryCurrent":true}},"sessionDeviceProofs":[{"sessionIndex":0,"providerOrder":["DmlExecutionProvider","CPUExecutionProvider"],"dmlDeviceId":0,"fallbackDisabled":true,"dmlNodeCount":2,"cpuNodeCount":1,"evidenceSource":"ort-graph-assignment"}],"sourceSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","requestedPageScope":[1],"dmlNodeCount":2,"runtimeSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","workerSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","modelSha256":"1111111111111111111111111111111111111111111111111111111111111111","profileId":"capture-workbench-ocr-pipeline-v1","profileSpecSha256":"2222222222222222222222222222222222222222222222222222222222222222","contractSetSha256":"3333333333333333333333333333333333333333333333333333333333333333","executionSha256":"55817e993fc1498da9603d3a03f3e5f35848c027caae4f52f596e2d357ea2199"}');
const childScript = `
import { join } from 'node:path'; import { writeFile } from 'node:fs/promises';
const { openAcceptanceCheckpointWriter } = await import(${JSON.stringify(journalModule)});
const { readOcrExecutionProof, writeAcceptanceManifest } = await import(${JSON.stringify(contractModule)});
const root = process.env.ROOT, mode = process.env.MODE ?? 'ok';
const stages = [['launch', 'desktop-process'], ['cdp', 'initial-attach'], ['runtime', 'runtime-ready'], ['ocr_compute', 'compute-preflight'], ['ocr_semantic', 'ocr-result']];
const writer = await openAcceptanceCheckpointWriter({ eventRoot: root, project: 'capture-workbench', runId: 'run-1' });
for (const [stage, checkpointId] of stages) { await writer.begin(stage, checkpointId); await writer.complete(stage, checkpointId); }
if (mode === 'none') process.exit(0);
const proofPath = join(root, 'ocr-device-proof-v1.json'), proofBytes = Buffer.from(mode === 'malformed' ? '{' : process.env.PROOF, 'utf8');
if (mode !== 'missing') await writeFile(proofPath, proofBytes);
const screenshotPath = join(root, 'proof.png'); await writeFile(screenshotPath, Buffer.from('shape-only screenshot', 'utf8'));
const evidenceProof = mode === 'mismatch'
  ? { ...(await readOcrExecutionProof(root)), sha256: '0000000000000000000000000000000000000000000000000000000000000000' }
  : mode === 'missing' ? undefined : await readOcrExecutionProof(root);
await writeAcceptanceManifest(root, {
  project: 'capture-workbench', runId: 'run-1', status: 'completed', recordVideo: false,
  artifacts: [...(mode === 'missing' ? [] : [{ path: proofPath, kind: 'log' }]), { path: screenshotPath, kind: 'screenshot' }],
  errors: [], consoleErrors: [], pageErrors: [],
  cleanup: { app: mode !== 'cleanup-live', sidecar: mode !== 'cleanup-live', cdpPort: mode !== 'cleanup-live', temporaryAppData: mode !== 'cleanup-live', ownedPids: mode !== 'cleanup-live', ownedListeners: mode !== 'cleanup-live', ownedWorkers: mode !== 'cleanup-live' },
  fixture: { name: 'fixture.pdf', sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' },
  ...(evidenceProof ? { evidence: { ocrExecutionProof: evidenceProof } } : {}),
});
if (mode === 'missing') process.exitCode = 1;
`;

function plan(artifactRoot: string) { return { project, cwd: process.cwd(), target: 'capture-workbench-desktop:acceptance-real', artifactRoot, scopePath: join(artifactRoot, 'scope.json'), environment: process.env } as const; }

function runChild(root: string, mode = 'ok'): Promise<{ status: number; error: boolean }> {
  return new Promise((resolveChild) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript], { cwd: process.cwd(), env: { ...process.env, ROOT: root, MODE: mode, PROOF: JSON.stringify(proof) }, stdio: 'ignore', windowsHide: true });
    let error = false;
    child.once('error', () => { error = true; });
    child.once('close', (status) => resolveChild({ status: status ?? 1, error }));
    if (mode === 'cleanup-live') setTimeout(() => void finalizeDesktopTeardown(undefined, child, 'window-close', () => undefined), 500);
  });
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-orchestration-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function orchestrate(root: string, mode = 'ok', requiredScope = false) {
  const item = plan(root);
  return runCaptureWorkbenchAcceptanceOrchestration({ run: { project, runId, recordVideo: false, artifactRoot: root }, acceptanceEventRoot: root, manifestValidationPlan: item, child: () => runChild(root, mode), ...(requiredScope ? { scope: { context: { item, scopePath: item.scopePath } } } : {}) }, requiredScope ? { verifyCleanup: async () => ({ scopeVerified: false, errors: ['missing'], cleanup: {} } as never) } : {});
}

test('child error marks the result but close owns settlement', async () => await withRoot(async (root) => { const child = new EventEmitter() as unknown as ChildProcess; let settled = false; const result = waitForChildClose(child).then((value) => { settled = true; return value; }); child.emit('error', new Error('spawn failed')); await new Promise<void>((resolve) => setImmediate(resolve)); await writeFile(join(root, 'late-sentinel.json'), 'late evidence', 'utf8'); assert.equal(settled, false); child.emit('close', null); assert.deepEqual(await result, { status: 1, error: true }); }));

test('closed production child writes journal, manifest, and physical OCR proof before parent pass', async () => {
  await withRoot(async (root) => { const result = await orchestrate(root); assert.equal(result.terminal.phase1Verdict, 'pass'); assert.equal(result.terminal.sourceManifestSha256?.length, 64); assert.equal(result.journal.status, 'valid-complete'); });
});

test('child evidence failures and nonzero child exit fail closed', async () => {
  for (const mode of ['missing', 'malformed', 'mismatch', 'none']) {
    await withRoot(async (root) => { assert.equal((await orchestrate(root, mode)).terminal.phase1Verdict, 'fail', mode); });
  }
});

test('direct run has not-applicable outer scope; required failed scope blocks it', async () => {
  await withRoot(async (root) => { assert.equal((await orchestrate(root)).terminal.cleanupOutcome.outerScope, 'not-applicable'); });
  await withRoot(async (root) => { assert.deepEqual((await orchestrate(root, 'ok', true)).terminal.primaryAcceptanceFailure, { code: 'cleanup_failed', stage: null, checkpointId: null }); });
});

test('production teardown cleanup failure remains terminal failure', async () => {
  await withRoot(async (root) => { const result = await orchestrate(root, 'cleanup-live'); const manifest = JSON.parse(await readFile(join(root, 'acceptance-manifest.json'), 'utf8')); assert.equal(manifest.status, 'completed'); assert.equal(manifest.cleanup.app, false); assert.deepEqual(result.terminal.primaryAcceptanceFailure, { code: 'cleanup_failed', stage: null, checkpointId: null }); assert.equal(result.terminal.phase1Verdict, 'fail'); });
});
