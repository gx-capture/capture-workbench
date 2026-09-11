import { createHash } from 'node:crypto';

export type Sha256 = string;
export type ParentGate = 'D4' | 'D7';
export type Tier = 'candidate' | 'published';
export type MediaKind = 'jpeg' | 'pdf';

export interface RootBinding {
  readonly ordinal: number;
  readonly role: string;
  readonly rootRefDigest: Sha256;
  readonly rootGeneration: number;
  readonly specDigest: Sha256;
  readonly reservedListenerIdentity: string;
}

export type Binding =
  | { readonly kind: 'unbound' }
  | {
      readonly kind: 'bound';
      readonly bindingAttemptId: string;
      readonly groupRefDigest: Sha256;
      readonly groupGeneration: number;
      readonly rootBindings: readonly RootBinding[];
      readonly activationReceiptDigest: Sha256;
    };

/**
 * Producer-owned read-back expectation. The codec cannot derive a complete
 * root set from a prefix, so bound records must be checked against this
 * explicit immutable context before they are claimed as prepared or frozen.
 */
export interface ExpectedBindingContext {
  readonly bindingAttemptId: string;
  readonly groupRefDigest: Sha256;
  readonly groupGeneration: number;
  readonly rootBindings: readonly RootBinding[];
  readonly activationReceiptDigest: Sha256;
}

export interface PlannedChildScopeV1 {
  readonly schemaVersion: 'ProducerChildScopeV1';
  readonly contractVersion: '1';
  readonly contractSha256: Sha256;
  readonly producer: 'capture-runtime';
  readonly parentGate: ParentGate;
  readonly tier: Tier;
  readonly runIdDigest: Sha256;
  readonly sequenceIndex: number;
  readonly childKey: string;
  readonly legId: string;
  readonly childId: Sha256;
  readonly childPlanDigest: Sha256;
  readonly readyState: 'planned';
  readonly binding: { readonly kind: 'unbound' };
}

export interface PreparedChildScopeV1 extends Omit<PlannedChildScopeV1, 'readyState' | 'binding'> {
  readonly readyState: 'prepared';
  readonly binding: Extract<Binding, { readonly kind: 'bound' }>;
}

export interface ReadyChildScopeV1 extends Omit<PreparedChildScopeV1, 'readyState'> {
  readonly readyState: 'ready';
  readonly invocationSha256: Sha256;
  readonly outputPathNonce: string;
}

export type ProducerChildScopeV1 =
  | PlannedChildScopeV1
  | PreparedChildScopeV1
  | ReadyChildScopeV1;

export interface LedgerBindingD3 {
  readonly sourceGate: 'D3';
  readonly ledgerSha256: Sha256;
  readonly candidateId: Sha256;
  readonly candidateManifestSha256: Sha256;
}

export interface LedgerBindingD6 {
  readonly sourceGate: 'D6';
  readonly ledgerSha256: Sha256;
  readonly publicationLedgerSha256: Sha256;
  readonly downloadBundleSha256: Sha256;
}

export type LedgerBinding = LedgerBindingD3 | LedgerBindingD6;

export interface ArtifactDigest {
  readonly artifactKey: string;
  readonly sha256: Sha256;
}

export interface WireLedgerBindingD3 extends LedgerBindingD3 {
  readonly artifactDigests: readonly ArtifactDigest[];
}

export interface WireLedgerBindingD6 extends LedgerBindingD6 {
  readonly artifactDigests: readonly ArtifactDigest[];
}

export type WireLedgerBinding = WireLedgerBindingD3 | WireLedgerBindingD6;

export interface FixtureAssignment {
  readonly fixtureIndex: number;
  readonly fixtureKey: string;
  readonly fixtureIdentitySha256: Sha256;
  readonly mediaKind: MediaKind;
  readonly page: number | null;
  readonly mediaCapabilityHandle: string;
  readonly mediaCapabilityHandleSha256: Sha256;
  readonly oracleCapabilityHandle: string;
  readonly oracleCapabilityHandleSha256: Sha256;
  readonly mediaSha256: Sha256;
  readonly oracleSha256: Sha256;
  readonly expectedNormalizedTruthSha256: Sha256;
  readonly expectedAnchorSetSha256: Sha256;
  readonly cerThreshold: number;
  readonly artifactId: Sha256;
}

export interface ProducerChildInvocationV1 {
  readonly schemaVersion: 'ProducerChildInvocationV1';
  readonly contractVersion: '1';
  readonly contractSha256: Sha256;
  readonly producer: 'capture-runtime';
  readonly parentGate: ParentGate;
  readonly tier: Tier;
  readonly invocationState: 'frozen';
  readonly sequenceIndex: number;
  readonly childKey: string;
  readonly legId: string;
  readonly childId: Sha256;
  readonly root: Sha256;
  readonly groupRefDigest: Sha256;
  readonly groupGeneration: number;
  readonly bindingAttemptId: string;
  readonly rootBindings: readonly RootBinding[];
  readonly activationReceiptDigest: Sha256;
  readonly artifactIds: readonly Sha256[];
  readonly ledgerBinding: LedgerBinding;
  readonly predecessorCleanupProofSha256: Sha256 | null;
  readonly fixtureAssignments: readonly FixtureAssignment[];
  readonly outputPathNonce: string;
  readonly invocationSha256: Sha256;
}

export interface SemanticFixtureResult {
  readonly fixtureIndex: number;
  readonly fixtureKey: string;
  readonly fixtureIdentitySha256: Sha256;
  readonly mediaKind: MediaKind;
  readonly page: number | null;
  readonly mediaCapabilityHandleSha256: Sha256;
  readonly oracleCapabilityHandleSha256: Sha256;
  readonly mediaSha256: Sha256;
  readonly oracleSha256: Sha256;
  readonly actualNormalizedOutputSha256: Sha256;
  readonly expectedNormalizedTruthSha256: Sha256;
  readonly expectedAnchorSetSha256: Sha256;
  readonly cer: number;
  readonly anchorOmissions: number;
  readonly cerThreshold: number;
  readonly outcome: 'passed' | 'failed';
  readonly projectionSha256: Sha256;
  readonly artifactId: Sha256;
}

export interface ConsumerSemanticResultV1 {
  readonly schemaVersion: 'ConsumerSemanticResultV1';
  readonly contractVersion: '1';
  readonly contractSha256: Sha256;
  readonly consumer: string;
  readonly parentGate: ParentGate;
  readonly tier: Tier;
  readonly sequenceIndex: number;
  readonly childKey: string;
  readonly legId: string;
  readonly childId: Sha256;
  readonly artifactIds: readonly Sha256[];
  readonly fixtureResults: readonly SemanticFixtureResult[];
  readonly semanticResultSha256: Sha256;
}

