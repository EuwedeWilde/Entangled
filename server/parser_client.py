"""
parser_client.py — Python-side client for the long-lived Node parser worker.

We spawn `node server/parser_worker.js` once and keep it alive. Every call to
.evaluate(pattern) sends one line and reads one line back. The protocol is
strictly synchronous request/response from this side — PPO's vector env runs
many envs in lockstep on one thread, so we don't need parallel requests.

If the worker dies (parser bug, OOM, anything), we lazily respawn on the next
call. Failures during a respawn surface as the standard "fail" verdict so the
agent gets the negative reward and the training loop keeps going.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
WORKER_PATH = HERE / "parser_worker.js"


@dataclass(frozen=True)
class ParseVerdict:
    """Result of evaluating one pattern."""
    ok: bool
    n_stitches: int = 0
    error: str = ""


class ParserClient:
    """Synchronous line-delimited JSON client over a persistent Node worker.

    Thread-safe (one in-flight request at a time, guarded by a Lock). PPO's
    rollout worker is single-threaded so the lock isn't strictly necessary,
    but it makes the websocket layer safer when the user issues a `generate`
    call mid-training.
    """

    def __init__(self, node_binary: str = "node") -> None:
        self._node_binary = node_binary
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._next_id = 0

    # --- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Spawn the worker and wait for the ready handshake."""
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return  # already running
            self._spawn_locked()

    def _spawn_locked(self) -> None:
        """Caller must hold self._lock."""
        if not WORKER_PATH.exists():
            raise FileNotFoundError(f"parser worker not found at {WORKER_PATH}")
        self._proc = subprocess.Popen(
            [self._node_binary, str(WORKER_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
            cwd=str(PROJECT_ROOT),
        )
        # Wait for the ready handshake. If this times out or the process
        # exits early, surface the worker's stderr so the user can diagnose.
        ready = self._proc.stdout.readline()
        if not ready:
            stderr = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"parser worker died at startup: {stderr.strip()}")
        try:
            msg = json.loads(ready)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"parser worker sent garbage at startup: {ready!r}") from e
        if msg.get("id") != "ready":
            raise RuntimeError(f"parser worker sent unexpected handshake: {msg!r}")

    def stop(self) -> None:
        with self._lock:
            if self._proc is None:
                return
            try:
                self._proc.stdin.close()
                self._proc.wait(timeout=2.0)
            except Exception:
                self._proc.kill()
            finally:
                self._proc = None

    def __enter__(self) -> "ParserClient":
        self.start()
        return self

    def __exit__(self, *_exc):
        self.stop()

    # --- evaluation ---------------------------------------------------------

    def evaluate(self, pattern: str) -> ParseVerdict:
        """Send one pattern, get one verdict.

        Empty patterns are treated as invalid without round-tripping to Node
        (the worker would respond with an error anyway, but this saves IPC).
        """
        if not pattern or not pattern.strip():
            return ParseVerdict(ok=False, error="empty")

        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                # First call, or worker has died — (re)spawn.
                self._spawn_locked()
            self._next_id += 1
            req = {"id": self._next_id, "pattern": pattern}
            try:
                self._proc.stdin.write(json.dumps(req) + "\n")
                self._proc.stdin.flush()
                resp_line = self._proc.stdout.readline()
            except (BrokenPipeError, OSError) as e:
                # Worker crashed mid-call. Mark this attempt failed; next
                # call will respawn.
                self._proc = None
                return ParseVerdict(ok=False, error=f"worker-io: {e}")

            if not resp_line:
                self._proc = None
                return ParseVerdict(ok=False, error="worker-eof")

            try:
                resp = json.loads(resp_line)
            except json.JSONDecodeError:
                return ParseVerdict(ok=False, error=f"bad-resp: {resp_line[:80]!r}")

            return ParseVerdict(
                ok=bool(resp.get("ok")),
                n_stitches=int(resp.get("n_stitches") or 0),
                error=str(resp.get("error") or ""),
            )
