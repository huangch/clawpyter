"""ClawPyter — Hermes Agent plugin for Jupyter notebook integration.

Provides 20 tools for creating, editing, and executing Jupyter notebooks
through the Jupyter REST API and WebSocket kernel protocol.

Configuration (set in .env or environment):
  JUPYTER_URL             — Jupyter server URL (default: http://127.0.0.1:8888)
  JUPYTER_TOKEN           — Auth token (default: empty, suitable for local servers)
  JUPYTER_TIMEOUT_MS      — Request timeout in ms (default: 30000)
  JUPYTER_DEFAULT_NOTEBOOK — Default notebook name (default: Untitled)

Install:
  cp -r /path/to/clawpyter/hermes-plugin ~/.hermes/plugins/clawpyter
  pip install httpx websockets

Usage: start your Jupyter server with ./start-jpy.sh, then ask Hermes to
work with notebooks. See the clawpyter skill for detailed usage instructions.
"""

import logging
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

from . import schemas
from . import tools as _tools


def _install_skill() -> None:
    """Copy the bundled skill file to ~/.hermes/skills/clawpyter/ on first load."""
    try:
        from hermes_cli.config import get_hermes_home
        dest = get_hermes_home() / "skills" / "clawpyter" / "SKILL.md"
    except Exception:
        dest = Path.home() / ".hermes" / "skills" / "clawpyter" / "SKILL.md"

    if dest.exists():
        return  # Don't overwrite user edits

    source = Path(__file__).parent / "skill.md"
    if source.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        logger.info("ClawPyter: installed skill to %s", dest)


def register(ctx) -> None:
    """Register all ClawPyter tools with the Hermes plugin context."""

    # ------------------------------------------------------------------
    # Server tools (no active notebook required)
    # ------------------------------------------------------------------
    ctx.register_tool(
        name="jupyter_server_info",
        toolset="clawpyter",
        schema=schemas.JUPYTER_SERVER_INFO,
        handler=_tools.jupyter_server_info,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_connect_to_jupyter",
        toolset="clawpyter",
        schema=schemas.JUPYTER_CONNECT_TO_JUPYTER,
        handler=_tools.jupyter_connect_to_jupyter,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_list_files",
        toolset="clawpyter",
        schema=schemas.JUPYTER_LIST_FILES,
        handler=_tools.jupyter_list_files,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_list_kernels",
        toolset="clawpyter",
        schema=schemas.JUPYTER_LIST_KERNELS,
        handler=_tools.jupyter_list_kernels,
        is_async=True,
    )

    # ------------------------------------------------------------------
    # Notebook management tools
    # ------------------------------------------------------------------
    ctx.register_tool(
        name="jupyter_create_notebook",
        toolset="clawpyter",
        schema=schemas.JUPYTER_CREATE_NOTEBOOK,
        handler=_tools.jupyter_create_notebook,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_use_notebook",
        toolset="clawpyter",
        schema=schemas.JUPYTER_USE_NOTEBOOK,
        handler=_tools.jupyter_use_notebook,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_list_notebooks",
        toolset="clawpyter",
        schema=schemas.JUPYTER_LIST_NOTEBOOKS,
        handler=_tools.jupyter_list_notebooks,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_restart_notebook",
        toolset="clawpyter",
        schema=schemas.JUPYTER_RESTART_NOTEBOOK,
        handler=_tools.jupyter_restart_notebook,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_restart_notebook_compat",
        toolset="clawpyter",
        schema=schemas.JUPYTER_RESTART_NOTEBOOK_COMPAT,
        handler=_tools.jupyter_restart_notebook_compat,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_unuse_notebook",
        toolset="clawpyter",
        schema=schemas.JUPYTER_UNUSE_NOTEBOOK,
        handler=_tools.jupyter_unuse_notebook,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_unuse_notebook_compat",
        toolset="clawpyter",
        schema=schemas.JUPYTER_UNUSE_NOTEBOOK_COMPAT,
        handler=_tools.jupyter_unuse_notebook_compat,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_read_notebook",
        toolset="clawpyter",
        schema=schemas.JUPYTER_READ_NOTEBOOK,
        handler=_tools.jupyter_read_notebook,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_read_notebook_compat",
        toolset="clawpyter",
        schema=schemas.JUPYTER_READ_NOTEBOOK_COMPAT,
        handler=_tools.jupyter_read_notebook_compat,
        is_async=True,
    )

    # ------------------------------------------------------------------
    # Cell tools (require an active notebook)
    # ------------------------------------------------------------------
    ctx.register_tool(
        name="jupyter_insert_cell",
        toolset="clawpyter",
        schema=schemas.JUPYTER_INSERT_CELL,
        handler=_tools.jupyter_insert_cell,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_overwrite_cell_source",
        toolset="clawpyter",
        schema=schemas.JUPYTER_OVERWRITE_CELL_SOURCE,
        handler=_tools.jupyter_overwrite_cell_source,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_execute_cell",
        toolset="clawpyter",
        schema=schemas.JUPYTER_EXECUTE_CELL,
        handler=_tools.jupyter_execute_cell,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_insert_execute_code_cell",
        toolset="clawpyter",
        schema=schemas.JUPYTER_INSERT_EXECUTE_CODE_CELL,
        handler=_tools.jupyter_insert_execute_code_cell,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_read_cell",
        toolset="clawpyter",
        schema=schemas.JUPYTER_READ_CELL,
        handler=_tools.jupyter_read_cell,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_delete_cell",
        toolset="clawpyter",
        schema=schemas.JUPYTER_DELETE_CELL,
        handler=_tools.jupyter_delete_cell,
        is_async=True,
    )
    ctx.register_tool(
        name="jupyter_execute_code",
        toolset="clawpyter",
        schema=schemas.JUPYTER_EXECUTE_CODE,
        handler=_tools.jupyter_execute_code,
        is_async=True,
    )

    _install_skill()
