"""Stand-ins for torch and Transformers at the model adapter boundary.

One fake torch and one fake transformers module serve TEA-ASR, its forced aligner
as the real modules serve the speech adapter.
"""

import contextlib
import re
import sys
import weakref
from pathlib import Path
from types import SimpleNamespace

from capture_runtime import speech_recognition as backends

AUDIO = [0.0] * 16_000


class OutOfMemoryError(RuntimeError):
    pass


class _Inputs(dict):
    def to(self, *args):
        return self


class _Output:
    """Generated ids; slicing off the prompt keeps the fake decode independent of it."""

    def __init__(self, length):
        self.shape = (1, length)

    def __getitem__(self, index):
        return self


def _alignment_words(text):
    return re.findall(r"[一-鿿]|[A-Za-z0-9']+", text)


class FakeModels:
    """Records model events and raises configured failures.

    `failures[(engine, stage)]` raises on CUDA (always for stage "load");
    `cpu_failures[engine]` raises during CPU inference. Engines are "asr",
    "aligner" and "diarization".
    """

    def __init__(self, monkeypatch, *, cuda=True, bf16=True):
        self.events = []
        self.cuda = cuda
        self.bf16 = bf16
        self.failures = {}
        self.cpu_failures = {}
        self.transcript = "complete"
        self.language = "Chinese"
        self.alignment = None
        # Whether a transcription request of this many samples loops to the length limit.
        self.runaway = lambda samples: False
        self.requested = 0
        self.probabilities = [[0.9, 0.1]]
        # One frame per second of 16 kHz audio keeps the expected turns readable.
        self.hop_length = 16_000
        self.gpu_models = []
        self.failed = False
        self.on_load = None
        monkeypatch.setitem(sys.modules, "torch", self._torch())
        monkeypatch.setitem(sys.modules, "transformers", self._transformers())

    def loads(self, engine):
        return [event for event in self.events if event[:2] == ("load", engine)]

    def devices(self, engine):
        return [event[2] for event in self.events if event[:2] == ("transfer", engine)]

    def _fail(self, engine, stage, device):
        error = self.failures.get((engine, stage))
        if error is not None and (stage == "load" or device == "cuda"):
            self.failed = True
            raise error
        if stage == "inference" and device == "cpu" and engine in self.cpu_failures:
            raise self.cpu_failures[engine]

    def _torch(self):
        fake = self

        def available():
            fake.events.append(("probe",))
            return fake.cuda

        return SimpleNamespace(
            cuda=SimpleNamespace(
                is_available=available,
                is_bf16_supported=lambda: fake.bf16,
                empty_cache=lambda: fake.events.append(("empty_cache",)),
                OutOfMemoryError=OutOfMemoryError,
            ),
            OutOfMemoryError=OutOfMemoryError,
            device=lambda device: device,
            inference_mode=contextlib.nullcontext,
            float32="float32",
            float16="float16",
            bfloat16="bfloat16",
        )

    def _transformers(self):
        fake = self

        class Model:
            engine = ""
            config = SimpleNamespace(timestamp_token_id=151705)

            @classmethod
            def from_pretrained(cls, model, **options):
                fake.events.append(("load", cls.engine, model, options))
                if fake.on_load is not None:
                    fake.on_load()
                fake._fail(cls.engine, "load", None)
                return cls()

            def to(self, device):
                self.device = device
                fake.events.append(("transfer", self.engine, device))
                if device == "cuda":
                    fake.gpu_models.append(weakref.ref(self))
                fake._fail(self.engine, "transfer", device)
                return self

        class Recognizer(Model):
            engine = "asr"

            @classmethod
            def from_pretrained(cls, model, *, config, key_mapping, **options):
                assert Path(config.source).name in {"primary-architecture", "fallback-architecture"}
                assert key_mapping == backends.ASR_KEY_MAPPING
                return super().from_pretrained(model, **options)

            def generate(self, **inputs):
                assert inputs["do_sample"] is False
                for stop in inputs["stopping_criteria"]:
                    stop(None, None)
                fake.events.append(("generate", self.device, inputs["max_new_tokens"]))
                fake._fail("asr", "inference", self.device)
                looping = fake.runaway(fake.requested)
                return _Output(inputs["max_new_tokens"] if looping else 3)

        class Aligner(Model):
            engine = "aligner"

            def __call__(self, **inputs):
                fake.events.append(("align", self.device))
                fake._fail("aligner", "inference", self.device)
                return SimpleNamespace(logits="logits")

        class RecognizerProcessor:
            tokenizer = None

            def apply_transcription_request(self, *, audio, language):
                fake.events.append(("request", language, len(audio)))
                fake.requested = len(audio)
                return _Inputs(input_ids=SimpleNamespace(shape=(1, 3)))

            def decode(self, generated, *, return_format):
                assert return_format == "parsed"
                return [{"language": fake.language, "transcription": fake.transcript}]

        class AlignerProcessor:
            def prepare_forced_aligner_inputs(self, *, audio, transcript, language):
                fake.events.append(("align_request", language, transcript))
                return _Inputs(input_ids="ids"), [_alignment_words(transcript)]

            def decode_forced_alignment(self, *, logits, input_ids, word_lists, timestamp_token_id):
                assert timestamp_token_id == 151705
                if fake.alignment is not None:
                    return [fake.alignment]
                return [
                    [
                        {"text": word, "start_time": index * 0.2, "end_time": index * 0.2 + 0.2}
                        for index, word in enumerate(word_lists[0])
                    ]
                ]

        class AutoProcessor:
            @staticmethod
            def from_pretrained(model, **options):
                fake.events.append(("processor", model, options))
                if Path(model).name.endswith("-architecture"):
                    return RecognizerProcessor()
                if Path(model).name == "aligner":
                    return AlignerProcessor()
                raise AssertionError(model)

        class PreTrainedTokenizerFast:
            @staticmethod
            def from_pretrained(model, **options):
                fake.events.append(("tokenizer", model, options))
                return "tea-asr-tokenizer"

        class AutoConfig:
            @staticmethod
            def from_pretrained(model, **options):
                return SimpleNamespace(source=model)

        return SimpleNamespace(
            StoppingCriteriaList=list,
            AutoProcessor=AutoProcessor,
            PreTrainedTokenizerFast=PreTrainedTokenizerFast,
            AutoConfig=AutoConfig,
            Qwen3ASRForConditionalGeneration=Recognizer,
            Qwen3ASRForTokenClassification=Aligner,
        )


def model_tree(root):
    for folder, names in {
        "primary": backends.CHECKPOINT_FILES,
        "fallback": backends.CHECKPOINT_FILES,
        "primary-architecture": backends.ARCHITECTURE_FILES,
        "fallback-architecture": backends.ARCHITECTURE_FILES,
        "aligner": backends.ALIGNER_FILES,
    }.items():
        (root / folder).mkdir(parents=True, exist_ok=True)
        for name in names:
            (root / folder / name).write_bytes(f"{folder}:{name}".encode())


def adapter(root, fake, *, audio=None, **options):
    model_tree(root)
    return backends.TeaAsrAdapter(
        root,
        prefer_gpu=options.pop("prefer_gpu", True),
        max_duration_ms=120_000,
        torch_module=fake._torch(),
        transformers_module=fake._transformers(),
        decoder=lambda *a, **k: AUDIO if audio is None else audio,
        **options,
    )
