from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable

from capture_runtime.constants import OLLAMA_MODEL_REQUIREMENT_ID
from capture_runtime.ollama.installer_runtime import _atomic_json
from capture_runtime.ollama.lifecycle_impl import ManualActionRequiredError
from capture_runtime.ollama.system_installer import SystemRuntimeInstaller


async def install_legacy_model(
    installer: SystemRuntimeInstaller,
    cancel_event: asyncio.Event,
    report_progress: Callable[[float], None],
) -> None:
    executable = installer._lifecycle.executable()
    if executable is None:
        raise ManualActionRequiredError("Install the Ollama application first")
    installer._lifecycle.start()
    environment = installer._lifecycle.config.process_environment()
    report_progress(0.1)
    pull = await installer._runner.run(
        [executable, "pull", installer._lifecycle.config.base_model],
        environment=environment,
        cwd=installer._lifecycle.config.app_data_dir,
        cancel_event=cancel_event,
        timeout_seconds=3600,
    )
    if pull.return_code != 0:
        raise RuntimeError(f"Ollama model pull failed ({pull.return_code})")
    report_progress(0.75)
    modelfile = installer._lifecycle.config.app_data_dir / "Capture.Modelfile"
    modelfile_text = (
        f"FROM {installer._lifecycle.config.base_model}\n"
        "PARAMETER temperature 0\n"
        "SYSTEM Return only JSON matching the supplied schema. "
        "Preserve source provenance exactly.\n"
    )
    modelfile_bytes = modelfile_text.encode("utf-8")
    modelfile.write_bytes(modelfile_bytes)
    create = await installer._runner.run(
        [
            executable,
            "create",
            installer._lifecycle.config.profile_id,
            "-f",
            str(modelfile),
        ],
        environment=environment,
        cwd=installer._lifecycle.config.app_data_dir,
        cancel_event=cancel_event,
        timeout_seconds=600,
    )
    if create.return_code != 0:
        raise RuntimeError(f"Ollama capture profile creation failed ({create.return_code})")
    _atomic_json(
        installer._marker(OLLAMA_MODEL_REQUIREMENT_ID),
        {
            "profileId": installer._lifecycle.config.profile_id,
            "baseModel": installer._lifecycle.config.base_model,
            "modelfileSha256": hashlib.sha256(modelfile_bytes).hexdigest(),
            "installedAt": installer._clock.now().isoformat(),
        },
    )
    report_progress(1)
