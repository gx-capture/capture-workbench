# Decisions
Classify only after child close; never mutate the child journal or manifest.
Failure precedence is earliest stage, interruption, manifest, acceptance, then cleanup.
Outer cleanup is separate; exact PID identity uses creation/executable proof.
Use one canonical manifest/hash/proof reader; screenshots are ordinary evidence.
Phase 1 passes only when the terminal primary failure is null.
