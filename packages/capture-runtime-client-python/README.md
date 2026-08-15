# capture-runtime-client

Backend-side Capture Runtime client SDK.  It owns loopback endpoint
validation, readiness/schema-hash negotiation, authenticated HTTP and
deterministic in-memory transports, canonical v2 request methods, SSE decoding, and
redacted common errors. Generated Pydantic models are private SDK build input;
consumers import them from `capture_runtime_client`, never from a generated
contracts package.
