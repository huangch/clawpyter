"""Jupyter real-time collaboration (Y.js CRDT) client for ClawPyter.

Holds one persistent ``NbModelClient`` per active notebook so that edits made
by the agent appear live in any concurrently-open JupyterLab session and vice
versa.  If the optional dependencies (``jupyter_nbmodel_client``, ``pycrdt``)
or the server-side ``jupyter-collaboration`` extension are unavailable, the
module degrades gracefully: ``HAS_COLLAB`` becomes ``False`` and the calling
code falls back to the legacy Contents-API path.

Output decoding helpers (``_ytext_to_str``, ``_yarray_to_list``) are adapted
from ``datalayer/jupyter-mcp-server`` (BSD-3-Clause) — see ATTRIBUTIONS.md.
"""

from __future__ import annotations

import logging
import uuid as _uuid_mod
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    from jupyter_nbmodel_client import NbModelClient, get_notebook_websocket_url  # type: ignore
    HAS_COLLAB = True
except Exception:  # pragma: no cover - optional dependency
    HAS_COLLAB = False
    NbModelClient = None  # type: ignore

    def get_notebook_websocket_url(**_kwargs):  # type: ignore
        raise RuntimeError("jupyter_nbmodel_client is not installed")


# ---------------------------------------------------------------------------
# Y-types decoding helpers
# ---------------------------------------------------------------------------

def _ytext_to_str(v: Any) -> str:
    """Coerce a YText, list-of-lines, or plain string to a Python ``str``."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "".join(str(x) for x in v)
    if hasattr(v, "source"):
        return str(v.source)
    try:
        return str(v)
    except Exception:
        return ""


def _to_py(v: Any) -> Any:
    """Best-effort conversion of any pycrdt / YArray / YMap object to plain Python."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if hasattr(v, "to_py"):
        try:
            return v.to_py()
        except Exception:
            pass
    if isinstance(v, dict):
        return {k: _to_py(val) for k, val in v.items()}
    if isinstance(v, list):
        return [_to_py(x) for x in v]
    # YMap / YArray-like
    try:
        return {k: _to_py(v[k]) for k in v.keys()}  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        return [_to_py(x) for x in v]
    except Exception:
        return _ytext_to_str(v)


def _yarray_to_list(v: Any) -> list:
    if v is None:
        return []
    try:
        return [_to_py(item) for item in v]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Probe — does the server have jupyter-collaboration enabled?
# ---------------------------------------------------------------------------

async def probe_server_collab(http_client, server_url: str, token: str, path: str) -> bool:
    """Return True iff ``PUT /api/collaboration/session/<path>`` is reachable.

    Uses the supplied ``http_client`` (an ``httpx.AsyncClient``-like wrapper)
    so we share the caller's auth + timeout configuration.  A 200/201 response
    means jupyter-collaboration is installed; 404 means the endpoint is
    missing (typical when only stock JupyterLab is running).
    """
    if not HAS_COLLAB:
        return False
    try:
        from urllib.parse import quote
        import httpx  # local import to avoid hard dependency at import time
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"token {token}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            url = f"{server_url.rstrip('/')}/api/collaboration/session/{quote(path, safe='/')}"
            resp = await client.put(url, headers=headers, json={"format": "json", "type": "notebook"})
            return resp.status_code in (200, 201)
    except Exception as e:
        logger.debug("collab probe failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# CollabRoom — one open YDoc connection per notebook
# ---------------------------------------------------------------------------

class CollabRoom:
    """Persistent ``NbModelClient`` wrapper for one notebook path."""

    def __init__(self, server_url: str, token: str, path: str) -> None:
        if not HAS_COLLAB:
            raise RuntimeError("jupyter_nbmodel_client is not installed")
        self.server_url = server_url.rstrip("/")
        self.token = token
        self.path = path
        self._client: Optional[Any] = None  # NbModelClient

    async def open(self) -> None:
        ws_url = get_notebook_websocket_url(
            server_url=self.server_url,
            token=self.token,
            path=self.path,
        )
        self._client = NbModelClient(ws_url)
        await self._client.__aenter__()

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.__aexit__(None, None, None)
            except Exception as e:
                logger.warning("Closing collab room for %s failed: %s", self.path, e)
            finally:
                self._client = None

    # ------------------------------------------------------------------
    # YDoc access
    # ------------------------------------------------------------------

    @property
    def _doc(self):
        if self._client is None:
            raise RuntimeError("Collab room is not open")
        return self._client._doc  # YNotebook

    @property
    def ycells(self):
        return self._doc.ycells

    def cell_count(self) -> int:
        return len(self.ycells)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def get_cell(self, idx: int) -> dict:
        cell = self.ycells[idx]
        out = {
            "cell_type": str(cell.get("cell_type", "code")),
            "source": _ytext_to_str(cell.get("source", "")),
            "metadata": _to_py(cell.get("metadata", {})) or {},
        }
        if out["cell_type"] == "code":
            out["execution_count"] = cell.get("execution_count")
            out["outputs"] = _yarray_to_list(cell.get("outputs", []))
        return out

    def to_nbformat(self) -> dict:
        cells = [self.get_cell(i) for i in range(self.cell_count())]
        return {
            "cells": cells,
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5,
        }

    # ------------------------------------------------------------------
    # Write — prefer NbModelClient high-level ops, fall back to YDoc surgery
    # ------------------------------------------------------------------

    def _make_cell_dict(self, cell_type: str, source: str) -> dict:
        cell: dict = {
            "id": str(_uuid_mod.uuid4()),
            "cell_type": cell_type,
            "source": source,
            "metadata": {},
        }
        if cell_type == "code":
            cell["outputs"] = []
            cell["execution_count"] = None
        return cell

    def insert_cell(self, idx: int, cell_type: str, source: str) -> None:
        cell_dict = self._make_cell_dict(cell_type, source)
        ynb = self._doc
        # YNotebook.create_ycell builds a properly-structured Y.Map cell
        if hasattr(ynb, "create_ycell"):
            ycell = ynb.create_ycell(cell_dict)
            self.ycells.insert(idx, ycell)
            return
        # Fallback: append via NbModelClient helpers (loses precise index control)
        client = self._client
        if cell_type == "markdown" and hasattr(client, "add_markdown_cell"):
            client.add_markdown_cell(source)
        elif hasattr(client, "add_code_cell"):
            client.add_code_cell(source)
        else:
            raise RuntimeError("No supported cell-insert API on YNotebook/NbModelClient")

    def set_cell_source(self, idx: int, source: str) -> None:
        cell = self.ycells[idx]
        cell["source"] = source
        if str(cell.get("cell_type", "")) == "code":
            cell["outputs"] = []
            cell["execution_count"] = None

    def delete_cell(self, idx: int) -> dict:
        snapshot = self.get_cell(idx)
        del self.ycells[idx]
        return snapshot

    def write_outputs(self, idx: int, outputs: list, execution_count: Optional[int]) -> None:
        cell = self.ycells[idx]
        cell["outputs"] = outputs
        if execution_count is not None:
            cell["execution_count"] = execution_count
