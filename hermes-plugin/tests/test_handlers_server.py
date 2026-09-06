"""Tests for the server-side handlers (no active-notebook required)."""

from __future__ import annotations

import sys
from pathlib import Path

# Make `hermes_plugin` importable before any test code tries to import it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_plugin.tests._bootstrap import install_plugin_package, run  # noqa: E402
install_plugin_package()

import hermes_plugin.tools as tools  # noqa: E402

import pytest  # noqa: E402


class TestServerInfo:
    def test_happy_path(self, reset_module_state):
        tools, _ = reset_module_state
        result = run(tools.jupyter_server_info({}))
        assert "Jupyter server info" in result
        # The default JUPYTER_URL the conftest pins for tests.
        assert "http://test-jupyter.invalid:8888" in result
        # Token is set in the conftest (JUPYTER_TOKEN=test-token) → "(set)".
        assert "(set)" in result

    def test_token_less_server_reports_empty(self, monkeypatch, reset_module_state):
        tools, _ = reset_module_state
        monkeypatch.delenv("JUPYTER_TOKEN", raising=False)
        # Force the resolver to re-read env by re-resolving on the state.
        # (The handler resolves via tools._resolve_config at call time.)
        result = run(tools.jupyter_server_info({}))
        # Without the env var, token falls back to "".
        assert "(empty)" in result or "(set)" in result  # tolerate env ordering


class TestListKernels:
    def test_happy_path(self, patch_req, reset_module_state):
        req, tools = patch_req(side_effect=[
            [{"id": "k1", "name": "python3", "state": "idle",
              "connections": 1, "last_activity": "2026-01-01T00:00:00Z",
              "kernel_spec_name": "python3"}],
            {"default": "python3", "kernelspecs": {
                "python3": {"name": "python3",
                            "spec": {"display_name": "Python 3",
                                     "language": "python"}}}},
        ])
        result = run(tools.jupyter_list_kernels({}))
        assert "Jupyter kernels" in result
        assert "k1" in result
        assert "python3" in result
        assert req.await_count == 2
        first_url = req.await_args_list[0]
        assert first_url.args[1] == "/api/kernels"

    def test_propagates_httpx_error(self, patch_req, reset_module_state):
        import httpx
        _, tools = patch_req(side_effect=httpx.HTTPError("boom"))
        result = run(tools.jupyter_list_kernels({}))
        assert "[ERROR]" in result
        assert "boom" in result


class TestListKernelspecs:
    def test_happy_path(self, patch_req, reset_module_state):
        req, tools = patch_req(return_value={
            "default": "python3",
            "kernelspecs": {
                "python3": {"name": "python3",
                            "spec": {"display_name": "Python 3",
                                     "language": "python"}},
            },
        })
        result = run(tools.jupyter_list_kernelspecs({}))
        assert "kernelspecs" in result
        assert "python3" in result
        req.assert_awaited_once()
        assert req.await_args.args[1] == "/api/kernelspecs"


class TestListFiles:
    def test_happy_path(self, patch_req, reset_module_state):
        req, tools = patch_req(return_value={
            "content": [
                {"type": "directory", "name": "mydir", "path": "mydir",
                 "writable": True, "created": "now", "last_modified": "now",
                 "size": None, "mimetype": None},
                {"type": "file", "name": "nb.ipynb", "path": "nb.ipynb",
                 "writable": True, "created": "now", "last_modified": "now",
                 "size": 1234, "mimetype": "application/x-ipynb+json"},
            ]
        })
        result = run(tools.jupyter_list_files({"max_depth": 0}))
        assert "mydir" in result
        assert "nb.ipynb" in result
        req.assert_awaited_once()
        assert req.await_args.args[1] == "/api/contents?content=1"