export interface ProducerCleanup {
  readonly journalState: 'terminal';
  readonly reconcileRefSha256: Sha256;
  readonly generation: number;
  readonly automaticAttempts: number;
  readonly rootReaped: true;
  readonly descendantsTerminated: true;
  readonly listenersReleased: true;
  readonly stagingReleased: true;
  readonly captureDeleted: true;
  readonly modelMemoryReleased: true;
  readonly processesAbsent: true;
  readonly listenersAbsent: true;
  readonly stagingAbsent: true;
  readonly proofSha256: Sha256;
}

export interface PrivacyFlags {
  readonly rawOcr: false;
  readonly rawTruth: false;
  readonly rawMedia: false;
  readonly tokens: false;
  readonly paths: false;
  readonly nativeIds: false;
}

export interface WireFixtureResult extends SemanticFixtureResult {
  readonly normalization: 'nfkc-whitespace-v1';
  readonly distance: 'code-point-levenshtein-v1';
}

export interface AcceptanceChildWireV1 {
  readonly schemaVersion: 'AcceptanceChildWireV1';
  readonly contractVersion: '1';
  readonly contractSha256: Sha256;
  readonly producer: 'capture-runtime';
  readonly parentGate: ParentGate;
  readonly tier: Tier;
  readonly runIdDigest: Sha256;
  readonly sequenceIndex: number;
  readonly childKey: string;
  readonly legId: string;
  readonly childId: Sha256;
  readonly root: Sha256;
  readonly artifactIds: readonly Sha256[];
  readonly ledgerBinding: WireLedgerBinding;
  readonly invocationSha256: Sha256;
  readonly fixtureAssignments: readonly FixtureAssignment[];
  readonly fixtureResults: readonly WireFixtureResult[];
  readonly childSemanticResultSha256: Sha256;
  readonly producerCleanup: ProducerCleanup;
  readonly privacy: PrivacyFlags;
  readonly wireSha256: Sha256;
}

export class AcceptanceContractCodecError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AcceptanceContractCodecError';
  }
}

export class CapabilityReplayError extends AcceptanceContractCodecError {
  public constructor(handleDigest: Sha256) {
    super(`Acceptance capability was already consumed: ${handleDigest}`);
    this.name = 'CapabilityReplayError';
  }
}

export class CapabilityNotIssuedError extends AcceptanceContractCodecError {
  public constructor(handleDigest: Sha256) {
    super(`Acceptance capability was not issued: ${handleDigest}`);
    this.name = 'CapabilityNotIssuedError';
  }
}

export interface CapabilityUseContext {
  readonly childId: Sha256;
  readonly legId: string;
  readonly parentGate: ParentGate;
  readonly invocationSha256: Sha256;
}

interface IssuedCapability {
  readonly context: CapabilityUseContext;
  consumed: boolean;
}

/**
 * Synthetic in-memory seam for codec tests. Production issuance, revocation,
 * persistence, and atomic resolver consumption remain outside D2.3.
 */
export class CapabilityUseRegistry {
  #issued = new Map<Sha256, IssuedCapability>();

  public issue(handleDigest: Sha256, context: CapabilityUseContext): void {
    const digest = assertSha256(handleDigest, 'capability handle digest');
    const expectedContext = capabilityUseContext(context, 'capability context');
    if (this.#issued.has(digest)) {
      throw new AcceptanceContractCodecError(`Acceptance capability was already issued: ${digest}`);
    }
    this.#issued.set(digest, { context: expectedContext, consumed: false });
  }

  public consume(handleDigest: Sha256, context: CapabilityUseContext): void {
    const digest = assertSha256(handleDigest, 'capability handle digest');
    const issued = this.#issued.get(digest);
    if (issued === undefined) {
      throw new CapabilityNotIssuedError(digest);
    }
    const expectedContext = capabilityUseContext(context, 'capability context');
    if (!sameCapabilityContext(issued.context, expectedContext)) {
      fail('acceptance capability context does not match issuance');
    }
    if (issued.consumed) {
      throw new CapabilityReplayError(digest);
    }
    issued.consumed = true;
  }

  public isConsumed(handleDigest: Sha256, context: CapabilityUseContext): boolean {
    const digest = assertSha256(handleDigest, 'capability handle digest');
    const issued = this.#issued.get(digest);
    if (issued === undefined) {
      throw new CapabilityNotIssuedError(digest);
    }
    const expectedContext = capabilityUseContext(context, 'capability context');
    if (!sameCapabilityContext(issued.context, expectedContext)) {
      fail('acceptance capability context does not match issuance');
    }
    return issued.consumed;
  }
}

const SCOPE_BASE_KEYS = [
  'schemaVersion',
  'contractVersion',
  'contractSha256',
  'producer',
  'parentGate',
  'tier',
  'runIdDigest',
  'sequenceIndex',
  'childKey',
  'legId',
  'childId',
  'childPlanDigest',
  'readyState',
  'binding',
] as const;

const INVOCATION_KEYS = [
  'schemaVersion',
  'contractVersion',
  'contractSha256',
  'producer',
  'parentGate',
  'tier',
  'invocationState',
  'sequenceIndex',
  'childKey',
  'legId',
  'childId',
  'root',
  'groupRefDigest',
  'groupGeneration',
  'bindingAttemptId',
  'rootBindings',
  'activationReceiptDigest',
  'artifactIds',
  'ledgerBinding',
  'predecessorCleanupProofSha256',
  'fixtureAssignments',
  'outputPathNonce',
  'invocationSha256',
] as const;

const SEMANTIC_KEYS = [
  'schemaVersion',
  'contractVersion',
  'contractSha256',
  'consumer',
  'parentGate',
  'tier',
  'sequenceIndex',
  'childKey',
  'legId',
  'childId',
  'artifactIds',
  'fixtureResults',
  'semanticResultSha256',
] as const;

const WIRE_KEYS = [
  'schemaVersion',
  'contractVersion',
  'contractSha256',
  'producer',
  'parentGate',
  'tier',
  'runIdDigest',
  'sequenceIndex',
  'childKey',
  'legId',
  'childId',
  'root',
  'artifactIds',
  'ledgerBinding',
  'invocationSha256',
  'fixtureAssignments',
  'fixtureResults',
  'childSemanticResultSha256',
  'producerCleanup',
  'privacy',
  'wireSha256',
] as const;

