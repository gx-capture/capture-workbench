"""Whole-page reader for vertical Japanese pages, built on NDLOCR-Lite.

NDLOCR-Lite (National Diet Library, Japan; CC BY 4.0) supplies the models and the
layout and reading-order code under ``_vendor/ndlocr_lite``. This module is the
inference wrapper: it follows ``src/ocr.py``, ``src/deim.py`` and ``src/parseq.py``
of the pinned upstream commit step by step, so the text and line order equal
upstream's for the same raster, and adds a recognition score per line.

The line detector always runs on the CPU provider: on DirectML its output is
wrong. The three recognizers run on the DirectML device of the regular pipeline
when there is one, one line at a time, and otherwise on CPU threads.

The engine delivers upstream's files unchanged. Creating a session from an
upstream recognizer takes seconds, so each recognizer is optimized once per
machine by ONNX Runtime (extended level, CPU provider) into the shared engine
cache and loaded from there without further optimization. A cached file is used
only when it has the pinned size and digest; when the cache is off, cannot be
written, or this machine derives other bytes, the upstream file is loaded as
before, more slowly and with the same text. The detector is never derived: it
loads quickly as it is, and its derived form moves a few boxes by a pixel.
Imported only by the OCR worker; numpy, OpenCV and ONNX Runtime are required.
"""

from __future__ import annotations

import importlib
import io
import logging
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from capture_runtime.ocr_vertical_routing import (
    CHARSET,
    CLASSES,
    DERIVATION_ONNXRUNTIME,
    DERIVED_RECOGNIZER_FILES,
    DETECTOR,
    RECOGNIZER_30,
    RECOGNIZER_50,
    RECOGNIZER_100,
    VerticalLayoutError,
    cached_recognizer,
    read_reader_file,
)

DETECTION_THRESHOLD = 0.25
_LOGGER = logging.getLogger(__name__)


class VerticalReaderDeviceError(RuntimeError):
    """A recognizer asked to run on DirectML was not placed on it."""


@dataclass(frozen=True, slots=True)
class VerticalLine:
    text: str
    polygon: tuple[tuple[float, float], ...]
    confidence: float
    kind: str


def _numpy() -> Any:
    # Imported on use: the module itself stays importable without the WindowsML extras.
    return importlib.import_module("numpy")


def derive_recognizer(source: bytes, target: Path) -> None:
    """Write ONNX Runtime's extended-level optimization of an upstream recognizer."""

    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    options.optimized_model_filepath = str(target)
    onnxruntime.InferenceSession(source, options, providers=["CPUExecutionProvider"])


def _session_options(*, optimized: bool) -> Any:
    import onnxruntime

    options = onnxruntime.SessionOptions()
    # Optimizing a file that is already optimized only costs start-up.
    options.graph_optimization_level = (
        onnxruntime.GraphOptimizationLevel.ORT_DISABLE_ALL
        if optimized
        else onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
    )
    # The arena keeps every thread's peak allocation: about 400 MiB more per page read.
    options.enable_cpu_mem_arena = False
    return options


def _softmax_peak(logits: Any) -> Any:
    np = _numpy()
    shifted = logits - logits.max(axis=1, keepdims=True)
    exponent = np.exp(shifted)
    return (exponent / exponent.sum(axis=1, keepdims=True)).max(axis=1)


