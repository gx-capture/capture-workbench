"""DirectML execution evidence read from the ONNX Runtime sessions of one OCR run.

A configured provider list is only a request. The evidence adapter disables
ONNX Runtime's implicit CPU fallback before prediction and, after prediction,
reads which provider executed each node (graph assignment or session profile),
then proves that the owned profile files are gone.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from capture_runtime.worker_probe import EngineRuntimeUnavailableError


@dataclass(frozen=True, slots=True)
class OcrExecutionEvidence:
    """Provider assignment observed from an ONNX Runtime execution profile.

    The configured provider list is only a request.  DML provenance is
    resolved from this evidence after the first prediction, so a session that
    silently assigned every node to CPU cannot be labelled as DML.
    """

    dml_node_count: int
    cpu_node_count: int
    source: str = "ort-profile"
    session_device_proofs: tuple[OcrSessionDeviceProof, ...] = ()

    def __post_init__(self) -> None:
        for name in ("dml_node_count", "cpu_node_count"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if not self.source.strip():
            raise ValueError("execution evidence source must be non-empty")
        if self.session_device_proofs:
            if tuple(item.session_index for item in self.session_device_proofs) != tuple(
                range(len(self.session_device_proofs))
            ):
                raise ValueError("execution evidence session order is invalid")
            if (
                sum(item.dml_node_count for item in self.session_device_proofs)
                != self.dml_node_count
            ):
                raise ValueError("execution evidence DML count does not match sessions")
            if (
                sum(item.cpu_node_count for item in self.session_device_proofs)
                != self.cpu_node_count
            ):
                raise ValueError("execution evidence CPU count does not match sessions")


@dataclass(frozen=True, slots=True)
class OcrSessionDeviceProof:
    """Provider/node evidence tied to one returned ORT session.

    ``dml_device_id`` is the optional provider-options readback.  A value of
    ``None`` means that ORT did not expose that readback; the configured
    adapter identity remains bound by the retained execution plan and native
    map construction proof.
    """

    session_index: int
    providers: tuple[str, ...]
    dml_device_id: int | None
    fallback_disabled: bool
    dml_node_count: int
    evidence_source: str
    cpu_node_count: int = 0

    def __post_init__(self) -> None:
        if (
            isinstance(self.session_index, bool)
            or not isinstance(self.session_index, int)
            or self.session_index < 0
        ):
            raise ValueError("session index must be a non-negative integer")
        if not isinstance(self.providers, tuple) or self.providers != (
            "DmlExecutionProvider",
            "CPUExecutionProvider",
        ):
            raise ValueError("session provider order is invalid")
        if self.dml_device_id is not None and (
            isinstance(self.dml_device_id, bool)
            or not isinstance(self.dml_device_id, int)
            or self.dml_device_id < 0
        ):
            raise ValueError("session DML device id is invalid")
        if not isinstance(self.fallback_disabled, bool) or not self.fallback_disabled:
            raise ValueError("session fallback must be disabled")
        if (
            isinstance(self.dml_node_count, bool)
            or not isinstance(self.dml_node_count, int)
            or self.dml_node_count < 1
        ):
            raise ValueError("session DML node count must be positive")
        if (
            isinstance(self.cpu_node_count, bool)
            or not isinstance(self.cpu_node_count, int)
            or self.cpu_node_count < 0
        ):
            raise ValueError("session CPU node count must be non-negative")
        if not isinstance(self.evidence_source, str) or not self.evidence_source.strip():
            raise ValueError("session evidence source must be non-empty")


@dataclass(frozen=True, slots=True)
class OcrExecutionEvidenceFailure:
    """Sanitized failure collected while closing one ORT profile session."""

    code: str
    session_index: int | None = None


class OcrExecutionEvidenceError(EngineRuntimeUnavailableError):
    """Aggregate fail-closed result for ORT evidence or profile cleanup."""

    def __init__(
        self,
        failures: Iterable[OcrExecutionEvidenceFailure],
        *,
        cleanup_verified: bool,
    ) -> None:
        self.failures = tuple(failures)
        self.cleanup_failures = self.failures
        self.cleanup_verified = cleanup_verified
        self.profile_paths_absent = cleanup_verified
        message_labels = [
            "profile does not belong" if failure.code == "profile_path_foreign" else failure.code
            for failure in self.failures
        ]
        labels = ",".join(
            label
            + (f"@session-{failure.session_index + 1}" if failure.session_index is not None else "")
            for label, failure in zip(message_labels, self.failures, strict=True)
        )
        cleanup = "verified" if cleanup_verified else "unverified"
        super().__init__(
            "DML execution evidence failed; "
            f"failures={labels or 'unknown'}; profile cleanup={cleanup}."
        )


class OcrInferenceCleanupError(EngineRuntimeUnavailableError):
    """A primary OCR failure whose owned-profile cleanup also failed.

    The public message contains only stable failure codes.  The original
    inference exception remains the Python cause, while cleanup evidence is
    available as typed fields for the owning adapter and tests.
    """

    def __init__(
        self,
        *,
        primary_code: str,
        cleanup_error: OcrExecutionEvidenceError,
    ) -> None:
        self.primary_code = primary_code
        self.cleanup_failures = cleanup_error.failures
        self.cleanup_verified = cleanup_error.cleanup_verified
        self.profile_paths_absent = cleanup_error.profile_paths_absent
        cleanup_codes = ",".join(dict.fromkeys(item.code for item in self.cleanup_failures))
        super().__init__(
            f"{primary_code}; OCR profile cleanup failed "
            f"(codes={cleanup_codes or 'unknown'}; "
            f"residue={'absent' if self.cleanup_verified else 'present-or-unknown'})."
        )


class OcrExecutionEvidenceAdapter(Protocol):
    """Internal seam for provider preparation and post-prediction execution proof."""

    def prepare(self, pipeline: Any, *, expected_device_id: int | None = None) -> None: ...

    def finalize(self, pipeline: Any) -> OcrExecutionEvidence: ...

    def abort(self, pipeline: Any | None = None) -> None: ...


def _paddle_onnx_sessions(pipeline: Any) -> tuple[Any, ...]:
    """Find the ONNX sessions owned by the Paddle OCR pipeline.

    PaddleOCR's public wrapper intentionally does not expose provider
    assignment.  Its PaddleX pipeline does, however, retain one runner for
    each OCR model.  Keeping this traversal here gives the runtime one
    narrowly-scoped internal adapter instead of spreading PaddleX knowledge
    into the worker and projection modules.
    """

    roots = [pipeline]
    visited_roots: set[int] = set()
    sessions: list[Any] = []
    visited_sessions: set[int] = set()
    while roots:
        root = roots.pop()
        if root is None or id(root) in visited_roots:
            continue
        visited_roots.add(id(root))
        nested = getattr(root, "paddlex_pipeline", None)
        if nested is not None:
            roots.append(nested)
        for child_name in ("doc_preprocessor_pipeline",):
            child = getattr(root, child_name, None)
            if child is not None:
                roots.append(child)
        for model_name in (
            "text_det_model",
            "text_rec_model",
            "textline_orientation_model",
        ):
            model = getattr(root, model_name, None)
            runner = getattr(model, "runner", None)
            session = getattr(runner, "session", None)
            if session is not None and id(session) not in visited_sessions:
                visited_sessions.add(id(session))
                sessions.append(session)
    return tuple(sessions)


_ALLOWED_ORT_NODE_PROVIDERS = frozenset(
    {
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    }
)


class _UnknownExecutionProviderError(EngineRuntimeUnavailableError):
    """A provider name outside the canonical ORT execution policy."""

    def __init__(self) -> None:
        super().__init__("OCR execution evidence has an unknown provider.")


def _provider_node_counts(provider: object) -> tuple[int, int]:
    """Return one node count for an exact, allowlisted provider name."""

    if type(provider) is not str or provider not in _ALLOWED_ORT_NODE_PROVIDERS:
        raise _UnknownExecutionProviderError()
    if provider == "DmlExecutionProvider":
        return 1, 0
    return 0, 1


def _profile_node_counts(value: object) -> tuple[int, int]:
    if not isinstance(value, list):
        raise EngineRuntimeUnavailableError("OCR execution profile has an invalid shape.")
    dml_nodes = 0
    cpu_nodes = 0
    for event in value:
        if not isinstance(event, dict):
            raise EngineRuntimeUnavailableError("OCR execution profile has an invalid event.")
        if event.get("cat") != "Node":
            continue
        args = event.get("args")
        if not isinstance(args, dict):
            raise EngineRuntimeUnavailableError("OCR execution profile has an invalid node event.")
        provider = args.get("provider")
        dml_count, cpu_count = _provider_node_counts(provider)
        dml_nodes += dml_count
        cpu_nodes += cpu_count
    return dml_nodes, cpu_nodes


class PaddleOcrExecutionEvidenceAdapter:
    """Disable ORT fallback and prove provider assignment after prediction.

    PaddleX does not expose a stable graph-assignment API in every supported
    ONNX Runtime build. The graph API is preferred when available on every
    OCR session and its recording option is enabled; otherwise the session
    profile is read only after prediction. Preparation intentionally never
    returns resolved evidence because provider configuration is not execution
    proof.
    """

    def __init__(
        self,
        profile_file_prefix: Path,
        *,
        stage_reporter: Callable[[str], None] | None = None,
    ) -> None:
        self._profile_file_prefix = profile_file_prefix
        self._stage_reporter = stage_reporter
        self._sessions: tuple[Any, ...] = ()
        self._cleanup_sessions: tuple[Any, ...] = ()
        self._profile_aliases: set[Path] = set()
        self._lifecycle = "idle"
        self._expected_device_id: int | None = None
        self._session_device_ids: tuple[int | None, ...] = ()
        self._session_proofs: tuple[OcrSessionDeviceProof, ...] = ()

    def _report_stage(self, stage: str) -> None:
        if self._stage_reporter is not None:
            self._stage_reporter(stage)

    def prepare(self, pipeline: Any, *, expected_device_id: int | None = None) -> None:
        sessions = _paddle_onnx_sessions(pipeline)
        self._sessions = sessions
        self._cleanup_sessions = ()
        self._expected_device_id = expected_device_id
        self._session_device_ids = ()
        self._session_proofs = ()
        self._lifecycle = "prepared"
        if not sessions:
            raise EngineRuntimeUnavailableError(
                "DML execution evidence is unavailable: PaddleOCR created no ONNX sessions."
            )
        session_device_ids: list[int | None] = []
        for session in sessions:
            get_providers = getattr(session, "get_providers", None)
            if not callable(get_providers):
                raise EngineRuntimeUnavailableError(
                    "DML provider identity is unavailable: ONNX Runtime session "
                    "does not expose get_providers()."
                )
            try:
                providers = tuple(get_providers())
            except Exception as error:
                raise EngineRuntimeUnavailableError(
                    "DML provider identity could not be read from ONNX Runtime."
                ) from error
            expected = ("DmlExecutionProvider", "CPUExecutionProvider")
            if providers != expected:
                raise EngineRuntimeUnavailableError(
                    "DML provider identity mismatch: expected one DML-first session "
                    f"with providers {list(expected)!r}, observed {list(providers)!r}."
                )
            if expected_device_id is not None:
                get_options = getattr(session, "get_provider_options", None)
                if not callable(get_options):
                    self._report_stage("ocr-dml-device-id-unobservable")
                    session_device_ids.append(None)
                else:
                    try:
                        options = get_options()
                    except Exception:
                        # Some supported ORT builds expose the method but do
                        # not expose provider options.  Execution proof still
                        # comes from the post-predict profile, never this
                        # optional readback.
                        self._report_stage("ocr-dml-device-id-unobservable")
                        session_device_ids.append(None)
                    else:
                        if not isinstance(options, Mapping):
                            raise EngineRuntimeUnavailableError(
                                "DML provider options have an invalid shape."
                            )
                        if "DmlExecutionProvider" not in options:
                            self._report_stage("ocr-dml-device-id-unobservable")
                            session_device_ids.append(None)
                        else:
                            dml_options = options["DmlExecutionProvider"]
                            if not isinstance(dml_options, Mapping):
                                raise EngineRuntimeUnavailableError(
                                    "DML provider options have an invalid shape."
                                )
                            if "device_id" not in dml_options:
                                self._report_stage("ocr-dml-device-id-unobservable")
                                session_device_ids.append(None)
                            else:
                                reported = dml_options["device_id"]
                                if isinstance(reported, bool):
                                    self._report_stage("ocr-dml-device-id-mismatch")
                                    raise EngineRuntimeUnavailableError(
                                        "DML session device_id is invalid"
                                    )
                                if isinstance(reported, int):
                                    canonical_id = reported
                                elif isinstance(reported, str) and re.fullmatch(
                                    r"(?:0|[1-9][0-9]*)", reported
                                ):
                                    canonical_id = int(reported)
                                else:
                                    self._report_stage("ocr-dml-device-id-mismatch")
                                    raise EngineRuntimeUnavailableError(
                                        "DML session device_id is invalid"
                                    )
                                if canonical_id != expected_device_id:
                                    self._report_stage("ocr-dml-device-id-mismatch")
                                    raise EngineRuntimeUnavailableError(
                                        "DML session device_id does not match the retained OCR plan"
                                    )
                                session_device_ids.append(canonical_id)
            else:
                session_device_ids.append(None)
            disable_fallback = getattr(session, "disable_fallback", None)
            if not callable(disable_fallback):
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence is unavailable: ONNX Runtime fallback "
                    "cannot be disabled."
                )
            self._cleanup_sessions += (session,)
            # Register ownership before invoking the mutating ORT call.  A
            # provider can throw after partially enabling profiling; retaining
            # it here lets abort() close and prove that session as well.
            try:
                disabled = disable_fallback()
            except Exception as error:
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence could not disable ONNX Runtime fallback."
                ) from error
            if disabled is False:
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence could not disable ONNX Runtime fallback."
                )
        self._session_device_ids = tuple(session_device_ids)
        return None

    def finalize(self, pipeline: Any) -> OcrExecutionEvidence:
        """Read provider evidence after the pipeline has run inference."""

        sessions = self._sessions or _paddle_onnx_sessions(pipeline)
        if not sessions:
            raise EngineRuntimeUnavailableError(
                "DML execution evidence is unavailable: PaddleOCR created no ONNX sessions."
            )
        if all(
            callable(getattr(session, "get_provider_graph_assignment_info", None))
            for session in sessions
        ):
            assignments: list[Any] = []
            session_proofs: list[OcrSessionDeviceProof] = []
            graph_evidence_unavailable = False
            assignment_error: _UnknownExecutionProviderError | None = None
            try:
                for session_index, session in enumerate(sessions):
                    get_assignments = session.get_provider_graph_assignment_info
                    try:
                        session_assignments = get_assignments()
                    except Exception as error:
                        if _is_ort_graph_assignment_unavailable(error):
                            # PaddleX 3.7 cannot set ORT's internal graph
                            # assignment recording option through its public
                            # engine_config.  In that supported case, use the
                            # already-configured execution profile.  This is
                            # deliberately a selection fallback only: the
                            # profile parser remains the same fail-closed
                            # evidence path and no profile is trusted before
                            # prediction has completed.
                            graph_evidence_unavailable = True
                            evidence = self._profile_evidence(sessions)
                            self._mark_finalized()
                            return evidence
                        raise EngineRuntimeUnavailableError(
                            "DML execution evidence could not be read from ONNX Runtime."
                        ) from error
                    if not isinstance(session_assignments, list):
                        raise EngineRuntimeUnavailableError(
                            "DML execution evidence has an invalid ONNX Runtime graph assignment."
                        )
                    assignments.extend(session_assignments)
                    try:
                        session_evidence = _assignment_evidence(session_assignments)
                    except _UnknownExecutionProviderError as error:
                        assignment_error = error
                        continue
                    if self._expected_device_id is not None:
                        if session_evidence.dml_node_count < 1:
                            raise EngineRuntimeUnavailableError(
                                "DML execution evidence contained zero assigned DML nodes."
                            )
                        session_proofs.append(
                            OcrSessionDeviceProof(
                                session_index=session_index,
                                providers=(
                                    "DmlExecutionProvider",
                                    "CPUExecutionProvider",
                                ),
                                dml_device_id=(
                                    self._session_device_ids[session_index]
                                    if session_index < len(self._session_device_ids)
                                    else None
                                ),
                                fallback_disabled=True,
                                dml_node_count=session_evidence.dml_node_count,
                                evidence_source=session_evidence.source,
                                cpu_node_count=session_evidence.cpu_node_count,
                            )
                        )
                try:
                    evidence = _assignment_evidence(assignments)
                except _UnknownExecutionProviderError as error:
                    assignment_error = error
            finally:
                if not graph_evidence_unavailable:
                    try:
                        self._cleanup_profiles(sessions)
                    except OcrExecutionEvidenceError as cleanup_error:
                        if assignment_error is None:
                            raise
                        raise OcrExecutionEvidenceError(
                            [
                                OcrExecutionEvidenceFailure("graph_unknown_provider"),
                                *cleanup_error.failures,
                            ],
                            cleanup_verified=cleanup_error.cleanup_verified,
                        ) from assignment_error
            if assignment_error is not None:
                self._mark_finalized()
                raise OcrExecutionEvidenceError(
                    [OcrExecutionEvidenceFailure("graph_unknown_provider")],
                    cleanup_verified=True,
                ) from assignment_error
            self._mark_finalized()
            if session_proofs:
                evidence = OcrExecutionEvidence(
                    dml_node_count=evidence.dml_node_count,
                    cpu_node_count=evidence.cpu_node_count,
                    source=evidence.source,
                    session_device_proofs=tuple(session_proofs),
                )
            return evidence

        evidence = self._profile_evidence(sessions)
        self._mark_finalized()
        return evidence

    def abort(self, pipeline: Any | None = None) -> None:
        """Close all prepared sessions and prove owned profiles are absent.

        Aborting intentionally does not parse profile contents: inference did
        not complete, so no provider evidence is accepted.  It still ends all
        known sessions, discovers stale files for this prefix, deletes each
        owned file, and requires a successful absence probe.  A failure leaves
        the session set retained so the caller can retry idempotently.
        """

        if self._lifecycle in {"aborted", "finalized"} and not self._sessions:
            return None
        sessions = self._cleanup_sessions
        if not sessions and pipeline is not None:
            try:
                sessions = _paddle_onnx_sessions(pipeline)
            except Exception as error:
                raise OcrExecutionEvidenceError(
                    [OcrExecutionEvidenceFailure("profile_session_discovery_failed")],
                    cleanup_verified=False,
                ) from error
        self._cleanup_profiles(sessions, read_profiles=False)
        self._sessions = ()
        self._cleanup_sessions = ()
        self._lifecycle = "aborted"
        return None

    def _mark_finalized(self) -> None:
        self._sessions = ()
        self._cleanup_sessions = ()
        self._lifecycle = "finalized"
        self._session_proofs = ()

    def _cleanup_profiles(
        self,
        sessions: tuple[Any, ...],
        *,
        read_profiles: bool = True,
    ) -> None:
        """Close every ORT profile and prove that this adapter left no residue."""

        session_paths, failures = self._end_profiles(sessions)
        profile_paths, path_failures, path_sessions = self._unique_profile_paths(session_paths)
        failures.extend(path_failures)
        alias_keys = self._append_profile_aliases(profile_paths)
        discovered_paths, discovery_failures = self._discover_owned_profiles()
        failures.extend(discovery_failures)
        for profile_path in discovered_paths:
            key = self._profile_key(profile_path)
            if key is not None and key not in {self._profile_key(path) for path in profile_paths}:
                profile_paths.append(profile_path)
                if key in alias_keys:
                    continue
        if read_profiles:
            for profile_path in profile_paths:
                profile_key = self._profile_key(profile_path)
                if profile_key in alias_keys:
                    continue
                self._read_profile(
                    profile_path,
                    failures,
                    path_sessions.get(profile_key) if profile_key is not None else None,
                )
        self._delete_profiles(profile_paths, failures)
        cleanup_verified = self._prove_profiles_absent(failures)
        if failures:
            raise OcrExecutionEvidenceError(
                failures,
                cleanup_verified=cleanup_verified,
            )
        self._profile_aliases.clear()

    def _profile_evidence(self, sessions: tuple[Any, ...]) -> OcrExecutionEvidence:
        """Read and clean all sessions, collecting failures before failing closed."""

        session_paths, failures = self._end_profiles(sessions)
        profile_paths, path_failures, path_sessions = self._unique_profile_paths(session_paths)
        failures.extend(path_failures)
        alias_keys = self._append_profile_aliases(profile_paths)
        discovered_paths, discovery_failures = self._discover_owned_profiles()
        failures.extend(discovery_failures)
        known_keys = {
            key for key in (self._profile_key(path) for path in profile_paths) if key is not None
        }
        for profile_path in discovered_paths:
            key = self._profile_key(profile_path)
            if key is not None and key not in known_keys:
                profile_paths.append(profile_path)
                known_keys.add(key)

        dml_nodes = 0
        cpu_nodes = 0
        session_counts: dict[int, tuple[int, int]] = {}
        for profile_path in profile_paths:
            profile_key = self._profile_key(profile_path)
            if profile_key in alias_keys:
                continue
            session_index = path_sessions.get(profile_key) if profile_key is not None else None
            profile_counts = self._read_profile(profile_path, failures, session_index)
            if profile_counts is not None:
                session_dml_nodes, session_cpu_nodes = profile_counts
                dml_nodes += session_dml_nodes
                cpu_nodes += session_cpu_nodes
                if session_index is not None:
                    session_counts[session_index] = (session_dml_nodes, session_cpu_nodes)

        self._delete_profiles(profile_paths, failures)
        cleanup_verified = self._prove_profiles_absent(failures)
        if failures:
            raise OcrExecutionEvidenceError(
                failures,
                cleanup_verified=cleanup_verified,
            )
        self._profile_aliases.clear()
        if self._expected_device_id is not None:
            if set(session_counts) != set(range(len(sessions))) or any(
                counts[0] < 1 for counts in session_counts.values()
            ):
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence is not associated with every OCR session."
                )
            session_proofs = tuple(
                OcrSessionDeviceProof(
                    session_index=index,
                    providers=("DmlExecutionProvider", "CPUExecutionProvider"),
                    dml_device_id=(
                        self._session_device_ids[index]
                        if index < len(self._session_device_ids)
                        else None
                    ),
                    fallback_disabled=True,
                    dml_node_count=session_counts[index][0],
                    evidence_source="ort-profile",
                    cpu_node_count=session_counts[index][1],
                )
                for index in range(len(sessions))
            )
        else:
            session_proofs = ()
        return OcrExecutionEvidence(
            dml_node_count=dml_nodes,
            cpu_node_count=cpu_nodes,
            session_device_proofs=session_proofs,
        )

    def _end_profiles(
        self,
        sessions: tuple[Any, ...],
    ) -> tuple[list[tuple[int, Path | None]], list[OcrExecutionEvidenceFailure]]:
        """Call ``end_profiling`` for every session, even after one raises."""

        paths: list[tuple[int, Path | None]] = []
        failures: list[OcrExecutionEvidenceFailure] = []
        relocated_sources: set[str] = set()
        source_fingerprints: dict[str, tuple[int, int, str | None]] = {}
        for session_index, session in enumerate(sessions):
            try:
                end_profiling = getattr(session, "end_profiling", None)
            except Exception:
                failures.append(
                    OcrExecutionEvidenceFailure("profile_end_unavailable", session_index)
                )
                paths.append((session_index, None))
                continue
            if not callable(end_profiling):
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_end_unavailable",
                        session_index,
                    )
                )
                paths.append((session_index, None))
                continue
            try:
                profile_path_value = end_profiling()
            except Exception:
                failures.append(OcrExecutionEvidenceFailure("profile_end_failed", session_index))
                paths.append((session_index, None))
                continue
            if not isinstance(profile_path_value, str) or not profile_path_value:
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_invalid",
                        session_index,
                    )
                )
                paths.append((session_index, None))
                continue
            profile_path = Path(profile_path_value)
            if not self._owns_profile(profile_path):
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_foreign",
                        session_index,
                    )
                )
                paths.append((session_index, None))
                continue
            profile_key = self._profile_key(profile_path)
            if profile_key is not None and self._is_ort_timestamp_profile(profile_path):
                relocated_path, relocation_failure = self._relocate_ort_profile(
                    profile_path,
                    session_index,
                    source_key=profile_key,
                    relocated_sources=relocated_sources,
                    source_fingerprints=source_fingerprints,
                )
                if relocation_failure is not None:
                    failures.append(OcrExecutionEvidenceFailure(relocation_failure, session_index))
                if relocated_path is None:
                    paths.append((session_index, None))
                    continue
                profile_path = relocated_path
            paths.append((session_index, profile_path))
        return paths, failures

    def _is_ort_timestamp_profile(self, profile_path: Path) -> bool:
        """Recognize ORT's second-resolution profile filename, not arbitrary paths.

        ORT appends a second-resolution timestamp to the profile prefix, so
        sessions sharing one prefix can return the same path.  The default
        factory gives each OCR model its own prefix; a session left on the
        shared prefix is still handled here.  Restricting this normalization to ORT's known
        filename shape preserves the generic duplicate-path fail-closed rule.
        """

        prefix = self._profile_file_prefix.name + "_"
        if not profile_path.name.casefold().startswith(prefix.casefold()):
            return False
        suffix = profile_path.name[len(prefix) :]
        if not suffix.casefold().endswith(".json"):
            return False
        timestamp = suffix[:-5]
        return (
            re.fullmatch(
                r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?",
                timestamp,
            )
            is not None
        )

    def _relocate_ort_profile(
        self,
        profile_path: Path,
        session_index: int,
        *,
        source_key: str,
        relocated_sources: set[str],
        source_fingerprints: dict[str, tuple[int, int, str | None]],
    ) -> tuple[Path | None, str | None]:
        """Give each timestamped ORT profile a unique owned path before the next session ends."""

        profile_state = self._wait_for_profile(profile_path)
        if profile_state is False:
            # A prior session may have returned this same timestamped path and
            # already moved it.  A missing second file is therefore a duplicate
            # result, not an empty successful profile.
            if source_key in relocated_sources:
                return None, "profile_path_duplicate"
            return profile_path, "profile_path_relocate_failed"
        if profile_state is None:
            return profile_path, "profile_path_relocate_failed"
        current_fingerprint = self._profile_fingerprint(profile_path)
        previous_fingerprint = source_fingerprints.get(source_key)
        if previous_fingerprint is not None:
            if current_fingerprint is None or current_fingerprint == previous_fingerprint:
                return None, "profile_path_duplicate"

        destination = self._profile_file_prefix.parent / (
            f"{self._profile_file_prefix.name}_session-{session_index + 1}.json"
        )
        try:
            destination.lstat()
        except FileNotFoundError:
            pass
        except (OSError, RuntimeError, ValueError):
            return profile_path, "profile_path_relocate_failed"
        else:
            return profile_path, "profile_path_relocate_failed"
        deadline = time.monotonic() + 1.0
        renamed = False
        while True:
            try:
                profile_path.rename(destination)
                renamed = True
                break
            except FileNotFoundError:
                if source_key in relocated_sources:
                    return None, "profile_path_duplicate"
                return profile_path, "profile_path_relocate_failed"
            except (OSError, RuntimeError, ValueError):
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.01)
        if renamed:
            relocated_sources.add(source_key)
            return destination, None

        # Windows may keep ORT's profile handle open after it returns the
        # path.  A same-volume copy preserves the first session's bytes while
        # the original path remains an alias to delete after all sessions end.
        try:
            destination.lstat()
        except FileNotFoundError:
            pass
        except (OSError, RuntimeError, ValueError):
            return profile_path, "profile_path_relocate_failed"
        else:
            return profile_path, "profile_path_relocate_failed"
        try:
            shutil.copyfile(profile_path, destination)
        except (OSError, RuntimeError, ValueError):
            return profile_path, "profile_path_relocate_failed"
        fingerprint = self._profile_fingerprint(destination)
        if fingerprint is None:
            return profile_path, "profile_path_relocate_failed"
        self._profile_aliases.add(profile_path)
        source_fingerprints[source_key] = fingerprint
        relocated_sources.add(source_key)
        return destination, None

    def _append_profile_aliases(self, profile_paths: list[Path]) -> set[str]:
        """Include copied source paths for deletion without counting them twice."""

        alias_keys: set[str] = set()
        known_keys = {
            key for key in (self._profile_key(path) for path in profile_paths) if key is not None
        }
        for alias in self._profile_aliases:
            if not self._owns_profile(alias):
                continue
            key = self._profile_key(alias)
            if key is None:
                continue
            alias_keys.add(key)
            if key not in known_keys:
                profile_paths.append(alias)
                known_keys.add(key)
        return alias_keys

    @staticmethod
    def _profile_fingerprint(profile_path: Path) -> tuple[int, int, str | None] | None:
        try:
            profile_stat = profile_path.stat()
        except (OSError, RuntimeError, ValueError):
            return None
        digest: str | None
        try:
            digest = hashlib.sha256(profile_path.read_bytes()).hexdigest()
        except (OSError, RuntimeError, ValueError):
            digest = None
        return profile_stat.st_size, profile_stat.st_mtime_ns, digest

    @staticmethod
    def _wait_for_profile(profile_path: Path) -> bool | None:
        """Allow ORT's end-profiling writer to publish its returned path."""

        deadline = time.monotonic() + 1.0
        while True:
            try:
                profile_path.lstat()
                return True
            except FileNotFoundError:
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.01)
            except (OSError, RuntimeError, ValueError):
                return None

    def _unique_profile_paths(
        self,
        session_paths: list[tuple[int, Path | None]],
    ) -> tuple[
        list[Path],
        list[OcrExecutionEvidenceFailure],
        dict[str, int],
    ]:
        profile_paths: list[Path] = []
        failures: list[OcrExecutionEvidenceFailure] = []
        path_sessions: dict[str, int] = {}
        for session_index, profile_path in session_paths:
            if profile_path is None:
                continue
            key = self._profile_key(profile_path)
            if key is None:
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_unresolvable",
                        session_index,
                    )
                )
                continue
            if key in path_sessions:
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_duplicate",
                        session_index,
                    )
                )
                continue
            path_sessions[key] = session_index
            profile_paths.append(profile_path)
        return profile_paths, failures, path_sessions

    def _discover_owned_profiles(
        self,
    ) -> tuple[list[Path], list[OcrExecutionEvidenceFailure]]:
        """Find profiles left behind by a session whose end call failed."""

        try:
            candidates = tuple(self._profile_file_prefix.parent.iterdir())
        except FileNotFoundError:
            return [], []
        except OSError:
            return [], [OcrExecutionEvidenceFailure("profile_discovery_failed")]
        except Exception:
            return [], [OcrExecutionEvidenceFailure("profile_discovery_failed")]
        profile_prefix = (self._profile_file_prefix.name + "_").casefold()
        return [
            path
            for path in candidates
            if path.name.casefold().startswith(profile_prefix) and self._owns_profile(path)
        ], []

    def _read_profile(
        self,
        profile_path: Path,
        failures: list[OcrExecutionEvidenceFailure],
        session_index: int | None,
    ) -> tuple[int, int] | None:
        try:
            profile_stat = profile_path.lstat()
        except FileNotFoundError:
            failures.append(OcrExecutionEvidenceFailure("profile_missing", session_index))
            return None
        except OSError:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown", session_index))
            return None
        except Exception:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown", session_index))
            return None
        if stat.S_ISLNK(profile_stat.st_mode) or not stat.S_ISREG(profile_stat.st_mode):
            failures.append(OcrExecutionEvidenceFailure("profile_invalid", session_index))
            return None
        try:
            profile_text = profile_path.read_text(encoding="utf-8")
        except Exception:
            failures.append(OcrExecutionEvidenceFailure("profile_read_failed", session_index))
            return None
        try:
            profile = json.loads(profile_text)
            return _profile_node_counts(profile)
        except _UnknownExecutionProviderError:
            failures.append(OcrExecutionEvidenceFailure("profile_unknown_provider", session_index))
            return None
        except (json.JSONDecodeError, EngineRuntimeUnavailableError, TypeError, ValueError):
            failures.append(OcrExecutionEvidenceFailure("profile_invalid", session_index))
            return None

    def _delete_profiles(
        self,
        profile_paths: list[Path],
        failures: list[OcrExecutionEvidenceFailure],
    ) -> None:
        """Attempt deletion for every path; an earlier deletion error is not terminal."""

        for profile_path in profile_paths:
            try:
                profile_path.unlink()
            except FileNotFoundError:
                pass
            except Exception:
                failures.append(OcrExecutionEvidenceFailure("profile_delete_failed"))

    def _prove_profiles_absent(
        self,
        failures: list[OcrExecutionEvidenceFailure],
    ) -> bool:
        """Prove every owned profile prefix is absent; unknown stat is failure."""

        try:
            candidates = tuple(self._profile_file_prefix.parent.iterdir())
        except FileNotFoundError:
            return True
        except OSError:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
            return False
        except Exception:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
            return False
        residue = False
        profile_prefix = (self._profile_file_prefix.name + "_").casefold()
        for path in candidates:
            if not path.name.casefold().startswith(profile_prefix):
                continue
            if not self._owns_profile(path):
                continue
            try:
                path.lstat()
            except FileNotFoundError:
                continue
            except OSError:
                failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
                residue = True
            except Exception:
                failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
                residue = True
            else:
                failures.append(OcrExecutionEvidenceFailure("profile_residue"))
                residue = True
        return not residue

    def _profile_key(self, profile_path: Path) -> str | None:
        try:
            return str(profile_path.resolve(strict=False)).casefold()
        except (OSError, RuntimeError, ValueError):
            return None

    def _owns_profile(self, profile_path: Path) -> bool:
        try:
            return (
                profile_path.name.casefold().startswith(
                    (self._profile_file_prefix.name + "_").casefold()
                )
                and profile_path.parent.resolve() == self._profile_file_prefix.parent.resolve()
            )
        except (OSError, RuntimeError, ValueError):
            return False


