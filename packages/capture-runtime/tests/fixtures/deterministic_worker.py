from __future__ import annotations

import json
import os
import sys
import time

MAX_OUTPUT = 8 * 1024 * 1024


def response(request_id: str, result: dict[str, object]) -> dict[str, object]:
    return {
        "protocolVersion": "1",
        "requestId": request_id,
        "ok": True,
        "result": result,
        "error": None,
    }


request_line = sys.stdin.buffer.readline()
request = json.loads(request_line)
request_id = request["requestId"]
mode = request["payload"].get("mode", "normal")

if mode == "timeout":
    time.sleep(60)
elif mode == "cancel":
    sys.stdin.buffer.readline()
    sys.exit(0)
elif mode == "malformed":
    sys.stdout.write("{not-json}\n")
    sys.stdout.flush()
elif mode == "oversized":
    sys.stdout.write("x" * (MAX_OUTPUT + 1024))
    sys.stdout.flush()
elif mode == "multiple":
    encoded = json.dumps(response(request_id, {"value": "first"}))
    sys.stdout.write(encoded + "\n" + encoded + "\n")
    sys.stdout.flush()
elif mode == "protocol-mismatch":
    payload = response(request_id, {"value": "wrong"})
    payload["protocolVersion"] = "999"
    print(json.dumps(payload), flush=True)
elif mode == "security":
    serialized_request = request_line.decode("utf-8", errors="replace")
    print(
        json.dumps(
            response(
                request_id,
                {
                    "apiTokenInEnvironment": "CAPTURE_API_TOKEN" in os.environ,
                    "secretInEnvironment": "CAPTURE_TEST_SECRET" in os.environ,
                    "secretInArgv": any("secret-value" in item for item in sys.argv),
                    "secretInStdin": "secret-value" in serialized_request,
                },
            )
        ),
        flush=True,
    )
else:
    print(json.dumps(response(request_id, {"value": "ok"})), flush=True)
