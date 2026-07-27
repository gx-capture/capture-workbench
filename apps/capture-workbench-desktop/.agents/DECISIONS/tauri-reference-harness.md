# Tauri Reference Harness Decisions

## Status

Accepted for the Windows 11 x64 verification host.

## Decisions

1. The desktop app is a packaging and deterministic verification harness, not a public desktop product.
2. The app bundles one `capture-runtime` Windows x64 sidecar and verifies its release manifest, byte count, SHA-256 digest, runtime version, and schema version before execution.
3. Every launch creates an OS-random 256-bit bearer token and independent loopback ports. Connection data exists only in Rust memory and crosses into Angular through the `backend_config` Tauri command.
4. The Workbench development provider is an isolated Ollama lane. It has a dedicated loopback port, app-data directory, model directory, profile, PID file, and model selection. Host applications may inject another provider through the runtime provider interface; the reference harness does not weaken its own isolation.
5. Runtime logs are opt-in and the launcher never writes command lines, environment values, authorization headers, or bearer tokens to a URL, local storage, or log.
6. The launcher owns only the process tree it starts. Shutdown targets the recorded child PID tree and never kills by executable name, port, or shared Ollama model store.
7. Production CSP permits Tauri IPC and loopback HTTP connections only. API documentation is disabled for production runtime launches.
8. Deterministic package QA is diagnostic consumer evidence. Its fake runtime does not certify real
   WindowsML, Whisper, Ollama, or licensed-fixture behavior and is not a publication gate.
9. The launcher advertises a 50 MiB upload ceiling. This keeps single-file multipart buffering bounded while still covering the reference PDF, image, and short-audio workflows.
10. The deterministic runtime matches the canonical v1 transport: multipart capture creation, `captureId`, schema version `1`, and the status/raw/result/error envelopes used by the Angular client and Python runtime.

## Residual Risk

The launcher currently discovers an ephemeral loopback port by binding and releasing it before the child runtime binds. A local process could race that interval. The accepted mitigation for this verification harness is the OS-random 256-bit bearer token plus an authenticated readiness response whose runtime/API/schema versions and capabilities are checked against a SHA-256-verified bundled manifest. Host validation includes the exact port authority. The release gate must retain the adversarial wrong-authority check; inheriting an already-bound socket is preferred if a future runtime transport supports it.

## Rejected Alternatives

- Reusing the cert-prep study Ollama process or model directory: this makes cleanup and model/profile provenance unsafe.
- Passing the token in a query string or persistent web storage: both create unnecessary disclosure surfaces.
- Killing all `ollama.exe` or `capture-runtime.exe` processes: this can terminate another product's provider.
- Treating a TCP-open check as runtime readiness: the harness must receive an authenticated ready response.
