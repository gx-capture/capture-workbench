# @gx-capture/capture-runtime-client

Framework-neutral Capture Runtime client SDK.  The package owns endpoint
discovery, compatibility/hash negotiation, transport adapters, protocol
decoding, and common errors.  Angular, desktop, and other hosts can build a
thin adapter over the same client without importing generated wire contracts.

The HTTP adapter is for a backend or trusted local process. Browser code must
not receive a sidecar URL or Bearer token; expose a host-backend adapter (or a
trusted local-process bridge) to the browser instead. Bearer credentials are
only attached after the destination has been validated as an HTTP loopback
origin. Requests always omit browser credentials and reject redirects.
