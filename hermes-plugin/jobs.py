"""Async execution jobs for the Hermes-side Jupyter plugin.

The default `jupyter_execute_code` tool blocks until the kernel's
execute_reply lands; for very long cells that pins the agent. The async
path returns immediately with a `job_id` and lets the agent poll
`jupyter_get_job_result` / `jupyter_list_jobs` and cancel with
`jupyter_cancel_job`.

This mirrors `openclaw-plugin/src/jobs.ts` exactly, including the
30-minute TTL on terminal jobs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid as _uuid_mod
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

try:
    import websockets
    _HAS_WEBSOCKETS = True
except ImportError:
    _HAS_WEBSOCKETS = False

logger = logging.getLogger(__name__)

_JOB_TTL_S = 30 * 60
_JOB_CODES: dict[str, "JobState"] = {}


@dataclass
class JobState:
    id: str
    notebook_name: Optional[str]
    notebook_path: Optional[str]
    kernel_id: str
    code: str
    persist_cell_index: Optional[int]
    status: str = "queued"  # queued | running | succeeded | failed | cancelled
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    outputs: list[dict] = field(default_factory=list)  # [{stream, text, ...}]
    error_message: Optional[str] = None
    _finalize_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _on_complete: Optional[Callable[["JobState", str], Awaitable[None]]] = field(
        default=None, repr=False
    )


def register_job(job: JobState) -> None:
    _cleanup()
    _JOB_CODES[job.id] = job


def get_job(job_id: str) -> Optional[JobState]:
    return _JOB_CODES.get(job_id)


def list_jobs() -> list[JobState]:
    _cleanup()
    return sorted(_JOB_CODES.values(), key=lambda j: j.started_at, reverse=True)


def delete_job(job_id: str) -> None:
    _JOB_CODES.pop(job_id, None)


def _cleanup() -> None:
    now = time.time()
    stale = [
        jid
        for jid, j in _JOB_CODES.items()
        if j.ended_at is not None and now - j.ended_at > _JOB_TTL_S
    ]
    for jid in stale:
        del _JOB_CODES[jid]


def summarise(job: JobState) -> str:
    age_s = int(time.time() - job.started_at)
    lines = [
        f"## Job {job.id}",
        f"status        : {job.status}",
        f"kernel        : {job.kernel_id}",
        f"notebook      : {job.notebook_path or '(detached)'}",
        f"started       : {age_s}s ago",
        f"code_preview  : {job.code[:80] + '...' if len(job.code) > 80 else job.code}",
        f"outputs       : {len(job.outputs)} chunk(s) accumulated",
    ]
    if job.ended_at is not None:
        lines.append(
            f"ended         : {int(job.ended_at - job.started_at)}s after start"
        )
    if job.error_message:
        lines.append(f"error         : {job.error_message[:400]}")
    return "\n".join(lines)


def format_outputs(job: JobState) -> str:
    """Return the accumulated outputs as plain text."""
    out: list[str] = []
    for o in job.outputs:
        tag = o.get("stream", "STDOUT").upper()
        text = o.get("text", "")
        out.append(f"[{tag}] {text}")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Fire-and-forget execution
# ---------------------------------------------------------------------------


async def _execute_code_ws_async(
    kernel_id: str,
    code: str,
    job_id: str,
    on_complete: Optional[Callable[[JobState, str], Awaitable[None]]] = None,
    interrupt_event: Optional[asyncio.Event] = None,
) -> None:
    """Background coroutine that buffers outputs into the given job state."""
    if not _HAS_WEBSOCKETS:
        job = _JOB_CODES.get(job_id)
        if job is not None:
            finalize(job_id, "failed", "websockets library not installed")
        return

    ws_url = _build_ws_url(kernel_id)
    msg_id = str(_uuid_mod.uuid4())
    session_id = str(_uuid_mod.uuid4())

    execute_request = {
        "header": {
            "msg_id": msg_id,
            "msg_type": "execute_request",
            "username": "",
            "session": session_id,
            "date": "",
            "version": "5.3",
        },
        "parent_header": {},
        "metadata": {},
        "content": {
            "code": code,
            "silent": False,
            "store_history": True,
            "user_expressions": {},
            "allow_stdin": False,
        },
        "channel": "shell",
    }

    job = _JOB_CODES.get(job_id)
    if job is None:
        return
    job.status = "running"

    try:
        async with websockets.connect(ws_url, open_timeout=15) as ws:
            await ws.send(json.dumps(execute_request))

            async def _receive():
                async for raw in ws:
                    cur = _JOB_CODES.get(job_id)
                    if cur is None:
                        return
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue
                    header = msg.get("header", {})
                    msg_type = header.get("msg_type", "")
                    channel = msg.get("channel", "")
                    content = msg.get("content", {})
                    if channel == "iopub":
                        if msg_type == "stream":
                            text = content.get("text", "") or ""
                            name = content.get("name", "stdout") or "stdout"
                            if text:
                                cur.outputs.append({"stream": "stderr" if name == "stderr" else "stdout", "text": text})
                        elif msg_type in ("execute_result", "display_data"):
                            data = content.get("data", {})
                            text = data.get("text/plain") or json.dumps(data)
                            if text:
                                cur.outputs.append({
                                    "stream": "result" if msg_type == "execute_result" else "display",
                                    "text": str(text),
                                    "execution_count": content.get("execution_count"),
                                })
                        elif msg_type == "error":
                            ename = content.get("ename") or "Error"
                            evalue = content.get("evalue") or ""
                            cur.outputs.append({"stream": "error", "text": f"{ename}: {evalue}"})
                            cur.error_message = f"{ename}: {evalue}"
                    elif channel == "shell" and msg_type == "execute_reply":
                        status = content.get("status") or "unknown"
                        finalize(job_id, "succeeded" if status == "ok" else "failed",
                                 None if status == "ok" else f"Execute status: {status}")
                        if on_complete is not None:
                            try:
                                await on_complete(cur, status)
                            except Exception as e:  # pragma: no cover
                                logger.warning("on_complete callback failed: %s", e)
                        return

            recv_task = asyncio.create_task(_receive())

            # Wait for either execute_reply or cancel event
            stop = asyncio.create_task(job._finalize_event.wait())
            interrupt = asyncio.create_task(interrupt_event.wait()) if interrupt_event else None
            try:
                done, _pending = await asyncio.wait(
                    {recv_task, stop, interrupt} if interrupt else {recv_task, stop},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                # If the cancel event landed close our websocket to nudge the kernel
                if interrupt and interrupt in done and not recv_task.done():
                    try:
                        await ws.close()
                    except Exception:
                        pass
            finally:
                for t in (recv_task, stop, interrupt) if interrupt else (recv_task, stop):
                    if t and not t.done():
                        t.cancel()
                # Drain cancelled tasks
                for t in (recv_task, stop, interrupt) if interrupt else (recv_task, stop):
                    if t:
                        try:
                            await t
                        except (asyncio.CancelledError, Exception):
                            pass
    except Exception as e:
        finalize(job_id, "failed", f"WebSocket error: {e}")


def finalize(job_id: str, status: str, error_message: Optional[str]) -> None:
    job = _JOB_CODES.get(job_id)
    if job is None:
        return
    job.status = status
    job.ended_at = time.time()
    if error_message is not None:
        job.error_message = error_message
    job._finalize_event.set()
