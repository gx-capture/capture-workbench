"""Ollama server log parsing for device discovery, scheduler, and runtime verification."""

from __future__ import annotations

import re
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from threading import Lock


@dataclass(frozen=True, slots=True)
class DiscoveredDevice:
    """Device discovered by Ollama's inference compute enumeration."""

    library: str
    id: str
    filter_id: str | None
    name: str
    description: str
    pci_id: str | None
    type: str
    libdirs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SchedulerSelection:
    """Device selected by Ollama's scheduler for a model execution."""

    library: str
    name: str
    description: str
    integrated: bool
    id: str
    filter_id: str


@dataclass(frozen=True, slots=True)
class ModelLoadStarted:
    """Boundary marker for a model load invocation."""

    trigger: str = ""


@dataclass(frozen=True, slots=True)
class RunnerDevice:
    """Actual device initialized by llama-server for model execution."""

    device_name: str
    description: str
    pci_bus: str | None


@dataclass(frozen=True, slots=True)
class BackendLoaded:
    """Backend dynamic library loaded by llama-server (directory token only, never path)."""

    library: str
    token: str


@dataclass(frozen=True, slots=True)
class LayerOffload:
    """Model layer offloading counts reported by llama-server."""

    offloaded_layers: int
    total_layers: int


@dataclass(frozen=True, slots=True)
class RunnerStarted:
    """Model runner readiness and startup duration."""

    duration_seconds: float


@dataclass(frozen=True, slots=True)
class CpuModelBuffer:
    """Positive CPU model tensor allocation in a runner load."""


type LogRecord = (
    DiscoveredDevice
    | SchedulerSelection
    | ModelLoadStarted
    | RunnerDevice
    | BackendLoaded
    | CpuModelBuffer
    | LayerOffload
    | RunnerStarted
)

MAX_LINE_LENGTH = 8192
MAX_RECORD_HISTORY = 512

_LOGFMT_PATTERN = re.compile(r'([a-zA-Z0-9_]+)=(?:"((?:\\.|[^"\\])*)"|([^\s]*))')
_RUNNER_DEVICE_PATTERN = re.compile(
    r"llama_prepare_model_devices:\s+using device\s+([^\s]+)\s+\((.*)\)\s+\(([^()]*)\)"
)
_BACKEND_LOADED_PATTERN = re.compile(r"load_backend:\s+loaded\s+(\w+)\s+backend from\s+(.*)")
_LAYER_OFFLOAD_PATTERN = re.compile(
    r"load_tensors:\s+offloaded\s+([0-9]{1,9})/([0-9]{1,9})\s+layers to GPU"
)
_RUNNER_STARTED_PATTERN = re.compile(r"llama-server started in\s+([0-9]+(?:\.[0-9]+)?)\s+seconds")


