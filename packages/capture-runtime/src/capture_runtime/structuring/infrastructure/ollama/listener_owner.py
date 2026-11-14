"""OS listener identity; unavailable evidence never authenticates a peer."""

from __future__ import annotations

import ctypes
import os
import socket
from pathlib import Path
from typing import Protocol


class ListenerOwner(Protocol):
    def listener_pid(self, port: int) -> int | None: ...


class SystemListenerOwner:
    def listener_pid(self, port: int) -> int | None:
        try:
            return _windows_listener_pid(port) if os.name == "nt" else _proc_listener_pid(port)
        except (OSError, ValueError, IndexError):
            return None


def choose_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _windows_listener_pid(port: int) -> int | None:
    # TCP_TABLE_OWNER_PID_LISTENER contains only IPv4 listeners, with six DWORDs per row.
    api = ctypes.WinDLL("iphlpapi", use_last_error=True).GetExtendedTcpTable
    api.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.c_int,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
    ]
    api.restype = ctypes.c_uint32
    size = ctypes.c_uint32()
    if api(None, ctypes.byref(size), False, socket.AF_INET, 3, 0) != 122:
        return None
    for _ in range(3):
        buffer = ctypes.create_string_buffer(size.value)
        result = api(buffer, ctypes.byref(size), False, socket.AF_INET, 3, 0)
        if result == 122:
            continue
        if result != 0:
            return None
        words = (ctypes.c_uint32 * (len(buffer) // 4)).from_buffer(buffer)
        owners = set()
        for index in range(words[0]):
            offset = 1 + index * 6
            address = socket.inet_ntoa(int(words[offset + 1]).to_bytes(4, "little"))
            if socket.ntohs(words[offset + 2] & 0xFFFF) == port and address in {
                "127.0.0.1",
                "0.0.0.0",
            }:
                owners.add(int(words[offset + 5]))
        return owners.pop() if len(owners) == 1 else None
    return None


def _proc_listener_pid(port: int) -> int | None:
    inodes = set()
    for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
        fields = line.split()
        address, encoded_port = fields[1].split(":")
        if (
            fields[3] == "0A"
            and int(encoded_port, 16) == port
            and address in {"0100007F", "00000000"}
        ):
            inodes.add(fields[9])
    if len(inodes) != 1:
        return None
    owners = set()
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            for descriptor in (process / "fd").iterdir():
                try:
                    target = os.readlink(descriptor)
                except OSError:
                    continue
                if target.startswith("socket:[") and target[8:-1] in inodes:
                    owners.add(int(process.name))
        except OSError:
            continue
    return owners.pop() if len(owners) == 1 else None