const ROOT_BINDING_KEYS = [
  'ordinal',
  'role',
  'rootRefDigest',
  'rootGeneration',
  'specDigest',
  'reservedListenerIdentity',
] as const;

const EXPECTED_BINDING_KEYS = [
  'bindingAttemptId',
  'groupRefDigest',
  'groupGeneration',
  'rootBindings',
  'activationReceiptDigest',
] as const;

const FIXTURE_ASSIGNMENT_KEYS = [
  'fixtureIndex',
  'fixtureKey',
  'fixtureIdentitySha256',
  'mediaKind',
  'page',
  'mediaCapabilityHandle',
  'mediaCapabilityHandleSha256',
  'oracleCapabilityHandle',
  'oracleCapabilityHandleSha256',
  'mediaSha256',
  'oracleSha256',
  'expectedNormalizedTruthSha256',
  'expectedAnchorSetSha256',
  'cerThreshold',
  'artifactId',
] as const;

const SEMANTIC_RESULT_KEYS = [
  'fixtureIndex',
  'fixtureKey',
  'fixtureIdentitySha256',
  'mediaKind',
  'page',
  'mediaCapabilityHandleSha256',
  'oracleCapabilityHandleSha256',
  'mediaSha256',
  'oracleSha256',
  'actualNormalizedOutputSha256',
  'expectedNormalizedTruthSha256',
  'expectedAnchorSetSha256',
  'cer',
  'anchorOmissions',
  'cerThreshold',
  'outcome',
  'projectionSha256',
  'artifactId',
] as const;

const WIRE_RESULT_KEYS = [
  ...SEMANTIC_RESULT_KEYS,
  'normalization',
  'distance',
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

type JsonRecord = Record<string, unknown>;
type Decoder<T> = (value: unknown) => T;

function fail(message: string): never {
  throw new AcceptanceContractCodecError(message);
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail(`${context} has an unknown or missing field`);
  }
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  return value;
}

function opaque(value: unknown, context: string): string {
  const result = stringValue(value, context);
  if (!OPAQUE_PATTERN.test(result)) {
    fail(`${context} must be an opaque value`);
  }
  return result;
}

function assertSha256(value: unknown, context: string): Sha256 {
  const result = stringValue(value, context);
  if (!SHA256_PATTERN.test(result)) {
    fail(`${context} must be lowercase SHA-256`);
  }
  return result;
}

function integer(value: unknown, context: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    fail(`${context} must be an integer >= ${minimum}`);
  }
  return value;
}

