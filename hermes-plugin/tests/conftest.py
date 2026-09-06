"""Shared pytest fixtures for the ClawPyter Hermes plugin.

pytest auto-discovers conftest.py at the test directory. We use it for the
real pytest machinery (autouse fixtures, pytest fixtures):::

    @pytest.fixture(autouse=True)
    def reset_module_state(): ...

The actual plugin bootstrapping (loading `hermes-plugin/__init__.py` against
the synthetic `hermes_plugin` package name) lives in `_bootstrap.py` and is
triggered once per test module via `install_plugin_package()` at the top.

Run from the repo root::

    pytest hermes-plugin/tests
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock

import pytest


# Default test env so handlers don't dial out during module init (e.g. for the
# Y.js collab probe).
os.environ.setdefault("JUPYTER_URL", "http://test-jupyter.invalid:8888")
os.environ.setdefault("JUPYTER_TOKEN", "test-token")
os.environ.setdefault("JUPYTER_TIMEOUT_MS", "5000")


@pytest.fixture(autouse=True)
def reset_module_state():
    """Reset `_state` and expose the (tools, schemas) modules each test uses."""
    from hermes_plugin.tests._bootstrap import install_plugin_package
    install_plugin_package()

    import hermes_plugin.tools as tools
    import hermes_plugin.schemas as _schemas  # noqa: F401  intentional re-import

    tools._state.current_notebook = None
    tools._state.sessions.clear()
    tools._state.collab_rooms.clear()
    tools._state.collab_available = None
    tools._state.collab_probed = False
    tools._collab_mode = "off"
    yield tools, _schemas


def _patch_req_factory(tools):
    """Create an AsyncMock for `tools._req` and return `(mock, tools)`."""
    mock = AsyncMock()
    tools._req = mock
    return mock, tools


@pytest.fixture
def patch_req():
    """Replace `tools._req` with an AsyncMock; restore the real fn at teardown.

    Usage::

        def test_x(self, patch_req, reset_module_state):
            req, tools = patch_req(return_value=[...])
            tools._req  # -> the mock; assert_awaited_once_with(...)
    """
    from hermes_plugin.tests._bootstrap import install_plugin_package
    install_plugin_package()
    import hermes_plugin.tools as tools
    real_req = tools._req
    def make(**kwargs):
        mock, _t = _patch_req_factory(tools)
        mock.configure_mock(**kwargs)
        return mock, tools
    yield make
    tools._req = real_req
