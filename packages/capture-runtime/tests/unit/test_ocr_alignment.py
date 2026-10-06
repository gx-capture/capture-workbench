from __future__ import annotations

import weakref
from dataclasses import FrozenInstanceError
from types import SimpleNamespace

import pytest

from capture_runtime.ocr_alignment import (
    AlignmentCollector,
    AlignmentContractError,
    UnsupportedAlignmentPipeline,
    alignment_available,
)

cv2 = pytest.importorskip("cv2", reason="Pixel alignment tests require WindowsML OpenCV extras.")
np = pytest.importorskip("numpy", reason="Pixel alignment tests require WindowsML NumPy extras.")


class Cropper:
    det_box_type = "quad"

    def __init__(self):
        self.calls = 0
        self.outputs = []

    def get_rotate_crop_image(self, image, points):
        self.calls += 1
        width = int(
            max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3]))
        )
        height = int(
            max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2]))
        )
        destination = np.float32([[0, 0], [width, 0], [width, height], [0, height]])
        crop = cv2.warpPerspective(
            image, cv2.getPerspectiveTransform(points, destination), (width, height)
        )
        if height / width >= 1.5:
            crop = np.rot90(crop)
        self.outputs.append(crop)
        return crop

    def __call__(self, image, polygons):
        return [
            self.get_rotate_crop_image(image, np.asarray(poly, dtype=np.float32))
            for poly in polygons
        ]


class Reader:
    format = "RGB"

    def __init__(self):
        self.calls = 0

    def read(self, image):
        self.calls += 1
        return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    def __call__(self, imgs):
        return [self.read(image) for image in imgs]


class Resize:
    rec_image_shape = (3, 8, 16)
    input_shape = None
    max_imgW = 32

    def __init__(self):
        self.calls = 0

    def resize_norm_img(self, image, max_wh_ratio):
        self.calls += 1
        width = int(self.rec_image_shape[1] * max_wh_ratio)
        content = (
            self.max_imgW
            if width > self.max_imgW
            else min(width, int(np.ceil(8 * image.shape[1] / image.shape[0])))
        )
        width = min(width, self.max_imgW)
        normalized = np.zeros((3, 8, width), dtype=np.float32)
        normalized[:, :, :content] = cv2.resize(image, (content, 8)).transpose(2, 0, 1) / 127.5 - 1
        return normalized

    def __call__(self, imgs):
        return [
            self.resize_norm_img(image, max(2, image.shape[1] / image.shape[0])) for image in imgs
        ]


class Batch:
    def __init__(self):
        self.calls = 0
        self.last_output = None

    def __call__(self, imgs):
        self.calls += 1
        width = max(image.shape[-1] for image in imgs)
        self.last_output = [
            np.stack(
                [np.pad(image, ((0, 0), (0, 0), (0, width - image.shape[-1]))) for image in imgs]
            )
        ]
        return self.last_output


class Decode:
    character = ("blank", "A", "B")
    reverse = False

    def __init__(self):
        self.calls = 0
        self.last_output = None

    def get_ignored_tokens(self):
        return [0]

    def __call__(self, predictions, return_word_box=False, **kwargs):
        self.calls += 1
        probabilities = predictions[0]
        ids = probabilities.argmax(-1)
        maxima = probabilities.max(-1)
        texts, scores = [], []
        for path, values in zip(ids, maxima, strict=True):
            selected = [
                i for i, token in enumerate(path) if token and (i == 0 or token != path[i - 1])
            ]
            texts.append("".join(self.character[path[i]] for i in selected))
            scores.append(float(values[selected].mean()) if selected else 0.0)
        self.last_output = (texts, scores)
        return self.last_output


