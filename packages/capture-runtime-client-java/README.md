# capture-runtime-client

`com.gx.capture:capture-runtime-client` is the framework-neutral Java client
for the authenticated Capture Runtime v2 APIs. It discovers the runtime-owned
catalog at `/meta/v2/contracts`, verifies the exact immutable bundle SHA-256
before decoding responses, maps structured error envelopes, and includes an
in-memory transport for consumer tests.

`CaptureRuntimeClient.ClientOptions` defaults to contract-set version `2` and
the hash embedded in the coordinated release resource. Pass an explicit
SHA-256 allowlist to support an intentional release rollback or test fixture;
an unknown bundle is rejected by default. Every client operation (including
SSE) performs discovery before use; runtime version is retained as a
diagnostic consistency check rather than the contract identity.

Generated wire codecs are package-private implementation details. Consumers
use the public `CaptureRuntimeTypes` v2 DTOs and `CaptureRuntimeClient` methods;
there is no public schema loader or generated-model package. Runtime version and
contract hash identity are negotiated from discovery, never copied from a local
schema or manifest file.

Law Prep's AI connector and structuring provider use the narrow typed
`RawCapture`/`CaptureDocument` boundary for provenance and validation. Product
mapping, persistence, review, and coordination remain local to Law Prep.

Publication coordinates are `com.gx.capture:capture-runtime-client` through
GitHub Packages (`https://maven.pkg.github.com/gx-capture/capture-workbench`).
The module declares Maven distribution metadata; publication still requires a
GitHub Packages credential/settings entry and a release workflow in the
producer repository.
