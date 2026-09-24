import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { AcceptanceManifestReadResult } from './acceptance-contract.ts';

const STAGES = ['launch', 'cdp', 'runtime', 'ocr_compute', 'ocr_semantic'] as const;
const IDS = ['desktop-process', 'initial-attach', 'runtime-ready', 'compute-preflight', 'ocr-result'] as const;
const FAILURE: Record<AcceptanceCheckpointStage, AcceptanceCheckpointFailureCode> = {
  launch: 'launch_failed', cdp: 'cdp_failed', runtime: 'runtime_failed',
  ocr_compute: 'ocr_gpu_failed', ocr_semantic: 'ocr_semantic_failed',
};
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export const ACCEPTANCE_CHECKPOINT_STAGES = STAGES;
export type AcceptanceCheckpointStage = (typeof STAGES)[number];
export const ACCEPTANCE_CHECKPOINT_IDS = IDS;
export type AcceptanceCheckpointId = (typeof IDS)[number];
export type AcceptanceCheckpointState = 'started' | 'completed' | 'failed';
export type AcceptanceCheckpointFailureCode =
  | 'launch_failed' | 'cdp_failed' | 'runtime_failed' | 'ocr_gpu_failed'
  | 'ocr_semantic_failed' | 'runner_interrupted';
export interface AcceptanceCheckpointEntry {
  readonly seq: number; readonly stage: AcceptanceCheckpointStage;
  readonly checkpointId: AcceptanceCheckpointId; readonly state: AcceptanceCheckpointState;
  readonly code: 'checkpoint_started' | 'checkpoint_completed' | AcceptanceCheckpointFailureCode;
}
export interface AcceptanceCheckpointJournalState {
  readonly schemaVersion: 1; readonly kind: 'checkpoint-journal';
  readonly project: string; readonly runId: string; readonly sequence: number;
  readonly entries: readonly AcceptanceCheckpointEntry[];
  readonly active: readonly { readonly stage: AcceptanceCheckpointStage; readonly checkpointId: AcceptanceCheckpointId }[];
}
export interface AcceptanceCheckpointJournalRequest { readonly eventRoot: string; readonly project: string; readonly runId: string; }
export interface AcceptanceCheckpointWriter {
  readonly state: AcceptanceCheckpointJournalState;
  begin(stage: AcceptanceCheckpointStage, checkpointId: AcceptanceCheckpointId): Promise<void>;
  complete(stage: AcceptanceCheckpointStage, checkpointId: AcceptanceCheckpointId): Promise<void>;
  fail(stage: AcceptanceCheckpointStage, checkpointId: AcceptanceCheckpointId, code?: AcceptanceCheckpointFailureCode): Promise<void>;
  failActive(code?: AcceptanceCheckpointFailureCode): Promise<boolean>;
}
export type AcceptanceJournalStatus = 'absent' | 'valid-complete' | 'valid-active' | 'invalid';
export interface AcceptanceJournalObservation { readonly status: AcceptanceJournalStatus; readonly state?: AcceptanceCheckpointJournalState; }
export interface AcceptanceCleanupOutcome { readonly producer: 'completed' | 'failed'; readonly outerScope: 'completed' | 'failed' | 'not-applicable'; }
export interface AcceptanceChildResult { readonly status: number; readonly error: boolean; }
export interface AcceptanceTerminalInput {
  readonly eventRoot: string; readonly project: string; readonly runId: string;
  readonly child: AcceptanceChildResult; readonly journal: AcceptanceJournalObservation;
  readonly manifest: AcceptanceManifestReadResult;
  readonly outerScope: AcceptanceCleanupOutcome['outerScope'];
}
export interface AcceptancePrimaryAcceptanceFailure {
  readonly code: AcceptanceCheckpointFailureCode | 'acceptance_failed' | 'manifest_missing_or_invalid' | 'cleanup_failed';
  readonly stage: AcceptanceCheckpointStage | null; readonly checkpointId: AcceptanceCheckpointId | null;
}
export interface AcceptanceTerminalRecord {
  readonly schemaVersion: 1; readonly kind: 'acceptance-terminal'; readonly project: string; readonly runId: string;
  readonly checkpointJournalStatus: AcceptanceJournalStatus; readonly checkpointSequence: readonly AcceptanceCheckpointEntry[];
  readonly primaryAcceptanceFailure: AcceptancePrimaryAcceptanceFailure | null;
  readonly sourceManifestSha256: string | null; readonly artifactCount: number;
  readonly cleanupOutcome: AcceptanceCleanupOutcome; readonly phase1Verdict: 'pass' | 'fail';
  readonly artifactCleanup: 'allowed' | 'blocked';
}
export class AcceptanceCheckpointJournalError extends Error {
  public readonly code: string;
  public constructor(code: string) { super(code); this.name = 'AcceptanceCheckpointJournalError'; this.code = code; }
}

