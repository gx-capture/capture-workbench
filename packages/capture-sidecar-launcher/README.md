# capture-sidecar-launcher

Shared authenticated Capture Runtime sidecar launcher for Windows desktop
hosts. The crate owns process lifecycle, loopback endpoint discovery, bearer
token handling, and health verification for host applications.

Runtime jobs remain ephemeral. Host applications own durable source and domain
data, and callers must not log or persist the sidecar bearer token.
