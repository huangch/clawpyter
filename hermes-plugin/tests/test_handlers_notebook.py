"""Tests for the notebook-lifecycle handlers."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_plugin.tests._bootstrap import install_plugin_package, run  # noqa: E402
install_plugin_package()

import hermes_plugin.tools as tools  # noqa: E402

import pytest  # noqa: E402


# Standard Jupyter /api/sessions response shape.
SESSION_BODY = {
    "id": "sess-abc-123",
    "kernel": {"id": "kernel-xyz-789", "name": "python3"},
    "path": "/notebooks/demo.ipynb",
}

NOTEBOOK_BODY = {
    "name": "demo.ipynb", "path": "demo.ipynb", "type": "notebook",
    "content": {
        "cells": [
            {"cell_type": "code", "id": "cell-A", "source": "print(1)\n",
             "metadata": {}, "outputs": [], "execution_count": None},
            {"cell_type": "markdown", "id": "cell-B", "source": "# Hi\n",
             "metadata": {}},
        ],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    },
}


def install_router(tools_mod, *, sessions=None, notebooks=None, deleted=None, kernel_restarts=None):
    """Install a request router that returns canned responses by URL pattern.

    Usage: replace `tools_mod._req = fake_req`. Returns the routing callable
    that records all calls (each test can inspect them via closure).
    """
    deleted = deleted if deleted is not None else []
    kernel_restarts = kernel_restarts if kernel_restarts is not None else []
    sessions = sessions if sessions is not None else SESSION_BODY
    notebooks = notebooks if notebooks is not None else NOTEBOOK_BODY

    async def fake_req(method, path, body=None):
        if method == "PUT":
            return {}
        if method == "POST" and path == "/api/sessions":
            return sessions
        if method == "POST" and path.endswith("/restart"):
            kernel_restarts.append(path)
            return {}
        if method == "GET" and path.startswith("/api/contents/"):
            return notebooks
        if method == "DELETE" and path.startswith("/api/sessions/"):
            deleted.append(path)
            return None
        raise AssertionError(f"unexpected request: {method} {path}")
    return fake_req


class TestUseNotebook:
    def test_create_then_activate(self, reset_module_state):
        tools, _ = reset_module_state
        tools._req = install_router(tools)

        result = run(tools.jupyter_use_notebook({
            "notebook_path": "demo.ipynb",
            "notebook_name": "wsinsight",
            "mode": "create",
        }))
        assert "Successfully activated notebook 'wsinsight'" in result
        assert tools._state.current_notebook == "wsinsight"
        sess = tools._state.sessions["wsinsight"]
        assert sess["kernel_id"] == "kernel-xyz-789"
        assert sess["path"] == "demo.ipynb"

    def test_connect_mode_does_not_PUT(self, reset_module_state):
        tools, _ = reset_module_state
        method_calls = []

        async def router(method, path, body=None):
            method_calls.append(method)
            return await install_router(tools)(method, path, body)
        tools._req = router

        run(tools.jupyter_use_notebook({
            "notebook_path": "demo.ipynb", "notebook_name": "wsinsight",
        }))
        assert "PUT" not in method_calls

    def test_missing_notebook_path_errors(self, reset_module_state):
        tools, _ = reset_module_state
        result = run(tools.jupyter_use_notebook({}))
        assert "notebook_path is required" in result

    def test_idempotent_when_already_active(self, reset_module_state):
        tools, _ = reset_module_state
        tools._req = install_router(tools)

        # First call activates.
        run(tools.jupyter_use_notebook({
            "notebook_path": "demo.ipynb", "notebook_name": "n1",
        }))
        # Second call returns the "DO NOT REACTIVATE" banner without
        # issuing new HTTP traffic.
        result2 = run(tools.jupyter_use_notebook({
            "notebook_path": "demo.ipynb", "notebook_name": "n1",
        }))
        assert "DO NOT REACTIVATE" in result2


class TestListNotebooks:
    def test_empty(self, reset_module_state):
        tools, _ = reset_module_state
        result = run(tools.jupyter_list_notebooks({}))
        assert "No notebooks currently in use" in result

    def test_lists_known_sessions(self, reset_module_state):
        tools, _ = reset_module_state
        tools._req = install_router(tools)

        run(tools.jupyter_use_notebook({
            "notebook_path": "demo.ipynb", "notebook_name": "n1",
        }))
        result = run(tools.jupyter_list_notebooks({}))
        assert "n1" in result
        assert "demo.ipynb" in result
        assert "kernel-xyz-789" in result


class TestRestartNotebook:
    def test_happy_path(self, reset_module_state):
        tools, _ = reset_module_state
        tools._req = install_router(tools)

        run(tools.jupyter_use_notebook({
            "notebook_path": "demo.ipynb", "notebook_name": "n1",
        }))
        result = run(tools.jupyter_restart_notebook({"notebook_name": "n1"}))
        assert "restarted successfully" in result

    def test_unknown_session(self, reset_module_state):
        tools, _ = reset_module_state
        result = run(tools.jupyter_restart_notebook({"notebook_name": "ghost"}))
        assert "is not connected" in result


class TestUnuseNotebook:
    def test_delete_session(self, reset_module_state):
        tools, _ = reset_module_state
        deleted = []
        tools._req = install_router(tools, deleted=deleted)

        run(tools.jupyter_use_notebook({
            "notebook_path": "demo.ipynb", "notebook_name": "n1",
        }))
        result = run(tools.jupyter_unuse_notebook({"notebook_name": "n1"}))
        assert "disconnected" in result
        assert "n1" not in tools._state.sessions
        assert tools._state.current_notebook is None
        assert deleted == ["/api/sessions/sess-abc-123"]
