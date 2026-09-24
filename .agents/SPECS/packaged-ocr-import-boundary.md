# Packaged OCR import seam - Phase 1 j16 design

Baseline: HEAD `a6671e93`; docs-only update; unrelated dirty files remain untouched.
The installed j15 Workbench page 1 (`j15-luna-xhigh-pdf-20260831-01`) failed with
`status=failed`, `primary=ocr_semantic_failed`, and terminal stage
`python-import-paddleocr-failed-importerror-native-load-paddleocr`; cleanup was true.
`paddleocr` is the family fallback, not native-component evidence or packaging proof.
The Sol advisor direct-fix lane is blocked; this slice selects no direct fix.

## One bounded j16 slice

Owners remain `workers/ocr_main.py` (catch), `worker_stage_policy.py` (policy),
`worker_process.py` (bounded evidence), and `ocr_execution_proof.py` (v1 sink).
Only `native-load` extends: append `-<nativeReason>-<nativeComponent>` to the
current `...-native-load-<family>` stage; non-native and legacy stages stay unchanged.
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
TDD reason/code precedence, depth/cycle cutoff, every component source, unknowns, and
malicious path/token non-leakage. Regenerate canonical policy and corpus from source.
No public API/schema/contract change (keep the v1 sink); handwritten production+test
additions are at most 100 lines. Then run exactly one j16 installed Workbench page 1:
a failure selects one unique fix; a pass advances to semantic/GPU gates.