const paths = (root: string) => ({
  journal: join(resolve(root), 'private', 'checkpoint-journal-v1.json'),
  terminal: join(resolve(root), 'public', 'acceptance-terminal-v1.json'),
});
const pair = (index: number) => ({ stage: STAGES[index], checkpointId: IDS[index] });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};
const requestOk = (r: AcceptanceCheckpointJournalRequest) => {
  if (!SAFE.test(r.project) || !SAFE.test(r.runId)) throw new AcceptanceCheckpointJournalError('invalid_request');
};
async function atomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8'); await rename(temp, path); }
  finally { await unlink(temp).catch(() => undefined); }
}
const initial = (r: AcceptanceCheckpointJournalRequest): AcceptanceCheckpointJournalState => ({
  schemaVersion: 1, kind: 'checkpoint-journal', project: r.project, runId: r.runId, sequence: 0, entries: [], active: [],
});
function validState(value: unknown, r: AcceptanceCheckpointJournalRequest): value is AcceptanceCheckpointJournalState {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'kind', 'project', 'runId', 'sequence', 'entries', 'active']) || value.schemaVersion !== 1 || value.kind !== 'checkpoint-journal' || value.project !== r.project || value.runId !== r.runId ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || !Array.isArray(value.entries) || value.sequence !== value.entries.length ||
      value.entries.length > STAGES.length * 2 + 1 || !Array.isArray(value.active) || value.active.length > 1) return false;
  let completed = 0; let active: { stage: AcceptanceCheckpointStage; checkpointId: AcceptanceCheckpointId } | undefined; let failed = false;
  for (const [index, raw] of value.entries.entries()) {
    if (!object(raw) || !exactKeys(raw, ['seq', 'stage', 'checkpointId', 'state', 'code']) || raw.seq !== index + 1 || typeof raw.stage !== 'string' || typeof raw.checkpointId !== 'string' ||
        !STAGES.some((stage, i) => stage === raw.stage && IDS[i] === raw.checkpointId) || !['started', 'completed', 'failed'].includes(String(raw.state))) return false;
    if (raw.state === 'started') {
      const next = pair(completed); if (failed || active || !next.stage || raw.stage !== next.stage || raw.checkpointId !== next.checkpointId || raw.code !== 'checkpoint_started') return false;
      active = { stage: raw.stage as AcceptanceCheckpointStage, checkpointId: raw.checkpointId as AcceptanceCheckpointId };
    } else {
      if (!active || active.stage !== raw.stage || active.checkpointId !== raw.checkpointId) return false;
      if (raw.state === 'completed') { if (raw.code !== 'checkpoint_completed') return false; completed += 1; }
      else if (raw.code !== FAILURE[raw.stage as AcceptanceCheckpointStage] && raw.code !== 'runner_interrupted') return false;
      else failed = true;
      active = undefined;
    }
  }
  if (value.active.length === 0) return active === undefined;
  const saved = value.active[0];
  return object(saved) && exactKeys(saved, ['stage', 'checkpointId']) && active !== undefined && saved.stage === active.stage && saved.checkpointId === active.checkpointId;
}
export async function openAcceptanceCheckpointWriter(r: AcceptanceCheckpointJournalRequest): Promise<AcceptanceCheckpointWriter> {
  requestOk(r); const path = paths(r.eventRoot).journal; let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (!(object(error) && error.code === 'ENOENT')) throw new AcceptanceCheckpointJournalError('journal_read_failed');
    value = initial(r); await atomic(path, value);
  }
  if (!validState(value, r)) throw new AcceptanceCheckpointJournalError('invalid_journal');
  let current = value;
  const save = async (next: AcceptanceCheckpointJournalState) => { if (!validState(next, r)) throw new AcceptanceCheckpointJournalError('invalid_transition'); await atomic(path, next); current = next; };
  const transition = async (kind: 'begin' | 'complete' | 'fail', stage: AcceptanceCheckpointStage, checkpointId: AcceptanceCheckpointId, code?: AcceptanceCheckpointFailureCode) => {
    const active = current.active.at(-1); const next = pair(current.entries.filter((e) => e.state === 'completed').length);
    if (!STAGES.some((s, i) => s === stage && IDS[i] === checkpointId)) throw new AcceptanceCheckpointJournalError('invalid_transition');
    if (kind === 'begin') {
      if (active || current.entries.some((e) => e.checkpointId === checkpointId) || next.stage !== stage || next.checkpointId !== checkpointId) throw new AcceptanceCheckpointJournalError('invalid_transition');
      const e = { seq: current.sequence + 1, stage, checkpointId, state: 'started' as const, code: 'checkpoint_started' as const };
      return save({ ...current, sequence: e.seq, entries: [...current.entries, e], active: [{ stage, checkpointId }] });
    }
    if (!active || active.stage !== stage || active.checkpointId !== checkpointId) throw new AcceptanceCheckpointJournalError('invalid_transition');
    if (kind === 'fail' && code !== undefined && code !== FAILURE[stage] && code !== 'runner_interrupted') throw new AcceptanceCheckpointJournalError('invalid_transition');
    const state = kind === 'fail' ? 'failed' as const : 'completed' as const;
    const e = { seq: current.sequence + 1, stage, checkpointId, state, code: kind === 'fail' ? code ?? FAILURE[stage] : 'checkpoint_completed' } as AcceptanceCheckpointEntry;
    return save({ ...current, sequence: e.seq, entries: [...current.entries, e], active: [] });
  };
  return { get state() { return current; }, begin: (s, i) => transition('begin', s, i), complete: (s, i) => transition('complete', s, i), fail: (s, i, c) => transition('fail', s, i, c), failActive: async (c) => { const a = current.active.at(-1); if (!a) return false; await transition('fail', a.stage, a.checkpointId, c); return true; } };
}
export async function readAcceptanceCheckpointJournal(r: AcceptanceCheckpointJournalRequest): Promise<AcceptanceJournalObservation> {
  requestOk(r); try { const value = JSON.parse(await readFile(paths(r.eventRoot).journal, 'utf8')); return validState(value, r) ? { status: value.active.length ? 'valid-active' : 'valid-complete', state: value } : { status: 'invalid' }; }
  catch (error) { return object(error) && error.code === 'ENOENT' ? { status: 'absent' } : { status: 'invalid' }; }
}
export function hasMandatoryCheckpointCoverage(state: AcceptanceCheckpointJournalState | undefined): boolean {
  return !!state && state.active.length === 0 && state.entries.length === STAGES.length * 2 && state.entries.every((e, i) => {
    const expected = pair(Math.floor(i / 2)); return e.stage === expected.stage && e.checkpointId === expected.checkpointId && e.state === (i % 2 ? 'completed' : 'started') && e.code === (i % 2 ? 'checkpoint_completed' : 'checkpoint_started');
  });
}
function cleanupComplete(value: unknown): boolean { return object(value) && Object.keys(value).length > 0 && Object.values(value).every((entry) => entry === true); }
function failure(code: AcceptancePrimaryAcceptanceFailure['code'], stage: AcceptanceCheckpointStage | null = null, checkpointId: AcceptanceCheckpointId | null = null): AcceptancePrimaryAcceptanceFailure { return { code, stage, checkpointId }; }
function derive(input: AcceptanceTerminalInput): { primary: AcceptancePrimaryAcceptanceFailure | null; producer: 'completed' | 'failed'; artifactCount: number } {
  const failed = input.journal.state?.entries.find((entry) => entry.state === 'failed');
  if (failed) return { primary: failure(failed.code as AcceptancePrimaryAcceptanceFailure['code'], failed.stage, failed.checkpointId), producer: 'failed', artifactCount: 0 };
  const active = input.journal.state?.active.at(-1);
  if (active) return { primary: failure('runner_interrupted', active.stage, active.checkpointId), producer: 'failed', artifactCount: 0 };
  const manifest = input.manifest.status === 'valid' ? input.manifest.manifest : undefined;
  const producerCleanup = manifest !== undefined && cleanupComplete(manifest.cleanup);
  const producer = manifest?.status === 'completed' && producerCleanup ? 'completed' : 'failed';
  const artifactCount = manifest?.status === 'completed' && Array.isArray(manifest.artifacts) ? manifest.artifacts.length : 0;
  if (input.manifest.status !== 'valid') return { primary: failure('manifest_missing_or_invalid'), producer, artifactCount };
  if (input.journal.status !== 'valid-complete' || !hasMandatoryCheckpointCoverage(input.journal.state) || input.child.status !== 0 || input.child.error || manifest.status !== 'completed') return { primary: failure('acceptance_failed'), producer, artifactCount };
  if (!producerCleanup || input.outerScope === 'failed' || (input.outerScope !== 'completed' && input.outerScope !== 'not-applicable')) return { primary: failure('cleanup_failed'), producer, artifactCount };
  return { primary: null, producer, artifactCount };
}
export async function writeAcceptanceTerminal(input: AcceptanceTerminalInput): Promise<{ readonly terminal: AcceptanceTerminalRecord; readonly verified: true }> {
  requestOk(input); const derived = derive(input); const source = input.manifest.sourceManifestSha256;
  const terminal: AcceptanceTerminalRecord = { schemaVersion: 1, kind: 'acceptance-terminal', project: input.project, runId: input.runId, checkpointJournalStatus: input.journal.status, checkpointSequence: input.journal.state?.entries ?? [], primaryAcceptanceFailure: derived.primary, sourceManifestSha256: source && SHA256.test(source) ? source : null, artifactCount: derived.artifactCount, cleanupOutcome: { producer: derived.producer, outerScope: input.outerScope }, phase1Verdict: derived.primary ? 'fail' : 'pass', artifactCleanup: derived.producer === 'completed' && input.outerScope !== 'failed' ? 'allowed' : 'blocked' };
  const path = paths(input.eventRoot).terminal; try { await readFile(path); throw new AcceptanceCheckpointJournalError('terminal_already_written'); } catch (error) { if (error instanceof AcceptanceCheckpointJournalError) throw error; if (!(object(error) && error.code === 'ENOENT')) throw new AcceptanceCheckpointJournalError('terminal_read_failed'); }
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await mkdir(dirname(path), { recursive: true }); await writeFile(temp, `${JSON.stringify(terminal)}\n`, 'utf8'); const parsed = JSON.parse(await readFile(temp, 'utf8')); if (JSON.stringify(parsed) !== JSON.stringify(terminal)) throw new AcceptanceCheckpointJournalError('terminal_publication_failed'); await rename(temp, path); return { terminal, verified: true }; }
  catch (error) { if (error instanceof AcceptanceCheckpointJournalError) throw error; throw new AcceptanceCheckpointJournalError('terminal_publication_failed'); }
  finally { await unlink(temp).catch(() => undefined); }
}
