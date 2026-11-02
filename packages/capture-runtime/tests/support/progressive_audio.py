from __future__ import annotations

from capture_runtime.contracts import StreamingEventType
from capture_runtime.progressive_audio import (
    ProgressiveAudioSession,
    ProgressiveSessionEvent,
    _elapsed_ms,
)


def tick(session: ProgressiveAudioSession) -> list[ProgressiveSessionEvent]:
    if session._terminal:
        return session.drain_events()
    now = session.clock.now()
    elapsed_heartbeat = _elapsed_ms(session._last_heartbeat_at, now)
    if elapsed_heartbeat >= session.heartbeat_ms:
        session._pending_events.append(
            ProgressiveSessionEvent(StreamingEventType.HEARTBEAT, "extracting")
        )
        session._last_heartbeat_at = now
    if _elapsed_ms(session._last_progress_at, now) >= session.stall_timeout_ms:
        session._fail(
            code="progressive_stall",
            message="Progressive audio extraction stopped producing observable progress.",
            retryable=True,
            stage="watchdog",
        )
    return session.drain_events()