class Recognizer:
    return_word_box = False

    def __init__(self, paths=((0, 1, 1, 0, 2, 0),)):
        self.paths = paths
        self.pre_tfs = {"Read": Reader(), "ReisizeNorm": Resize(), "ToBatch": Batch()}
        self.post_op = Decode()
        self.calls = 0
        self.runner_calls = 0
        self.last_output = None

    def process(self, batch_data, return_word_box=False):
        self.calls += 1
        images = self.pre_tfs["Read"](imgs=batch_data.instances)
        normalized = self.pre_tfs["ReisizeNorm"](imgs=images)
        tensor = self.pre_tfs["ToBatch"](imgs=normalized)
        self.runner_calls += 1
        assert tensor[0].shape[0] == len(self.paths)
        predictions = np.full((len(self.paths), len(self.paths[0]), 3), 0.01, dtype=np.float32)
        for row, path in enumerate(self.paths):
            for time, token in enumerate(path):
                predictions[row, time, token] = 0.8 + row * 0.05
        texts, scores = self.post_op([predictions], return_word_box=return_word_box)
        self.last_output = {"input_img": images, "rec_text": texts, "rec_score": scores}
        return self.last_output


class Pipeline:
    def __init__(self, paths=((0, 1, 1, 0, 2, 0),)):
        self._crop_by_polys = Cropper()
        self.text_rec_model = Recognizer(paths)

    def predict(self, image, polygons, *, order=None):
        crops = self._crop_by_polys(image, polygons)
        if order is not None:
            crops = [crops[index] for index in order]
        return self.text_rec_model.process(SimpleNamespace(instances=crops))


def test_same_inference_collector_preserves_result_and_tracks_geometry() -> None:
    pipeline = Pipeline()
    image = np.full((20, 30, 3), 255, dtype=np.uint8)
    image[2:6, 5:9] = 0
    polygon = ((0, 0), (16, 0), (16, 8), (0, 8))
    originals = (
        pipeline._crop_by_polys,
        pipeline.text_rec_model.pre_tfs["ToBatch"],
        pipeline.text_rec_model.post_op,
    )

    with AlignmentCollector(pipeline) as collector:
        result = pipeline.predict(image, [polygon])

    assert result is pipeline.text_rec_model.last_output
    assert (
        pipeline._crop_by_polys,
        pipeline.text_rec_model.pre_tfs["ToBatch"],
        pipeline.text_rec_model.post_op,
    ) == originals
    assert pipeline.text_rec_model.runner_calls == 1
    assert originals[0].calls == originals[1].calls == originals[2].calls == 1
    (record,) = collector.records
    assert record.detector_slot == 0
    assert record.polygon == polygon
    assert (record.crop_width, record.crop_height) == (16, 8)
    assert record.source_to_rect == ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    assert record.blank_intervals == ((0, 5), (9, 16))
    assert record.text == "AB"
    assert [(run.start, run.end, run.token) for run in record.runs] == [
        (0, 1, ""),
        (1, 3, "A"),
        (3, 4, ""),
        (4, 5, "B"),
        (5, 6, ""),
    ]
    assert record.confidence == result["rec_score"][0]


def test_collectors_are_pipeline_local_and_restore_instance_attribute_ownership() -> None:
    first, second = Pipeline(), Pipeline()
    image = np.full((16, 24, 3), 255, dtype=np.uint8)
    polygon = ((0, 0), (16, 0), (16, 8), (0, 8))
    first_cropper, second_cropper = first._crop_by_polys, second._crop_by_polys
    original_second = second.text_rec_model.process
    second.text_rec_model.process = original_second

    with AlignmentCollector(first) as first_observer:
        assert second._crop_by_polys is second_cropper
        with AlignmentCollector(second) as second_observer:
            first.predict(image, [polygon])
            second.predict(image, [polygon])
        assert first._crop_by_polys is not first_cropper
        assert second.text_rec_model.process is original_second

    assert first._crop_by_polys is first_cropper
    assert "process" not in vars(first.text_rec_model)
    assert "get_rotate_crop_image" not in vars(first_cropper)
    assert "read" not in vars(first.text_rec_model.pre_tfs["Read"])
    assert "resize_norm_img" not in vars(first.text_rec_model.pre_tfs["ReisizeNorm"])
    assert len(first_observer.records) == len(second_observer.records) == 1
    with pytest.raises(FrozenInstanceError):
        first_observer.records[0].text = "changed"


