"""ClawPyter tool handlers for Hermes Agent.

Implements the Jupyter REST API client and WebSocket kernel execution in Python,
mirroring the TypeScript JupyterDirectClient from the OpenClaw plugin.

Configuration via environment variables:
  JUPYTER_URL             — Jupyter server base URL (default: http://127.0.0.1:8888)
  JUPYTER_TOKEN           — Authentication token (default: empty)
  JUPYTER_TIMEOUT_MS      — Request timeout in milliseconds (default: 30000)
  JUPYTER_DEFAULT_NOTEBOOK — Default notebook name (default: Untitled)
"""

import asyncio
import json
import logging
import os
import re
import uuid as _uuid_mod
from typing import Optional
from urllib.parse import quote

try:
    import httpx
    _HAS_HTTPX = True
except ImportError:
    _HAS_HTTPX = False

try:
    import websockets
    _HAS_WEBSOCKETS = True
except ImportError:
    _HAS_WEBSOCKETS = False

from . import collab_client as _collab
from .jobs import (
    JobState,
    delete_job,
    finalize,
    format_outputs as _format_job_outputs,
    get_job,
    list_jobs,
    register_job,
    summarise as _summarise_job,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Module-level state (mirrors the TypeScript JupyterDirectClient instance)
# ---------------------------------------------------------------------------

class _State:
    """Mutable Jupyter connection and session state, shared across tool calls."""

    def __init__(self) -> None:
        self.jupyter_url: str = os.environ.get("JUPYTER_URL", "http://127.0.0.1:8888").rstrip("/")
        self.jupyter_token: str = os.environ.get("JUPYTER_TOKEN", "")
        self.timeout_s: float = int(os.environ.get("JUPYTER_TIMEOUT_MS", "30000")) / 1000.0
        self.current_notebook: Optional[str] = None
        # name -> {"path": str, "kernel_id": str, "session_id": str}
        self.sessions: dict = {}
        # Collaboration: tri-state mode ("auto" / "on" / "off") + cached probe result.
        # "off" = never use RTC. "on" = require RTC (error if unavailable).
        # "auto" = probe once per server, prefer RTC if the endpoint answers.
        self.collab_mode: str = os.environ.get("JUPYTER_COLLAB_MODE", "auto").lower()
        self.collab_available: Optional[bool] = None  # None = not probed yet
        # name -> CollabRoom
        self.collab_rooms: dict = {}


_state = _State()


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _auth_headers() -> dict:
    h = {"Content-Type": "application/json"}
    if _state.jupyter_token:
        h["Authorization"] = f"token {_state.jupyter_token}"
    return h


async def _req(method: str, path: str, body=None):
    """Perform an authenticated HTTP request to the Jupyter REST API."""
    if not _HAS_HTTPX:
        raise RuntimeError("httpx is required. Install with: pip install httpx")

    url = f"{_state.jupyter_url}{path}"
    async with httpx.AsyncClient(timeout=_state.timeout_s) as client:
        resp = await client.request(
            method,
            url,
            headers=_auth_headers(),
            json=body,
        )
        if resp.status_code == 204:
            return None
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _format_size(b) -> str:
    if b is None:
        return ""
    b = int(b)
    if b < 1024:
        return f"{b}B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f}KB"
    return f"{b / (1024 * 1024):.1f}MB"


def _format_date(iso) -> str:
    if not iso:
        return ""
    try:
        return str(iso).replace("T", " ")[:19]
    except Exception:
        return str(iso)


def _tsv(headers: list, rows: list) -> str:
    return "\n".join(["\t".join(headers)] + ["\t".join(str(c) for c in r) for r in rows])


def _format_cells(cells: list, fmt: str, start: int, limit: int) -> str:
    total = len(cells)
    end = min(start + limit, total) if limit > 0 else total
    lines = [f"Showing cells {start}-{end - 1} of {total}"]
    for i, cell in enumerate(cells[start:end]):
        idx = start + i
        source = cell.get("source", "")
        ec = cell.get("execution_count") or "-"
        if fmt == "brief":
            first_line = source.split("\n")[0] if source else ""
            line_count = len(source.split("\n"))
            lines.append(f"[{idx}] {cell.get('cell_type')} | exec:{ec} | {line_count} lines | {first_line}")
        else:
            lines.append(f"[{idx}] {cell.get('cell_type')} | exec:{ec}")
            lines.append(source)
            lines.append("---")
    return "\n".join(lines)


def _diff_source(old: str, new: str) -> str:
    old_lines = old.split("\n")
    new_lines = new.split("\n")
    result = []
    max_len = max(len(old_lines), len(new_lines))
    for i in range(max_len):
        o = old_lines[i] if i < len(old_lines) else None
        n = new_lines[i] if i < len(new_lines) else None
        if o is None:
            result.append(f"+ {n}")
        elif n is None:
            result.append(f"- {o}")
        elif o != n:
            result.append(f"- {o}")
            result.append(f"+ {n}")
        else:
            result.append(f"  {o}")
    return "\n".join(result) or "no changes detected"


# ---------------------------------------------------------------------------
# WebSocket kernel execution
# ---------------------------------------------------------------------------

def _build_ws_url(kernel_id: str) -> str:
    ws_base = _state.jupyter_url.replace("http://", "ws://").replace("https://", "wss://")
    token_param = f"?token={_state.jupyter_token}" if _state.jupyter_token else ""
    return f"{ws_base}/api/kernels/{kernel_id}/channels{token_param}"


async def _execute_code_ws(kernel_id: str, code: str, timeout_s: float) -> list:
    """Execute code on a Jupyter kernel via WebSocket and return output lines."""
    if not _HAS_WEBSOCKETS:
        return ["[ERROR: websockets library not installed. Run: pip install websockets]"]

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

    outputs = []
    done_event = asyncio.Event()

    async def _receive(ws):
        async for raw in ws:
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
                    text = content.get("text", "")
                    if text:
                        outputs.append(text)
                elif msg_type in ("execute_result", "display_data"):
                    data = content.get("data", {})
                    text = data.get("text/plain") or json.dumps(data)
                    if text:
                        outputs.append(str(text))
                elif msg_type == "error":
                    ename = content.get("ename", "Error")
                    evalue = content.get("evalue", "")
                    outputs.append(f"[ERROR: {ename}: {evalue}]")
            elif channel == "shell" and msg_type == "execute_reply":
                done_event.set()
                return

    try:
        async with websockets.connect(ws_url, open_timeout=min(timeout_s, 30)) as ws:
            await ws.send(json.dumps(execute_request))
            recv_task = asyncio.ensure_future(_receive(ws))
            try:
                await asyncio.wait_for(done_event.wait(), timeout=timeout_s)
            except asyncio.TimeoutError:
                outputs.append(f"[TIMEOUT ERROR: Execution exceeded {timeout_s:.0f}s]")
            finally:
                recv_task.cancel()
                try:
                    await recv_task
                except (asyncio.CancelledError, Exception):
                    pass
    except Exception as e:
        outputs.append(f"[ERROR: {e}]")

    return outputs if outputs else ["[No output generated]"]


# ---------------------------------------------------------------------------
# Jupyter REST API helpers
# ---------------------------------------------------------------------------

async def _list_files_raw(path: str = "", max_depth: int = 1, pattern: str = "") -> str:
    files = []

    async def traverse(dir_path: str, depth: int) -> None:
        encoded = quote(dir_path, safe="/")
        url = f"/api/contents/{encoded}?content=1" if encoded else "/api/contents?content=1"
        try:
            data = await _req("GET", url)
        except Exception:
            return
        items = data.get("content", []) if isinstance(data.get("content"), list) else []
        for item in items:
            files.append({
                "path": item["path"],
                "type": item["type"],
                "size": _format_size(item.get("size")),
                "last_modified": _format_date(item.get("last_modified")),
            })
            if item["type"] == "directory" and depth < max_depth:
                await traverse(item["path"], depth + 1)

    await traverse(path, 0)
    files.sort(key=lambda f: f["path"])

    if pattern:
        re_pat = (
            "^"
            + pattern.replace(".", r"\.").replace("**", ".*").replace("*", "[^/]*")
            + "$"
        )
        files = [f for f in files if re.match(re_pat, f["path"])]

    if not files:
        if pattern:
            return f"No files matching pattern '{pattern}' found in path '{path or 'root'}'"
        return f"No files found in path '{path or 'root'}'"

    return _tsv(
        ["Path", "Type", "Size", "Last_Modified"],
        [[f["path"], f["type"], f["size"], f["last_modified"]] for f in files],
    )


async def _get_notebook(path: str) -> dict:
    encoded = quote(path, safe="/")
    data = await _req("GET", f"/api/contents/{encoded}?content=1")
    return data["content"]


async def _resolve_cell_index(
    notebook: dict,
    cell_index: "int | None",
    cell_id: "str | None",
) -> int:
    """Resolve the cell index for an op given either `cell_index` or `cell_id`.

    Mirrors jmcp's `cell_ids.resolve` logic: cell_id is preferred when both
    are supplied. Returns the resolved int index, or raises ValueError for
    invalid inputs.
    """
    if cell_id is None and cell_index is None:
        raise ValueError("Either cell_index or cell_id must be supplied.")
    cells = notebook.get("cells", []) or []
    if cell_id is not None:
        for i, c in enumerate(cells):
            if c.get("id") == cell_id:
                return i
        raise ValueError(
            f"No cell with cell_id='{cell_id}' (notebook has {len(cells)} cells)."
        )
    # cell_index path
    if cell_index < 0 or cell_index >= len(cells):
        raise ValueError(
            f"cell_index {cell_index} is out of range (notebook has {len(cells)} cells)."
        )
    return cell_index


async def _put_notebook(path: str, notebook: dict) -> None:
    encoded = quote(path, safe="/")
    await _req("PUT", f"/api/contents/{encoded}", {"type": "notebook", "content": notebook})


async def _create_notebook(path: str) -> None:
    scaffold = {
        "cells": [{
            "cell_type": "markdown",
            "metadata": {},
            "source": "New Notebook Created by ClawPyter",
        }],
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 4,
    }
    encoded = quote(path, safe="/")
    await _req("PUT", f"/api/contents/{encoded}", {"type": "notebook", "content": scaffold})


async def _create_session(path: str, kernel_id: Optional[str] = None) -> dict:
    body = {
        "path": path,
        "type": "notebook",
        "name": path,
        "kernel": {"id": kernel_id} if kernel_id else {},
    }
    return await _req("POST", "/api/sessions", body)


async def _delete_session(session_id: str) -> None:
    await _req("DELETE", f"/api/sessions/{session_id}")


async def _restart_kernel(kernel_id: str) -> None:
    await _req("POST", f"/api/kernels/{kernel_id}/restart", {})


def _build_lab_url(path: str) -> str:
    clean = path.lstrip("/")
    token_part = f"?token={_state.jupyter_token}" if _state.jupyter_token else ""
    return f"{_state.jupyter_url}/lab/tree/{clean}{token_part}"


async def _resolve_new_notebook_name(explicit_name: Optional[str] = None) -> str:
    base = explicit_name or os.environ.get("JUPYTER_DEFAULT_NOTEBOOK", "Untitled")
    if not base.endswith(".ipynb"):
        base += ".ipynb"

    try:
        listing = await _list_files_raw("", 1, base.replace(".ipynb", "") + "*")
        existing = set()
        for line in listing.split("\n"):
            if line and not line.startswith("Path\t") and not line.startswith("No files"):
                parts = line.split("\t")
                if parts:
                    existing.add(parts[0])
    except Exception:
        existing = set()

    if base not in existing:
        return base

    base_no_ext = base[:-6]
    counter = 1
    while True:
        candidate = f"{base_no_ext}-{counter}.ipynb"
        if candidate not in existing:
            return candidate
        counter += 1


def _resolve_notebook_identifier(args: dict) -> str:
    name = args.get("notebook_name", "")
    if name and name.strip():
        return name
    return args.get("notebook_path", "")


def _resolve_target_session(args: dict) -> Optional[dict]:
    """Pick a session by optional `notebook_name`; falls back to current notebook.

    Returns the session dict from `_state.sessions`, or None when no current
    notebook is set and `notebook_name` is also unset / unknown.

    Multi-notebook support: when `notebook_name` is provided, look it up in
    `_state.sessions` and use that session instead of the current one. When
    omitted, use the existing current-notebook behaviour for backwards
    compatibility. The session dict exposes `name`, `path`, `kernel_id`, and `session_id`.
    """
    name = args.get("notebook_name", "")
    if isinstance(name, str) and name.strip():
        target = name.strip()
        return _state.sessions.get(target)
    if _state.current_notebook and _state.current_notebook in _state.sessions:
        return _state.sessions[_state.current_notebook]
    return None


# ---------------------------------------------------------------------------
# Collaboration (Y.js RTC) helpers
# ---------------------------------------------------------------------------

async def _ensure_collab_probed() -> bool:
    """Probe ``/api/collaboration/session/...`` once per server (cached).

    Returns True iff jupyter-collaboration is available and the user hasn't
    disabled it via ``JUPYTER_COLLAB_MODE=off``."""
    if _state.collab_mode == "off":
        _state.collab_available = False
        return False
    if not _collab.HAS_COLLAB:
        _state.collab_available = False
        return False
    if _state.collab_available is not None:
        return _state.collab_available
    # Probe against a stable path: prefer an active session's path.
    probe_path = next(iter(_state.sessions.values()))["path"] if _state.sessions else ""
    available = await _collab.probe_server_collab(
        None, _state.jupyter_url, _state.jupyter_token, probe_path or "Untitled.ipynb"
    )
    _state.collab_available = available
    if not available and _state.collab_mode == "on":
        logger.warning("JUPYTER_COLLAB_MODE=on but server has no jupyter-collaboration; using REST fallback.")
    return available


async def _open_collab_room(notebook_name: str, path: str):
    """Open a CollabRoom for ``notebook_name`` if collaboration is available.

    Silent no-op (returns None) when collaboration is off/unavailable so callers
    can transparently fall back to the Contents-API path."""
    if not await _ensure_collab_probed():
        return None
    if notebook_name in _state.collab_rooms:
        return _state.collab_rooms[notebook_name]
    try:
        room = _collab.CollabRoom(_state.jupyter_url, _state.jupyter_token, path)
        await room.open()
        _state.collab_rooms[notebook_name] = room
        logger.info("ClawPyter: opened collaboration room for %s", path)
        return room
    except Exception as e:
        logger.warning("ClawPyter: could not open collab room for %s: %s — falling back to REST", path, e)
        return None


async def _close_collab_room(notebook_name: str) -> None:
    room = _state.collab_rooms.pop(notebook_name, None)
    if room is not None:
        await room.close()


def _get_collab_room(notebook_name: Optional[str]):
    if not notebook_name:
        return None
    return _state.collab_rooms.get(notebook_name)


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------

async def jupyter_server_info(args: dict, **kwargs) -> str:
    return (
        f"Jupyter server info\n\n"
        f"jupyter_url: {_state.jupyter_url}\n"
        f"jupyter_token: {'(set)' if _state.jupyter_token else '(empty)'}"
    )


async def jupyter_connect_to_jupyter(args: dict, **kwargs) -> str:
    url = str(args.get("jupyter_url", "")).strip()
    token = str(args.get("jupyter_token", "") or "")
    if not url:
        return "Error: jupyter_url is required"
    _state.jupyter_url = url.rstrip("/")
    _state.jupyter_token = token
    # Reset cached collab probe so we re-probe the new server.
    _state.collab_available = None
    collab_ok = await _ensure_collab_probed()
    mode = "collaborative (RTC)" if collab_ok else "REST (no jupyter-collaboration)"
    return f"Connect to Jupyter: {url}\n\nConnected to Jupyter server at {url}\nEdit mode: {mode}"


async def jupyter_list_files(args: dict, **kwargs) -> str:
    path = str(args.get("path", "") or "")
    max_depth = int(args.get("max_depth", 1))
    pattern = str(args.get("pattern", "") or "")
    start_index = int(args.get("start_index", 0))
    limit = int(args.get("limit", 25))

    result = await _list_files_raw(path, max_depth, pattern)

    lines = result.split("\n")
    if len(lines) > 1 and lines[0].startswith("Path\t"):
        header = lines[0]
        rows = lines[1:]
        total = len(rows)
        end = min(start_index + limit, total) if limit > 0 else total
        paginated = rows[start_index:end]
        result = (
            f"Showing {start_index}-{end} of {total} files\n\n"
            + header
            + "\n"
            + "\n".join(paginated)
        )

    return f"Jupyter files\n\n{result}"


async def jupyter_list_kernels(args: dict, **kwargs) -> str:
    try:
        kernels = await _req("GET", "/api/kernels")
    except Exception as e:
        return f"Jupyter kernels\n\n[ERROR] Failed to list kernels: {e}"
    try:
        specs_response = await _req("GET", "/api/kernelspecs")
    except Exception:
        specs_response = {"default": "", "kernelspecs": {}}

    if not kernels:
        return "Jupyter kernels\n\nNo kernels found on the Jupyter server."

    specs = (specs_response or {}).get("kernelspecs", {})
    rows = []
    for k in kernels:
        spec = specs.get(k["name"], {}).get("spec", {})
        display_name = spec.get("display_name", "unknown")
        language = spec.get("language", "unknown")
        env_dict = spec.get("env", {})
        env_str = "; ".join(f"{k2}={v2}" for k2, v2 in env_dict.items())
        if len(env_str) > 100:
            env_str = env_str[:100] + "..."
        env_str = env_str or "unknown"
        rows.append([
            k["id"],
            k["name"],
            display_name,
            language,
            k.get("execution_state", "unknown"),
            str(k.get("connections", "unknown")),
            _format_date(k.get("last_activity")),
            env_str,
        ])

    result = _tsv(
        ["ID", "Name", "Display_Name", "Language", "State", "Connections", "Last_Activity", "Environment"],
        rows,
    )
    return f"Jupyter kernels\n\n{result}"


async def jupyter_create_notebook(args: dict, **kwargs) -> str:
    explicit_name = args.get("notebook_name")
    resolved_name = await _resolve_new_notebook_name(explicit_name or None)

    await _create_notebook(resolved_name)
    session = await _create_session(resolved_name)
    _state.sessions[resolved_name] = {
        "name": resolved_name,
        "path": resolved_name,
        "kernel_id": session["kernel"]["id"],
        "session_id": session["id"],
    }
    _state.current_notebook = resolved_name

    url = _build_lab_url(resolved_name)
    message = f"Notebook **{resolved_name}** created successfully.\n\nAccess URL:\n{url}"
    return f"Notebook created\n\n{message}"


async def jupyter_use_notebook(args: dict, **kwargs) -> str:
    notebook_path = str(args.get("notebook_path", "") or "")
    notebook_name = str(args.get("notebook_name", "") or "")
    mode = str(args.get("mode", "connect"))
    requested_kernel_id = args.get("kernel_id")

    if not notebook_path:
        return "Error: notebook_path is required"
    if not notebook_name:
        notebook_name = notebook_path

    info_lines = []

    existing = _state.sessions.get(notebook_name)
    if existing:
        if mode == "create" and existing["path"] == notebook_path:
            return (
                f"Use notebook: {notebook_path}\n\n"
                f"Notebook '{notebook_name}' (path: {notebook_path}) is already created. "
                "DO NOT CREATE AGAIN."
            )
        if existing["path"] == notebook_path:
            if notebook_name == _state.current_notebook:
                return (
                    f"Use notebook: {notebook_path}\n\n"
                    f"Notebook '{notebook_name}' is already activated now. DO NOT REACTIVATE AGAIN."
                )
            info_lines.append(f"[INFO] Reactivating notebook '{notebook_name}'")
            _state.current_notebook = notebook_name
        else:
            return (
                f"Use notebook: {notebook_path}\n\n"
                f"The path '{notebook_path}' is not the correct path for notebook "
                f"'{notebook_name}'. Do you mean connect to '{existing['path']}'?"
            )
    else:
        if mode == "create":
            await _create_notebook(notebook_path)
            info_lines.append(f"[INFO] Notebook file '{notebook_path}' created.")

        session = await _create_session(notebook_path, requested_kernel_id or None)
        _state.sessions[notebook_name] = {
            "name": notebook_name,
            "path": notebook_path,
            "kernel_id": session["kernel"]["id"],
            "session_id": session["id"],
        }
        _state.current_notebook = notebook_name
        info_lines.append(f"[INFO] Connected to kernel '{session['kernel']['id']}'.")
        info_lines.append(f"[INFO] Successfully activated notebook '{notebook_name}'.")

    # Try to open a collaboration room so subsequent edits go through the
    # CRDT layer.  Failure is non-fatal — we silently fall back to REST.
    room = await _open_collab_room(notebook_name, notebook_path)
    if room is not None:
        info_lines.append("[INFO] Collaboration room open (live co-editing enabled).")

    try:
        nb = await _get_notebook(notebook_path)
        cells = nb.get("cells", [])
        info_lines.append(f"\nNotebook has {len(cells)} cells.")
        info_lines.append(f"Showing first {min(20, len(cells))} cells:\n")
        info_lines.append(_format_cells(cells, "brief", 0, 20))
    except Exception:
        pass

    return f"Use notebook: {notebook_path}\n\n" + "\n".join(info_lines)


async def jupyter_list_notebooks(args: dict, **kwargs) -> str:
    if not _state.sessions:
        return "Jupyter notebooks\n\nNo notebooks currently in use."

    rows = []
    for name, sess in _state.sessions.items():
        rows.append([
            name,
            sess["path"],
            sess["kernel_id"],
            "unknown",
            "✓" if name == _state.current_notebook else "",
        ])

    result = _tsv(["Name", "Path", "Kernel_ID", "Kernel_Status", "Activate"], rows)
    return f"Jupyter notebooks\n\n{result}"


async def jupyter_restart_notebook(args: dict, **kwargs) -> str:
    notebook_name = str(args.get("notebook_name", "") or "")
    sess = _state.sessions.get(notebook_name)
    if not sess:
        return f"Restart notebook: {notebook_name}\n\nNotebook '{notebook_name}' is not connected."
    await _restart_kernel(sess["kernel_id"])
    return f"Restart notebook: {notebook_name}\n\nKernel for notebook '{notebook_name}' restarted successfully."


async def jupyter_restart_notebook_compat(args: dict, **kwargs) -> str:
    notebook_name = _resolve_notebook_identifier(args)
    return await jupyter_restart_notebook({**args, "notebook_name": notebook_name})


async def jupyter_unuse_notebook(args: dict, **kwargs) -> str:
    notebook_name = str(args.get("notebook_name", "") or "")
    sess = _state.sessions.get(notebook_name)
    if not sess:
        return f"Unuse notebook: {notebook_name}\n\nNotebook '{notebook_name}' is not connected."
    await _close_collab_room(notebook_name)
    await _delete_session(sess["session_id"])
    del _state.sessions[notebook_name]
    if _state.current_notebook == notebook_name:
        _state.current_notebook = next(iter(_state.sessions), None)
    return f"Unuse notebook: {notebook_name}\n\nNotebook '{notebook_name}' disconnected and resources released."


async def jupyter_unuse_notebook_compat(args: dict, **kwargs) -> str:
    notebook_name = _resolve_notebook_identifier(args)
    return await jupyter_unuse_notebook({**args, "notebook_name": notebook_name})


async def jupyter_read_notebook(args: dict, **kwargs) -> str:
    notebook_name = str(args.get("notebook_name", "") or "")
    sess = _state.sessions.get(notebook_name)
    if not sess:
        return f"Read notebook: {notebook_name}\n\nNotebook '{notebook_name}' is not connected."

    fmt = str(args.get("response_format", "brief"))
    if fmt not in ("brief", "detailed"):
        fmt = "brief"
    start_index = int(args.get("start_index", 0))
    limit = int(args.get("limit", 20))

    room = _get_collab_room(notebook_name)
    if room is not None:
        nb = room.to_nbformat()
    else:
        nb = await _get_notebook(sess["path"])
    cells = nb.get("cells", [])
    output = (
        f"Notebook {notebook_name} has {len(cells)} cells.\n\n"
        + _format_cells(cells, fmt, start_index, limit)
    )
    return f"Read notebook: {notebook_name}\n\n{output}"


async def jupyter_read_notebook_compat(args: dict, **kwargs) -> str:
    notebook_name = _resolve_notebook_identifier(args)
    return await jupyter_read_notebook({**args, "notebook_name": notebook_name})


async def jupyter_insert_cell(args: dict, **kwargs) -> str:
    current = _state.current_notebook
    if not current:
        return "Insert cell\n\nNo active notebook. Use jupyter_use_notebook first."

    sess = _state.sessions[current]
    room = _get_collab_room(current)

    cell_type = str(args.get("cell_type", "code"))
    cell_source = str(args.get("cell_source", ""))
    cell_index = int(args.get("cell_index", -1))

    if room is not None:
        total = room.cell_count()
        if cell_index < -1 or cell_index > total:
            return (
                f"Insert cell\n\nIndex {cell_index} is outside valid range [-1, {total}]. "
                "Use -1 to append at end."
            )
        actual_index = total if cell_index == -1 else cell_index
        room.insert_cell(actual_index, cell_type, cell_source)
        cells = room.to_nbformat().get("cells", [])
    else:
        nb = await _get_notebook(sess["path"])
        cells = nb.get("cells", [])
        total = len(cells)
        if cell_index < -1 or cell_index > total:
            return (
                f"Insert cell\n\nIndex {cell_index} is outside valid range [-1, {total}]. "
                "Use -1 to append at end."
            )
        actual_index = total if cell_index == -1 else cell_index

        new_cell = {"cell_type": cell_type, "source": cell_source, "metadata": {}}
        if cell_type == "code":
            new_cell["outputs"] = []
            new_cell["execution_count"] = None

        cells.insert(actual_index, new_cell)
        nb["cells"] = cells
        await _put_notebook(sess["path"], nb)

    new_total = len(cells)
    start_ctx = max(0, actual_index - 5)
    output = "\n".join([
        f"Cell inserted successfully at index {actual_index} ({cell_type})!",
        f"Notebook now has {new_total} cells, showing surrounding cells:",
        _format_cells(cells, "brief", start_ctx, 10),
    ])
    return f"Insert cell\n\n{output}"


async def jupyter_overwrite_cell_source(args: dict, **kwargs) -> str:
    sess = _resolve_target_session(args)
    if sess is None:
        return "Overwrite cell\n\nNo active notebook. Use jupyter_use_notebook first (or pass notebook_name)."

    current = sess["name"]
    room = _get_collab_room(current)
    cell_index_arg = args.get("cell_index")
    cell_id = args.get("cell_id")
    if cell_index_arg is not None:
        try:
            cell_index = int(cell_index_arg)
        except (TypeError, ValueError):
            return "Overwrite cell\n\n'cell_index' must be an integer."
    else:
        cell_index = None
    new_source = str(args.get("cell_source", ""))

    if room is not None:
        # CRDT path: cells carry `id` on cell maps
        def _resolve_in_room(room_obj):
            for i in range(room_obj.cell_count()):
                cv = room_obj.get_cell(i)
                if cell_id is not None and cv.get("id") == cell_id:
                    return i
            if cell_id is not None:
                raise ValueError(
                    f"No cell with cell_id='{cell_id}' (notebook has {room_obj.cell_count()} cells)."
                )
            total = room_obj.cell_count()
            if cell_index < 0 or cell_index >= total:
                raise ValueError(f"Cell index {cell_index} out of range (notebook has {total} cells).")
            return cell_index
        try:
            cell_index_resolved = _resolve_in_room(room)
        except ValueError as e:
            return f"Overwrite cell\n\n[ERROR] {e}"
        old_source = room.get_cell(cell_index_resolved).get("source", "")
        room.set_cell_source(cell_index_resolved, new_source)
    else:
        nb = await _get_notebook(sess["path"])
        try:
            cell_index_resolved = await _resolve_cell_index(nb, cell_index, cell_id)
        except ValueError as e:
            return f"Overwrite cell\n\n[ERROR] {e}"
        cells = nb.get("cells", [])
        cell = cells[cell_index_resolved]
        old_source = cell.get("source", "")
        cells[cell_index_resolved]["source"] = new_source
        if cell.get("cell_type") == "code":
            cells[cell_index_resolved]["outputs"] = []
            cells[cell_index_resolved]["execution_count"] = None
        await _put_notebook(sess["path"], nb)

    diff = _diff_source(old_source, new_source)
    return f"Overwrite cell {cell_index_resolved}\n\n{diff}"


async def jupyter_execute_cell(args: dict, **kwargs) -> str:
    """Synchronous by default; pass run_async=true to fire-and-forget."""
    sess = _resolve_target_session(args)
    if sess is None:
        return "Execute cell\n\nNo active notebook. Use jupyter_use_notebook first (or pass notebook_name)."

    current = sess["name"]
    room = _get_collab_room(current)
    cell_index_arg = args.get("cell_index")
    cell_id = args.get("cell_id")
    if cell_index_arg is not None:
        try:
            cell_index = int(cell_index_arg)
        except (TypeError, ValueError):
            return "Execute cell\n\n'cell_index' must be an integer."
    else:
        cell_index = None
    run_async = bool(args.get("run_async", False))

    if room is not None:
        def _resolve_in_room(room_obj):
            for i in range(room_obj.cell_count()):
                cv = room_obj.get_cell(i)
                if cell_id is not None and cv.get("id") == cell_id:
                    return i
            if cell_id is not None:
                raise ValueError(
                    f"No cell with cell_id='{cell_id}' (notebook has {room_obj.cell_count()} cells)."
                )
            total = room_obj.cell_count()
            if cell_index < 0 or cell_index >= total:
                raise ValueError(f"Cell index {cell_index} out of range (notebook has {total} cells).")
            return cell_index
        try:
            cell_index_resolved = _resolve_in_room(room)
        except ValueError as e:
            return f"Execute cell\n\n[ERROR] {e}"
        cell_view = room.get_cell(cell_index_resolved)
        if cell_view.get("cell_type") != "code":
            return (
                f"Execute cell {cell_index_resolved}\n\n"
                f"Cell {cell_index_resolved} is not a code cell (type: {cell_view.get('cell_type')})."
            )
        source = cell_view.get("source", "")
        prev_exec_count = int(cell_view.get("execution_count") or 0)
    else:
        nb = await _get_notebook(sess["path"])
        try:
            cell_index_resolved = await _resolve_cell_index(nb, cell_index, cell_id)
        except ValueError as e:
            return f"Execute cell\n\n[ERROR] {e}"
        cell_arr = nb.get("cells", [])
        cell = cell_arr[cell_index_resolved]
        if cell.get("cell_type") != "code":
            return (
                f"Execute cell {cell_index_resolved}\n\n"
                f"Cell {cell_index_resolved} is not a code cell (type: {cell.get('cell_type')})."
            )
        source = cell.get("source", "")
        prev_exec_count = int(cell.get("execution_count") or 0)

    if run_async:
        async def _persist(job: JobState, _status: str) -> None:
            """Write the buffered outputs back to the cell when the kernel done."""
            nb_outputs = [
                {"output_type": "stream", "name": "stdout", "text": o.get("text", "")}
                if o.get("stream") != "stderr"
                else {"output_type": "stream", "name": "stderr", "text": o.get("text", "")}
                for o in job.outputs
            ]
            # Pick the last result's execution_count if present, else prev+1.
            exec_count = prev_exec_count + 1
            for o in reversed(job.outputs):
                ec = o.get("execution_count")
                if ec is not None:
                    exec_count = ec
                    break
            try:
                if _get_collab_room(current) is not None:
                    _get_collab_room(current).write_outputs(cell_index_resolved, nb_outputs, exec_count)
                else:
                    nb2 = await _get_notebook(sess["path"])
                    nb2["cells"][cell_index_resolved]["outputs"] = nb_outputs
                    nb2["cells"][cell_index_resolved]["execution_count"] = exec_count
                    await _put_notebook(sess["path"], nb2)
            except Exception as e:
                logger.warning("jupyter_execute_cell async persist failed: %s", e)

        job_id = await _enqueue_async_execute(
            notebook_name=current,
            notebook_path=sess["path"],
            kernel_id=sess["kernel_id"],
            code=source,
            persist_cell_index=cell_index_resolved,
            on_complete=_persist,
        )
        return (
            f"Execute cell {cell_index_resolved} (async)\n\n"
            f"Job queued: {job_id}\n"
            f"Cell will be updated in-place when the kernel completes.\n\n"
            f"Poll: jupyter_get_job_result(job_id=\"{job_id}\", wait=true)"
        )

    timeout_s = float(args.get("timeout", 90))
    outputs = await _execute_code_ws(sess["kernel_id"], source, timeout_s)
    nb_outputs = [
        {"output_type": "stream", "name": "stdout", "text": t} for t in outputs
    ]

    if room is not None:
        max_count = 0
        for i in range(room.cell_count()):
            c = room.get_cell(i)
            if c.get("cell_type") == "code" and c.get("execution_count"):
                max_count = max(max_count, int(c["execution_count"]))
        room.write_outputs(cell_index_resolved, nb_outputs, max_count + 1)
    else:
        nb = await _get_notebook(sess["path"])
        cells = nb.get("cells", [])
        cells[cell_index_resolved]["outputs"] = nb_outputs
        cells[cell_index_resolved]["execution_count"] = (cells[cell_index_resolved].get("execution_count") or 0) + 1
        nb["cells"] = cells
        await _put_notebook(sess["path"], nb)

    result = "\n".join(outputs)
    return f"Execute cell {cell_index_resolved}\n\n{result}"


async def jupyter_insert_execute_code_cell(args: dict, **kwargs) -> str:
    sess = _resolve_target_session(args)
    if sess is None:
        return "Insert + execute code cell\n\nNo active notebook. Use jupyter_use_notebook first (or pass notebook_name)."

    current = sess["name"]
    room = _get_collab_room(current)
    cell_index = int(args.get("cell_index", -1))
    cell_source = str(args.get("cell_source", ""))

    if room is not None:
        total = room.cell_count()
        if cell_index < -1 or cell_index > total:
            return (
                "Insert + execute code cell\n\n"
                f"Index {cell_index} is outside valid range [-1, {total}]. Use -1 to append at end."
            )
        actual_index = total if cell_index == -1 else cell_index
        room.insert_cell(actual_index, "code", cell_source)
    else:
        nb = await _get_notebook(sess["path"])
        cells = nb.get("cells", [])
        total = len(cells)
        if cell_index < -1 or cell_index > total:
            return (
                "Insert + execute code cell\n\n"
                f"Index {cell_index} is outside valid range [-1, {total}]. Use -1 to append at end."
            )
        actual_index = total if cell_index == -1 else cell_index
        new_cell = {
            "cell_type": "code",
            "source": cell_source,
            "metadata": {},
            "outputs": [],
            "execution_count": None,
        }
        cells.insert(actual_index, new_cell)
        nb["cells"] = cells
        await _put_notebook(sess["path"], nb)

    timeout_s = float(args.get("timeout", 90))
    outputs = await _execute_code_ws(sess["kernel_id"], cell_source, timeout_s)
    nb_outputs = [
        {"output_type": "stream", "name": "stdout", "text": t} for t in outputs
    ]

    if room is not None:
        room.write_outputs(actual_index, nb_outputs, 1)
    else:
        fresh_nb = await _get_notebook(sess["path"])
        fresh_cells = fresh_nb.get("cells", [])
        if actual_index < len(fresh_cells):
            inserted = fresh_cells[actual_index]
            inserted["outputs"] = nb_outputs
            inserted["execution_count"] = 1
            fresh_nb["cells"] = fresh_cells
            await _put_notebook(sess["path"], fresh_nb)

    result = "\n".join([
        f"Cell inserted at index {actual_index} and executed.",
        "Outputs:",
        *outputs,
    ])
    return f"Insert + execute code cell at {actual_index}\n\n{result}"


async def jupyter_read_cell(args: dict, **kwargs) -> str:
    sess = _resolve_target_session(args)
    if sess is None:
        return "Read cell\n\nNo active notebook. Use jupyter_use_notebook first (or pass notebook_name)."

    current = sess["name"]
    room = _get_collab_room(current)
    cell_index_arg = args.get("cell_index")
    cell_id = args.get("cell_id")
    if cell_index_arg is not None:
        try:
            cell_index = int(cell_index_arg)
        except (TypeError, ValueError):
            return "Read cell\n\n'cell_index' must be an integer."
    else:
        cell_index = None

    if room is not None:
        def _resolve_in_room(room_obj):
            for i in range(room_obj.cell_count()):
                cv = room_obj.get_cell(i)
                if cell_id is not None and cv.get("id") == cell_id:
                    return i
            if cell_id is not None:
                raise ValueError(
                    f"No cell with cell_id='{cell_id}' (notebook has {room_obj.cell_count()} cells)."
                )
            total = room_obj.cell_count()
            if cell_index < 0 or cell_index >= total:
                raise ValueError(f"Cell index {cell_index} out of range (notebook has {total} cells).")
            return cell_index
        try:
            cell_index_resolved = _resolve_in_room(room)
        except ValueError as e:
            return f"Read cell\n\n[ERROR] {e}"
        cell = room.get_cell(cell_index_resolved)
    else:
        nb = await _get_notebook(sess["path"])
        try:
            cell_index_resolved = await _resolve_cell_index(nb, cell_index, cell_id)
        except ValueError as e:
            return f"Read cell\n\n[ERROR] {e}"
        cells = nb.get("cells", [])
        cell = cells[cell_index_resolved]

    include_outputs = args.get("include_outputs", True)

    lines = [
        f"Index: {cell_index_resolved}",
        f"ID: {cell.get('id') or '(none)'}",
        f"Type: {cell.get('cell_type')}",
        f"Execution count: {cell.get('execution_count') or '-'}",
        f"Source:\n{cell.get('source', '')}",
    ]

    if include_outputs and cell.get("cell_type") == "code" and cell.get("outputs"):
        lines.append("Outputs:")
        for out in cell["outputs"]:
            text = out.get("text") if isinstance(out, dict) else None
            if text:
                lines.append("".join(text) if isinstance(text, list) else text)
            elif isinstance(out, dict) and out.get("data"):
                plain = out["data"].get("text/plain")
                if plain:
                    lines.append(str(plain))

    return f"Read cell {cell_index_resolved}\n\n" + "\n".join(lines)

    lines = [
        f"Index: {cell_index}",
        f"Type: {cell.get('cell_type')}",
        f"Execution count: {cell.get('execution_count') or '-'}",
        f"Source:\n{cell.get('source', '')}",
    ]

    if include_outputs and cell.get("cell_type") == "code" and cell.get("outputs"):
        lines.append("Outputs:")
        for out in cell["outputs"]:
            text = out.get("text") if isinstance(out, dict) else None
            if text:
                lines.append("".join(text) if isinstance(text, list) else text)
            elif isinstance(out, dict) and out.get("data"):
                plain = out["data"].get("text/plain")
                if plain:
                    lines.append(str(plain))

    return f"Read cell {cell_index}\n\n" + "\n".join(lines)


async def jupyter_delete_cell(args: dict, **kwargs) -> str:
    sess = _resolve_target_session(args)
    if sess is None:
        nb_hint = (
            " Unknown notebook_name."
            if isinstance(args.get("notebook_name"), str) and args.get("notebook_name")
            else " Use jupyter_use_notebook first."
        )
        return f"Delete cells\n\nNo active notebook.{nb_hint}"
    current = sess["name"]

    room = _get_collab_room(current)

    raw_indices = args.get("cell_indices", [])
    raw_ids = args.get("cell_ids_to_delete", [])
    include_source = args.get("include_source", True)

    # jmcp-compat atomic semantic: when cell_ids are supplied, every id is
    # validated up front and the whole call fails rather than partially
    # deleting the notebook. We also merge + dedup if both lists are given.
    indices: list[int] = []
    if raw_indices is not None:
        for x in raw_indices:
            try:
                indices.append(int(x))
            except (TypeError, ValueError):
                return f"Delete cells\n\n[ERROR] Bad cell_indices entry: {x!r}"
    raw_ids_list: list[str] = []
    if raw_ids:
        if not isinstance(raw_ids, list):
            return "Delete cells\n\n[ERROR] cell_ids_to_delete must be a list."
        raw_ids_list = [str(x) for x in raw_ids]
        # Snapshot cell ids → indices ONCE, in stable order, before any mutation.
        if room is not None:
            id_to_idx = {}
            for i in range(room.cell_count()):
                cid = room.get_cell(i).get("id")
                if cid:
                    id_to_idx[cid] = i
        else:
            nb_snap = await _get_notebook(sess["path"])
            id_to_idx = {
                (c.get("id") or ""): i
                for i, c in enumerate(nb_snap.get("cells", []) or [])
            }
        missing = [cid for cid in raw_ids_list if cid not in id_to_idx]
        if missing:
            return (
                "Delete cells\n\n[ERROR] The following cell_ids_to_delete were "
                f"not found: {missing}. No cells were deleted (atomic semantic)."
            )
        # Id-supplied targets win on ties with index targets; merge dedup.
        indices = sorted(set(indices) | {id_to_idx[c] for c in raw_ids_list}, reverse=True)
    if not indices:
        return "Delete cells\n\n[ERROR] Provide at least one of cell_indices or cell_ids_to_delete."
    # Delete in descending index order so removing one cell doesn't shift
    # the position of any later one in the batch.

    deleted_sources = []

    if room is not None:
        total = room.cell_count()
        for idx in indices:
            if 0 <= idx < total:
                snap = room.delete_cell(idx)
                if include_source:
                    deleted_sources.append(f"[{idx}] {snap.get('source', '')}")
                total -= 1
        remaining = room.cell_count()
    else:
        nb = await _get_notebook(sess["path"])
        cells = nb.get("cells", [])
        for idx in indices:
            if 0 <= idx < len(cells):
                if include_source:
                    deleted_sources.append(f"[{idx}] {cells[idx].get('source', '')}")
                cells.pop(idx)
        nb["cells"] = cells
        await _put_notebook(sess["path"], nb)
        remaining = len(cells)

    result_lines = [f"Deleted {len(indices)} cell(s). Notebook now has {remaining} cells."]
    if include_source and deleted_sources:
        result_lines.append("Deleted cell sources:")
        result_lines.extend(deleted_sources)

    return "Delete cells\n\n" + "\n".join(result_lines)


async def jupyter_execute_code(args: dict, **kwargs) -> str:
    """Synchronous by default; pass run_async=true to fire-and-forget.

    Optional `kernel_id` lets the agent target a raw (no-notebook) kernel.
    Optional `notebook_name` picks a non-current but already-activated notebook.
    """
    # Multi-notebook: notebook_name takes precedence; then current notebook; else raw kernel_id only.
    sess = _resolve_target_session(args)
    explicit_kernel_id = args.get("kernel_id")
    current = sess["name"] if sess else None

    code = str(args.get("code", ""))
    run_async = bool(args.get("run_async", False))

    # Resolve which kernel to talk to.
    if explicit_kernel_id:
        kernel_id = str(explicit_kernel_id)
        notebook_path = sess["path"] if sess else f"(raw kernel {kernel_id})"
        notebook_name = current or "(raw)"
    elif sess is not None:
        kernel_id = sess["kernel_id"]
        notebook_path = sess["path"]
        notebook_name = current
    else:
        return (
            "Execute code\n\nNo active notebook and no 'kernel_id' provided. "
            "Call jupyter_use_notebook first or pass kernel_id=<existing_kernel_id>."
        )

    if run_async:
        job_id = await _enqueue_async_execute(
            notebook_name=notebook_name,
            notebook_path=notebook_path,
            kernel_id=kernel_id,
            code=code,
            persist_cell_index=None,
        )
        return (
            "Execute code (async)\n\n"
            f"Job queued: {job_id}\n"
            f"target: {notebook_path}\n"
            f"kernel: {kernel_id}\n\n"
            f"Poll: jupyter_get_job_result(job_id=\"{job_id}\", wait=true)"
        )

    timeout_s = min(float(args.get("timeout", 30)), 60.0)
    outputs = await _execute_code_ws(kernel_id, code, timeout_s)
    result = "\n".join(outputs)
    return f"Execute code\n\n{result}"


# ===========================================================================
# New tools (added 2026-09-06) — close the REST-API gap with jupyter-mcp-server:
#   jupyter_edit_cell_source    find-and-replace in one cell's source
#   jupyter_clear_cell_outputs  drop stdout/image outputs without removing cells
#   jupyter_move_cell           relocate one cell to a new index
#   jupyter_interrupt_cell      SIGINT-stop a running cell without killing state
#   jupyter_list_kernelspecs    enumerate python3/r/julia/... kernelspecs
#   jupyter_nbconvert           convert notebook to html/python/script/...
#   jupyter_upload_file         PUT file content (text or base64)
#   jupyter_save_file           text-friendly alias for jupyter_upload_file
#   jupyter_mkdir               PUT a directory entry
#   jupyter_delete_file         DELETE /api/contents/<path>
#   jupyter_rename_file         PATCH /api/contents/<old>  (preserves mtime)
#   jupyter_copy_file           POST /api/contents/<old>/copy
# ===========================================================================


async def _interrupt_kernel(kernel_id: str) -> None:
    await _req("POST", f"/api/kernels/{kernel_id}/interrupt", body={})


async def _list_kernelspecs() -> str:
    data = await _req("GET", "/api/kernelspecs")
    specs = (data or {}).get("kernelspecs", {}) if isinstance(data, dict) else {}
    if not specs:
        return "No kernel specifications found on the Jupyter server."
    rows = []
    for name in sorted(specs.keys()):
        spec = specs[name].get("spec", {})
        env = spec.get("env", {}) or {}
        env_str = ";".join(f"{k}={v}" for k, v in env.items())[:200] if env else "unknown"
        argv = spec.get("argv", []) or []
        argv_sample = " ".join(argv[:5]) if isinstance(argv, list) else ""
        rows.append([
            name,
            spec.get("display_name", "unknown"),
            spec.get("language", "unknown"),
            spec.get("codemirror_mode", "auto"),
            env_str,
            argv_sample or "n/a",
            str(spec.get("help_links", "n/a")),
            str(specs[name].get("default", "false")).lower(),
        ])
    return _tsv(
        [
            "Name",
            "Display_Name",
            "Language",
            "CodeMirror_Mode",
            "Environment",
            "Argv_Sample",
            "Help_Links",
            "Is_Default",
        ],
        rows,
    )


async def _nbconvert(path: str, fmt: str, download_as: str = "") -> str:
    encoded = quote(path, safe="/")
    await _req("POST", f"/api/nbconvert/{encoded}", body={"type": fmt})
    # Re-fetch as text. The Jupyter server returns the converted body as the
    # response to a GET; the POST above merely commits the conversion.
    if not _HAS_HTTPX:
        return f"[nbconvert POST committed; install httpx to fetch output]"
    async with httpx.AsyncClient(timeout=_state.timeout_s) as client:
        resp = await client.get(
            f"{_state.jupyter_url}/api/nbconvert/{encoded}",
            headers={**_auth_headers(), "Accept": "text/plain"},
            params={} if not download_as else {},
        )
    return resp.text or f"[nbconvert returned empty body for {path} → {fmt}]"


async def _upload_file(path: str, content: str, fmt: str = "text") -> None:
    encoded = quote(path, safe="/")
    await _req("PUT", f"/api/contents/{encoded}", body={
        "type": "file",
        "format": fmt,
        "content": content,
    })


async def _mkdir(path: str) -> None:
    encoded = quote(path, safe="/")
    await _req("PUT", f"/api/contents/{encoded}", body={"type": "directory"})


async def _delete_file(path: str) -> None:
    encoded = quote(path, safe="/")
    await _req("DELETE", f"/api/contents/{encoded}")


async def _rename_file(old_path: str, new_path: str) -> None:
    encoded = quote(old_path, safe="/")
    await _req("PATCH", f"/api/contents/{encoded}", body={"path": new_path})


async def _copy_file(old_path: str, new_path: str) -> None:
    encoded = quote(old_path, safe="/")
    await _req("POST", f"/api/contents/{encoded}/copy", body={"new_path": new_path})


async def jupyter_edit_cell_source(args: dict, **kwargs) -> str:
    """Apply a literal find-and-replace to one cell's source."""
    sess = _resolve_target_session(args)
    if sess is None:
        return "Edit cell\n\nNo active notebook. Use jupyter_use_notebook first (or pass notebook_name)."
    current = sess["name"]
    room = _get_collab_room(current)

    cell_index_arg = args.get("cell_index")
    cell_id = args.get("cell_id")
    if cell_index_arg is not None:
        try:
            cell_index = int(cell_index_arg)
        except (TypeError, ValueError):
            return "Edit cell\n\n'cell_index' must be an integer."
    else:
        cell_index = None

    old_string = str(args.get("old_string", ""))
    new_string = str(args.get("new_string", ""))
    replace_all = bool(args.get("replace_all", False))
    if not old_string:
        return "Edit cell\n\n'old_string' is required."

    nb = await _get_notebook_on_room(sess["path"]) if await _ensure_collab_probed() else await _get_notebook_raw(sess["path"])
    try:
        cell_index_resolved = await _resolve_cell_index(nb, cell_index, cell_id)
    except ValueError as e:
        return f"Edit cell\n\n[ERROR] {e}"
    cells = nb.get("cells", [])
    old_source = cells[cell_index_resolved].get("source", "") or ""
    if replace_all:
        occurrences = old_source.count(old_string)
        new_source = old_source.replace(old_string, new_string)
    else:
        occurrences = 1 if old_string in old_source else 0
        new_source = old_source.replace(old_string, new_string)
    if occurrences == 0:
        return f"Edit cell\n\nNo occurrence of old_string found in cell {cell_index_resolved}. Use jupyter_read_cell to inspect."
    cells[cell_index_resolved]["source"] = new_source
    await _save_notebook_via_collab_or_put(sess["path"], nb)

    diff = _diff_source(old_source, new_source)
    return (
        f"Edit cell {cell_index_resolved}\n\nReplaced {occurrences} occurrence(s).\n\n"
        f"{diff}\n\n[New cell source]\n{new_source}"
    )


async def jupyter_clear_cell_outputs(args: dict, **kwargs) -> str:
    """Drop outputs from one or more code cells, preserving the cells themselves."""
    sess = _resolve_target_session(args)
    if sess is None:
        return "Clear cell outputs\n\nNo active notebook. Use jupyter_use_notebook first (or pass notebook_name)."
    current = sess["name"]

    raw = args.get("cell_indices")
    targets_all = raw is None or raw == [] or raw == ""
    explicit = [] if targets_all else [int(i) for i in raw if isinstance(i, (int, float))]

    nb = await _get_notebook_on_room(sess["path"]) if await _ensure_collab_probed() else await _get_notebook_raw(sess["path"])
    cells = nb.get("cells", [])
    cleared_count = 0
    for i, cell in enumerate(cells):
        if cell.get("cell_type") != "code":
            continue
        if not (targets_all or i in explicit):
            continue
        cell["outputs"] = []
        cell["execution_count"] = None
        cleared_count += 1
    await _save_notebook_via_collab_or_put(sess["path"], nb)

    scope = "all code cells" if targets_all else f"{cleared_count} cell(s)"
    return f"Clear cell outputs\n\nCleared outputs from {scope}."


async def jupyter_clear_cell_output(args: dict, **kwargs) -> str:
    """Clear the outputs of a single cell. jmcp-compatible thin wrapper over the plural."""
    sess = _resolve_target_session(args)
    if sess is None:
        return "Clear cell output\n\nNo active notebook. Use jupyter_use_notebook first (or pass notebook_name)."
    current = sess["name"]

    cell_index = args.get("cell_index")
    cell_id = args.get("cell_id")
    if cell_index is None and cell_id is None:
        return "Clear cell output\n\n[ERROR] Provide either cell_index or cell_id."
    if cell_index is None:
        cell_index = 0  # not used when cell_id resolves; resolver will pick the right one

    try:
        cell_index_resolved = await _resolve_cell_index(
            await _get_notebook_raw(sess["path"]),
            cell_index if cell_index is not None else 0,
            cell_id,
        )
    except ValueError as e:
        return f"Clear cell output\n\n[ERROR] {e}"

    nb = await _get_notebook_on_room(sess["path"]) if await _ensure_collab_probed() else await _get_notebook_raw(sess["path"])
    cells = nb.get("cells", [])
    if cell_index_resolved < 0 or cell_index_resolved >= len(cells):
        return f"Clear cell output\n\n[ERROR] Index {cell_index_resolved} out of range."
    target = cells[cell_index_resolved]
    if target.get("cell_type") != "code":
        return f"Clear cell output\n\nCell {cell_index_resolved} is not a code cell."
    target["outputs"] = []
    target["execution_count"] = None
    await _save_notebook_via_collab_or_put(sess["path"], nb)
    return f"Clear cell output\n\nCleared outputs from cell {cell_index_resolved}."


async def jupyter_move_cell(args: dict, **kwargs) -> str:
    """Relocate one cell. Each endpoint can be addressed by index OR by cell_id."""
    sess = _resolve_target_session(args)
    if sess is None:
        nb_hint = (
            " Unknown notebook_name."
            if isinstance(args.get("notebook_name"), str) and args.get("notebook_name")
            else " Use jupyter_use_notebook first."
        )
        return f"Move cell\n\nNo active notebook.{nb_hint}"
    current = sess["name"]

    source_id = args.get("source_cell_id")
    target_id = args.get("target_cell_id")

    if source_id is None and args.get("source_index") is None:
        return "Move cell\n\n[ERROR] Provide either source_index or source_cell_id."
    if target_id is None and "target_index" not in args and "destination_index" not in args:
        return "Move cell\n\n[ERROR] Provide target_index, target_cell_id, or destination_index."

    nb = await _get_notebook_on_room(sess["path"]) if await _ensure_collab_probed() else await _get_notebook_raw(sess["path"])
    cells = nb.get("cells", [])

    # Resolve source first so the target id — if any — points at the pre-move state.
    # jmcp's move_cell does the same: it resolves both endpoints against the
    # unchanged notebook so we never compute a target on something the source
    # already left.
    try:
        source_index = await _resolve_cell_index(
            nb,
            int(args["source_index"]) if args.get("source_index") is not None else None,
            source_id,
        )
    except ValueError as e:
        return f"Move cell\n\n[ERROR] {e}"

    if target_id is not None:
        try:
            destination_index = await _resolve_cell_index(nb, None, target_id)
        except ValueError as e:
            return f"Move cell\n\n[ERROR] {e}"
    elif "target_index" in args:
        destination_index = int(args["target_index"])
    else:
        destination_index = int(args["destination_index"])

    if source_index < 0 or source_index >= len(cells):
        return f"Move cell\n\nsource {source_index} out of range (notebook has {len(cells)} cells)."
    if destination_index < 0 or destination_index >= len(cells):
        return f"Move cell\n\ntarget {destination_index} out of range (notebook has {len(cells)} cells)."
    if source_index == destination_index:
        return "Move cell\n\nsource and destination are identical; nothing moved."

    moved = cells.pop(source_index)
    # After pop, destination > source shifts left by one.
    if destination_index > source_index:
        destination_index -= 1
    destination_index = min(destination_index, len(cells))
    cells.insert(destination_index, moved)
    await _save_notebook_via_collab_or_put(sess["path"], nb)

    return (
        f"Move cell\n\nMoved cell from index {source_index} to index {destination_index}."
    )


async def jupyter_interrupt_cell(args: dict, **kwargs) -> str:
    """SIGINT a running kernel without resetting state."""
    current = _state.current_notebook
    if not current:
        return "Interrupt cell\n\nNo active notebook. Use jupyter_use_notebook first."
    sess = _state.sessions[current]
    try:
        await _interrupt_kernel(sess["kernel_id"])
        return f"Interrupt cell\n\nInterrupt signal sent to kernel {sess['kernel_id']}."
    except Exception as e:
        return f"Interrupt cell\n\n[ERROR] interrupt kernel failed: {e}"


async def jupyter_list_kernelspecs(args: dict, **kwargs) -> str:
    """List available kernel specifications (python3, r, julia, ...)."""
    try:
        tsv = await _list_kernelspecs()
    except Exception as e:
        return f"Jupyter kernelspecs\n\n[ERROR] {e}"
    return f"Jupyter kernelspecs\n\n{tsv}"


async def jupyter_nbconvert(args: dict, **kwargs) -> str:
    """Convert a notebook to another format via /api/nbconvert."""
    path = str(args.get("notebook_path", ""))
    fmt = str(args.get("format", "html"))
    download_as = str(args.get("download_as", "")) if args.get("download_as") else ""
    if not path:
        return "nbconvert\n\nnotebook_path is required."
    if fmt not in {"html", "python", "script", "markdown", "rst", "latex", "asciidoc", "slides", "pdf"}:
        return f"nbconvert\n\nUnsupported format: {fmt}"
    try:
        body = await _nbconvert(path, fmt, download_as)
    except Exception as e:
        return f"nbconvert {path} → {fmt}\n\n[ERROR] {e}"
    return f"nbconvert {path} → {fmt}\n\n{body[:8192]}"


async def jupyter_upload_file(args: dict, **kwargs) -> str:
    """PUT text or base64 file content to the Jupyter server."""
    path = str(args.get("path", ""))
    content = str(args.get("content", ""))
    fmt = "base64" if args.get("format") == "base64" else "text"
    if not path:
        return "Upload file\n\npath is required."
    try:
        await _upload_file(path, content, fmt)
        return f"Upload file\n\nUploaded {len(content)} chars ({fmt}) to {path}."
    except Exception as e:
        return f"Upload file\n\n[ERROR] {e}"


async def jupyter_save_file(args: dict, **kwargs) -> str:
    """Alias of jupyter_upload_file with text-friendly default naming."""
    path = str(args.get("path", ""))
    content = str(args.get("content", ""))
    fmt = "base64" if args.get("format") == "base64" else "text"
    if not path:
        return "Save file\n\npath is required."
    try:
        await _upload_file(path, content, fmt)
        return f"Save file\n\nSaved {len(content)} chars ({fmt}) to {path}."
    except Exception as e:
        return f"Save file\n\n[ERROR] {e}"


async def jupyter_mkdir(args: dict, **kwargs) -> str:
    """Create a directory on the Jupyter server."""
    path = str(args.get("path", ""))
    if not path:
        return "mkdir\n\npath is required."
    try:
        await _mkdir(path)
        return f"mkdir\n\nCreated directory {path}."
    except Exception as e:
        return f"mkdir\n\n[ERROR] {e}"


async def jupyter_delete_file(args: dict, **kwargs) -> str:
    """Delete a file or directory."""
    path = str(args.get("path", ""))
    if not path:
        return "Delete file\n\npath is required."
    try:
        await _delete_file(path)
        return f"Delete file\n\nDeleted {path}."
    except Exception as e:
        return f"Delete file\n\n[ERROR] {e}"


async def jupyter_rename_file(args: dict, **kwargs) -> str:
    """Rename / move (preserves sibling mtimes)."""
    old_path = str(args.get("old_path", ""))
    new_path = str(args.get("new_path", ""))
    if not old_path or not new_path:
        return "Rename file\n\nold_path and new_path are required."
    try:
        await _rename_file(old_path, new_path)
        return f"Rename file\n\nRenamed {old_path} → {new_path}."
    except Exception as e:
        return f"Rename file\n\n[ERROR] {e}"


async def jupyter_copy_file(args: dict, **kwargs) -> str:
    """Server-side copy of a file or directory."""
    old_path = str(args.get("old_path", ""))
    new_path = str(args.get("new_path", ""))
    if not old_path or not new_path:
        return "Copy file\n\nold_path and new_path are required."
    try:
        await _copy_file(old_path, new_path)
        return f"Copy file\n\nCopied {old_path} → {new_path}."
    except Exception as e:
        return f"Copy file\n\n[ERROR] {e}"


# ===========================================================================
# Async execution jobs — fire-and-forget model that avoids blocking the
# agent session on long-running cells. Three new tools plus a `run_async`
# opt-in on `jupyter_execute_code` and `jupyter_execute_cell`. The Hermes
# side mirrors `openclaw-plugin/src/jobs.ts` + the run_async branch in
# `openclaw-plugin/src/index.ts`.
# ===========================================================================


async def _enqueue_async_execute(
    *,
    notebook_name: Optional[str],
    notebook_path: Optional[str],
    kernel_id: str,
    code: str,
    persist_cell_index: Optional[int],
    on_complete=None,
) -> str:
    """Create a JobState, kick off the background WebSocket coroutine, and
    return the job_id immediately."""
    job_id = f"job-{int(__import__('time').time() * 1000)}-{_uuid_mod.uuid4().hex[:8]}"
    job = JobState(
        id=job_id,
        notebook_name=notebook_name,
        notebook_path=notebook_path,
        kernel_id=kernel_id,
        code=code,
        persist_cell_index=persist_cell_index,
    )
    register_job(job)
    job._on_complete = on_complete  # type: ignore[attr-defined]
    # Fire-and-forget coroutine (schedules but does not await)
    asyncio.create_task(
        _execute_code_async_for_kernel(kernel_id, code, job_id, on_complete),
    )
    return job_id


async def _execute_code_async_for_kernel(
    kernel_id: str,
    code: str,
    job_id: str,
    on_complete,
) -> None:
    """Thin wrapper around jobs._execute_code_ws_async that resolves the
    stored callback if `on_complete` was omitted."""
    if not _HAS_WEBSOCKETS:
        finalize(job_id, "failed", "websockets library not installed")
        return
    from .jobs import _execute_code_ws_async as _do_run
    job = get_job(job_id)
    callback = on_complete if on_complete is not None else (job._on_complete if job else None)  # type: ignore[attr-defined]
    await _do_run(kernel_id, code, job_id, on_complete=callback)


async def jupyter_get_job_result(args: dict, **kwargs) -> str:
    """Poll a fire-and-forget execute for its result."""
    job_id = str(args.get("job_id", ""))
    if not job_id:
        return "Get job\n\njob_id is required."
    wait = bool(args.get("wait", False))
    timeout_ms = int(args.get("timeout_ms") or 15000)
    job = get_job(job_id)
    if job is None:
        return f"Get job\n\nNo job with id {job_id}. Expired (TTL 30 min) or deleted."
    if wait and job.status in ("queued", "running"):
        try:
            await asyncio.wait_for(job._finalize_event.wait(), timeout=timeout_ms / 1000.0)
        except asyncio.TimeoutError:
            pass
        job = get_job(job_id) or job
    summary = _summarise_job(job)
    outputs = _format_job_outputs(job)
    body = f"{summary}\n\noutputs:\n{outputs}"
    if job.error_message:
        body += f"\n\nerror: {job.error_message}"
    return f"Job {job.id}\n\n{body}"


async def jupyter_list_jobs(args: dict, **kwargs) -> str:
    """List async jobs."""
    status_filter = str(args.get("status_filter") or "")
    jobs = list_jobs()
    if status_filter:
        jobs = [j for j in jobs if j.status == status_filter]
    if not jobs:
        return f"Jobs\n\nNo jobs{(' with status=' + status_filter) if status_filter else ''}."
    lines = [f"{len(jobs)} job(s):"]
    for j in jobs:
        age = int(__import__("time").time() - j.started_at)
        lines.append(
            f"  {j.id}  {j.status:<11}  kernel={j.kernel_id}  "
            f"chunks={len(j.outputs)}  started={age}s ago  "
            f"notebook={j.notebook_path or '(detached)'}"
        )
    return f"Jobs\n\n" + "\n".join(lines)


async def jupyter_cancel_job(args: dict, **kwargs) -> str:
    """Cancel a queued/running async execution."""
    job_id = str(args.get("job_id", ""))
    if not job_id:
        return "Cancel job\n\njob_id is required."
    job = get_job(job_id)
    if job is None:
        return f"Cancel job\n\nNo job with id {job_id}."
    if job.status in ("succeeded", "failed", "cancelled"):
        return f"Cancel job\n\nJob {job_id} already terminal ({job.status}); nothing to do."
    try:
        await _interrupt_kernel(job.kernel_id)
    except Exception as e:
        return f"Cancel job\n\n[ERROR] interrupt failed: {e}"
    # The async coroutine's connection-close handler will transition the job.
    try:
        await asyncio.wait_for(job._finalize_event.wait(), timeout=5)
    except asyncio.TimeoutError:
        pass
    final = get_job(job_id)
    if final is None:
        return f"Cancel job\n\nCancelled {job_id}."
    return f"Cancel job {job_id}\n\nstatus={final.status}\n\noutputs:\n{_format_job_outputs(final)}"


async def _interrupt_kernel_local(kernel_id: str) -> None:
    """In-process helper to interrupt a kernel. The async-job cancel path is
    the only caller; uses the lower-level `_interrupt_kernel` helper."""
    await _interrupt_kernel(kernel_id)


# ---------------------------------------------------------------------------
# CRDT-aware collaborators (used by the new tools above). The legacy code
# path uses _get_notebook / _put_notebook directly; mirrors the TypeScript
# `mutateNotebook` helper added in src/index.ts.
# ---------------------------------------------------------------------------


async def _get_notebook_raw(path: str) -> dict:
    """Plain Contents-API fetch (no CRDT)."""
    encoded = quote(path, safe="/")
    data = await _req("GET", f"/api/contents/{encoded}?content=1")
    content = (data or {}).get("content", {}) if isinstance(data, dict) else {}
    return content if isinstance(content, dict) else {}


async def _get_notebook_on_room(path: str):
    """CRDT-aware read of a notebook's cells via the existing CollabRoom."""
    room = await _open_collab_room(_state.current_notebook or path, path)
    if room is None:
        return await _get_notebook_raw(path)
    try:
        # Wait briefly for sync then pull.
        import asyncio as _aio
        await _aio.sleep(0.05)
        cells = room.read_cells()
        return {"cells": cells, "metadata": {}, "nbformat": 4, "nbformat_minor": 5}
    except Exception:
        return await _get_notebook_raw(path)


async def _put_notebook_raw(path: str, notebook: dict) -> None:
    encoded = quote(path, safe="/")
    await _req("PUT", f"/api/contents/{encoded}", body={
        "type": "notebook",
        "content": notebook,
    })


async def _save_notebook_via_collab_or_put(path: str, notebook: dict) -> None:
    """Mirror of the TypeScript `mutateNotebook` helper: prefer CRDT, fall back to PUT."""
    used_crdt = False
    if await _ensure_collab_probed() and _state.current_notebook:
        room = _get_collab_room(_state.current_notebook)
        if room is not None:
            try:
                cells = notebook.get("cells", [])
                room.replace_all_cells(cells)
                await room.flush()
                used_crdt = True
            except Exception as e:  # pragma: no cover - depends on deps
                logger.warning("CRDT write failed, falling back to PUT: %s", e)
    if not used_crdt:
        await _put_notebook_raw(path, notebook)
