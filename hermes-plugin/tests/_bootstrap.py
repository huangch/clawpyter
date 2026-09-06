"""Bootstrap helper for tests: expose `hermes-plugin/` as the `hermes_plugin`
Python package, then re-export its top-level modules so call sites can do::

    from hermes_plugin import tools, schemas
    from hermes_plugin.tests._bootstrap import run, install_plugin_package

Always call `install_plugin_package()` exactly **once** at import time. The
recommended pattern is to put `from hermes_plugin.tests._bootstrap
import install_plugin_package; install_plugin_package()` at the very top of
each test file, or rely on `hermes_plugin/tests/conftest.py` to do it once.

We can't use a top-level `tests/__init__.py` because Python's package
discovery trips over the dashed name `hermes-plugin/` and pytest's
collect-only pass would try to import `hermes-plugin/__init__.py` as a
top-level test module. So this file lives under `hermes-plugin/tests/`
but is NOT itself a test file (no `test_` prefix).
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

_HERMES_PLUGIN_NAME = "hermes_plugin"
_HERMES_PLUGIN_SRC = Path(__file__).resolve().parents[1]  # hermes-plugin/

_install_done = False


def install_plugin_package() -> None:
    """Make `hermes_plugin` importable; idempotent."""
    global _install_done
    if _install_done:
        return

    # 1) Placeholder parent package so submodule relative imports can resolve
    if _HERMES_PLUGIN_NAME not in sys.modules:
        placeholder = types.ModuleType(_HERMES_PLUGIN_NAME)
        placeholder.__path__ = [str(_HERMES_PLUGIN_SRC)]  # type: ignore[attr-defined]
        sys.modules[_HERMES_PLUGIN_NAME] = placeholder

    # 2) Pre-load every top-level module under that package
    for sub in ("schemas", "tools", "jobs", "collab_client"):
        spec = importlib.util.spec_from_file_location(
            f"{_HERMES_PLUGIN_NAME}.{sub}",
            _HERMES_PLUGIN_SRC / f"{sub}.py",
        )
        if not spec or not spec.loader:
            continue
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f"{_HERMES_PLUGIN_NAME}.{sub}"] = mod
        spec.loader.exec_module(mod)

    # 3) Then exec __init__.py as the package itself. Use
    #    submodule_search_locations so `from . import schemas` resolves.
    init_path = _HERMES_PLUGIN_SRC / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        _HERMES_PLUGIN_NAME,
        init_path,
        submodule_search_locations=[str(_HERMES_PLUGIN_SRC)],
    )
    if not spec or not spec.loader:
        raise RuntimeError(f"could not build module spec for {init_path}")
    init_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(init_mod)
    sys.modules[_HERMES_PLUGIN_NAME] = init_mod

    _install_done = True


# Convenience runner for async test bodies.
def run(coro):
    import asyncio
    return asyncio.run(coro)