class _Detector:
    def __init__(self, model: bytes, classes: list[str]) -> None:
        import onnxruntime

        np = _numpy()
        self._session = onnxruntime.InferenceSession(
            model, _session_options(optimized=False), providers=["CPUExecutionProvider"]
        )
        self._inputs = [item.name for item in self._session.get_inputs()]
        self._outputs = [item.name for item in self._session.get_outputs()]
        self._height, self._width = self._session.get_inputs()[0].shape[2:]
        self.classes = classes
        self._mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        self._inverse_std = np.reciprocal(np.array([0.229, 0.224, 0.225], dtype=np.float32))

    def detect(self, image: Any) -> list[dict[str, Any]]:
        from PIL import Image

        np = _numpy()
        side = max(image.shape[0], image.shape[1])
        padded = np.zeros((side, side, 3), dtype=np.uint8)
        padded[: image.shape[0], : image.shape[1], :] = image
        resized = Image.fromarray(padded).resize((self._width, self._height))
        tensor = np.asarray(resized, dtype=np.float32)
        tensor *= np.float32(1.0 / 255.0)
        tensor -= self._mean
        tensor *= self._inverse_std
        tensor = np.ascontiguousarray(tensor.transpose(2, 0, 1)[np.newaxis, :, :, :])
        outputs = self._session.run(
            self._outputs,
            {
                self._inputs[0]: tensor,
                self._inputs[1]: np.array([[self._height, self._width]], np.int64),
            },
        )
        if len(outputs) == 4:
            class_ids, boxes, scores, counts = (np.squeeze(item) for item in outputs)
        elif len(outputs) == 3:
            class_ids, boxes, scores = (np.squeeze(item) for item in outputs)
            counts = np.array([100.0] * scores.shape[0])
        else:
            raise VerticalLayoutError("The line detector returned an unexpected output set.")
        if scores.ndim != 1 or boxes.ndim != 2:
            return []
        # Upstream filters boxes and scores only and pairs them with the unfiltered
        # class and count arrays; the detector returns candidates by falling score,
        # so the kept ones are a prefix. Kept as is for identical results.
        keep = scores > DETECTION_THRESHOLD
        boxes, scores = boxes[keep, :], scores[keep]
        scale = np.array([side / self._width] * 4, dtype=np.float32)
        boxes = (boxes[:, :4] * scale).astype(np.int32)
        boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]], 0, side)
        boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]], 0, side)
        return [
            {
                "class_index": int(label) - 1,
                "confidence": score,
                "box": box,
                "pred_char_count": count,
            }
            for box, score, label, count in zip(boxes, scores, class_ids, counts, strict=False)
        ]


class _Recognizer:
    def __init__(
        self,
        model: bytes,
        characters: Sequence[str],
        dml_device_id: int | None = None,
        *,
        optimized: bool,
    ) -> None:
        import onnxruntime

        options = _session_options(optimized=optimized)
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        providers: list[Any] = ["CPUExecutionProvider"]
        if dml_device_id is not None:
            # The settings DirectML requires, as for the regular pipeline.
            options.enable_mem_pattern = False
            options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
            providers.insert(0, ("DmlExecutionProvider", {"device_id": dml_device_id}))
        self._session = onnxruntime.InferenceSession(model, options, providers=providers)
        if dml_device_id is not None and self._session.get_providers()[0] != "DmlExecutionProvider":
            raise VerticalReaderDeviceError(
                "A vertical reader recognizer was not placed on DirectML."
            )
        self._input = self._session.get_inputs()[0].name
        self._outputs = [item.name for item in self._session.get_outputs()]
        self._height, self._width = self._session.get_inputs()[0].shape[2:]
        self._characters = characters

    def read(self, image: Any) -> tuple[str, float]:
        if image is None or image.size == 0:
            return "", 0.0
        cv2 = importlib.import_module("cv2")
        np = _numpy()
        height, width = image.shape[:2]
        if height > width * 0.8:
            image = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
        resized = cv2.resize(image, (self._width, self._height), interpolation=cv2.INTER_LINEAR)
        tensor = np.ascontiguousarray(resized[:, :, ::-1]).astype(np.float32)
        tensor /= 127.5
        tensor -= 1.0
        tensor = tensor.transpose(2, 0, 1)[np.newaxis, :, :, :]
        logits = self._session.run(self._outputs, {self._input: tensor})[0][0]
        indices = np.argmax(logits, axis=1)
        stops = np.where(indices == 0)[0]
        end = int(stops[0]) if stops.size > 0 else len(indices)
        text = "".join(self._characters[index - 1] for index in indices[:end].tolist())
        score = float(_softmax_peak(logits[:end]).mean()) if end else 0.0
        return text, score


