# Phase 2 documentation review handoff

Administrative record, 2026-09-10. This index records accumulated review and
bounded finding closure. It does not supersede the normative SPEC, DECISION,
or executable TODO, grant implementation authorization, or advance a release
gate. The historical checkpoints in those documents retain their original
meaning. This administrative commit preserves their reviewed content and the
original evidence at its recorded heads; it is not a fresh D1 approval of its
own HEAD. Apply the canonical exact-head review rule before implementation.

## Repository entrypoints

Use sibling checkouts named `capture-workbench`, `cert-prep`, and `gx.law-prep`
under any common parent. The relative links below assume that layout. For
other layouts, map those repository names to the actual checkout roots and
retain the listed `.agents/` paths; no machine-specific checkout is required.

| Repository | Normative and executable entrypoints |
| --- | --- |
| Capture Workbench (producer) | [SPEC](../SPECS/capture-runtime-042-p2-hardening.md), [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md), [TODO](../TODOS/capture-runtime-042-p2-hardening.md), [worker guide](staged-ocr-delivery-workflow.md) |
| Cert Prep | [SPEC](../../../cert-prep/.agents/SPECS/capture-runtime-consumer.md), [DECISION](../../../cert-prep/.agents/DECISIONS/capture-runtime-consumer.md), [TODO](../../../cert-prep/.agents/TODOS/capture-runtime-consumer.md), [adoption guide](../../../cert-prep/.agents/GUIDES/staged-ocr-delivery-adoption.md) |
| GX Law Prep | [SPEC](../../../gx.law-prep/.agents/SPECS/capture-runtime-042-phase2-consumer.md), [DECISION](../../../gx.law-prep/.agents/DECISIONS/capture-runtime-042-phase2-consumer.md), [TODO](../../../gx.law-prep/.agents/TODOS/capture-runtime-042-phase2-consumer.md) |

## Evidence and review scope

The user accepted Phase 1 as completed real local-package OCR at the
`local-probe` tier, in Capture -> Cert -> LAW order. Formal Capture Runtime
0.4.2 release remains pending Phase 2. CI repairs remain paused.

The coordinating session reports repeated earlier Sol Ultra Standards and
Specification audits that failed and drove advisor amendments. The latest
independent Astra low read-only review of producer `e6eeabb` and LAW `019113`
reported three LAW blockers only. A separate review of Cert `81e467` reported
one legacy no-session branch blocker while approving the bounded producer R3
and acceptance seams. Fresh Astra fixes and independent bounded reviews closed
the three LAW findings at `1d5460` and the Cert finding at `3fc3e3`.

These are accumulated review plus bounded closure, not a complete final
dual-axis audit of every line across all three final heads. Review history is
reported from the coordinating session; this handoff writer verified the
repository heads and documentation, not a new independent design verdict.
The design work applied `codebase-design` and `grill-me`; this record preserves
that design and its resolved choices without repeating the workshop.

| Repository | Verified HEAD before this administrative commit | Worktree boundary |
| --- | --- | --- |
| Capture Workbench | `e6eeabb9b7eca4235292c6889fd4cf2f8a538819` | Only unrelated untracked `.github/copilot-instructions.md` and `.github/instructions/` |
| Cert Prep | `3fc3e3e46259b2c16bfbb109122761a2944962dd` | Clean |
| GX Law Prep | `1d5460db781159ecec605721c8ca56c69da3f043` | Clean |

## First executable slices and dependencies

Each slice remains subject to its canonical review/authorization prerequisites,
owner discovery, RED proof, resolved Nx targets, stop conditions, and separate
commit boundary. This handoff authorizes none of them.

| Repository | First implementation slice in its actual TODO |
| --- | --- |
| Capture | D2.1: upgrade Nx 23.1.0 to 23.1.2 in `package.json`/`pnpm-lock.yaml`, retain Node 24 and pnpm 12.0.0, and extend `tools/release/version-sources.ts` plus its existing test for the complete version/contract/channel inventory. |
| Cert | Slice 1: Nx 23.1.2 and canonical version inventory in the root package/lock and `tools/capture-runtime-version.mts` / `tools/capture-runtime-version-check.mts`, rejecting stale or mixed identity before candidate staging or pointer work. |
| LAW | After LAW-G0 documentation closure, item 1 generates the closed request/ACK/cancel/result/error schemas, four language codecs, shared semantic validator, and positive/negative vectors from the five canonical `contracts/*.contract.json` sources before consuming slices. Missing generator owners or targets require discovery/creation first. |

The producer journal and acceptance schema/codec synthetic foundation precedes
dependent lifecycle and acceptance adapters. LAW generation precedes its
receipt, Python, Java, Rust/Tauri, TypeScript, IPC, and acceptance consumers.
Cert and LAW consume the producer's exact acceptance package and generated
validator; neither creates a competing wire schema. D2 acceptance work is
schemas/codecs and synthetic RED/GREEN infrastructure only. D3 first constructs
the immutable package/bundle, semantic manifest, and byte ledger. A missing
package, generated symbol, or target is a discovery/creation stop.

## Remaining implementation and release milestones

- Bind runtime 0.4.2, API 2.0, document schema 2, projection schema 3, generated
  runtime contract identity, clients, native launcher, assets, model/profile/
  catalog/source locks, and release channels. Keep runtime `contractSetSha256`,
  acceptance `contractSha256`, and archive `acceptanceContractArchiveSha256`
  distinct and tied to exact bytes.
- Implement the chosen O1 OCR and R3 lifecycle seams. Producer-owned whole-group
  prepare/persist/read-back/verify must precede activation; recovery after loss
  of live ownership is observe-only. Prove model-memory release and exact
  journal/process/listener/staging cleanup before the next child.
- Verify GPU selection, including positively unavailable dGPU plus usable
  mapped iGPU selecting DirectML on iGPU. Indeterminate identity fails closed;
  selected DirectML failure cannot silently retry CPU or another GPU.
- D4 accepts externally supplied immutable D3 candidates without rebuilding,
  staging from source, or substituting mutable downloads. The proposed
  `acceptance-d3-candidate` target requires creation/discovery; existing local
  acceptance diagnostics do not establish D4.
- D4 and D7 run strictly sequentially: Capture private JPEG -> cleanup ->
  Capture original scanned PDF page 1 -> cleanup -> Cert -> cleanup -> LAW ->
  cleanup. JPEG CER must be <= 3%, PDF page-1 CER <= 1%, and every critical
  anchor must be present, per fixture. Stop at the first failed identity,
  semantic, or cleanup proof.
- D5 publishes the exact accepted bytes; D6 independently downloads and
  rehashes them; D7 repeats acceptance using only those downloads; D8 moves
  the stable pointer through a separate protected, CAS-guarded producer
  dispatch. No gate is established by this documentation task. Published-byte
  correction uses producer supersession, never overwrite or direct pointer
  reversal.

This handoff performs only repository/document checks and a narrow local
documentation commit. No implementation, test execution, CI action, OCR run,
candidate build, artifact publication, download-back acceptance, pointer
mutation, or push is performed. Its commit SHA is reported externally so the
record need not embed its own hash.
