# Packaged OCR import failure diagnostics

When the packaged OCR worker cannot import its native dependencies, the
failure stage names the reason and the component without exposing raw detail.

Owners: `workers/ocr_main.py` (catch), `worker_stage_policy.py` (policy),
`worker_process.py` (bounded evidence), and `ocr_execution_proof.py` (v1 sink),
all under `packages/capture-runtime/src/capture_runtime/`.

Only `native-load` is extended: `-<nativeReason>-<nativeComponent>` is appended
to the `...-native-load-<family>` stage. Non-native and legacy stages, the
public API, schema, contract and the v1 failure sink are unchanged.
`paddleocr` in the family position is the fallback, not proof of the failing
component.

Build a cycle-safe chain at depth 0..3: follow `__cause__`, else `__context__`,
and stop on `None` or a seen identity. Pass 1 scans every node for exact integer
`winerror`; use fixed reason precedence, with deeper-node ties winning. Only if
Pass 1 is empty, Pass 2 scans strict normalized `WinError N` phrases; no broad scan.
Reasons: `dependency-missing(126)`, `symbol-missing(127)`, `bad-image(193)`,
`initialization-failed(1114)`, `resource-exhausted(8/14/1455)`, `blocked(5/577)`,
`side-by-side(14001)`, then `unknown`.
Components: scan all-chain allowlisted `error.name` (deeper match), then all-chain
allowlisted `while importing <token>`, then all-chain allowlisted DLL basename, then `unknown`; never
emit or persist raw paths, tokens, names, or messages.
Finite components: `onnxruntime|directml|opencv|numpy|pandas|shapely|pyclipper|pillow|pydantic-core|rpds|tokenizers|chardet|charset-normalizer|aiohttp|multidict|yarl|frozenlist|propcache|vc-runtime|python-runtime|paddlex|paddleocr|unknown`.
Example: outer generic plus inner `OSError(winerror=126,name="cv2")` yields
`-dependency-missing-opencv`; the inner exact code wins.

The canonical policy and corpus (`assets/worker-stage-policy.json`,
`assets/worker-stage-policy-corpus.json`, `_generated_worker_stage_policy.py`)
are generated from source; `tools/worker-stage-policy.test.ts` checks them.
