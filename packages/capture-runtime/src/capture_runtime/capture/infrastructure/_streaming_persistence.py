"""Private file and JSONL persistence primitives for streaming captures."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from capture_runtime.capture.infrastructure._streaming_records import (
    _CaptureRecord,
    _IngestionRecord,
)
from capture_runtime.contracts import CaptureEventV2

_LOGGER = logging.getLogger(__name__)


def _event_sequence(line: bytes) -> int | None:
    """The sequence of one event-log line, or None for a blank or damaged line."""
    if not line.strip():
        return None
    try:
        sequence = json.loads(line.decode("utf-8"))["sequence"]
    except (KeyError, TypeError, ValueError):
        return None
    return sequence if isinstance(sequence, int) and not isinstance(sequence, bool) else None


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
    def write_source(path: Path, offset: int, data: bytes) -> None:
        """Write a chunk at its accepted offset.

        A write that failed halfway (a full disk) leaves bytes after the last
        accepted chunk; appending the replay after them would shift every later
        chunk. Truncating to the offset first replaces that tail; accepted bytes
        before the offset are never changed.
        """
        with path.open("r+b") as source:
            source.truncate(offset)
            source.seek(offset)
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
    ) -> tuple[list[_IngestionRecord], list[Path]]:
        records: list[_IngestionRecord] = []
        invalid_directories: list[Path] = []
        for directory in (self.root / "ingestions").iterdir():
            if not directory.is_dir() or directory.is_symlink():
                continue
            try:
                raw = (directory / "metadata.json").read_bytes()
            except FileNotFoundError:
                # A crash in create_ingestion before its metadata: nothing can reach it.
                invalid_directories.append(directory)
                continue
            except OSError:
                # Unreadable now (a lock, a permission) is not proof of damage: keep
                # the directory; the next start reads it again.
                _LOGGER.warning("Ingestion metadata unreadable at startup; left in place")
                continue
            try:
                payload = json.loads(raw.decode("utf-8"))
                record = _IngestionRecord.load(
                    payload,
                    ingestion_id=identifier(str(payload["ingestionId"])),
                    datetime_from_text=datetime_parser,
                )
            except (
                KeyError,
                TypeError,
                ValueError,
                ValidationError,
                json.JSONDecodeError,
            ):
                invalid_directories.append(directory)
                continue
            records.append(record)
        return records, invalid_directories

    def load_captures(
        self,
        ingestions: Mapping[str, _IngestionRecord],
    ) -> tuple[list[_CaptureRecord], bool]:
        """Loadable captures, and whether every capture directory could be read.

        A capture that cannot be loaded still references its ingestion; when one is
        skipped, the caller cannot know every reference.
        """
        records: list[_CaptureRecord] = []
        complete = True
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
                complete = False
                continue
            records.append(record)
        return records, complete

    @staticmethod
    def recover_last_event_sequence(path: Path) -> int | None:
        """The sequence of the last complete event in a capture's log, or None.

        A crash can leave the last line unfinished. Startup repairs it so the next
        event starts on a line of its own: a tail that is a whole event gets its
        newline, anything else is cut. Lines that cannot be decoded are skipped.
        """
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None
        if raw and not raw.endswith(b"\n"):
            cut = raw.rfind(b"\n") + 1
            if _event_sequence(raw[cut:]) is not None:
                with path.open("ab") as log:
                    log.write(b"\n")
                    log.flush()
                    os.fsync(log.fileno())
                raw += b"\n"
            else:
                with path.open("r+b") as log:
                    log.truncate(cut)
                    log.flush()
                    os.fsync(log.fileno())
                raw = raw[:cut]
        for line in reversed(raw.split(b"\n")):
            sequence = _event_sequence(line)
            if sequence is not None:
                return sequence
        return None

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
