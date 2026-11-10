# capture-sidecar-launcher

Shared authenticated Capture Runtime sidecar launcher for Windows desktop
hosts. The crate verifies the runtime manifest and executable, reserves a
loopback port, generates a bearer token, launches the runtime, and probes its
readiness.

There is one launch path. `launch_sidecar` and `launch_sidecar_with_observer`
make up to 3 attempts within 60 seconds by default. A host that runs its own
process uses `OwnedRuntimeSession::spawn` or `OwnedSidecarProcess::spawn`. On
Windows every root is created suspended, assigned to a new kill-on-close Job
object, and resumed only after that assignment is checked, so the system stops
the runtime and its descendants when the host exits. The crate writes nothing
to disk.

Runtime jobs remain ephemeral. Host applications own durable source and domain
data, and callers must not log or persist the sidecar bearer token.
