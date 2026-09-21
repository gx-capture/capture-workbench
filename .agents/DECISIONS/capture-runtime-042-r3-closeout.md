# Public R3 closeout decisions

2026-09-21. Scope is defined by the
[slice specification](../SPECS/capture-runtime-042-r3-closeout.md).

- Change mode: edit. Existing owner: producer launcher and its tests. No new
  lifecycle coordinator is needed. Preserve pre-existing dirty work.
- Prefer completing and independently checking the public R3 seam before
  migrating hosts. Parallel host migration would depend on an unverified
  ownership interface; implementing consumer substitutes would duplicate
  producer policy. Both alternatives are deferred.
- Risk: high (public interface, native process ownership, filesystem cleanup,
  durable CAS). Require focused independent standards/specification review
  and a fresh post-repair review. Workers use GPT-6 Astra medium and fresh
  sessions per stage. Built-in worker thread capacity was exhausted after
  analysis; subsequent workers use fresh Codex CLI sessions with the same model
  and reasoning effort, without resuming the analysis sessions.
- Token posture: compact quality. Reviews name concrete failure scenarios,
  owner paths, and required regressions rather than restating the full plan.
- Verification floor: uncached launcher format/check/fixture/unit/public tests
  and desktop compile/test compatibility. Retain all ownership assertions.
- Stop on an unresolved cleanup/proof defect or changed scope. Do not call
  partial fixture success full R3 or release acceptance.
- Rollback: revert only this continuation's bounded edits; retain the original
  working-tree diff and unrelated files. No reset, broad staging, publication,
  or consumer version changes are authorized by this record.

## Root grill-me consultation and scheduling

The user requested at least 30 minutes for worker analysis before Root
schedules further implementation. Fresh Astra medium workers completed
read-only analysis in 30m40s (durable state) and 30m55s (fixtures), with
unchanged source hashes and HEAD. Root then checked the proposed repair
against the concrete adoption, failure-construction and fixture-admission
paths. The consultation resolved these questions:

| Question | Resolution |
| --- | --- |
| Is repairing only the final Terminal proof helper sufficient? | No. Confirm the exact retained candidate at the first successful durable read, before another budget check/read/admission. Cover Terminal, Closing and activation reconciliation, including Ready/Launching/Running adoption. |
| Does confirming persistence also grant live authority after timeout? | No. Retain confirmation in the owned error while still rejecting expired/cancelled authority. |
| Can every predecessor retry be rejected? | No. A genuinely ambiguous attempt may retry from its exact predecessor. A confirmed attempt must reject predecessor restoration with zero additional CAS. |
| What survives a subsequent prewrite failure? | The previous pending successor and its disposition. A new attempted successor supersedes it. A baseline Running/Closing record is not a pending successor. |
| Does four-thread or serial rerun success explain the public failure? | No. The original activation result was lost. Repair diagnostics and synchronization, then test controlled early failure and post-authorization cancellation separately. |
| Can fixture gates wait for every root authorization before releasing responses? | No. Sequential producer probing would deadlock. Preserve handles -> response gates -> silent-root authorization -> cancellation. |
| Who owns test admission? | One test-only permit owner, acquired before the intended scenario clock and transferred once. Preserve explicit budgeted-admission tests; no nested permit acquisition or production deadline changes. |
| Is serial success sufficient to advance? | The user explicitly answered no: standard Nx commands must pass the complete suite under bounded concurrency before the next stage. |

One fresh implementation worker owns the coupled state and fixture repairs
because both touch `process.rs`; Root owns documentation and scheduling. Keep
public APIs, journal schema and native/staging ownership unchanged. Changes
to fixture `main.rs` require a demonstrated fixture need. The `cargo-test`
target may set a finite thread bound only together with synchronization
repairs, not as their substitute. No bound is accepted solely because an
isolated rerun happened to pass.

Verification is declared before execution: deterministic regressions, launcher
format/check/fixture checks, then **three complete uncached standard Nx
launcher runs** at the selected bound, with no overlapping independent native
suites. Every failure is retained and blocks closeout; do not retry until
green. Run desktop compile/tests after source stabilizes, followed by a fresh
bounded review. Serial results remain diagnostic evidence. These checks do
not establish installed OCR, power-loss durability or release acceptance.

## Post-implementation evidence questions

Root retains the same grill-me approach: answer source-verifiable questions
from code and execution evidence, rather than asking the user to restate
existing requirements. Fresh reviewers separately challenge these answers.

- Did the concurrency setting alone repair the failure? No. Series A still
  failed with four threads. A delayed-request regression then reproduced a
  fixture socket defect; only after its repair was series B declared and
  completed three times. Earlier isolated passes remain diagnostic.
- Were deadlines extended to obtain green results? No production deadline
  changed. Test admission precedes the scenario clock, while explicit
  budgeted-admission and post-durable-read deadline regressions remain.
  Fixture request I/O retains its 250 ms limit and shared absolute deadline.
- Did correcting the listener-proof test remove a required guarantee?
  Terminalization already discarded the earlier listener snapshot in the
  baseline. The corrected assertion checks retained native/staging progress
  and the exact Terminal candidate's listener proof; adjacent tests retain
  listener-rebinding and no-repeat-staging-deletion checks.
- Can prewrite errors forget the previous candidate? The pending-successor
  helper retains that exact attempt and disposition, excluding ordinary
  Running/Closing baselines. Only a newer attempted CAS supersedes it.
- Does passing series B establish release readiness? No. The test bound is
  explicit, review is source/hash-bound, and the public RequestRef SDK,
  candidate ledger, consumer migration and formal acceptance remain separate.

The final review workers are fresh Astra medium sessions with a minimum
30-minute analysis window. Root performs desktop compatibility checks after
the launcher series completes and makes no source changes during review.

## Root closeout assessment (2026-09-21)

Both fresh reviews found no blocking findings: durable state ran
06:46:52-07:17:09 UTC (30m17s), and concurrency/fixtures ran
06:46:51-07:17:41 UTC (30m50s). Each verified all 18 source/config hashes
against the successful series-B manifest and the unchanged baseline HEAD.
Reviewers also examined Root's documentation-only evidence questions added
during the review. Their reports are retained with the execution evidence
listed in the [closeout TODO](../TODOS/capture-runtime-042-r3-closeout.md).

Root accepts the bounded implementation and local verification slice. The
user's standard-Nx bounded-concurrency requirement is satisfied by three
complete four-thread runs; desktop compilation and 53 tests also passed.
No further source repair is indicated by these reviews. Existing dirty work
is preserved, and no commit, push, candidate or publication was performed.
Public RequestRef lifecycle/SDK delivery, producer candidate construction,
consumer migration, and formal acceptance remain separate incomplete work.
