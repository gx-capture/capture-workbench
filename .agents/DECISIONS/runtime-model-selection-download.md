# Decision: allowlisted runtime model selection

Status: accepted for the 0.3.11 release-candidate work; promotion remains
blocked until the new gates pass.

The release will keep the existing `StartRuntimeInstallationV1` contract and
legacy `/runtime/installations` endpoint intact. Adding `optionId` to that
strict request would make older clients reject the request and would blur the
boundary between generic runtime dependencies and model selection.

The standalone Workbench bridge will use the additive model endpoints. The
runtime maps stable option IDs to exact model references and profile settings.
This prevents a renderer or consumer app from injecting an arbitrary Ollama
model or profile. The active selection is persisted by the runtime, not in Web
Storage, so a restart observes the same verified selection.

The existing `capture-ollama-model` requirement ID remains for compatibility,
but a fresh standalone runtime reports it as manual action required until an
active model option exists. The fixed 4B environment constants are legacy
compatibility inputs only; the standalone launch policy must not force them.

Expected model digest/size are release metadata, not guessed values. A local
preflight may operate with unset expectations, but a candidate cannot be
promoted until its catalog binds exact values and the post-pull verification is
green.
