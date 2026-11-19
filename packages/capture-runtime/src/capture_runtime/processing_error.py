"""Capture processing failures."""


class CaptureProcessingError(RuntimeError):
    """A safe runtime-side capture processing failure."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "extraction_failed",
        retryable: bool = True,
        stage: str = "extraction",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.stage = stage
