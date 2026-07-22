# CaptureReleaseEvidenceV1

The release gate promotes exact artifacts; it does not infer readiness from a developer machine,
an ambient model cache, or a handwritten checklist. `build-release-artifacts` packages code and
schema without reading installed OCR or Whisper model stores. A separate clean Windows 11 x64
lane must exercise the candidate and generate the evidence subject from observed files and
`CaptureDocumentV1` results.

`capture_runtime.release_evidence.generate_release_evidence` binds all of the following:

- runtime executable file name, byte count, and SHA-256;
- `CaptureDocumentV1` schema file name, byte count, and SHA-256;
- compressed WindowsML six-file ZIP name, exact byte count, and SHA-256;
- non-public Tauri NSIS verification installer name, byte count, and SHA-256;
- exactly one stable PDF, image, and licensed/authorized audio fixture ID;
- each fixture source name/bytes/SHA-256, expected-text SHA-256, and result JSON SHA-256;
- schema parsing, expected text, page/time locator provenance, JSON round trip, and text
  projection derived from each result instead of caller-provided booleans;
- runner image, timezone-aware generation time, evidence tool version, and Windows version;
- Capture Ollama profile/model digest, both allowlisted Whisper model digests, and the concurrent
  process/model-store isolation result.

Unknown fields and drift are terminal failures. Fixture IDs and source/expected-text digests must
also match the protected `FixtureRegistryV1`; the evidence file cannot introduce a new fixture.

Local generator output uses `attestation.kind=unsigned-local`, `verified=false`, and
`releaseable=false`. It is diagnostic only. A release candidate evidence subject must be created
for GitHub artifact attestation and then verified for the exact evidence file with
`gh attestation verify --repo WodenWang820118/capture-workbench`. The Python validator additionally
requires the workflow-only external-verification signal; editing JSON to claim verification cannot
pass that gate.

The protected `capture-release` environment must supply non-empty, valid values for:

- `CAPTURE_WINDOWSML_BUNDLE_URL`, `CAPTURE_WINDOWSML_BUNDLE_BYTES`, and
  `CAPTURE_WINDOWSML_BUNDLE_SHA256`;
- `CAPTURE_RELEASE_EVIDENCE_B64` for the exact candidate artifacts;
- `CAPTURE_RELEASE_FIXTURE_REGISTRY_B64` for the approved fixtures.
- `CAPTURE_RELEASE_EVIDENCE_SIGNER_WORKFLOW` for the exact trusted workflow identity enforced by
  `gh attestation verify --signer-workflow`.

Until real protected values and the matching GitHub attestation exist, the release workflow is
intentionally blocked. The read-only build job first uploads one immutable candidate containing
the runtime, schema, package tarball, and non-public installer. The protected verification job can
therefore wait while the separate trusted clean-install lane exercises those exact bytes and
attests the generated evidence. Only the verifier's new runtime/package payload reaches the
publish job, which receives narrow `contents:write` and `packages:write` permissions.

The synchronized manifest descriptor is strict and identical in Python, JavaScript, and Rust:

```json
{
  "runtimeRequirements": {
    "windowsml-ocr": {
      "artifactUrl": "https://public.example.org/path/capture-windowsml-ocr-windows-x64.zip",
      "artifactFileName": "capture-windowsml-ocr-windows-x64.zip",
      "bytes": 123456,
      "sha256": "64-lowercase-hex-characters"
    }
  }
}
```

`bytes` is the exact compressed ZIP length in the range 1 through 536870912. The installer
rejects redirects, mismatched `Content-Length`, streams shorter or longer than `bytes`, checksum
drift, duplicate/extra/ADS/traversal/symlink/encrypted entries, excessive expansion, and
cancellation/interruption residue. The archive must contain exactly the six allowlisted files.

The runtime executable manifest's `bytes` is also a strict integer from 1 through 536870912
(`MAX_RUNTIME_ARTIFACT_BYTES`, 512 MiB) in the Python builder, JavaScript staging validator, and
Rust launcher.

Publishing is preflighted, runtime-first, and retry-safe. Before any GitHub Release create,
upload, or edit, the publisher validates a regular `.tgz`, its npm package identity/version, its
exact local integrity, and the registry's existing `dist.integrity`. A conflicting published
version is terminal before GitHub mutation. Otherwise, a draft release is created or resumed,
exact runtime assets are uploaded and made public, and only then may the synchronized npm tarball
publish. A rerun compares already-public release bytes and registry integrity; post-publication
integrity is re-read and must match rather than being overwritten.
