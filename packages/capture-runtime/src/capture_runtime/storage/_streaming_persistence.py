"""Private file and JSONL persistence primitives for streaming captures."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from capture_runtime.contracts import CaptureEventV2
from capture_runtime.storage._streaming_records import (
    _CaptureRecord,
    _IngestionRecord,
)


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def datetime_from_text(value: str) -> datetime:
    return datetime.fromisoformat(value)


class _StreamingRepositoryPersistence:
    """Own the streaming repository's on-disk layout and durable writes."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def initialize(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "ingestions").mkdir(exist_ok=True)
        (self.root / "captures").mkdir(exist_ok=True)

    def ingestion_directory(self, ingestion_id: str) -> Path:
        return self.root / "ingestions" / ingestion_id

    def capture_directory(self, capture_id: str) -> Path:
        return self.root / "captures" / capture_id

    def create_ingestion_directory(self, ingestion_id: str) -> None:
        directory = self.ingestion_directory(ingestion_id)
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "source.bin").touch()

    def create_capture_directory(self, capture_id: str) -> None:
        directory = self.capture_directory(capture_id)
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "events.jsonl").touch()

    @staticmethod
    def append_source(path: Path, data: bytes) -> None:
        with path.open("ab") as source:
            source.write(data)
            source.flush()
            os.fsync(source.fileno())

    @staticmethod
    def append_event(path: Path, event: CaptureEventV2) -> None:
        with path.open("a", encoding="utf-8") as events:
            events.write(json.dumps(event.model_dump(mode="json", by_alias=True)) + "\n")
            events.flush()
            os.fsync(events.fileno())

    @staticmethod
    def read_event_lines(path: Path) -> list[str]:
        return path.read_text(encoding="utf-8").splitlines()

    def persist_ingestion(self, record: _IngestionRecord) -> None:
        _atomic_json(self.ingestion_directory(record.ingestion_id) / "metadata.json", record.dump())

    def persist_capture(self, record: _CaptureRecord) -> None:
        _atomic_json(
            self.capture_directory(record.operation.capture_id) / "metadata.json",
            record.dump(),
        )

    def load_ingestions(
        self,
        identifier: Callable[[str], str],
        *,
        datetime_parser: Callable[[str], datetime] = datetime_from_text,
    ) -> list[_IngestionRecord]:
        records: list[_IngestionRecord] = []
        for directory in (self.root / "ingestions").iterdir():
            try:
                payload = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                record = _IngestionRecord.load(
                    payload,
                    ingestion_id=identifier(str(payload["ingestionId"])),
                    datetime_from_text=datetime_parser,
                )
            except (
                OSError,
                KeyError,
                TypeError,
                ValueError,
                ValidationError,
                json.JSONDecodeError,
            ):
                continue
            records.append(record)
        return records

    def load_captures(
        self,
        ingestions: Mapping[str, _IngestionRecord],
    ) -> list[_CaptureRecord]:
        records: list[_CaptureRecord] = []
        for directory in (self.root / "captures").iterdir():
            try:
                payload = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                record = _CaptureRecord.load(
                    payload,
                    kind_for_ingestion=lambda ingestion_id: (
                        ingestions[ingestion_id].request.kind
                        if ingestion_id in ingestions
                        else None
                    ),
                )
            except (
                OSError,
                KeyError,
                TypeError,
                ValueError,
                ValidationError,
                json.JSONDecodeError,
            ):
                continue
            records.append(record)
        return records

    def delete_capture_directory(self, directory: Path) -> None:
        if directory.parent.resolve() != (self.root / "captures").resolve():
            raise RuntimeError("capture directory escaped repository root")
        shutil.rmtree(directory, ignore_errors=True)

    def delete_ingestion_directory(self, directory: Path) -> None:
        if directory.parent.resolve() != (self.root / "ingestions").resolve():
            raise RuntimeError("ingestion directory escaped repository root")
        shutil.rmtree(directory, ignore_errors=True)


__all__ = [
    "_StreamingRepositoryPersistence",
    "_atomic_json",
    "_file_sha256",
    "datetime_from_text",
]
