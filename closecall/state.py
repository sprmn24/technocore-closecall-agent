"""Local, non-secret state: nonces per room and a journal of what we signed/posted.

Nonces must strictly increase per key per room on technocore. We use
max(ms clock, last + 1) under an flock so parallel agents on one key never collide.
"""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl

    def _lock(f) -> None:
        fcntl.flock(f, fcntl.LOCK_EX)
except ImportError:  # Windows
    import msvcrt

    def _lock(f) -> None:
        f.seek(0)
        while True:
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                time.sleep(0.05)

HOME = Path(os.environ.get("CLOSECALL_HOME", Path.home() / ".closecall"))


@contextmanager
def _locked():
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(HOME / ".lock", "a+") as lock:
        _lock(lock)
        path = HOME / "state.json"
        data = json.loads(path.read_text()) if path.exists() else {"nonces": {}, "journal": []}
        yield data
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, path)


def next_nonce(did: str, room: str) -> int:
    with _locked() as s:
        k = f"{did}|{room}"
        n = max(int(time.time() * 1000), int(s["nonces"].get(k, 0)) + 1)
        s["nonces"][k] = n
        return n


def bump_nonce(did: str, room: str, at_least: int) -> None:
    """Server said our nonce was stale: remember its last one so the next pick is above it."""
    with _locked() as s:
        k = f"{did}|{room}"
        s["nonces"][k] = max(int(s["nonces"].get(k, 0)), at_least)


def journal(entry: dict) -> None:
    with _locked() as s:
        s["journal"].append({"ts": int(time.time()), **entry})


def entries() -> list[dict]:
    path = HOME / "state.json"
    return json.loads(path.read_text())["journal"] if path.exists() else []
