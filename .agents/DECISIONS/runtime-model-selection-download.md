# Decision: allowlisted runtime model selection

Status: accepted for the v2 runtime release; promotion remains blocked until
the candidate gates pass.

The standalone Workbench bridge uses the v2 model endpoints. The
runtime maps stable option IDs to exact model references and profile settings.
This prevents a renderer or consumer app from injecting an arbitrary Ollama
model or profile. The active selection is persisted by the runtime, not in Web
Storage, so a restart observes the same verified selection.

The `capture-ollama-model` requirement reports `manual_action_required` until
an active model option exists. The standalone launch policy does not force a
fixed model profile.

Expected model digest/size are release metadata, not guessed values. A local
preflight may operate with unset expectations, but a candidate cannot be
promoted until its catalog binds exact values and the post-pull verification is
green.
