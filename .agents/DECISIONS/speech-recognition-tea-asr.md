# Decision: TEA-ASR speech recognition under `speech-recognition`

## Decision

The product is Taiwan-first; more selectable models may follow. Speech recognition runs
`JacobLinCool/TEA-ASR-1.1` (Qwen3-ASR-1.7B fine-tune, Traditional Chinese with Taiwan
vocabulary) on CUDA and `JacobLinCool/TEA-ASR-1.1-mini` (Qwen3-ASR-0.6B based) on CPU, keeping
the former GPU-primary / CPU-fallback-model rule. Word times come from
`Qwen/Qwen3-ForcedAligner-0.6B-hf`. faster-whisper and CTranslate2 are removed.

The public requirement id `whisper-primary` is renamed to `speech-recognition` (breaking under
the 0.x policy; the user chose a generic id over keeping the old one). Engine provenance is
`speech-recognition` with model `tea-asr-1.1` or `tea-asr-1.1-mini`.

Inference uses Transformers 5.20.2's native Qwen3-ASR, ported from Transcript Workbench, whose
verification record compares it with the official `qwen-asr` package (identical transcript on
the reference clip):

- TEA checkpoints keep the original Qwen3-ASR layout; they load with the matching `-hf`
  architecture directory's configuration and processor plus a four-rule `key_mapping`.
- The tokenizer is `PreTrainedTokenizerFast` from the TEA directory; `AutoTokenizer` drops the
  tokenizer.json decoder step that deletes private-use marker characters.
- TEA loops on long input (stable at 60 s, loops at 90 s): audio is cut into ~30 s chunks at
  the quietest 100 ms, and a chunk that reaches the generation limit is retried as halves while
  they last at least 5 s. Pieces that still loop are reported in the result warning.
- Chinese is always forced (`language="zh"`), as the model card recommends for Taiwan speech;
  it also keeps dense Chinese-English code-switching from being translated. Recordings in other
  languages need another model.

PyTorch comes from the CUDA 12.8 index on Windows for both the speech and diarization extras.

## Renames

Requirement id, engine provenance and constant (`SPEECH_RECOGNITION_REQUIREMENT_ID`); extra
`whisper` → `speech-recognition`; worker `workers/speech_recognition_main.py`, spec, build
script, worker directory, executable and archive/manifest stem `capture-engine-speech-recognition`;
nx targets `build-speech-recognition-worker`, `verify-speech-recognition-worker`,
`generate-speech-recognition-preflight-catalog`, `verify-speech-recognition-preflight`; catalog,
boundary and preflight flags `--speech-recognition-*`; stages `speech-*`. Internal module names
`whisper_session.py` and `progressive_whisper.py` keep their names and binary protocol.
`whisper_download.py` is removed: installation uses the pinned direct-file lock pipeline, like
`speaker-diarization`.

## Consequences

- The release model-source lock pins 34 files (about 7.5 GB) and needs the user's
  re-approval before release. Install-time bounds were raised to admit it (4 GiB per file,
  8 GiB per unit, 10 GiB across the lock).
- The `whisper-private-reference` fixture keeps its audio but its expected normalized output
  hash still records the Whisper measurement; two identical production TEA runs must replace it.
- Size budgets were not changed; the speech worker archive, installed tree and bundle report
  must be measured before `verify-worker-boundaries` and the size regression checks.
- Consumers that install `whisper-primary` (for example law-prep's AI service) change the id
  when they move to the release that contains this decision.