def _assignment_evidence(assignments: list[Any]) -> OcrExecutionEvidence:
    dml_nodes = 0
    cpu_nodes = 0
    for assignment in assignments:
        provider = getattr(assignment, "ep_name", None)
        get_nodes = getattr(assignment, "get_nodes", None)
        if not callable(get_nodes):
            raise EngineRuntimeUnavailableError(
                "DML execution evidence has an invalid ONNX Runtime graph assignment."
            )
        try:
            nodes = get_nodes()
        except Exception as error:
            raise EngineRuntimeUnavailableError(
                "DML execution evidence could not read ONNX Runtime graph nodes."
            ) from error
        if not isinstance(nodes, list):
            raise EngineRuntimeUnavailableError(
                "DML execution evidence has an invalid ONNX Runtime graph node list."
            )
        dml_count, cpu_count = _provider_node_counts(provider)
        dml_nodes += len(nodes) * dml_count
        cpu_nodes += len(nodes) * cpu_count
    return OcrExecutionEvidence(
        dml_node_count=dml_nodes,
        cpu_node_count=cpu_nodes,
        source="ort-graph-assignment",
    )


def _is_ort_graph_assignment_unavailable(error: Exception) -> bool:
    """Recognize ORT's public signal that graph assignment recording is off.

    ``InferenceSession.get_provider_graph_assignment_info`` is present in
    recent ORT builds, but it raises until the internal session option
    ``session.record_ep_graph_assignment_info`` has been enabled.  PaddleX's
    supported runner cannot set that option through ``engine_config``.  Keep
    this compatibility check narrowly keyed to ORT's documented option name;
    unrelated graph API errors must remain fail-closed.
    """

    return "session.record_ep_graph_assignment_info" in str(error)


__all__ = [
    "OcrExecutionEvidence",
    "OcrExecutionEvidenceAdapter",
    "OcrExecutionEvidenceError",
    "OcrExecutionEvidenceFailure",
    "OcrInferenceCleanupError",
    "OcrSessionDeviceProof",
    "PaddleOcrExecutionEvidenceAdapter",
]