function ratio(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${context} must be a finite ratio`);
  }
  return value;
}

function arrayValue(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${context} must be a non-empty array`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${context} has an invalid value`);
  }
  return value as T;
}

function pageValue(value: unknown, mediaKind: MediaKind, context: string): number | null {
  if (value === null) {
    if (mediaKind !== 'jpeg') {
      fail(`${context} requires a PDF page`);
    }
    return null;
  }
  const page = integer(value, context, 1);
  if (mediaKind !== 'pdf') {
    fail(`${context} must be null for JPEG`);
  }
  return page;
}

function uniqueDigests(values: readonly Sha256[], context: string): readonly Sha256[] {
  if (new Set(values).size !== values.length) {
    fail(`${context} must contain unique digests`);
  }
  return values;
}

function rootBindings(value: unknown, context: string): readonly RootBinding[] {
  const values = arrayValue(value, context).map((item, index) => {
    const itemValue = record(item, `${context}[${index}]`);
    exactKeys(itemValue, ROOT_BINDING_KEYS, `${context}[${index}]`);
    return {
      ordinal: integer(itemValue.ordinal, `${context}[${index}].ordinal`),
      role: stringValue(itemValue.role, `${context}[${index}].role`),
      rootRefDigest: assertSha256(itemValue.rootRefDigest, `${context}[${index}].rootRefDigest`),
      rootGeneration: integer(
        itemValue.rootGeneration,
        `${context}[${index}].rootGeneration`,
      ),
      specDigest: assertSha256(itemValue.specDigest, `${context}[${index}].specDigest`),
      reservedListenerIdentity: opaque(
        itemValue.reservedListenerIdentity,
        `${context}[${index}].reservedListenerIdentity`,
      ),
    } satisfies RootBinding;
  });
  const seenRoles = new Set<string>();
  const seenRoots = new Set<Sha256>();
  values.forEach((item, index) => {
    if (item.ordinal !== index) {
      fail(`${context} must be complete and ordered`);
    }
    if (seenRoles.has(item.role) || seenRoots.has(item.rootRefDigest)) {
      fail(`${context} must not repeat a root`);
    }
    seenRoles.add(item.role);
    seenRoots.add(item.rootRefDigest);
  });
  return values;
}

function expectedBindingContext(
  value: ExpectedBindingContext,
  context: string,
): ExpectedBindingContext {
  const item = record(value, context);
  exactKeys(item, EXPECTED_BINDING_KEYS, context);
  return {
    bindingAttemptId: opaque(item.bindingAttemptId, `${context}.bindingAttemptId`),
    groupRefDigest: assertSha256(item.groupRefDigest, `${context}.groupRefDigest`),
    groupGeneration: integer(item.groupGeneration, `${context}.groupGeneration`),
    rootBindings: rootBindings(item.rootBindings, `${context}.rootBindings`),
    activationReceiptDigest: assertSha256(
      item.activationReceiptDigest,
      `${context}.activationReceiptDigest`,
    ),
  };
}

function assertBindingMatches(
  actual: Extract<Binding, { readonly kind: 'bound' }>,
  expected: ExpectedBindingContext,
  context: string,
): void {
  const expectedValue = expectedBindingContext(expected, `${context}.expected`);
  if (
    actual.bindingAttemptId !== expectedValue.bindingAttemptId ||
    actual.groupRefDigest !== expectedValue.groupRefDigest ||
    actual.groupGeneration !== expectedValue.groupGeneration ||
    actual.activationReceiptDigest !== expectedValue.activationReceiptDigest ||
    actual.rootBindings.length !== expectedValue.rootBindings.length ||
    actual.rootBindings.some((item, index) => {
      const expectedItem = expectedValue.rootBindings[index];
      return (
        expectedItem === undefined ||
        item.ordinal !== expectedItem.ordinal ||
        item.role !== expectedItem.role ||
        item.rootRefDigest !== expectedItem.rootRefDigest ||
        item.rootGeneration !== expectedItem.rootGeneration ||
        item.specDigest !== expectedItem.specDigest ||
        item.reservedListenerIdentity !== expectedItem.reservedListenerIdentity
      );
    })
  ) {
    fail(`${context} does not match the expected complete immutable binding`);
  }
}

function capabilityUseContext(value: CapabilityUseContext, context: string): CapabilityUseContext {
  const item = record(value, context);
  exactKeys(item, ['childId', 'legId', 'parentGate', 'invocationSha256'], context);
  return {
    childId: assertSha256(item.childId, `${context}.childId`),
    legId: stringValue(item.legId, `${context}.legId`),
    parentGate: enumValue(item.parentGate, ['D4', 'D7'] as const, `${context}.parentGate`),
    invocationSha256: assertSha256(item.invocationSha256, `${context}.invocationSha256`),
  };
}

function sameCapabilityContext(left: CapabilityUseContext, right: CapabilityUseContext): boolean {
  return (
    left.childId === right.childId &&
    left.legId === right.legId &&
    left.parentGate === right.parentGate &&
    left.invocationSha256 === right.invocationSha256
  );
}

function binding(value: unknown, context: string): Binding {
  const item = record(value, context);
  const kind = enumValue(item.kind, ['unbound', 'bound'] as const, `${context}.kind`);
  if (kind === 'unbound') {
    exactKeys(item, ['kind'], context);
    return { kind };
  }
  exactKeys(
    item,
    [
      'kind',
      'bindingAttemptId',
      'groupRefDigest',
      'groupGeneration',
      'rootBindings',
      'activationReceiptDigest',
    ],
    context,
  );
  return {
    kind,
    bindingAttemptId: opaque(item.bindingAttemptId, `${context}.bindingAttemptId`),
    groupRefDigest: assertSha256(item.groupRefDigest, `${context}.groupRefDigest`),
    groupGeneration: integer(item.groupGeneration, `${context}.groupGeneration`),
    rootBindings: rootBindings(item.rootBindings, `${context}.rootBindings`),
    activationReceiptDigest: assertSha256(
      item.activationReceiptDigest,
      `${context}.activationReceiptDigest`,
    ),
  };
}

function baseScope(value: JsonRecord, context: string): Omit<PlannedChildScopeV1, 'readyState' | 'binding'> {
  if (value.schemaVersion !== 'ProducerChildScopeV1' || value.contractVersion !== '1') {
    fail(`${context} has an invalid schema version`);
  }
  if (value.producer !== 'capture-runtime') {
    fail(`${context}.producer is invalid`);
  }
  const parentGate = enumValue(value.parentGate, ['D4', 'D7'] as const, `${context}.parentGate`);
  const tier = enumValue(value.tier, ['candidate', 'published'] as const, `${context}.tier`);
  assertGateTier(parentGate, tier, context);
  return {
    schemaVersion: 'ProducerChildScopeV1',
    contractVersion: '1',
    contractSha256: assertSha256(value.contractSha256, `${context}.contractSha256`),
    producer: 'capture-runtime',
    parentGate,
    tier,
    runIdDigest: assertSha256(value.runIdDigest, `${context}.runIdDigest`),
    sequenceIndex: integer(value.sequenceIndex, `${context}.sequenceIndex`, 1),
    childKey: stringValue(value.childKey, `${context}.childKey`),
    legId: stringValue(value.legId, `${context}.legId`),
    childId: assertSha256(value.childId, `${context}.childId`),
    childPlanDigest: assertSha256(value.childPlanDigest, `${context}.childPlanDigest`),
  };
}

function fixtureAssignment(value: unknown, context: string): FixtureAssignment {
  const item = record(value, context);
  exactKeys(item, FIXTURE_ASSIGNMENT_KEYS, context);
  const mediaKind = enumValue(item.mediaKind, ['jpeg', 'pdf'] as const, `${context}.mediaKind`);
  const result = {
    fixtureIndex: integer(item.fixtureIndex, `${context}.fixtureIndex`),
    fixtureKey: stringValue(item.fixtureKey, `${context}.fixtureKey`),
    fixtureIdentitySha256: assertSha256(
      item.fixtureIdentitySha256,
      `${context}.fixtureIdentitySha256`,
    ),
    mediaKind,
    page: pageValue(item.page, mediaKind, `${context}.page`),
    mediaCapabilityHandle: opaque(
      item.mediaCapabilityHandle,
      `${context}.mediaCapabilityHandle`,
    ),
    mediaCapabilityHandleSha256: assertSha256(
      item.mediaCapabilityHandleSha256,
      `${context}.mediaCapabilityHandleSha256`,
    ),
    oracleCapabilityHandle: opaque(
      item.oracleCapabilityHandle,
      `${context}.oracleCapabilityHandle`,
    ),
    oracleCapabilityHandleSha256: assertSha256(
      item.oracleCapabilityHandleSha256,
      `${context}.oracleCapabilityHandleSha256`,
    ),
    mediaSha256: assertSha256(item.mediaSha256, `${context}.mediaSha256`),
    oracleSha256: assertSha256(item.oracleSha256, `${context}.oracleSha256`),
    expectedNormalizedTruthSha256: assertSha256(
      item.expectedNormalizedTruthSha256,
      `${context}.expectedNormalizedTruthSha256`,
    ),
    expectedAnchorSetSha256: assertSha256(
      item.expectedAnchorSetSha256,
      `${context}.expectedAnchorSetSha256`,
    ),
    cerThreshold: ratio(item.cerThreshold, `${context}.cerThreshold`),
    artifactId: assertSha256(item.artifactId, `${context}.artifactId`),
  } satisfies FixtureAssignment;
  if (selfExcludedDigest(item, 'fixtureIdentitySha256') !== result.fixtureIdentitySha256) {
    fail(`${context}.fixtureIdentitySha256 does not match canonical assignment identity`);
  }
  return result;
}

function orderedAssignments(value: unknown, context: string): readonly FixtureAssignment[] {
  const values = arrayValue(value, context).map((item, index) =>
    fixtureAssignment(item, `${context}[${index}]`),
  );
  const keys = new Set<string>();
  values.forEach((item, index) => {
    if (item.fixtureIndex !== index || keys.has(item.fixtureKey)) {
      fail(`${context} must be complete, ordered, and unique`);
    }
    keys.add(item.fixtureKey);
  });
  return values;
}

function ledgerBinding(value: unknown, context: string): LedgerBinding {
  const item = record(value, context);
  const sourceGate = enumValue(item.sourceGate, ['D3', 'D6'] as const, `${context}.sourceGate`);
  if (sourceGate === 'D3') {
    exactKeys(item, ['sourceGate', 'ledgerSha256', 'candidateId', 'candidateManifestSha256'], context);
    return {
      sourceGate,
      ledgerSha256: assertSha256(item.ledgerSha256, `${context}.ledgerSha256`),
      candidateId: assertSha256(item.candidateId, `${context}.candidateId`),
      candidateManifestSha256: assertSha256(
        item.candidateManifestSha256,
        `${context}.candidateManifestSha256`,
      ),
    };
  }
  exactKeys(item, ['sourceGate', 'ledgerSha256', 'publicationLedgerSha256', 'downloadBundleSha256'], context);
  return {
    sourceGate,
    ledgerSha256: assertSha256(item.ledgerSha256, `${context}.ledgerSha256`),
    publicationLedgerSha256: assertSha256(
      item.publicationLedgerSha256,
      `${context}.publicationLedgerSha256`,
    ),
    downloadBundleSha256: assertSha256(
      item.downloadBundleSha256,
      `${context}.downloadBundleSha256`,
    ),
  };
}

function artifactDigests(value: unknown, context: string): readonly ArtifactDigest[] {
  const values = arrayValue(value, context).map((entry, index) => {
    const item = record(entry, `${context}[${index}]`);
    exactKeys(item, ['artifactKey', 'sha256'], `${context}[${index}]`);
    return {
      artifactKey: opaque(item.artifactKey, `${context}[${index}].artifactKey`),
      sha256: assertSha256(item.sha256, `${context}[${index}].sha256`),
    } satisfies ArtifactDigest;
  });
  values.forEach((item, index) => {
    if (index > 0 && values[index - 1].artifactKey >= item.artifactKey) {
      fail(`${context} must be sorted by unique artifactKey`);
    }
  });
  return values;
}

function wireLedgerBinding(value: unknown, context: string): WireLedgerBinding {
  const item = record(value, context);
  const sourceGate = enumValue(item.sourceGate, ['D3', 'D6'] as const, `${context}.sourceGate`);
  if (sourceGate === 'D3') {
    exactKeys(
      item,
      ['sourceGate', 'ledgerSha256', 'candidateId', 'candidateManifestSha256', 'artifactDigests'],
      context,
    );
    return {
      sourceGate,
      ledgerSha256: assertSha256(item.ledgerSha256, `${context}.ledgerSha256`),
      candidateId: assertSha256(item.candidateId, `${context}.candidateId`),
      candidateManifestSha256: assertSha256(
        item.candidateManifestSha256,
        `${context}.candidateManifestSha256`,
      ),
      artifactDigests: artifactDigests(item.artifactDigests, `${context}.artifactDigests`),
    };
  }
  exactKeys(
    item,
    ['sourceGate', 'ledgerSha256', 'publicationLedgerSha256', 'downloadBundleSha256', 'artifactDigests'],
    context,
  );
  return {
    sourceGate,
    ledgerSha256: assertSha256(item.ledgerSha256, `${context}.ledgerSha256`),
    publicationLedgerSha256: assertSha256(
      item.publicationLedgerSha256,
      `${context}.publicationLedgerSha256`,
    ),
    downloadBundleSha256: assertSha256(
      item.downloadBundleSha256,
      `${context}.downloadBundleSha256`,
    ),
    artifactDigests: artifactDigests(item.artifactDigests, `${context}.artifactDigests`),
  };
}

function assertGateTier(parentGate: ParentGate, tier: Tier, context: string): void {
  if ((parentGate === 'D4' && tier !== 'candidate') || (parentGate === 'D7' && tier !== 'published')) {
    fail(`${context} has an incompatible gate and tier`);
  }
}

function parseJson(input: string | Uint8Array): { text: string; value: unknown } {
  if (
    typeof input !== 'string' &&
    input.length >= 3 &&
    input[0] === 0xef &&
    input[1] === 0xbb &&
    input[2] === 0xbf
  ) {
    fail('record JSON must not contain a UTF-8 BOM');
  }
  let text: string;
  try {
    text =
      typeof input === 'string'
        ? input
        : new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new AcceptanceContractCodecError('record is not valid UTF-8');
  }
  if (text.startsWith('\uFEFF')) {
    fail('record JSON must not contain a UTF-8 BOM');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AcceptanceContractCodecError('record is not valid JSON');
  }
  if (canonicalJson(value) !== text) {
    fail('record JSON is not canonical');
  }
  return { text, value };
}

export function canonicalJson(value: unknown): string {
  try {
    return canonicalJsonValue(value, new Set<object>());
  } catch (error) {
    if (error instanceof AcceptanceContractCodecError) {
      throw error;
    }
    throw new AcceptanceContractCodecError('value is not strict JSON');
  }
}

function canonicalJsonValue(value: unknown, stack: Set<object>): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    fail('canonical JSON cannot contain this value type');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('canonical JSON cannot contain a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || stack.has(value)) {
      fail('canonical JSON arrays must be plain and acyclic');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== value.length + 1 ||
      !ownKeys.includes('length') ||
      ownKeys.some(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' || !/^\d+$/u.test(key) || Number(key) >= value.length),
      )
    ) {
      fail('canonical JSON arrays must be dense and have no extra keys');
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        fail('canonical JSON arrays cannot contain accessors or holes');
      }
    }
    stack.add(value);
    const encoded = `[${value.map((item) => canonicalJsonValue(item, stack)).join(',')}]`;
    stack.delete(value);
    return encoded;
  }
  const object = record(value, 'canonical JSON value');
  if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) {
    fail('canonical JSON objects must be plain');
  }
  if (stack.has(object)) {
    fail('canonical JSON cannot contain cycles');
  }
  const keys = Reflect.ownKeys(object);
  if (keys.some((key) => typeof key !== 'string')) {
    fail('canonical JSON objects cannot contain symbol keys');
  }
  const stringKeys = keys as string[];
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail('canonical JSON objects cannot contain accessors or hidden keys');
    }
  }
  stack.add(object);
  const encoded = `{${stringKeys
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(object[key], stack)}`)
    .join(',')}}`;
  stack.delete(object);
  return encoded;
}

/** Internal record/self-digest helper; D3 hash and manifest delivery remain deferred. */
export function sha256Canonical(value: unknown): Sha256 {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function selfExcludedDigest(value: JsonRecord, field: string): Sha256 {
  const copy = { ...value };
  delete copy[field];
  return sha256Canonical(copy);
}

function decodeCanonical<T>(input: string | Uint8Array, decoder: Decoder<T>): T {
  return decoder(parseJson(input).value);
}

export function encodeCanonicalRecord(value: unknown): string {
  return canonicalJson(value);
}

export function decodeProducerChildScope(
  input: string | Uint8Array,
  expectedBinding?: ExpectedBindingContext,
): ProducerChildScopeV1 {
  return decodeCanonical(input, (value) => decodeProducerChildScopeValue(value, expectedBinding));
}

function decodeProducerChildScopeValue(
  value: unknown,
  expectedBinding?: ExpectedBindingContext,
): ProducerChildScopeV1 {
  const item = record(value, 'ProducerChildScopeV1');
  const base = baseScope(item, 'ProducerChildScopeV1');
  const readyState = enumValue(item.readyState, ['planned', 'prepared', 'ready'] as const, 'scope.readyState');
  if (readyState === 'planned') {
    exactKeys(item, SCOPE_BASE_KEYS, 'ProducerChildScopeV1');
    const scopeBinding = binding(item.binding, 'scope.binding');
    if (scopeBinding.kind !== 'unbound') {
      fail('planned scope must use the unbound binding');
    }
    return { ...base, readyState, binding: scopeBinding };
  }
  if (readyState === 'prepared') {
    exactKeys(item, SCOPE_BASE_KEYS, 'ProducerChildScopeV1');
    const scopeBinding = binding(item.binding, 'scope.binding');
    if (scopeBinding.kind !== 'bound') {
      fail('prepared scope must use the bound binding');
    }
    if (expectedBinding === undefined) {
      fail('prepared scope requires an expected immutable binding context');
    }
    assertBindingMatches(scopeBinding, expectedBinding, 'prepared scope.binding');
    return { ...base, readyState, binding: scopeBinding };
  }
  exactKeys(item, [...SCOPE_BASE_KEYS, 'invocationSha256', 'outputPathNonce'], 'ProducerChildScopeV1');
  const scopeBinding = binding(item.binding, 'scope.binding');
  if (scopeBinding.kind !== 'bound') {
    fail('ready scope must use the bound binding');
  }
  if (expectedBinding === undefined) {
    fail('ready scope requires an expected immutable binding context');
  }
  assertBindingMatches(scopeBinding, expectedBinding, 'ready scope.binding');
  const scope = {
    ...base,
    readyState,
    binding: scopeBinding,
    invocationSha256: assertSha256(item.invocationSha256, 'scope.invocationSha256'),
    outputPathNonce: opaque(item.outputPathNonce, 'scope.outputPathNonce'),
  };
  return scope;
}

export function decodeProducerChildInvocation(
  input: string | Uint8Array,
  expectedBinding?: ExpectedBindingContext,
): ProducerChildInvocationV1 {
  return decodeCanonical(input, (value) => decodeProducerChildInvocationValue(value, expectedBinding));
}

function decodeProducerChildInvocationValue(
  value: unknown,
  expectedBinding?: ExpectedBindingContext,
): ProducerChildInvocationV1 {
  const item = record(value, 'ProducerChildInvocationV1');
  exactKeys(item, INVOCATION_KEYS, 'ProducerChildInvocationV1');
  if (item.schemaVersion !== 'ProducerChildInvocationV1' || item.contractVersion !== '1') {
    fail('invocation schema version is invalid');
  }
  if (item.producer !== 'capture-runtime' || item.invocationState !== 'frozen') {
    fail('invocation producer or state is invalid');
  }
  const parentGate = enumValue(item.parentGate, ['D4', 'D7'] as const, 'invocation.parentGate');
  const tier = enumValue(item.tier, ['candidate', 'published'] as const, 'invocation.tier');
  assertGateTier(parentGate, tier, 'invocation');
  if (expectedBinding === undefined) {
    fail('invocation requires an expected immutable binding context');
  }
  const result = {
    schemaVersion: 'ProducerChildInvocationV1' as const,
    contractVersion: '1' as const,
    contractSha256: assertSha256(item.contractSha256, 'invocation.contractSha256'),
    producer: 'capture-runtime' as const,
    parentGate,
    tier,
    invocationState: 'frozen' as const,
    sequenceIndex: integer(item.sequenceIndex, 'invocation.sequenceIndex', 1),
    childKey: stringValue(item.childKey, 'invocation.childKey'),
    legId: stringValue(item.legId, 'invocation.legId'),
    childId: assertSha256(item.childId, 'invocation.childId'),
    root: assertSha256(item.root, 'invocation.root'),
    groupRefDigest: assertSha256(item.groupRefDigest, 'invocation.groupRefDigest'),
    groupGeneration: integer(item.groupGeneration, 'invocation.groupGeneration'),
    bindingAttemptId: opaque(item.bindingAttemptId, 'invocation.bindingAttemptId'),
    rootBindings: rootBindings(item.rootBindings, 'invocation.rootBindings'),
    activationReceiptDigest: assertSha256(
      item.activationReceiptDigest,
      'invocation.activationReceiptDigest',
    ),
    artifactIds: uniqueDigests(
      arrayValue(item.artifactIds, 'invocation.artifactIds').map((entry, index) =>
        assertSha256(entry, `invocation.artifactIds[${index}]`),
      ),
      'invocation.artifactIds',
    ),
    ledgerBinding: ledgerBinding(item.ledgerBinding, 'invocation.ledgerBinding'),
    predecessorCleanupProofSha256:
      item.predecessorCleanupProofSha256 === null
        ? null
        : assertSha256(item.predecessorCleanupProofSha256, 'invocation.predecessorCleanupProofSha256'),
    fixtureAssignments: orderedAssignments(item.fixtureAssignments, 'invocation.fixtureAssignments'),
    outputPathNonce: opaque(item.outputPathNonce, 'invocation.outputPathNonce'),
    invocationSha256: assertSha256(item.invocationSha256, 'invocation.invocationSha256'),
  } satisfies ProducerChildInvocationV1;
  if (result.ledgerBinding.sourceGate !== (parentGate === 'D4' ? 'D3' : 'D6')) {
    fail('invocation ledger binding does not match its gate');
  }
  assertBindingMatches(
    {
      kind: 'bound',
      bindingAttemptId: result.bindingAttemptId,
      groupRefDigest: result.groupRefDigest,
      groupGeneration: result.groupGeneration,
      rootBindings: result.rootBindings,
      activationReceiptDigest: result.activationReceiptDigest,
    },
    expectedBinding,
    'invocation.binding',
  );
  if (selfExcludedDigest(item, 'invocationSha256') !== result.invocationSha256) {
    fail('invocation digest does not match canonical bytes');
  }
  return result;
}

function semanticFixtureResult(value: unknown, context: string): SemanticFixtureResult {
  const item = record(value, context);
  exactKeys(item, SEMANTIC_RESULT_KEYS, context);
  const mediaKind = enumValue(item.mediaKind, ['jpeg', 'pdf'] as const, `${context}.mediaKind`);
  return {
    fixtureIndex: integer(item.fixtureIndex, `${context}.fixtureIndex`),
    fixtureKey: stringValue(item.fixtureKey, `${context}.fixtureKey`),
    fixtureIdentitySha256: assertSha256(item.fixtureIdentitySha256, `${context}.fixtureIdentitySha256`),
    mediaKind,
    page: pageValue(item.page, mediaKind, `${context}.page`),
    mediaCapabilityHandleSha256: assertSha256(
      item.mediaCapabilityHandleSha256,
      `${context}.mediaCapabilityHandleSha256`,
    ),
    oracleCapabilityHandleSha256: assertSha256(
      item.oracleCapabilityHandleSha256,
      `${context}.oracleCapabilityHandleSha256`,
    ),
    mediaSha256: assertSha256(item.mediaSha256, `${context}.mediaSha256`),
    oracleSha256: assertSha256(item.oracleSha256, `${context}.oracleSha256`),
    actualNormalizedOutputSha256: assertSha256(
      item.actualNormalizedOutputSha256,
      `${context}.actualNormalizedOutputSha256`,
    ),
    expectedNormalizedTruthSha256: assertSha256(
      item.expectedNormalizedTruthSha256,
      `${context}.expectedNormalizedTruthSha256`,
    ),
    expectedAnchorSetSha256: assertSha256(
      item.expectedAnchorSetSha256,
      `${context}.expectedAnchorSetSha256`,
    ),
    cer: ratio(item.cer, `${context}.cer`),
    anchorOmissions: integer(item.anchorOmissions, `${context}.anchorOmissions`),
    cerThreshold: ratio(item.cerThreshold, `${context}.cerThreshold`),
    outcome: enumValue(item.outcome, ['passed', 'failed'] as const, `${context}.outcome`),
    projectionSha256: assertSha256(item.projectionSha256, `${context}.projectionSha256`),
    artifactId: assertSha256(item.artifactId, `${context}.artifactId`),
  };
}

function orderedSemanticResults(value: unknown, context: string): readonly SemanticFixtureResult[] {
  const values = arrayValue(value, context).map((item, index) =>
    semanticFixtureResult(item, `${context}[${index}]`),
  );
  const keys = new Set<string>();
  values.forEach((item, index) => {
    if (item.fixtureIndex !== index || keys.has(item.fixtureKey)) {
      fail(`${context} must be complete, ordered, and unique`);
    }
    keys.add(item.fixtureKey);
  });
  return values;
}

export function decodeConsumerSemanticResult(input: string | Uint8Array): ConsumerSemanticResultV1 {
  return decodeCanonical(input, (value) => {
    const item = record(value, 'ConsumerSemanticResultV1');
    exactKeys(item, SEMANTIC_KEYS, 'ConsumerSemanticResultV1');
    if (item.schemaVersion !== 'ConsumerSemanticResultV1' || item.contractVersion !== '1') {
      fail('semantic result schema version is invalid');
    }
    const parentGate = enumValue(item.parentGate, ['D4', 'D7'] as const, 'semantic.parentGate');
    const tier = enumValue(item.tier, ['candidate', 'published'] as const, 'semantic.tier');
    assertGateTier(parentGate, tier, 'semantic result');
    const result = {
      schemaVersion: 'ConsumerSemanticResultV1' as const,
      contractVersion: '1' as const,
      contractSha256: assertSha256(item.contractSha256, 'semantic.contractSha256'),
      consumer: stringValue(item.consumer, 'semantic.consumer'),
      parentGate,
      tier,
      sequenceIndex: integer(item.sequenceIndex, 'semantic.sequenceIndex', 1),
      childKey: stringValue(item.childKey, 'semantic.childKey'),
      legId: stringValue(item.legId, 'semantic.legId'),
      childId: assertSha256(item.childId, 'semantic.childId'),
      artifactIds: uniqueDigests(
        arrayValue(item.artifactIds, 'semantic.artifactIds').map((entry, index) =>
          assertSha256(entry, `semantic.artifactIds[${index}]`),
        ),
        'semantic.artifactIds',
      ),
      fixtureResults: orderedSemanticResults(item.fixtureResults, 'semantic.fixtureResults'),
      semanticResultSha256: assertSha256(item.semanticResultSha256, 'semantic.semanticResultSha256'),
    } satisfies ConsumerSemanticResultV1;
    if (selfExcludedDigest(item, 'semanticResultSha256') !== result.semanticResultSha256) {
      fail('semantic result digest does not match canonical bytes');
    }
    const resultArtifacts = uniqueDigests(
      result.fixtureResults.map((fixture) => fixture.artifactId),
      'semantic fixture artifacts',
    );
    if (resultArtifacts.length !== result.artifactIds.length || resultArtifacts.some((id) => !result.artifactIds.includes(id))) {
      fail('semantic artifactIds must contain each fixture artifact exactly once');
    }
    return result;
  });
}

function producerCleanup(value: unknown, context: string): ProducerCleanup {
  const item = record(value, context);
  const keys = [
    'journalState',
    'reconcileRefSha256',
    'generation',
    'automaticAttempts',
    'rootReaped',
    'descendantsTerminated',
    'listenersReleased',
    'stagingReleased',
    'captureDeleted',
    'modelMemoryReleased',
    'processesAbsent',
    'listenersAbsent',
    'stagingAbsent',
    'proofSha256',
  ] as const;
  exactKeys(item, keys, context);
  keys.slice(4, 13).forEach((key) => {
    if (item[key] !== true) {
      fail(`${context}.${key} must be true`);
    }
  });
  return {
    journalState: enumValue(item.journalState, ['terminal'] as const, `${context}.journalState`),
    reconcileRefSha256: assertSha256(item.reconcileRefSha256, `${context}.reconcileRefSha256`),
    generation: integer(item.generation, `${context}.generation`),
    automaticAttempts: integer(item.automaticAttempts, `${context}.automaticAttempts`),
    rootReaped: true,
    descendantsTerminated: true,
    listenersReleased: true,
    stagingReleased: true,
    captureDeleted: true,
    modelMemoryReleased: true,
    processesAbsent: true,
    listenersAbsent: true,
    stagingAbsent: true,
    proofSha256: assertSha256(item.proofSha256, `${context}.proofSha256`),
  };
}

function privacy(value: unknown, context: string): PrivacyFlags {
  const item = record(value, context);
  const keys = ['rawOcr', 'rawTruth', 'rawMedia', 'tokens', 'paths', 'nativeIds'] as const;
  exactKeys(item, keys, context);
  keys.forEach((key) => {
    if (item[key] !== false) {
      fail(`${context}.${key} must be false`);
    }
  });
  return {
    rawOcr: false,
    rawTruth: false,
    rawMedia: false,
    tokens: false,
    paths: false,
    nativeIds: false,
  };
}

function wireFixtureResult(value: unknown, context: string): WireFixtureResult {
  const item = record(value, context);
  exactKeys(item, WIRE_RESULT_KEYS, context);
  const semanticValue = { ...item };
  delete semanticValue.normalization;
  delete semanticValue.distance;
  const result = semanticFixtureResult(semanticValue, context);
  return {
    ...result,
    normalization: enumValue(
      item.normalization,
      ['nfkc-whitespace-v1'] as const,
      `${context}.normalization`,
    ),
    distance: enumValue(
      item.distance,
      ['code-point-levenshtein-v1'] as const,
      `${context}.distance`,
    ),
  };
}

function orderedWireResults(value: unknown, context: string): readonly WireFixtureResult[] {
  const values = arrayValue(value, context).map((item, index) =>
    wireFixtureResult(item, `${context}[${index}]`),
  );
  const keys = new Set<string>();
  values.forEach((item, index) => {
    if (item.fixtureIndex !== index || keys.has(item.fixtureKey)) {
      fail(`${context} must be complete, ordered, and unique`);
    }
    keys.add(item.fixtureKey);
  });
  return values;
}

export function decodeAcceptanceChildWire(input: string | Uint8Array): AcceptanceChildWireV1 {
  return decodeCanonical(input, (value) => {
    const item = record(value, 'AcceptanceChildWireV1');
    exactKeys(item, WIRE_KEYS, 'AcceptanceChildWireV1');
    if (item.schemaVersion !== 'AcceptanceChildWireV1' || item.contractVersion !== '1') {
      fail('wire schema version is invalid');
    }
    if (item.producer !== 'capture-runtime') {
      fail('wire producer is invalid');
    }
    const parentGate = enumValue(item.parentGate, ['D4', 'D7'] as const, 'wire.parentGate');
    const tier = enumValue(item.tier, ['candidate', 'published'] as const, 'wire.tier');
    assertGateTier(parentGate, tier, 'wire');
    const assignments = orderedAssignments(item.fixtureAssignments, 'wire.fixtureAssignments');
    const results = orderedWireResults(item.fixtureResults, 'wire.fixtureResults');
    if (assignments.length !== results.length) {
      fail('wire assignment and result cardinality must match');
    }
    assignments.forEach((assignment, index) => {
      const result = results[index];
      if (
        assignment.fixtureIndex !== result.fixtureIndex ||
        assignment.fixtureKey !== result.fixtureKey ||
        assignment.fixtureIdentitySha256 !== result.fixtureIdentitySha256 ||
        assignment.mediaKind !== result.mediaKind ||
        assignment.page !== result.page ||
        assignment.mediaCapabilityHandleSha256 !== result.mediaCapabilityHandleSha256 ||
        assignment.oracleCapabilityHandleSha256 !== result.oracleCapabilityHandleSha256 ||
        assignment.mediaSha256 !== result.mediaSha256 ||
        assignment.oracleSha256 !== result.oracleSha256 ||
        assignment.expectedNormalizedTruthSha256 !== result.expectedNormalizedTruthSha256 ||
        assignment.expectedAnchorSetSha256 !== result.expectedAnchorSetSha256 ||
        assignment.cerThreshold !== result.cerThreshold ||
        assignment.artifactId !== result.artifactId
      ) {
        fail('wire fixture results must match assignments in order');
      }
    });
    const resultArtifacts = uniqueDigests(
      results.map((fixture) => fixture.artifactId),
      'wire fixture artifacts',
    );
    const artifactIds = uniqueDigests(
      arrayValue(item.artifactIds, 'wire.artifactIds').map((entry, index) =>
        assertSha256(entry, `wire.artifactIds[${index}]`),
      ),
      'wire.artifactIds',
    );
    if (resultArtifacts.length !== artifactIds.length || resultArtifacts.some((id) => !artifactIds.includes(id))) {
      fail('wire artifactIds must contain each fixture artifact exactly once');
    }
    const result = {
      schemaVersion: 'AcceptanceChildWireV1' as const,
      contractVersion: '1' as const,
      contractSha256: assertSha256(item.contractSha256, 'wire.contractSha256'),
      producer: 'capture-runtime' as const,
      parentGate,
      tier,
      runIdDigest: assertSha256(item.runIdDigest, 'wire.runIdDigest'),
      sequenceIndex: integer(item.sequenceIndex, 'wire.sequenceIndex', 1),
      childKey: stringValue(item.childKey, 'wire.childKey'),
      legId: stringValue(item.legId, 'wire.legId'),
      childId: assertSha256(item.childId, 'wire.childId'),
      root: assertSha256(item.root, 'wire.root'),
      artifactIds,
      ledgerBinding: wireLedgerBinding(item.ledgerBinding, 'wire.ledgerBinding'),
      invocationSha256: assertSha256(item.invocationSha256, 'wire.invocationSha256'),
      fixtureAssignments: assignments,
      fixtureResults: results,
      childSemanticResultSha256: assertSha256(
        item.childSemanticResultSha256,
        'wire.childSemanticResultSha256',
      ),
      producerCleanup: producerCleanup(item.producerCleanup, 'wire.producerCleanup'),
      privacy: privacy(item.privacy, 'wire.privacy'),
      wireSha256: assertSha256(item.wireSha256, 'wire.wireSha256'),
    } satisfies AcceptanceChildWireV1;
    if (result.ledgerBinding.sourceGate !== (parentGate === 'D4' ? 'D3' : 'D6')) {
      fail('wire ledger binding does not match its gate');
    }
    if (selfExcludedDigest(item, 'wireSha256') !== result.wireSha256) {
      fail('wire digest does not match canonical bytes');
    }
    return result;
  });
}