def test_provider_exception_propagates_and_restores_all_hooks() -> None:
    pipeline = Pipeline()
    error = RuntimeError("provider failed")

    def fail(*args, **kwargs):
        raise error

    pipeline.text_rec_model.process = fail
    reader = pipeline.text_rec_model.pre_tfs["Read"]
    resize = pipeline.text_rec_model.pre_tfs["ReisizeNorm"]
    batch = pipeline.text_rec_model.pre_tfs["ToBatch"]
    decoder = pipeline.text_rec_model.post_op
    cropper = pipeline._crop_by_polys
    image = np.full((16, 24, 3), 255, dtype=np.uint8)
    with pytest.raises(RuntimeError) as caught:
        with AlignmentCollector(pipeline) as collector:
            pipeline.predict(image, [((0, 0), (16, 0), (16, 8), (0, 8))])
    assert caught.value is error
    assert collector.records == ()
    assert pipeline.text_rec_model.process is fail
    assert pipeline._crop_by_polys is cropper
    assert pipeline.text_rec_model.post_op is decoder
    assert pipeline.text_rec_model.pre_tfs["ToBatch"] is batch
    assert "get_rotate_crop_image" not in vars(cropper)
    assert "read" not in vars(reader)
    assert "resize_norm_img" not in vars(resize)


def test_repeated_text_uses_crop_identity_across_recognition_batch_reordering() -> None:
    pipeline = Pipeline(paths=((0, 1, 0), (0, 1, 0)))
    image = np.full((32, 80, 3), 255, dtype=np.uint8)
    polygons = [((0, 0), (16, 0), (16, 8), (0, 8)), ((30, 0), (62, 0), (62, 8), (30, 8))]
    with AlignmentCollector(pipeline) as collector:
        result = pipeline.predict(image, polygons, order=[1, 0])
    assert [record.detector_slot for record in collector.records] == [0, 1]
    assert [record.text for record in collector.records] == ["A", "A"]
    assert [record.confidence for record in collector.records] == list(
        reversed(result["rec_score"])
    )
    assert [record.normalized_width for record in collector.records] == [16, 32]
    assert [record.batch_width for record in collector.records] == [32, 32]
    assert collector.records[0].polygon == polygons[0]


def test_rotated_crop_and_resize_cap_are_reported_without_a_second_crop() -> None:
    pipeline = Pipeline()
    image = np.full((100, 30, 3), 255, dtype=np.uint8)
    polygon = ((0, 0), (8, 0), (8, 80), (0, 80))
    with AlignmentCollector(pipeline) as collector:
        pipeline.predict(image, [polygon])
    (record,) = collector.records
    assert record.rotated_90
    assert (record.pre_rotation_width, record.pre_rotation_height) == (8, 80)
    assert (record.crop_width, record.crop_height) == (80, 8)
    assert (record.raster_width, record.raster_height) == (30, 100)
    assert record.resize_content_width == record.normalized_width == record.batch_width == 32
    assert record.normalized_shape == (3, 8, 32)
    assert record.batch_shape == (1, 3, 8, 32)
    assert pipeline._crop_by_polys.calls == pipeline.text_rec_model.runner_calls == 1


@pytest.mark.parametrize(
    "path,text,spans",
    [
        ((1, 1, 1), "A", [(0, 1)]),
        ((1, 0, 1), "AA", [(0, 1), (1, 2)]),
        ((0, 0, 0), "", []),
    ],
)
def test_ctc_maximal_runs_keep_repeated_letters_separated_only_by_blank(path, text, spans) -> None:
    pipeline = Pipeline(paths=(path,))
    with AlignmentCollector(pipeline) as collector:
        pipeline.predict(
            np.full((16, 24, 3), 255, dtype=np.uint8), [((0, 0), (16, 0), (16, 8), (0, 8))]
        )
    (record,) = collector.records
    assert record.text == text
    assert [(run.text_start, run.text_end) for run in record.runs if run.token_id] == spans
    assert record.time_steps == 3