@dataclass(slots=True)
class _Crop:
    image: Any
    index: int
    predicted_count: float
    text: str = ""
    score: float = 0.0


def _read_cascade(
    crops: list[_Crop],
    short: _Recognizer,
    middle: _Recognizer,
    long: _Recognizer,
    workers: int | None = None,
) -> list[_Crop]:
    """Upstream ``process_cascade``: shortest model first, overflow to the next one.

    ``workers`` is 1 on DirectML, where calls into a session cannot overlap.
    """

    done: list[_Crop] = []
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="vertical-reader") as executor:
        jobs_short = [
            (crop, executor.submit(short.read, crop.image))
            for crop in crops
            if crop.predicted_count == 3
        ]
        jobs_middle = [
            (crop, executor.submit(middle.read, crop.image))
            for crop in crops
            if crop.predicted_count == 2
        ]
        jobs_long = [
            (crop, executor.submit(long.read, crop.image))
            for crop in crops
            if crop.predicted_count not in (2, 3)
        ]
        for crop, future in jobs_short:
            text, score = future.result()
            if len(text) >= 25:
                jobs_middle.append((crop, executor.submit(middle.read, crop.image)))
            else:
                crop.text, crop.score = text, score
                done.append(crop)
        for crop, future in jobs_middle:
            text, score = future.result()
            if len(text) >= 45:
                jobs_long.append((crop, executor.submit(long.read, crop.image)))
            else:
                crop.text, crop.score = text, score
                done.append(crop)
        halves: list[tuple[_Crop, Any, Any]] = []
        for crop, future in jobs_long:
            crop.text, crop.score = future.result()
            if len(crop.text) >= 98 and crop.image.shape[0] < crop.image.shape[1]:
                middle_x = crop.image.shape[1] // 2
                halves.append(
                    (
                        crop,
                        executor.submit(long.read, crop.image[:, :middle_x, :]),
                        executor.submit(long.read, crop.image[:, middle_x:, :]),
                    )
                )
            else:
                done.append(crop)
        for crop, left, right in halves:
            (left_text, left_score), (right_text, right_score) = left.result(), right.result()
            crop.text = left_text + right_text
            total = len(left_text) + len(right_text)
            crop.score = (
                (left_score * len(left_text) + right_score * len(right_text)) / total
                if total
                else 0.0
            )
            done.append(crop)
    return sorted(done, key=lambda crop: crop.index)


