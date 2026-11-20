"""Static freezer closure guard; includes conditional imports and package initializers.

Run directly with Python (stdlib only), or through the runtime unit target.
Third-party modules/data/hooks are pinned by uv.lock and the worker spec inputs.
"""

import ast
import fnmatch
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "src"
PROJECT = json.loads((ROOT / "project.json").read_text(encoding="utf-8"))
WORKERS = {
    "ocr": "ocr_main",
    "speech-recognition": "speech_recognition_main",
    "speech-recognition-cpu": "speech_recognition_main",
    "diarization": "diarization_main",
}


def import_closure(entry):
    """Follow local imports without executing imports or requiring engine wheels."""
    pending = [entry]
    seen = set()
    while pending:
        module = pending.pop()
        path = SOURCE / (module.replace(".", "/") + ".py")
        package = SOURCE / module.replace(".", "/") / "__init__.py"
        if not path.is_file():
            path = ROOT / "scripts" / (module + ".py")
        if package.is_file():
            path = package
        if not path.is_file() or path in seen:
            continue
        seen.add(path)
        parts = module.split(".")
        pending.extend(".".join(parts[:i]) for i in range(1, len(parts)))
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                pending.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    owner = parts if path.name == "__init__.py" else parts[:-1]
                    base = ".".join(owner[: len(owner) - node.level + 1] + ([base] if base else []))
                pending.append(base)
                pending.extend(base + "." + alias.name for alias in node.names)
            elif isinstance(node, ast.Call) and node.args:
                # Include literal dynamic local imports as well as bytecode imports.
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    if arg.value.startswith("capture_runtime."):
                        pending.append(arg.value)
    return seen


def patterns(name):
    result = []
    for value in PROJECT["namedInputs"][name]:
        if value in PROJECT["namedInputs"]:
            result.extend(patterns(value))
        else:
            result.append(value.replace("{projectRoot}/", ""))
    return result


def matches(path, pattern):
    # Nx minimatch allows **/ to match zero directories; fnmatch does not.
    if fnmatch.fnmatchcase(path, pattern):
        return True
    if "**/" in pattern:
        return matches(path, pattern.replace("**/", "", 1))
    return False


class WorkerCacheInputsTest(unittest.TestCase):
    def test_local_import_closures_are_hashed(self):
        for worker, entry in WORKERS.items():
            with self.subTest(worker=worker):
                target = PROJECT["targets"][f"build-{worker}-worker"]
                globs = patterns(target["inputs"][0])
                closure = import_closure(f"capture_runtime.workers.{entry}")
                # Build-time imports can affect archive output without being frozen.
                closure |= import_closure("build_" + worker.replace("-", "_") + "_worker")
                missing = sorted(
                    path.relative_to(ROOT).as_posix()
                    for path in closure
                    if not any(matches(path.relative_to(ROOT).as_posix(), glob) for glob in globs)
                )
                self.assertEqual([], missing)

    def test_worker_cache_restores_archives_and_probes_hash_their_worker(self):
        for worker in WORKERS:
            with self.subTest(worker=worker):
                build = f"build-{worker}-worker"
                target = PROJECT["targets"][build]
                for output in target["outputs"]:
                    self.assertNotIn("/dist/workers", output)
                if worker == "ocr":
                    continue
                probe = PROJECT["targets"][f"verify-{worker}-worker"]
                self.assertIn(build, probe["dependsOn"])
                self.assertEqual(
                    [*target["inputs"], "{projectRoot}/scripts/probe_packaged_worker.py"],
                    probe["inputs"],
                )

    def test_workers_do_not_hash_unrelated_core_or_other_entries(self):
        for worker in WORKERS:
            globs = patterns(PROJECT["targets"][f"build-{worker}-worker"]["inputs"][0])
            paths = [
                "src/capture_runtime/app.py",
                "src/capture_runtime/capture/application/capture_service.py",
            ]
            paths.extend(
                f"src/capture_runtime/workers/{entry}.py"
                for entry in WORKERS.values()
                if entry != WORKERS[worker]
            )
            for path in paths:
                self.assertFalse(any(matches(path, glob) for glob in globs), (worker, path))


if __name__ == "__main__":
    unittest.main()
