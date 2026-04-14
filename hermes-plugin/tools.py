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
    return f"Connect to Jupyter: {url}\n\nConnected to Jupyter server at {url}"


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
    kernels = await _req("GET", "/api/kernels")
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
            "path": notebook_path,
            "kernel_id": session["kernel"]["id"],
            "session_id": session["id"],
        }
        _state.current_notebook = notebook_name
        info_lines.append(f"[INFO] Connected to kernel '{session['kernel']['id']}'.")
        info_lines.append(f"[INFO] Successfully activated notebook '{notebook_name}'.")

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
    nb = await _get_notebook(sess["path"])
    cells = nb.get("cells", [])
    total = len(cells)

    cell_index = int(args.get("cell_index", -1))
    if cell_index < -1 or cell_index > total:
        return (
            f"Insert cell\n\n"
            f"Index {cell_index} is outside valid range [-1, {total}]. Use -1 to append at end."
        )
    actual_index = total if cell_index == -1 else cell_index

    cell_type = str(args.get("cell_type", "code"))
    cell_source = str(args.get("cell_source", ""))

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
    current = _state.current_notebook
    if not current:
        return "Overwrite cell\n\nNo active notebook. Use jupyter_use_notebook first."

    sess = _state.sessions[current]
    nb = await _get_notebook(sess["path"])
    cells = nb.get("cells", [])

    cell_index = int(args.get("cell_index", 0))
    if cell_index >= len(cells):
        return (
            f"Overwrite cell {cell_index}\n\n"
            f"Cell index {cell_index} is out of range. Notebook has {len(cells)} cells."
        )

    cell = cells[cell_index]
    old_source = cell.get("source", "")
    new_source = str(args.get("cell_source", ""))

    cell["source"] = new_source
    if cell.get("cell_type") == "code":
        cell["outputs"] = []
        cell["execution_count"] = None

    nb["cells"] = cells
    await _put_notebook(sess["path"], nb)

    diff = _diff_source(old_source, new_source)
    return f"Overwrite cell {cell_index}\n\n{diff}"


async def jupyter_execute_cell(args: dict, **kwargs) -> str:
    current = _state.current_notebook
    if not current:
        return "Execute cell\n\nNo active notebook. Use jupyter_use_notebook first."

    sess = _state.sessions[current]
    nb = await _get_notebook(sess["path"])
    cells = nb.get("cells", [])

    cell_index = int(args.get("cell_index", 0))
    if cell_index >= len(cells):
        return (
            f"Execute cell {cell_index}\n\n"
            f"Cell index {cell_index} is out of range. Notebook has {len(cells)} cells."
        )

    cell = cells[cell_index]
    if cell.get("cell_type") != "code":
        return (
            f"Execute cell {cell_index}\n\n"
            f"Cell {cell_index} is not a code cell (type: {cell.get('cell_type')})."
        )

    timeout_s = float(args.get("timeout", 90))
    outputs = await _execute_code_ws(sess["kernel_id"], cell.get("source", ""), timeout_s)

    cell["outputs"] = [
        {"output_type": "stream", "name": "stdout", "text": t} for t in outputs
    ]
    cell["execution_count"] = (cell.get("execution_count") or 0) + 1
    nb["cells"] = cells
    await _put_notebook(sess["path"], nb)

    result = "\n".join(outputs)
    return f"Execute cell {cell_index}\n\n{result}"


async def jupyter_insert_execute_code_cell(args: dict, **kwargs) -> str:
    current = _state.current_notebook
    if not current:
        return "Insert + execute code cell\n\nNo active notebook. Use jupyter_use_notebook first."

    sess = _state.sessions[current]
    nb = await _get_notebook(sess["path"])
    cells = nb.get("cells", [])
    total = len(cells)

    cell_index = int(args.get("cell_index", -1))
    if cell_index < -1 or cell_index > total:
        return (
            "Insert + execute code cell\n\n"
            f"Index {cell_index} is outside valid range [-1, {total}]. Use -1 to append at end."
        )
    actual_index = total if cell_index == -1 else cell_index

    cell_source = str(args.get("cell_source", ""))
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

    # Re-fetch to avoid stale state when writing outputs back
    fresh_nb = await _get_notebook(sess["path"])
    fresh_cells = fresh_nb.get("cells", [])
    if actual_index < len(fresh_cells):
        inserted = fresh_cells[actual_index]
        inserted["outputs"] = [
            {"output_type": "stream", "name": "stdout", "text": t} for t in outputs
        ]
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
    current = _state.current_notebook
    if not current:
        return "Read cell\n\nNo active notebook. Use jupyter_use_notebook first."

    sess = _state.sessions[current]
    nb = await _get_notebook(sess["path"])
    cells = nb.get("cells", [])

    cell_index = int(args.get("cell_index", 0))
    if cell_index >= len(cells):
        return (
            f"Read cell {cell_index}\n\n"
            f"Cell index {cell_index} is out of range. Notebook has {len(cells)} cells."
        )

    cell = cells[cell_index]
    include_outputs = args.get("include_outputs", True)

    lines = [
        f"Index: {cell_index}",
        f"Type: {cell.get('cell_type')}",
        f"Execution count: {cell.get('execution_count') or '-'}",
        f"Source:\n{cell.get('source', '')}",
    ]

    if include_outputs and cell.get("cell_type") == "code" and cell.get("outputs"):
        lines.append("Outputs:")
        for out in cell["outputs"]:
            text = out.get("text")
            if text:
                lines.append("".join(text) if isinstance(text, list) else text)
            elif out.get("data"):
                plain = out["data"].get("text/plain")
                if plain:
                    lines.append(str(plain))

    return f"Read cell {cell_index}\n\n" + "\n".join(lines)


async def jupyter_delete_cell(args: dict, **kwargs) -> str:
    current = _state.current_notebook
    if not current:
        return "Delete cells\n\nNo active notebook. Use jupyter_use_notebook first."

    sess = _state.sessions[current]
    nb = await _get_notebook(sess["path"])
    cells = nb.get("cells", [])

    raw_indices = args.get("cell_indices", [])
    include_source = args.get("include_source", True)

    # Sort descending to avoid index shifting
    indices = sorted([int(i) for i in raw_indices], reverse=True)
    deleted_sources = []

    for idx in indices:
        if 0 <= idx < len(cells):
            if include_source:
                deleted_sources.append(f"[{idx}] {cells[idx].get('source', '')}")
            cells.pop(idx)

    nb["cells"] = cells
    await _put_notebook(sess["path"], nb)

    result_lines = [f"Deleted {len(indices)} cell(s). Notebook now has {len(cells)} cells."]
    if include_source and deleted_sources:
        result_lines.append("Deleted cell sources:")
        result_lines.extend(deleted_sources)

    return "Delete cells\n\n" + "\n".join(result_lines)


async def jupyter_execute_code(args: dict, **kwargs) -> str:
    current = _state.current_notebook
    if not current:
        return "Execute code\n\nNo active notebook. Use jupyter_use_notebook first."

    sess = _state.sessions[current]
    code = str(args.get("code", ""))
    timeout_s = min(float(args.get("timeout", 30)), 60.0)

    outputs = await _execute_code_ws(sess["kernel_id"], code, timeout_s)
    result = "\n".join(outputs)
    return f"Execute code\n\n{result}"
