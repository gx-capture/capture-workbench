# Runtime model selection and download

## Goal

The standalone Capture Workbench release must not download or bundle a fixed
Qwen model during installation. A user selects an allowlisted model and
explicitly consents before Capture Runtime downloads it into the isolated
runtime model store.

## Contract

Model selection is a first-class v2 runtime surface with explicit setup and
installation semantics:

- `GET /v2/runtime/model-options`
- `POST /v2/runtime/model-installations`
- `GET /v2/runtime/model-installations/{id}`
- `POST /v2/runtime/model-installations/{id}/cancel`

The renderer submits only a stable `optionId` and `consent: true`. Model
references, profile IDs, profile specifications, and verification metadata are
runtime-owned allowlist data. The renderer cannot provide an arbitrary Ollama
model name, URL, digest, or profile.

Each option exposes a display name, exact model reference, profile ID, profile
specification digest, and optional candidate-bound expected model digest/size.
Until expected digest and size are frozen for a release candidate, the option
is not eligible for release promotion; local verification may still record the
observed values without weakening fail-closed behavior.

## Behavior

- A fresh standalone runtime has no active model and does not pull a model.
- Model readiness is `manual_action_required` until the user selects and
  accepts an option.
- Installation pulls the allowlisted reference, verifies any candidate-bound
  digest/size, creates and probes the option's structure profile, and atomically
  persists the active selection in runtime app data.
- A model switch does not delete an older model. Deletion is a separate future
  user action.
- Capture structuring fails explicitly with `model_selection_required` when no
  active verified selection exists.
- Cert Prep and Law Prep continue to use host structuring and do not call the
  model-option endpoints or own Ollama.

## Release acceptance

The candidate ledger must include the model-options catalog digest. Production
Workbench evidence must show first launch without a model, explicit selection
and consent, a real pull and verification, OCR and Audio structuring, and
selection persistence after restart. Private fixtures and downloaded models
are local-only test inputs and must be removed after verification.
