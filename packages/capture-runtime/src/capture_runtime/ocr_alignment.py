"""Observe a single canonical PaddleX inference without changing its outputs.

Only instance-owned hooks are replaced, for the lifetime of the context. No
Paddle import, model invocation, tensor persistence, or recognition retry is
performed here. The adapter owns matching these records to its normalized
regions and deciding whether the canonical pipeline must support this seam.
"""

from __future__ import annotations

import importlib
import math
import sys
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Literal

Point = tuple[float, float]
Matrix = tuple[tuple[float, float, float], ...]


class UnsupportedAlignmentPipeline(RuntimeError):
    """The pipeline does not expose the supported instance-owned operations."""


class AlignmentContractError(RuntimeError):
    """Observed operations cannot be uniquely aligned without guessing."""


@dataclass(frozen=True, slots=True)
class CtcRun:
    start: int
    end: int
    token_id: int
    token: str
    text_start: int
    text_end: int
    selected_probability: float
    run_max_probability: float


@dataclass(frozen=True, slots=True)
class AlignmentRecord:
    detector_slot: int
    polygon: tuple[Point, ...]
    crop_width: int
    crop_height: int
    pre_rotation_width: int
    pre_rotation_height: int
    rotated_90: bool
    source_to_rect: Matrix
    blank_intervals: tuple[tuple[int, int], ...]
    resize_content_width: int
    normalized_width: int
    batch_width: int
    time_steps: int
    text: str
    confidence: float
    runs: tuple[CtcRun, ...]
    page_index: int = 0
    record_id: int = 0
    raster_width: int = 0
    raster_height: int = 0
    normalized_shape: tuple[int, ...] = ()
    batch_shape: tuple[int, ...] = ()


def _operations(pipeline: Any) -> tuple[Any, ...]:
    seen: set[int] = set()
    owner = pipeline
    while id(owner) not in seen:
        seen.add(id(owner))
        namespace = getattr(owner, "__dict__", {})
        if namespace.get("_multi_device_inference", False):
            raise UnsupportedAlignmentPipeline("Multi-device OCR alignment is unsupported.")
        if "_crop_by_polys" in namespace and "text_rec_model" in namespace:
            break
        nested = namespace.get("paddlex_pipeline", namespace.get("_pipeline"))
        if nested is None:
            raise UnsupportedAlignmentPipeline("No owned OCR cropper/recognizer pair.")
        owner = nested
    else:
        raise UnsupportedAlignmentPipeline("Cyclic OCR pipeline ownership.")
    cropper, recognizer = owner._crop_by_polys, owner.text_rec_model
    transforms = getattr(recognizer, "pre_tfs", None)
    if not isinstance(transforms, dict):
        raise UnsupportedAlignmentPipeline("Recognizer transforms are unavailable.")
    reader, resize, batch = (transforms.get(key) for key in ("Read", "ReisizeNorm", "ToBatch"))
    decoder = getattr(recognizer, "post_op", None)
    checks = (
        callable(cropper),
        getattr(cropper, "det_box_type", None) == "quad",
        callable(getattr(cropper, "get_rotate_crop_image", None)),
        callable(getattr(recognizer, "process", None)),
        callable(getattr(reader, "read", None)),
        getattr(reader, "format", None) in ("RGB", "BGR"),
        callable(getattr(resize, "resize_norm_img", None)),
        getattr(resize, "input_shape", "unsupported") is None,
        callable(batch),
        callable(decoder),
        callable(getattr(decoder, "get_ignored_tokens", None)),
        getattr(decoder, "reverse", None) is False,
        getattr(recognizer, "return_word_box", None) is False,
        not getattr(owner, "use_textline_orientation", False),
    )
    if not all(checks):
        raise UnsupportedAlignmentPipeline("Unsupported OCR crop/resize/CTC structure.")
    return owner, cropper, recognizer, reader, resize, batch, decoder


def alignment_available(pipeline: Any) -> bool:
    """Probe injected/custom pipelines; canonical attachment must still raise."""
    try:
        _operations(pipeline)
    except UnsupportedAlignmentPipeline:
        return False
    return True