class VerticalPageReader:
    """Loads the four models once and reads PNG pages into ordered lines."""

    def __init__(
        self,
        directory: Path,
        *,
        dml_device_id: int | None = None,
        cache_root: Path | None = None,
    ) -> None:
        import yaml

        self.recognizer_device = "cpu" if dml_device_id is None else "windowsml-dml"
        self._workers = None if dml_device_id is None else 1

        import onnxruntime

        classes = yaml.safe_load(read_reader_file(directory, CLASSES).decode("utf-8"))["names"]
        charset = yaml.safe_load(read_reader_file(directory, CHARSET).decode("utf-8"))
        characters = tuple(charset["model"]["charset_train"])
        # Every model is created from the bytes that were checked, never from a path.
        self._detector = _Detector(read_reader_file(directory, DETECTOR), list(classes.values()))
        recognizers: list[_Recognizer] = []
        self.derived_recognizers = 0
        for name in (RECOGNIZER_30, RECOGNIZER_50, RECOGNIZER_100):
            upstream = read_reader_file(directory, name)
            derived = cached_recognizer(
                upstream,
                DERIVED_RECOGNIZER_FILES[name],
                cache_root,
                derive_recognizer,
                derivable=onnxruntime.__version__ == DERIVATION_ONNXRUNTIME,
            )
            self.derived_recognizers += derived is not None
            recognizers.append(
                _Recognizer(
                    upstream if derived is None else derived,
                    characters,
                    dml_device_id,
                    optimized=derived is not None,
                )
            )
        self._short, self._middle, self._long = recognizers

    def read_png(self, image_png: bytes) -> tuple[VerticalLine, ...]:
        from PIL import Image

        np = _numpy()
        with Image.open(io.BytesIO(image_png)) as source:
            image = np.array(source.convert("RGB"))
        return self.read_array(image)

    def read_array(self, image: Any) -> tuple[VerticalLine, ...]:
        height, width = image.shape[:2]
        detections = self._detector.detect(image)
        try:
            root = _ordered_layout(width, height, self._detector.classes, detections)
        except Exception as error:
            raise VerticalLayoutError(f"{type(error).__name__}: {error}") from error
        elements = root.findall(".//LINE")
        crops: list[_Crop] = []
        for index, element in enumerate(elements):
            left, top = int(element.get("X", "0")), int(element.get("Y", "0"))
            line_width, line_height = (
                int(element.get("WIDTH", "0")),
                int(element.get("HEIGHT", "0")),
            )
            try:
                predicted = float(element.get("PRED_CHAR_CNT", ""))
            except ValueError:
                predicted = 100.0
            crops.append(
                _Crop(
                    image[max(top, 0) : top + line_height, max(left, 0) : left + line_width, :],
                    index,
                    predicted,
                )
            )
        read = _read_cascade(crops, self._short, self._middle, self._long, self._workers)
        lines: list[VerticalLine] = []
        for element, crop in zip(elements, read, strict=True):
            x, y = int(element.get("X", "0")), int(element.get("Y", "0"))
            left, top = min(max(x, 0), width), min(max(y, 0), height)
            right = min(max(x + int(element.get("WIDTH", "0")), left), width)
            bottom = min(max(y + int(element.get("HEIGHT", "0")), top), height)
            lines.append(
                VerticalLine(
                    text=crop.text,
                    polygon=(
                        (float(left), float(top)),
                        (float(right), float(top)),
                        (float(right), float(bottom)),
                        (float(left), float(bottom)),
                    ),
                    confidence=crop.score,
                    kind=element.get("TYPE", ""),
                )
            )
        return tuple(lines)


def _ordered_layout(
    width: int, height: int, classes: list[str], detections: list[dict[str, Any]]
) -> ET.Element:
    """Upstream ``_run_ocr_on_image_array`` up to the ordered line elements."""

    from capture_runtime._vendor.ndlocr_lite.ndl_parser import convert_to_xml_string3
    from capture_runtime._vendor.ndlocr_lite.reading_order.xy_cut.eval import eval_xml

    blocks: list[list[Any]] = []
    by_class: dict[int, list[list[Any]]] = {index: [] for index in range(17)}
    for detection in detections:
        left, top, right, bottom = detection["box"]
        if detection["class_index"] == 0:
            blocks.append([left, top, right, bottom])
        by_class[detection["class_index"]].append(
            [left, top, right, bottom, detection["confidence"], detection["pred_char_count"]]
        )
    page = convert_to_xml_string3(width, height, "page", classes, [{0: blocks}, by_class])
    root = ET.fromstring("<OCRDATASET>" + page.replace("&", "&amp;") + "</OCRDATASET>")
    eval_xml(root, logger=_LOGGER)  # type: ignore[no-untyped-call]
    if not root.findall(".//LINE") and detections:
        page_element = root.find("PAGE")
        if page_element is None:
            raise VerticalLayoutError("The layout has no page element.")
        for detection in detections:
            left, top, right, bottom = detection["box"]
            line_width, line_height = int(right - left), int(bottom - top)
            if line_width <= 0 or line_height <= 0:
                continue
            element = ET.SubElement(page_element, "LINE")
            element.set("TYPE", "本文")
            element.set("X", str(int(left)))
            element.set("Y", str(int(top)))
            element.set("WIDTH", str(line_width))
            element.set("HEIGHT", str(line_height))
            element.set("CONF", f"{detection['confidence']:0.3f}")
            element.set("PRED_CHAR_CNT", f"{detection['pred_char_count']:0.3f}")
    return root