@pytest.mark.parametrize("mismatch", ["text", "score"])
def test_decoder_mismatch_is_an_error_and_restores_instance_hooks(mismatch) -> None:
    class WrongDecode(Decode):
        def __call__(self, *args, **kwargs):
            texts, scores = super().__call__(*args, **kwargs)
            if mismatch == "text":
                texts[0] += "B"
            else:
                scores[0] -= 0.1
            return texts, scores

    pipeline = Pipeline()
    decoder = pipeline.text_rec_model.post_op = WrongDecode()
    with pytest.raises(AlignmentContractError, match="reproduce decoder"):
        with AlignmentCollector(pipeline) as collector:
            pipeline.predict(
                np.full((16, 24, 3), 255, dtype=np.uint8), [((0, 0), (16, 0), (16, 8), (0, 8))]
            )
    assert collector.records == ()
    assert pipeline.text_rec_model.post_op is decoder
    assert pipeline.text_rec_model.runner_calls == decoder.calls == 1


def test_arrays_are_released_after_context_and_unsupported_pipeline_is_explicit() -> None:
    pipeline = Pipeline()
    cropper = pipeline._crop_by_polys
    with AlignmentCollector(pipeline) as collector:
        pipeline.predict(
            np.full((16, 24, 3), 255, dtype=np.uint8), [((0, 0), (16, 0), (16, 8), (0, 8))]
        )
        reference = weakref.ref(cropper.outputs[0])
        cropper.outputs.clear()
        assert reference() is not None
    assert reference() is None
    assert len(collector.records) == 1
    custom = SimpleNamespace(predict=lambda image: [])
    assert not alignment_available(custom)
    with pytest.raises(UnsupportedAlignmentPipeline):
        with AlignmentCollector(custom):
            pass


def test_failed_batch_does_not_publish_partially_validated_records() -> None:
    pipeline = Pipeline(paths=((0, 1, 0), (0, 1, 0)))
    original = pipeline.text_rec_model.process

    def corrupt_second_result(*args, **kwargs):
        result = original(*args, **kwargs)
        result["rec_text"][1] = "different"
        return result

    pipeline.text_rec_model.process = corrupt_second_result
    with AlignmentCollector(pipeline) as collector:
        with pytest.raises(AlignmentContractError, match="same-call CTC"):
            pipeline.predict(
                np.full((16, 50, 3), 255, dtype=np.uint8),
                [((0, 0), (16, 0), (16, 8), (0, 8)), ((20, 0), (36, 0), (36, 8), (20, 8))],
            )
        assert collector.records == ()


@pytest.mark.parametrize("with_primary", [True, False])
def test_restoration_attempts_every_hook_without_masking_provider_failure(with_primary) -> None:
    class RestoreFailureRecognizer(Recognizer):
        fail_restore = False

        def __setattr__(self, name, value):
            if self.fail_restore and name == "post_op" and isinstance(value, Decode):
                raise RuntimeError("decoder restore failed")
            super().__setattr__(name, value)

    pipeline = Pipeline()
    pipeline.text_rec_model = RestoreFailureRecognizer()
    cropper = pipeline._crop_by_polys
    reader = pipeline.text_rec_model.pre_tfs["Read"]
    resize = pipeline.text_rec_model.pre_tfs["ReisizeNorm"]
    batch = pipeline.text_rec_model.pre_tfs["ToBatch"]
    primary = ValueError("original provider failure")
    with pytest.raises(BaseException) as caught:
        with AlignmentCollector(pipeline):
            pipeline.text_rec_model.fail_restore = True
            if with_primary:
                raise primary
    if with_primary:
        assert caught.value is primary
        assert "decoder restore failed" in " ".join(primary.__notes__)
    else:
        assert isinstance(caught.value, ExceptionGroup)
        assert str(caught.value.exceptions[0]) == "decoder restore failed"
    assert pipeline._crop_by_polys is cropper
    assert pipeline.text_rec_model.pre_tfs["ToBatch"] is batch
    for component in (pipeline, cropper, pipeline.text_rec_model, reader, resize):
        assert "_capture_alignment_owner" not in vars(component)
    assert "process" not in vars(pipeline.text_rec_model)
    assert "read" not in vars(reader)
    assert "resize_norm_img" not in vars(resize)
    assert "get_rotate_crop_image" not in vars(cropper)