class AlignmentCollector:
    """Collect immutable alignment evidence from exactly one inference context."""

    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline
        self._undo: list[Any] = []
        self._records: list[AlignmentRecord] = []
        self._refs: list[Any] = []
        self._crops: dict[int, dict[str, Any]] = {}
        self._aliases: dict[int, int] = {}
        self._frame: dict[str, Any] | None = None
        self._pages = 0
        self._entered = False

    @property
    def records(self) -> tuple[AlignmentRecord, ...]:
        return tuple(sorted(self._records, key=lambda record: record.record_id))

    def _attribute(self, owner: Any, name: str, value: Any) -> None:
        namespace = vars(owner)
        present, previous = name in namespace, namespace.get(name)
        setattr(owner, name, value)
        self._undo.append(
            lambda: setattr(owner, name, previous) if present else delattr(owner, name)
        )

    def _entry(self, mapping: dict[str, Any], name: str, value: Any) -> None:
        previous = mapping[name]
        mapping[name] = value
        self._undo.append(lambda: mapping.__setitem__(name, previous))

    def _active_frame(self) -> dict[str, Any]:
        if self._frame is None:
            raise AlignmentContractError("Recognition operation outside its process call.")
        return self._frame

    def _remember(self, array: Any, crop_id: int) -> None:
        if id(array) in self._aliases and self._aliases[id(array)] != crop_id:
            raise AlignmentContractError("Array identity was reused for another crop.")
        self._refs.append(array)
        self._aliases[id(array)] = crop_id

    def __enter__(self) -> AlignmentCollector:
        if self._entered:
            raise AlignmentContractError("An alignment collector cannot be reused.")
        self._entered = True
        owner, cropper, recognizer, reader, resize, batch, decoder = _operations(self._pipeline)
        cv2: Any = importlib.import_module("cv2")
        np: Any = importlib.import_module("numpy")

        original_crop = cropper.get_rotate_crop_image
        original_process = recognizer.process
        original_read = reader.read
        original_resize = resize.resize_norm_img

        def crop(image: Any, points: Any) -> Any:
            result = original_crop(image, points)
            quad = np.asarray(points)
            if quad.shape != (4, 2) or not np.isfinite(quad).all():
                raise AlignmentContractError("Crop homography requires a finite quadrilateral.")
            width = int(max(np.linalg.norm(quad[0] - quad[1]), np.linalg.norm(quad[2] - quad[3])))
            height = int(max(np.linalg.norm(quad[0] - quad[3]), np.linalg.norm(quad[1] - quad[2])))
            if min(width, height) <= 0:
                raise AlignmentContractError("Crop has no area.")
            rotated = height / width >= 1.5
            expected = (width, height) if rotated else (height, width)
            if tuple(result.shape[:2]) != expected or result.ndim != 3 or result.shape[2] != 3:
                raise AlignmentContractError("Crop dimensions differ from canonical rotation.")
            destination = np.asarray(
                [[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float32
            )
            matrix = cv2.getPerspectiveTransform(quad, destination)
            if not np.isfinite(matrix).all():
                raise AlignmentContractError("Crop homography is nonfinite.")
            gray = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
            _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
            blank = np.count_nonzero(ink, axis=0) == 0
            intervals, start = [], None
            for index, value in enumerate((*blank.tolist(), False)):
                if value and start is None:
                    start = index
                elif not value and start is not None:
                    intervals.append((start, index))
                    start = None
            key = id(result)
            if key in self._crops:
                raise AlignmentContractError("Cropper reused a live crop object.")
            self._crops[key] = dict(
                record_id=len(self._crops),
                page_index=self._pages,
                detector_slot=-1,
                polygon=(),
                crop_width=int(result.shape[1]),
                crop_height=int(result.shape[0]),
                pre_rotation_width=width,
                pre_rotation_height=height,
                rotated_90=rotated,
                source_to_rect=tuple(tuple(float(value) for value in row) for row in matrix),
                blank_intervals=tuple(intervals),
                raster_width=int(image.shape[1]),
                raster_height=int(image.shape[0]),
            )
            self._remember(result, key)
            return result

        def crop_page(image: Any, dt_polys: Any) -> Any:
            result = cropper(image, dt_polys)
            if len(result) != len(dt_polys):
                raise AlignmentContractError("Detector and crop counts differ.")
            for slot, (array, polygon) in enumerate(zip(result, dt_polys, strict=True)):
                evidence = self._crops.get(id(array))
                if evidence is None or evidence["detector_slot"] != -1:
                    raise AlignmentContractError("Crop identity is not unique.")
                points = np.asarray(polygon)
                if points.shape != (4, 2) or not np.isfinite(points).all():
                    raise AlignmentContractError("Detector polygon is not a finite quad.")
                evidence.update(
                    detector_slot=slot, polygon=tuple(tuple(float(v) for v in p) for p in points)
                )
            self._pages += 1
            return result

        def read(image: Any) -> Any:
            result = original_read(image)
            frame = self._active_frame()
            key = id(image)
            if key not in frame["inputs"] or key not in self._crops:
                raise AlignmentContractError("Reader input is not an observed crop.")
            self._remember(result, key)
            return result

        def normalize(image: Any, max_wh_ratio: float) -> Any:
            result = original_resize(image, max_wh_ratio)
            frame = self._active_frame()
            key = self._aliases.get(id(image))
            if key is None or key not in frame["inputs"]:
                raise AlignmentContractError("Resize input lost its crop identity.")
            channels, height, _ = resize.rec_image_shape
            requested_width = int(height * max_wh_ratio)
            width = min(resize.max_imgW, requested_width)
            content = (
                resize.max_imgW
                if requested_width > resize.max_imgW
                else min(width, math.ceil(height * image.shape[1] / image.shape[0]))
            )
            if tuple(result.shape) != (channels, height, width) or min(content, width) <= 0:
                raise AlignmentContractError("Resize output differs from canonical dimensions.")
            self._remember(result, key)
            frame["normalized"][id(result)] = (key, content, tuple(int(v) for v in result.shape))
            return result

        def to_batch(imgs: Any) -> Any:
            result = batch(imgs)
            frame = self._active_frame()
            if frame["batch"] is not None or len(result) != 1:
                raise AlignmentContractError("Expected one recognizer tensor per process call.")
            tensor = np.asarray(result[0])
            if tensor.ndim != 4 or tensor.shape[0] != len(imgs):
                raise AlignmentContractError("Unexpected recognition batch dimensions.")
            rows = []
            for index, array in enumerate(imgs):
                value = frame["normalized"].get(id(array))
                if value is None:
                    raise AlignmentContractError("Batch input lost its normalized identity.")
                width = array.shape[2]
                if not np.array_equal(tensor[index, :, :, :width], array) or np.any(
                    tensor[index, :, :, width:] != 0
                ):
                    raise AlignmentContractError("Batch changed row order/content or padding.")
                rows.append(value)
            if len({row[0] for row in rows}) != len(rows) or {row[0] for row in rows} != set(
                frame["inputs"]
            ):
                raise AlignmentContractError("Batch crop correspondence is not one-to-one.")
            frame["batch"] = (tuple(rows), tuple(int(v) for v in tensor.shape))
            return result

        def postprocess(predictions: Any, *args: Any, **kwargs: Any) -> Any:
            result = decoder(predictions, *args, **kwargs)
            frame = self._active_frame()
            if args or kwargs.get("return_word_box", False) or decoder.get_ignored_tokens() != [0]:
                raise AlignmentContractError("Unsupported CTC decoding options.")
            if frame["decoded"] is not None or frame["batch"] is None:
                raise AlignmentContractError("CTC output has no unique batch.")
            probabilities = np.asarray(predictions[0])
            rows, _ = frame["batch"]
            characters = decoder.character
            if (
                probabilities.ndim != 3
                or probabilities.shape[0] != len(rows)
                or probabilities.shape[1] <= 0
                or probabilities.shape[2] != len(characters)
                or not np.isfinite(probabilities).all()
            ):
                raise AlignmentContractError("Unexpected CTC tensor/dictionary dimensions.")
            ids, maxima = probabilities.argmax(-1), probabilities.max(-1)
            if len(result) != 2 or len(result[0]) != len(rows) or len(result[1]) != len(rows):
                raise AlignmentContractError("CTC decoder returned an unexpected batch.")
            decoded = []
            for row, (path, values) in enumerate(zip(ids, maxima, strict=True)):
                runs, tokens, selected = [], [], []
                offset, start = 0, 0
                while start < len(path):
                    end = start + 1
                    while end < len(path) and path[end] == path[start]:
                        end += 1
                    token_id = int(path[start])
                    token = characters[token_id] if token_id else ""
                    if not isinstance(token, str):
                        raise AlignmentContractError("CTC dictionary token is not text.")
                    runs.append(
                        CtcRun(
                            start,
                            end,
                            token_id,
                            token,
                            offset,
                            offset + len(token),
                            float(values[start]),
                            float(values[start:end].max()),
                        )
                    )
                    if token_id:
                        tokens.append(token)
                        selected.append(values[start])
                    offset += len(token)
                    start = end
                text = "".join(tokens)
                confidence = (
                    float(np.asarray(selected, dtype=values.dtype).mean()) if selected else 0.0
                )
                if text != result[0][row] or confidence != float(result[1][row]):
                    raise AlignmentContractError("CTC runs do not reproduce decoder text/score.")
                decoded.append((text, confidence, len(path), tuple(runs)))
            frame["decoded"] = tuple(decoded)
            return result

        def process(batch_data: Any, *args: Any, **kwargs: Any) -> Any:
            if self._frame is not None:
                raise AlignmentContractError("Concurrent/nested recognizer process call.")
            inputs = tuple(id(array) for array in batch_data.instances)
            if len(set(inputs)) != len(inputs) or any(key not in self._crops for key in inputs):
                raise AlignmentContractError("Recognition batch contains unknown/duplicate crops.")
            frame: dict[str, Any] = dict(inputs=inputs, normalized={}, batch=None, decoded=None)
            self._frame = frame
            try:
                result = original_process(batch_data, *args, **kwargs)
                if frame["batch"] is None or frame["decoded"] is None:
                    raise AlignmentContractError(
                        "Recognition skipped required alignment operations."
                    )
                rows, shape = frame["batch"]
                decoded = frame["decoded"]
                if len(result["rec_text"]) != len(rows) or len(result["rec_score"]) != len(rows):
                    raise AlignmentContractError("Recognition result count differs from CTC batch.")
                records = []
                for index, (
                    (key, content, normalized_shape),
                    (text, score, steps, runs),
                ) in enumerate(zip(rows, decoded, strict=True)):
                    if (
                        result["rec_text"][index] != text
                        or float(result["rec_score"][index]) != score
                    ):
                        raise AlignmentContractError(
                            "Recognition result differs from same-call CTC."
                        )
                    records.append(
                        AlignmentRecord(
                            **self._crops[key],
                            resize_content_width=content,
                            normalized_width=normalized_shape[2],
                            normalized_shape=normalized_shape,
                            batch_width=shape[3],
                            batch_shape=shape,
                            time_steps=steps,
                            text=text,
                            confidence=score,
                            runs=runs,
                        )
                    )
                self._records.extend(records)
                return result
            finally:
                self._frame = None

        try:
            for component in (owner, cropper, recognizer, reader, resize):
                if getattr(component, "_capture_alignment_owner", None) is not None:
                    raise AlignmentContractError(
                        "Pipeline component already has an alignment collector."
                    )
                self._attribute(component, "_capture_alignment_owner", self)
            self._attribute(cropper, "get_rotate_crop_image", crop)
            self._attribute(owner, "_crop_by_polys", crop_page)
            self._attribute(reader, "read", read)
            self._attribute(resize, "resize_norm_img", normalize)
            self._entry(recognizer.pre_tfs, "ToBatch", to_batch)
            self._attribute(recognizer, "post_op", postprocess)
            self._attribute(recognizer, "process", process)
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> Literal[False]:
        failures: list[BaseException] = []
        try:
            while self._undo:
                try:
                    self._undo.pop()()
                except BaseException as error:
                    failures.append(error)
        finally:
            self._frame = None
            self._refs.clear()
            self._aliases.clear()
            self._crops.clear()
            if exc_type is not None or failures:
                self._records.clear()
        if failures:
            if exc_value is not None:
                for cleanup_error in failures:
                    exc_value.add_note(
                        "OCR alignment restoration failed: "
                        f"{type(cleanup_error).__name__}: {cleanup_error}"
                    )
            else:
                raise BaseExceptionGroup("OCR alignment restoration failed", failures)
        return False
