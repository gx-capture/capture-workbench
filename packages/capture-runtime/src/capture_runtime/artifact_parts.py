"""Worker archives larger than one release asset are published as ordered parts.

GitHub release assets must stay under 2 GB, so an archive above `PART_BYTES` is
replaced by `<archive>.001`, `<archive>.002`, ... whose concatenation is the
archive. The catalog keeps the whole archive's size and digest and lists each part.
"""

from __future__ import annotations

import glob
import io
from pathlib import Path

PART_BYTES = 1_900_000_000
_COPY_CHUNK_BYTES = 1024 * 1024


def part_file_name(file_name: str, index: int) -> str:
    """Name of the one-based `index`th part of `file_name`."""

    return f"{file_name}.{index:03d}"


def split_archive(archive: Path, *, part_bytes: int = PART_BYTES) -> list[Path]:
    """Replace an archive above `part_bytes` with its parts; return the published files."""

    # A rebuild in the same directory replaces the parts an earlier build left.
    for stale in archive.parent.glob(f"{glob.escape(archive.name)}.[0-9][0-9][0-9]"):
        stale.unlink()
    if archive.stat().st_size <= part_bytes:
        return [archive]
    parts: list[Path] = []
    with archive.open("rb") as source:
        while True:
            part = archive.with_name(part_file_name(archive.name, len(parts) + 1))
            written = 0
            with part.open("xb") as destination:
                while written < part_bytes:
                    chunk = source.read(min(_COPY_CHUNK_BYTES, part_bytes - written))
                    if not chunk:
                        break
                    destination.write(chunk)
                    written += len(chunk)
            if not written:
                part.unlink()
                break
            parts.append(part)
            if written < part_bytes:
                break
    archive.unlink()
    return parts


def archive_parts(directory: Path, file_name: str) -> list[Path]:
    """The archive itself, or its parts in order when it was split."""

    whole = directory / file_name
    found = sorted(directory.glob(f"{glob.escape(file_name)}.[0-9][0-9][0-9]"))
    if whole.is_file():
        if found:
            raise ValueError(f"{file_name} exists both whole and as parts")
        return [whole]
    expected = [directory / part_file_name(file_name, index) for index in range(1, len(found) + 1)]
    if not found or found != expected:
        raise FileNotFoundError(whole)
    return found


class JoinedParts(io.RawIOBase):
    """Read-only, seekable view of files as if they were one, for `zipfile`."""

    def __init__(self, paths: list[Path]) -> None:
        super().__init__()
        self._files = [path.open("rb") for path in paths]
        self._sizes = [path.stat().st_size for path in paths]
        self._size = sum(self._sizes)
        self._position = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._position, io.SEEK_END: self._size}[whence]
        if base + offset < 0:
            raise ValueError("negative seek position")
        self._position = base + offset
        return self._position

    def readinto(self, buffer: memoryview) -> int:  # type: ignore[override]
        # A view, so that reads into its slices fill the caller's buffer.
        buffer = memoryview(buffer).cast("B")
        wanted = min(len(buffer), max(0, self._size - self._position))
        filled, start = 0, 0
        for handle, size in zip(self._files, self._sizes, strict=True):
            end = start + size
            if filled < wanted and start <= self._position < end:
                handle.seek(self._position - start)
                count = handle.readinto(
                    buffer[filled : filled + min(wanted - filled, end - self._position)]
                )
                filled += count
                self._position += count
            start = end
        return filled

    def close(self) -> None:
        for handle in self._files:
            handle.close()
        super().close()
