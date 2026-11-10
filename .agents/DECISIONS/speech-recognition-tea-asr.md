# Decision: TEA-ASR speech recognition under `speech-recognition`

## Decision

The product is Taiwan-first; more selectable models may follow. Speech recognition runs
`JacobLinCool/TEA-ASR-1.1` (Qwen3-ASR-1.7B fine-tune, Traditional Chinese with Taiwan
vocabulary). By default that checkpoint runs on CUDA when a GPU is present, and on CPU
when it is not. A classified CUDA failure retries the same checkpoint once on CPU.
`JacobLinCool/TEA-ASR-1.1-mini` stays installed for explicit selection and development
tests; it is not the automatic CPU substitute. Word times come from
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
- Chinese (`language="zh"`) is the default, as the model card recommends for Taiwan speech;
  it also keeps dense Chinese-English code-switching from being translated. A host may name
  the spoken language of a recording (`spokenLanguage`, 0.8.0); Japanese transcripts are then
  written in Japanese kanji forms (`capture_runtime/japanese_kanji`).

Only speech recognition uses CUDA PyTorch (the CUDA 12.8 index on Windows); it is about 12.5x
faster than CPU for transcription. Diarization uses CPU PyTorch: about a minute per 40-minute
recording on CPU against about 10 s on GPU, for a far smaller worker. The two extras are declared
conflicting in uv, and each worker builds in its own environment.

A worker archive above 1.9 GB is published as ordered parts `<archive>.001`, `.002`, ... because
GitHub release assets must stay under 2 GB (the CUDA speech worker archive is about 2.95 GB). The
catalog keeps the whole archive's size and digest and lists each part with its own digest and URL;
the installer downloads every part into its place in the archive, checks each part and the whole
archive, then extracts as before. Worker extraction is bounded at 8 GiB.

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

- The release model-source lock pins the TEA-ASR and aligner files (about 7.5 GB).
  Install-time bounds were raised to admit them (4 GiB per file, 8 GiB per unit, 10 GiB
  across the lock).
- The `whisper-private-reference` fixture is the owner's 40-minute Taiwanese Mandarin interview
  (M4A, 39,199,307 bytes), which replaced the earlier MP3 when that file could not be found. Two
  identical runs of the published 0.7.1 worker on CUDA froze its expected normalized output
  (`tea-asr-1.1`, 106 segments) on 2026-10-25. The file stays private and is never committed.
- Size budgets cover only the runtime executable and the NSIS installer, which hold no worker,
  so they are unchanged. Worker archives are bounded by the catalog: under 2 GB per part and
  8 GiB per archive and extracted tree.
- Consumers that install `whisper-primary` (for example law-prep's AI service) change the id
  when they move to the release that contains this decision.

## Optional Taiwan speech pack (2026-11-01)

Speech recognition and speaker identification are an optional pack the user downloads by
choice; documents never wait for them. The runtime reports `speech-recognition` with
`optional: true`, like `speaker-diarization`. Capture Workbench lists both units in a
"Taiwan speech pack (optional)" panel, each with its own download button, and still asks for a
unit when a recording arrives without it.

Before downloading, the user sees what each model is: a guide per unit (what it does, which
languages it suits, the hardware it runs on, what the download contains and the license), kept in
`capture-workbench-ui` as `CAPTURE_UNIT_GUIDES` and shown by both the desktop app and the Web
Component setup list. The guide's facts come from the pinned model cards and the published
worker archives; change them together with the model-source lock. Download size is not one of
those facts: both hosts format the runtime requirement's `downloadBytes`.

## Choosing the model (2026-11-04)

The runtime setting `CAPTURE_SPEECH_RECOGNITION_MODEL` picks the recognizer:

- `auto` (the default) runs `tea-asr-1.1` on CUDA or CPU, and the CPU retry after a
  classified CUDA failure keeps that same checkpoint.
- `tea-asr-1.1-mini` or `tea-asr-1.1` runs that model on either device. A CPU retry keeps the
  chosen model, so `tea-asr-1.1` on CPU is slow but stays the model the host asked for.
- When the GPU is tried and when it falls back are unchanged. Provenance reports the model and
  device that produced the result.

Why: development transcriptions run mini on CUDA (the user's choice on 2026-11-04,
for speed), while release smokes and the private fixture stay on TEA-ASR 1.1 / CUDA.
It is a runtime setting, not a capture option, so the contract set is unchanged. The runtime sends the choice to the worker only when it is not `auto`: run option
`model` for one-shot captures, `CAPTURE_SESSION_SPEECH_MODEL` for a streaming session worker,
whose warm-worker key includes it. It replaces `CAPTURE_WHISPER_PRIMARY_MODEL` and
`CAPTURE_WHISPER_FALLBACK_MODEL`, which were validated but never reached the worker.

The installed unit still holds both models. Installing only mini, and a worker without the CUDA
libraries, is evaluated in issue #274. The desktop app does not expose the setting yet: it
launches the runtime with a fixed environment, so the setting would need a field in
`compute-settings.json` and a line in `launch_policy.rs`.

## Device follows the machine (2026-11-04)

If a GPU is present and the model supports it, the shipping runtime uses the GPU.
If no GPU is present, it uses the CPU. The default checkpoint is TEA-ASR 1.1 on
both devices. An explicit model choice also stays the same across a CPU retry.
The earlier automatic pairing (TEA-ASR 1.1 on CUDA, mini on CPU) is retired.

OCR already selects DirectML when a GPU is usable and the CPU otherwise.
Diarization's adapter uses CUDA when that process can see one. Its shipped worker
is CPU PyTorch, so that process has no GPU and stays on CPU.

A development test that transcribes real audio sets
`CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini` and
`CAPTURE_WHISPER_ALLOW_CPU_FALLBACK=false`, then checks provenance
`tea-asr-1.1-mini` with device `cuda`, as
[the research note](../RESEARCH/tea-asr-1.1-mini-gpu-2026-11-04.md) specifies.
Release smokes and `whisper-private-reference` stay on `tea-asr-1.1` / `cuda`.