def _parse_logfmt_fields(line: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for match in _LOGFMT_PATTERN.finditer(line):
        key = match.group(1)
        quoted = match.group(2)
        if quoted is not None:
            val = quoted.replace(r"\"", '"').replace(r"\\", "\\")
        else:
            val = match.group(3) or ""
        fields[key] = val
    return fields


def _extract_lib_token(raw_path: str) -> str:
    parts = [p for p in re.split(r"[\\/]", raw_path.strip()) if p]
    if len(parts) >= 2 and re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", parts[-2]):
        return parts[-2]
    return "unknown"


def parse_log_line(line: str) -> LogRecord | None:
    """Parse one raw line of Ollama server logs into a structured record."""
    if len(line) > MAX_LINE_LENGTH:
        return None

    # 1. llama_prepare_model_devices: using device ...
    if line.startswith("llama_prepare_model_devices: using device"):
        match = _RUNNER_DEVICE_PATTERN.search(line)
        if match:
            dev_name = match.group(1).strip()
            desc = match.group(2).strip()
            bus_raw = match.group(3).strip()
            pci_bus = None if bus_raw.lower() == "unknown id" else bus_raw
            return RunnerDevice(device_name=dev_name, description=desc, pci_bus=pci_bus)

    # 2. load_backend: loaded ... backend from ...
    if line.startswith("load_backend: loaded"):
        match = _BACKEND_LOADED_PATTERN.search(line)
        if match:
            lib = match.group(1).strip()
            token = _extract_lib_token(match.group(2))
            return BackendLoaded(library=lib, token=token)

    # 3. load_tensors: offloaded ... layers to GPU
    if line.startswith("load_tensors: offloaded"):
        match = _LAYER_OFFLOAD_PATTERN.search(line)
        if match:
            if not 0 <= int(match[1]) <= int(match[2]) or int(match[2]) == 0:
                return None
            return LayerOffload(
                offloaded_layers=int(match.group(1)),
                total_layers=int(match.group(2)),
            )

    if line.startswith("load_tensors:"):
        match = re.match(
            r"load_tensors:\s+CPU(?:_REPACK)? model buffer size\s*=\s*"
            r"([0-9]+(?:\.[0-9]+)?)\s+MiB",
            line,
        )
        if match and any(digit in "123456789" for digit in match[1]):
            return CpuModelBuffer()

    # 4. llama-server started in ... seconds
    if "llama-server started in" in line:
        match = _RUNNER_STARTED_PATTERN.search(line)
        if match:
            return RunnerStarted(duration_seconds=float(match.group(1)))

    # 5. Logfmt structured lines
    if "msg=" in line:
        fields = _parse_logfmt_fields(line)
        msg = fields.get("msg", "")

        # inference compute
        if msg == "inference compute":
            libdirs_str = fields.get("libdirs", "")
            libdirs = tuple(d.strip() for d in libdirs_str.split(",") if d.strip())
            pci_id = fields.get("pci_id") or None
            return DiscoveredDevice(
                library=fields.get("library", ""),
                id=fields.get("id", ""),
                filter_id=fields.get("filter_id"),
                name=fields.get("name", ""),
                description=fields.get("description", ""),
                pci_id=pci_id,
                type=fields.get("type", ""),
                libdirs=libdirs,
            )

        # selecting single GPU for llama-server model
        if msg == "selecting single GPU for llama-server model":
            return SchedulerSelection(
                library=fields.get("library", ""),
                name=fields.get("name", ""),
                description=fields.get("description", ""),
                integrated=fields.get("integrated", "").lower() == "true",
                id=fields.get("id", ""),
                filter_id=fields.get("filter_id", ""),
            )

        # Model load boundary triggers
        if msg in ("starting llama-server", "using llama-server for model"):
            return ModelLoadStarted(trigger=msg)

    return None


class OllamaLogParser:
    """Thread-safe stream parser for Ollama server logs."""

    def __init__(self, maxlen: int = MAX_RECORD_HISTORY) -> None:
        self._lock = Lock()
        self._records: deque[LogRecord] = deque(maxlen=maxlen)
        self._load_revision = 0
        self._buffer: str = ""
        self._discarding_overlong: bool = False

    def feed(self, text_chunk: str) -> Sequence[LogRecord]:
        """Consume complete lines, discarding the remainder of any overlong line."""
        new_records: list[LogRecord] = []
        with self._lock:
            start = 0
            while (end := text_chunk.find("\n", start)) != -1:
                if (
                    not self._discarding_overlong
                    and len(self._buffer) + end - start <= MAX_LINE_LENGTH + 1
                ):
                    line = (self._buffer + text_chunk[start:end]).removesuffix("\r")
                    if (record := parse_log_line(line)) is not None:
                        if isinstance(record, ModelLoadStarted):
                            self._load_revision += 1
                        self._records.append(record)
                        new_records.append(record)
                self._buffer = ""
                self._discarding_overlong = False
                start = end + 1

            if not self._discarding_overlong:
                if len(self._buffer) + len(text_chunk) - start <= MAX_LINE_LENGTH + 1:
                    self._buffer += text_chunk[start:]
                else:
                    self._buffer = ""
                    self._discarding_overlong = True
        return tuple(new_records)

    def load_revision(self) -> int:
        with self._lock:
            return self._load_revision

    def records(self) -> tuple[LogRecord, ...]:
        """Return all retained log records."""
        with self._lock:
            return tuple(self._records)

    def discovered_devices(self) -> tuple[DiscoveredDevice, ...]:
        """Return all discovered device records currently retained."""
        with self._lock:
            return tuple(r for r in self._records if isinstance(r, DiscoveredDevice))

    def latest_load(self) -> tuple[LogRecord, ...]:
        """Return the records after the last load boundary (ModelLoadStarted)."""
        with self._lock:
            records_list = list(self._records)
            last_boundary_idx: int | None = None
            for idx in range(len(records_list) - 1, -1, -1):
                if isinstance(records_list[idx], ModelLoadStarted):
                    last_boundary_idx = idx
                    break
            if last_boundary_idx is None:
                return ()

            post_boundary = tuple(
                record
                for record in records_list[last_boundary_idx + 1 :]
                if not isinstance(record, DiscoveredDevice)
            )

            # Include the nearest SchedulerSelection before the last boundary,
            # unless a RunnerDevice, LayerOffload, or RunnerStarted record lies
            # between that selection and the boundary.
            selected_before: SchedulerSelection | None = None
            for idx in range(last_boundary_idx - 1, -1, -1):
                rec = records_list[idx]
                if isinstance(rec, (BackendLoaded, RunnerDevice, LayerOffload, RunnerStarted)):
                    break
                if isinstance(rec, SchedulerSelection):
                    selected_before = rec
                    break

            if selected_before is not None:
                return (selected_before, *post_boundary)
            return post_boundary


__all__ = [
    "BackendLoaded",
    "CpuModelBuffer",
    "DiscoveredDevice",
    "LayerOffload",
    "LogRecord",
    "ModelLoadStarted",
    "OllamaLogParser",
    "RunnerDevice",
    "RunnerStarted",
    "SchedulerSelection",
    "parse_log_line",
]
