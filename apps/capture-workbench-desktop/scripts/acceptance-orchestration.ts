// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance is a workspace-level seam.
import {
  readAcceptanceManifestTolerant,
  type AcceptanceManifestReadResult,
  type AcceptanceRun,
} from '../../../tools/acceptance-contract.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- parent/child evidence seam.
import {
  readAcceptanceCheckpointJournal,
  writeAcceptanceTerminal,
  type AcceptanceChildResult,
  type AcceptanceJournalObservation,
  type AcceptanceTerminalRecord,
} from '../../../tools/acceptance-checkpoint-journal.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- existing cleanup policy owner.
import {
  validateChildManifest,
  validateTerminalManifest,
  verifyRecordedCleanupScope,
  type AcceptanceCleanupContext,
  type AcceptanceCleanupProof,
  type AcceptanceProjectPlan,
} from '../../../tools/three-project-acceptance.ts';
export interface AcceptanceScopeVerification { readonly context: Omit<AcceptanceCleanupContext, 'manifest'>; }
export interface AcceptanceOrchestrationInput {
  readonly run: AcceptanceRun; readonly acceptanceEventRoot: string;
  readonly manifestValidationPlan: AcceptanceProjectPlan; readonly child: () => Promise<AcceptanceChildResult>;
  readonly scope?: AcceptanceScopeVerification;
}
export interface AcceptanceOrchestrationDependencies { readonly verifyCleanup?: (context: AcceptanceCleanupContext) => Promise<AcceptanceCleanupProof>; }
export interface AcceptanceOrchestrationResult {
  readonly childResult: AcceptanceChildResult; readonly manifestRead: AcceptanceManifestReadResult;
  readonly journal: AcceptanceJournalObservation; readonly terminal: AcceptanceTerminalRecord;
}
export async function runCaptureWorkbenchAcceptanceOrchestration(
  input: AcceptanceOrchestrationInput,
  dependencies: AcceptanceOrchestrationDependencies = {},
): Promise<AcceptanceOrchestrationResult> {
  let childResult: AcceptanceChildResult = { status: 1, error: true };
  try { childResult = await input.child(); } catch { /* child failure is terminal evidence */ }
  const manifestRead = await readAcceptanceManifestTolerant({
    project: input.run.project, runId: input.run.runId, recordVideo: input.run.recordVideo,
    artifactRoot: input.run.artifactRoot,
    validateTerminalManifest: (manifest) => validateTerminalManifest(manifest, input.manifestValidationPlan, input.run.runId, input.run.recordVideo),
    validateChildManifest: (manifest, requireCleanupComplete = true) => validateChildManifest(manifest, input.manifestValidationPlan, input.run.runId, input.run.recordVideo, requireCleanupComplete),
  });
  const journal = await readAcceptanceCheckpointJournal({ eventRoot: input.acceptanceEventRoot, project: input.run.project, runId: input.run.runId });
  const outerScope = await verifyOuterScope(input, manifestRead, dependencies.verifyCleanup ?? verifyRecordedCleanupScope);
  const { terminal } = await writeAcceptanceTerminal({
    eventRoot: input.acceptanceEventRoot, project: input.run.project, runId: input.run.runId,
    child: childResult, journal, manifest: manifestRead, outerScope,
  });
  return { childResult, manifestRead, journal, terminal };
}
async function verifyOuterScope(
  input: AcceptanceOrchestrationInput,
  manifest: AcceptanceManifestReadResult,
  verify: (context: AcceptanceCleanupContext) => Promise<AcceptanceCleanupProof>,
): Promise<'completed' | 'failed' | 'not-applicable'> {
  if (!input.scope) return 'not-applicable';
  const context = { ...input.scope.context, manifest: manifest.status === 'valid' ? manifest.manifest as unknown as Record<string, unknown> : undefined };
  try {
    const proof = await verify(context);
    return proof.scopeVerified && proof.errors.length === 0 && Object.values(proof.cleanup).every(Boolean) ? 'completed' : 'failed';
  } catch { return 'failed'; }
}
