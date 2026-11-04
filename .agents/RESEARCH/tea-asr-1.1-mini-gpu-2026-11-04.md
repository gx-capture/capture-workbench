# TEA-ASR 1.1 mini on GPU — development tests

2026-11-04. The user asked how TEA-ASR 1.1 mini runs on a GPU, and ruled that
development tests which actually transcribe audio use that pair.

The shipping runtime is a different rule, recorded the same day: if a GPU is
present and the model supports it, use the GPU; if no GPU is present, use the
CPU. TEA-ASR 1.1 supports CUDA, so the product runs that checkpoint on CUDA or,
with no GPU, on CPU. It does not switch to the mini checkpoint for lack of a
GPU. The mini files stay in the install so a development test can point the
adapter at them.

## What to run

A development transcription reports provenance `tea-asr-1.1-mini` and device
`cuda`. Refuse a CPU result for that run (`allow_cpu_fallback=False`). A
classified CUDA failure otherwise retries the same mini checkpoint on CPU, and
the model name alone no longer shows which device ran.

Release checks stay on the frozen pair. The private fixture
`whisper-private-reference` expects `tea-asr-1.1` on `cuda`, and
`model_source_lock.py` accepts `(tea-asr-1.1, cuda)`, `(tea-asr-1.1, cpu)`,
and `(tea-asr-1.1-mini, cpu)`. `smoke-real-media` and `smoke-real-media-model`
check that lock. Do not retarget them.

There is no import-linter or CI check for this. Set
`CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini`,
`CAPTURE_WHISPER_PREFER_GPU=true`, and
`CAPTURE_WHISPER_ALLOW_CPU_FALLBACK=false` on the runtime, then check the result's
model and device. The desktop's fixed launch environment does not expose the
model setting yet; its GPU switch only selects the device.

## The two checkpoints are the same loader

`TeaAsrAdapter` (`speech_recognition.py`) loads the chosen checkpoint plus its
matching `-architecture` directory on the selected device. CUDA and CPU use the
same checkpoint. With no explicit choice it uses `primary_model`; selecting
`tea-asr-1.1-mini` uses `fallback_model`. The probe still requires both trees.
The recognizer is `Qwen3ASRForConditionalGeneration` with the four-rule
`ASR_KEY_MAPPING`. The tokenizer is `PreTrainedTokenizerFast` from the TEA
checkpoint, not `AutoTokenizer`. CUDA uses bfloat16 when
`torch.cuda.is_bf16_supported()` is true, otherwise float16. The Qwen3 forced
aligner then runs on that same device. Chunking, the generation-loop stop, and
`language="zh"` are shared.

The installed speech model directory (the worker's `modelPath`; lock entry
point `model`) already contains both checkpoints:

| Checkpoint | Folder | Weights | Architecture config |
| --- | --- | --- | --- |
| Shipping, either device | `primary` | `JacobLinCool/TEA-ASR-1.1` @ `bda08df76d4fd6b487b4a1dd7f0bddf8541696f8`, `model.safetensors` 4,076,191,640 bytes | `Qwen/Qwen3-ASR-1.7B-hf` @ `bcd2b5b7f32b480ab5790554cfa8347f246a14f3` |
| Development tests | `fallback` | `JacobLinCool/TEA-ASR-1.1-mini` @ `98c58048572b44839dfcfa60de3ad7e365a5b232`, `model.safetensors` 1,564,926,456 bytes | `Qwen/Qwen3-ASR-0.6B-hf` @ `7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c` |

Pair a checkpoint with its own architecture directory. Mini weights with the
1.7B config are the wrong shapes. The aligner is
`Qwen/Qwen3-ForcedAligner-0.6B-hf` @ `c07281df297b9905d24a508279258cccf987a064`
(`model/aligner/model.safetensors`, 1,835,545,960 bytes) for both.

The packaged worker (`workers/speech_recognition_main.py`) loads `primary` by
default and reports provenance `tea-asr-1.1` on CUDA or CPU. The runtime setting
`CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini` selects `fallback` through the
one-shot run option `model` or the session environment `CAPTURE_SESSION_SPEECH_MODEL`.
The unused `CAPTURE_WHISPER_PRIMARY_MODEL` and `CAPTURE_WHISPER_FALLBACK_MODEL`
settings were removed by PR #275. The desktop GPU switch only chooses the device.

## Development call

For a direct adapter test, select the installed mini checkpoint by model name.
The device is still CUDA when a GPU is present. Provenance must name the mini
model, or a later reader will treat the run as the flagship.

```python
from capture_runtime.speech_recognition import TeaAsrAdapter

adapter = TeaAsrAdapter(
    models_dir,  # installed model directory containing both checkpoints and the aligner
    model="tea-asr-1.1-mini",
    prefer_gpu=True,
    allow_cpu_fallback=False,
    max_duration_ms=8 * 60 * 60 * 1000,
)
result = adapter.transcribe(source, should_cancel=lambda: False)
# result.model == "tea-asr-1.1-mini" and result.device == "cuda"
```

`models_dir` is the installed speech-recognition model directory, not a
Hugging Face repo id. Loading stays `local_files_only=True`.

## What the cards say, and what this repo does not pass

Both cards (those revisions) say the checkpoint loads like stock Qwen3-ASR.
Mini is the 780M model on `Qwen/Qwen3-ASR-0.6B`; the flagship is the 2B model
on `Qwen/Qwen3-ASR-1.7B`. Their mixed error rates, mini then flagship:
CommonVoice 19 zh-TW 5.12 / 3.58, ASCEND 11.20 / 9.60, CSZS 12.51 / 10.94,
NTUML2021 7.53 / 6.67. The card tells callers to pass `language="Chinese"` for
Taiwan speech. This repo passes `language="zh"` through
`apply_transcription_request` and does not pass the mini card's format tags
(`keep-en`, `digits`, `zh-num`).

The decision's "about 12.5× faster than CPU" and the 0.7.2 timings (a 30 s
clip in 6 s once warm, a 40-minute recording in 339 s, on an RTX 4060 Laptop
8 GB) were measured on the flagship CUDA path. This note does not remeasure
mini on GPU. The smaller checkpoint is why a development run uses it: the
loader, dtype, chunking, and aligner are the same code.

## Sources

- `packages/capture-runtime/src/capture_runtime/speech_recognition.py` — `_load_asr`, `_asr_dtype`, `TeaAsrAdapter._attempt`
- `packages/capture-runtime/src/capture_runtime/workers/speech_recognition_main.py` — selected model in run and session workers
- `packages/capture-runtime/src/capture_runtime/config.py` — `CAPTURE_SPEECH_RECOGNITION_MODEL` validation
- `packages/capture-runtime/model-sources/release-model-source-lock.json` — revisions and safetensors sizes
- `packages/capture-runtime/scripts/model_source_lock.py` — allowed fixture pairs
- `.agents/DECISIONS/speech-recognition-tea-asr.md` — product device rule
- `CHANGELOG.md` 0.7.2 — flagship CUDA timings
- https://huggingface.co/JacobLinCool/TEA-ASR-1.1-mini/raw/98c58048572b44839dfcfa60de3ad7e365a5b232/README.md
- https://huggingface.co/JacobLinCool/TEA-ASR-1.1/raw/bda08df76d4fd6b487b4a1dd7f0bddf8541696f8/README.md
