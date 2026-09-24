# Decision: packaged OCR import seam

Status: j15 is an installed page-1 failure at `native-load-paddleocr`; the suffix
is the family fallback, not native-component or packaging proof. Sol advisor direct-fix
advice is blocked, so j16 remains diagnostic-only until evidence selects one fix.
Extend only native-load with `-<nativeReason>-<nativeComponent>`; preserve its
prefix, non-native/legacy stages, and the v1 failure sink.
Use the cycle-safe depth-0..3 chain, all-node exact-winerror pass, deeper-node tie,
then strict-phrase pass and component precedence in the SPEC. Raw details never cross
the seam. Regenerate policy/corpus; do not change API/schema/contract.
This update changes no code, tests, builds, OCR runs, staging, or commits.
