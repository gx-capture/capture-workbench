# Direct Model Delivery TODO

- [ ] Resolve exact Paddle/Whisper user-directed upstream download/use terms,
  required attribution/NOTICE, canonical owners/URLs/revisions, first-party
  `pipeline.json` derivation, and redistribution permission for exact
  first-party-copied pipeline/license/NOTICE/real-fixture bytes. Pin normalized
  expected text and engine/model/device provenance.

- [ ] Complete the required two-commit bootstrap in
  `gx-capture/capture-workbench`: commit approved first-party bytes first, then
  in a later source-lock commit reference immutable raw URLs at that earlier
  full commit SHA. The source lock must not self-reference its own commit.
  Encode the resulting exact bytes/hashes and repository/commit binding.
  Verify: `pnpm nx run capture-runtime:validate-model-source-lock --skip-nx-cache`.

- [ ] Obtain explicit authorization, register, and secure a self-hosted Windows
  x64 GPU runner with the exact `capture-directml` label. GitHub-hosted
  `windows-latest` is not acceptable evidence for the DirectML product lane.

- [ ] After both prerequisites above are satisfied, dispatch the real model
  candidate workflow for the exact full commit SHA and retain a successful
  non-expired receipt proving:
  - OCR engine/model/device exactly
    `windowsml-ocr` / `pp-ocrv6-medium-windowsml` / `windowsml-dml`;
  - the lock-approved Whisper primary/fallback engine/model/device path;
  - exact normalized fixture output; and
  - exact fixture plus fixture-license bytes/SHA-256.

Every production catalog, real-probe, candidate-receipt, tag, and publication
lane remains blocked until these active prerequisites pass. Commit, tag,
release, package publication, runner registration, and machine configuration
require separate explicit authorization.
