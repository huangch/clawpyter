"""Tool schemas for ClawPyter — what the LLM sees when deciding which tool to call."""

JUPYTER_SERVER_INFO = {
    "name": "jupyter_server_info",
    "description": (
        "Return the Jupyter server URL and token that ClawPyter is currently connected to. "
        "Use this to verify the active connection after calling jupyter_connect_to_jupyter, "
        "or to construct notebook access URLs."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}

JUPYTER_CONNECT_TO_JUPYTER = {
    "name": "jupyter_connect_to_jupyter",
    "description": (
        "Connect to a Jupyter server dynamically with URL and token. Allows connecting to "
        "different Jupyter servers without restarting. Not available when running as a "
        "Jupyter extension. Returns connection status confirming successful connection."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "jupyter_url": {
                "type": "string",
                "description": "URL of the Jupyter server (e.g. http://127.0.0.1:8888)",
            },
            "jupyter_token": {
                "type": "string",
                "description": "Authentication token for the Jupyter server (optional)",
            },
        },
        "required": ["jupyter_url"],
    },
}

JUPYTER_LIST_FILES = {
    "name": "jupyter_list_files",
    "description": (
        "List files and directories recursively in the Jupyter server's file system. "
        "Returns a tab-separated table with columns: Path, Type, Size, Last_Modified. "
        "Supports pagination and glob pattern filtering."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Directory path to list (default: root)",
            },
            "max_depth": {
                "type": "integer",
                "description": "Maximum recursion depth (0-3, default: 1)",
                "minimum": 0,
                "maximum": 3,
            },
            "start_index": {
                "type": "integer",
                "description": "Pagination start index (default: 0)",
                "minimum": 0,
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of results to return (default: 25)",
                "minimum": 0,
            },
            "pattern": {
                "type": "string",
                "description": "Glob pattern to filter results (e.g. '*.ipynb')",
            },
        },
        "required": [],
    },
}

JUPYTER_LIST_KERNELS = {
    "name": "jupyter_list_kernels",
    "description": (
        "List all running kernels on the Jupyter server. Returns a tab-separated table with "
        "columns: ID, Name, Display_Name, Language, State, Connections, Last_Activity, Environment."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}

JUPYTER_CREATE_NOTEBOOK = {
    "name": "jupyter_create_notebook",
    "description": (
        "Create a new notebook with automatic name conflict detection. If no name is provided, "
        "uses JUPYTER_DEFAULT_NOTEBOOK env var or 'Untitled'. Appends a number suffix (-1, -2, "
        "etc.) if the file already exists. Returns success message with the notebook name and "
        "access URL."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Name for the new notebook (with or without .ipynb extension)",
            },
        },
        "required": [],
    },
}

JUPYTER_USE_NOTEBOOK = {
    "name": "jupyter_use_notebook",
    "description": (
        "Open and activate an existing notebook for subsequent cell operations. "
        "notebook_path is the file path relative to the Jupyter server root. "
        "notebook_name is a label you choose to identify the notebook; if unsure, use the same "
        "value as notebook_path. mode='connect' attaches to an existing notebook (default); "
        "mode='create' creates the file first. Returns notebook overview including cell count."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_path": {
                "type": "string",
                "description": "File path relative to Jupyter server root (e.g. 'demo.ipynb')",
            },
            "notebook_name": {
                "type": "string",
                "description": "Unique label for this notebook session (use notebook_path if unsure)",
            },
            "mode": {
                "type": "string",
                "enum": ["connect", "create"],
                "description": "Whether to connect to existing notebook or create new (default: connect)",
            },
            "kernel_id": {
                "type": "string",
                "description": "Specific kernel ID to attach (optional)",
            },
        },
        "required": ["notebook_path", "notebook_name"],
    },
}

JUPYTER_LIST_NOTEBOOKS = {
    "name": "jupyter_list_notebooks",
    "description": (
        "List all notebooks currently open in this session. Returns a tab-separated table with "
        "columns: Name, Path, Kernel_ID, Kernel_Status, Activate (✓ = currently active)."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}

JUPYTER_RESTART_NOTEBOOK = {
    "name": "jupyter_restart_notebook",
    "description": (
        "Restart the kernel for a specific notebook, clearing all in-memory state. "
        "Requires notebook_name as reported by jupyter_list_notebooks."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Notebook identifier (as shown by jupyter_list_notebooks)",
            },
        },
        "required": ["notebook_name"],
    },
}

JUPYTER_RESTART_NOTEBOOK_COMPAT = {
    "name": "jupyter_restart_notebook_compat",
    "description": (
        "(Compatibility wrapper) Restart the kernel for a specific notebook. "
        "Accepts either notebook_name or notebook_path. Falls back to notebook_path if "
        "notebook_name is not supplied."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Notebook identifier (preferred)",
            },
            "notebook_path": {
                "type": "string",
                "description": "Notebook file path (fallback)",
            },
        },
        "required": [],
    },
}

JUPYTER_UNUSE_NOTEBOOK = {
    "name": "jupyter_unuse_notebook",
    "description": (
        "Close a notebook and release its resources (kernel session). "
        "Requires notebook_name as reported by jupyter_list_notebooks."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Notebook identifier (as shown by jupyter_list_notebooks)",
            },
        },
        "required": ["notebook_name"],
    },
}

JUPYTER_UNUSE_NOTEBOOK_COMPAT = {
    "name": "jupyter_unuse_notebook_compat",
    "description": (
        "(Compatibility wrapper) Close a notebook and release its resources. "
        "Accepts either notebook_name or notebook_path. Falls back to notebook_path if "
        "notebook_name is not supplied."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Notebook identifier (preferred)",
            },
            "notebook_path": {
                "type": "string",
                "description": "Notebook file path (fallback)",
            },
        },
        "required": [],
    },
}

JUPYTER_READ_NOTEBOOK = {
    "name": "jupyter_read_notebook",
    "description": (
        "Read a notebook and return its cells. brief format returns the first line and line "
        "count per cell (good for an overview). detailed format returns the full cell source "
        "(good for debugging). Recommended workflow: use brief with a large limit for an "
        "overview, then detailed with a specific range for closer inspection."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Notebook identifier (as shown by jupyter_list_notebooks)",
            },
            "response_format": {
                "type": "string",
                "enum": ["brief", "detailed"],
                "description": "brief = first line per cell (default); detailed = full source",
            },
            "start_index": {
                "type": "integer",
                "description": "First cell index to show (default: 0)",
                "minimum": 0,
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of cells to show (default: 20)",
                "minimum": 0,
            },
        },
        "required": ["notebook_name"],
    },
}

JUPYTER_READ_NOTEBOOK_COMPAT = {
    "name": "jupyter_read_notebook_compat",
    "description": (
        "(Compatibility wrapper) Read a notebook. Accepts either notebook_name or notebook_path. "
        "Falls back to notebook_path if notebook_name is not supplied."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Notebook identifier (preferred)",
            },
            "notebook_path": {
                "type": "string",
                "description": "Notebook file path (fallback)",
            },
            "response_format": {
                "type": "string",
                "enum": ["brief", "detailed"],
                "description": "brief = first line per cell (default); detailed = full source",
            },
            "start_index": {
                "type": "integer",
                "description": "First cell index to show (default: 0)",
                "minimum": 0,
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of cells to show (default: 20)",
                "minimum": 0,
            },
        },
        "required": [],
    },
}

JUPYTER_INSERT_CELL = {
    "name": "jupyter_insert_cell",
    "description": (
        "Insert a cell at a specific position in the currently activated notebook. "
        "cell_index is 0-based; use -1 to append at the end. cell_type is 'code' or 'markdown'. "
        "Returns confirmation with surrounding cells (up to 5 above and below)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "cell_index": {
                "type": "integer",
                "description": "0-based insertion position; -1 to append at end",
                "minimum": -1,
            },
            "cell_type": {
                "type": "string",
                "enum": ["code", "markdown"],
                "description": "Cell type: 'code' or 'markdown'",
            },
            "cell_source": {
                "type": "string",
                "description": "Content of the new cell",
            },
        },
        "required": ["cell_index", "cell_type", "cell_source"],
    },
}

JUPYTER_OVERWRITE_CELL_SOURCE = {
    "name": "jupyter_overwrite_cell_source",
    "description": (
        "Replace the entire source of an existing cell in the currently activated notebook. "
        "Specify the cell by `cell_index` (0-based) OR `cell_id` (nbformat 4.5 id; "
        "recommended when concurrent edits may shift indices). `cell_id` wins if both supplied. "
        "Returns a diff showing added (+) and removed (-) lines."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "cell_index": {
                "type": "integer",
                "description": "0-based index of the cell to overwrite. Omit when passing cell_id.",
                "minimum": 0,
            },
            "cell_source": {
                "type": "string",
                "description": "New complete source for the cell",
            },
            "cell_id": {
                "type": "string",
                "description": "nbformat 4.5 cell id; preferred over cell_index when collaborators may be editing.",
            },
        },
        "anyOf": [
            {"required": ["cell_index", "cell_source"]},
            {"required": ["cell_id", "cell_source"]},
        ],
    },
}

JUPYTER_EXECUTE_CELL = {
    "name": "jupyter_execute_cell",
    "description": (
        "Execute an existing code cell in the currently activated notebook and return its outputs. "
        "Specify the cell by `cell_index` (0-based) OR `cell_id`. "
        "Synchronous by default; pass run_async=true to fire-and-forget (returns a "
        "job_id; outputs are written back to the cell when the kernel completes). "
        "timeout controls the maximum wait in seconds (default: 90). "
        "Returns text, display, and error outputs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "cell_index": {
                "type": "integer",
                "description": "0-based index of the code cell to execute. Omit when passing cell_id.",
                "minimum": 0,
            },
            "cell_id": {
                "type": "string",
                "description": "nbformat 4.5 cell id; preferred over cell_index when collaborators may be editing.",
            },
            "timeout": {
                "type": "integer",
                "description": "Maximum execution time in seconds (default: 90). Ignored when run_async=true.",
                "minimum": 1,
            },
            "run_async": {
                "type": "boolean",
                "default": False,
                "description": "Fire-and-forget execution; returns a job_id instead of waiting for outputs.",
            },
            "stream": {
                "type": "boolean",
                "default": False,
                "description": "Enable streaming progress (including time indicator) updates for long-running cells.",
            },
            "progress_interval": {
                "type": "integer",
                "default": 5,
                "minimum": 1,
                "description": "Seconds between progress updates (MCP keepalive + optional stream log).",
            },
        },
        "anyOf": [
            {"required": ["cell_index"]},
            {"required": ["cell_id"]},
        ],
    },
}

JUPYTER_INSERT_EXECUTE_CODE_CELL = {
    "name": "jupyter_insert_execute_code_cell",
    "description": (
        "Insert a new code cell at a position in the currently activated notebook and immediately "
        "execute it. This is the preferred shortcut when you want to add and run code in one step. "
        "cell_index is 0-based; use -1 to append at end. Returns insertion confirmation and outputs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "cell_index": {
                "type": "integer",
                "description": "0-based insertion position; -1 to append at end",
                "minimum": -1,
            },
            "cell_source": {
                "type": "string",
                "description": "Python code to insert and execute",
            },
            "timeout": {
                "type": "integer",
                "description": "Maximum execution time in seconds (default: 90)",
                "minimum": 1,
            },
            "stream": {
                "type": "boolean",
                "default": False,
                "description": "Enable streaming progress updates while the cell runs.",
            },
            "progress_interval": {
                "type": "integer",
                "default": 5,
                "minimum": 1,
                "description": "Seconds between progress updates (MCP keepalive + optional stream log).",
            },
        },
        "required": ["cell_index", "cell_source"],
    },
}

JUPYTER_READ_CELL = {
    "name": "jupyter_read_cell",
    "description": (
        "Read a single cell from the currently activated notebook, returning its metadata "
        "(index, id, type, execution count), source, and outputs (for code cells). "
        "Specify the cell by `cell_index` (0-based) OR `cell_id` (nbformat 4.5 id; "
        "preferred when concurrent edits may shift indices)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "cell_index": {
                "type": "integer",
                "description": "0-based index of the cell to read. Omit when passing cell_id.",
                "minimum": 0,
            },
            "cell_id": {
                "type": "string",
                "description": "nbformat 4.5 cell id; preferred over cell_index.",
            },
            "include_outputs": {
                "type": "boolean",
                "description": "Include cell outputs for code cells (default: true)",
            },
        },
        "anyOf": [
            {"required": ["cell_index"]},
            {"required": ["cell_id"]},
        ],
    },
}

JUPYTER_DELETE_CELL = {
    "name": "jupyter_delete_cell",
    "description": (
        "Delete one or more cells from the currently activated notebook. "
        "Specify targets by `cell_indices` (list of 0-based indices) OR by "
        "`cell_ids_to_delete` (list of nbformat 4.5 cell ids). Both lists "
        "can be supplied — they are merged and deduplicated; ids win on a tie. "
        "Cells are deleted in descending index order automatically to avoid "
        "shifting, and every id is checked up front so a single bad id fails "
        "the whole call rather than partially deleting the notebook. "
        "Returns deletion confirmation and optionally the deleted cell sources."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "cell_indices": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0},
                "description": "List of 0-based cell indices to delete. Omit when passing cell_ids_to_delete.",
            },
            "cell_ids_to_delete": {
                "type": "array",
                "items": {"type": "string", "minLength": 1},
                "description": (
                    "List of nbformat 4.5 cell ids to delete. Safer than indices "
                    "for multi-cell deletes (indices shift as earlier cells are removed). "
                    "All ids are validated before any cell is deleted; a bad id fails "
                    "the whole call rather than half-deleting the notebook."
                ),
            },
            "include_source": {
                "type": "boolean",
                "description": "Include deleted cell sources in the response (default: true)",
            },
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
        },
        "anyOf": [
            {"required": ["cell_indices"]},
            {"required": ["cell_ids_to_delete"]},
        ],
    },
}

JUPYTER_EXECUTE_CODE = {
    "name": "jupyter_execute_code",
    "description": (
        "Execute code directly in the kernel without saving to the notebook. "
        "Supports magic commands (%, %%) and shell commands (!). "
        "Synchronous by default — returns outputs when the kernel replies or after "
        "timeout (max 60 s). Pass run_async=true to fire-and-forget: the call returns "
        "immediately with a job_id, and you poll with jupyter_get_job_result. "
        "Use synchronous for short snippets; use async for anything that may take "
        "longer than a minute (training loops, large downloads, deep sleeps). "
        "Pass `kernel_id` to target a raw (no-notebook) kernel."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "code": {
                "type": "string",
                "description": "Code to execute in the kernel",
            },
            "timeout": {
                "type": "integer",
                "description": "Maximum execution time in seconds (default: 30, max: 60). Ignored when run_async=true.",
                "minimum": 1,
                "maximum": 60,
            },
            "run_async": {
                "type": "boolean",
                "default": False,
                "description": "Fire-and-forget execution; returns a job_id instead of waiting for outputs.",
            },
            "kernel_id": {
                "type": "string",
                "description": "Optional: target a specific kernel by ID (raw, no notebook). Defaults to the current notebook's kernel.",
            },
            "stream": {
                "type": "boolean",
                "default": False,
                "description": "Enable streaming progress updates while the code runs.",
            },
            "progress_interval": {
                "type": "integer",
                "default": 5,
                "minimum": 1,
                "description": "Seconds between progress updates (MCP keepalive + optional stream log).",
            },
        },
        "required": ["code"],
    },
}


# ===========================================================================
# New schemas — closing the REST-API gap with jupyter-mcp-server.
# Keep in sync with the corresponding `async def jupyter_*` handlers below.
# ===========================================================================

JUPYTER_EDIT_CELL_SOURCE = {
    "name": "jupyter_edit_cell_source",
    "description": (
        "Apply a literal find-and-replace to one cell's source. Useful for surgical edits "
        "(import line, variable rename) when overwriting the whole source via "
        "jupyter_overwrite_cell_source is wasteful or risky. Returns the diff plus the new "
        "cell source. Specify the cell by `cell_index` (0-based) OR `cell_id` (preferred)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "cell_index": {
                "type": "integer",
                "minimum": 0,
                "description": "0-based cell index. Omit when passing cell_id.",
            },
            "old_string": {"type": "string", "description": "Exact substring to find"},
            "new_string": {"type": "string", "description": "Replacement string"},
            "replace_all": {
                "type": "boolean",
                "default": False,
                "description": "If true, replace every occurrence (default: first only).",
            },
            "cell_id": {
                "type": "string",
                "description": "nbformat 4.5 cell id; preferred over cell_index.",
            },
        },
        "anyOf": [
            {"required": ["cell_index", "old_string", "new_string"]},
            {"required": ["cell_id", "old_string", "new_string"]},
        ],
    },
}

JUPYTER_CLEAR_CELL_OUTPUTS = {
    "name": "jupyter_clear_cell_outputs",
    "description": (
        "Clear outputs of one or more code cells without removing the cells themselves. "
        "Accepts cell_indices (list of 0-based indices). Empty list clears ALL code cells. "
        "Returns the number of cells cleared."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "cell_indices": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0},
                "description": (
                    "0-based cell indices to clear. Empty or omitted means clear all code cells."
                ),
            },
        },
        "required": [],
    },
}

JUPYTER_CLEAR_CELL_OUTPUT = {
    "name": "jupyter_clear_cell_output",
    "description": (
        "Clear the outputs of a single cell without removing the cell. "
        "Specify the cell by `cell_index` (0-based) OR `cell_id` (nbformat 4.5). "
        "jmcp-compatible thin wrapper around jupyter_clear_cell_outputs that targets one cell."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
            "cell_index": {
                "type": "integer",
                "minimum": 0,
                "description": "0-based index of the cell to clear. Omit when passing cell_id.",
            },
            "cell_id": {
                "type": "string",
                "description": "nbformat 4.5 cell id; preferred over cell_index.",
            },
        },
        "anyOf": [
            {"required": ["cell_index"]},
            {"required": ["cell_id"]},
        ],
    },
}

JUPYTER_MOVE_CELL = {
    "name": "jupyter_move_cell",
    "description": (
        "Move a cell inside the currently activated notebook. "
        "Specify each endpoint by 0-based index OR by nbformat 4.5 cell id; "
        "`cell_id`s win when both are supplied. `destination_index` is accepted "
        "as a legacy alias for `target_index`. "
        "After removal of the source cell, the target index is applied (standard "
        "array splice). Indices are 0-based."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "source_index": {"type": "integer", "minimum": 0, "description": "0-based index of the cell to move. Omit when passing source_cell_id."},
            "source_cell_id": {
                "type": "string",
                "minLength": 1,
                "description": "nbformat 4.5 cell id of the cell to move. Safer than source_index when collaborators are editing.",
            },
            "target_index": {
                "type": "integer",
                "minimum": 0,
                "description": "Destination index where the cell will end up (0-based). Omit when passing target_cell_id.",
            },
            "target_cell_id": {
                "type": "string",
                "minLength": 1,
                "description": (
                    "Place the moved cell where this cell currently sits, addressed "
                    "by id rather than by an index that the move itself will shift. "
                    "Resolved against the notebook as it is now, BEFORE the source "
                    "is removed."
                ),
            },
            "destination_index": {
                "type": "integer",
                "minimum": 0,
                "description": "Legacy alias for target_index. Prefer target_index.",
            },
            "notebook_name": {
                "type": "string",
                "description": "Optional: target a specific already-activated notebook by name. Defaults to the current notebook.",
            },
        },
        # Source side: need at least one of source_index / source_cell_id.
        # Target side: need at least one of target_index / target_cell_id / destination_index.
        # JSON Schema only supports one `anyOf` per schema, so we use `oneOf`
        # at the top level with a single combined constraint object that the
        # Pydantic-validating runtime (Hermes) accepts; the handler does the
        # actual cross-product validation by inspecting the params dict.
        "oneOf": [
            {
                "allOf": [
                    {"anyOf": [{"required": ["source_index"]}, {"required": ["source_cell_id"]}]},
                    {"anyOf": [
                        {"required": ["target_index"]},
                        {"required": ["target_cell_id"]},
                        {"required": ["destination_index"]},
                    ]},
                ]
            }
        ],
    },
}

JUPYTER_INTERRUPT_CELL = {
    "name": "jupyter_interrupt_cell",
    "description": (
        "Interrupt (SIGINT-style) the kernel attached to the currently activated notebook "
        "without restarting it. Use this to cancel a long-running cell while preserving "
        "kernel state. Non-blocking — returns immediately."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

JUPYTER_LIST_KERNELSPECS = {
    "name": "jupyter_list_kernelspecs",
    "description": (
        "List all kernel specifications this Jupyter server supports (e.g. python3, ir, "
        "julia-1.10, xpython). Useful when jupyter_use_notebook kernel_id=… needs a specific "
        "kernel type. Returns TSV with name / display_name / language / codemirror_mode / env."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

JUPYTER_NBCONVERT = {
    "name": "jupyter_nbconvert",
    "description": (
        "Convert a notebook to another format via /api/nbconvert "
        "(html | python | script | markdown | rst | latex | asciidoc | slides | pdf). "
        "Returned as a text/plain preview (first 8192 chars). Path is relative to the "
        "Jupyter server root."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "notebook_path": {
                "type": "string",
                "description": "Path to the source notebook, relative to the Jupyter server root.",
            },
            "format": {
                "type": "string",
                "enum": ["html", "python", "script", "markdown", "rst", "latex", "asciidoc", "slides", "pdf"],
                "description": "Output format.",
            },
            "download_as": {
                "type": "string",
                "description": "Optional filename hint for downloader clients.",
            },
        },
        "required": ["notebook_path", "format"],
    },
}

JUPYTER_UPLOAD_FILE = {
    "name": "jupyter_upload_file",
    "description": (
        "Upload plain text or base64-encoded file content to the Jupyter server at the given "
        "path. Use format='text' for source/scripts/logs, 'base64' for binary data. Creates "
        "a new file or overwrites an existing one."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Server-relative destination path."},
            "content": {"type": "string", "description": "File content (UTF-8 text or base64)."},
            "format": {
                "type": "string",
                "enum": ["text", "base64"],
                "default": "text",
                "description": "Content encoding.",
            },
        },
        "required": ["path", "content"],
    },
}

JUPYTER_SAVE_FILE = {
    "name": "jupyter_save_file",
    "description": (
        "Save plain-text or base64-encoded content to the Jupyter server. Convenience alias "
        "for jupyter_upload_file when the intent is 'create a text file under the server root'. "
        "Set format='base64' for binary."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
            "format": {"type": "string", "enum": ["text", "base64"], "default": "text"},
        },
        "required": ["path", "content"],
    },
}

JUPYTER_MKDIR = {
    "name": "jupyter_mkdir",
    "description": "Create a new directory on the Jupyter server at the given path.",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Server-relative directory path."},
        },
        "required": ["path"],
    },
}

JUPYTER_DELETE_FILE = {
    "name": "jupyter_delete_file",
    "description": "Delete a file or directory from the Jupyter server.",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Server-relative path to delete."},
        },
        "required": ["path"],
    },
}

JUPYTER_RENAME_FILE = {
    "name": "jupyter_rename_file",
    "description": (
        "Rename or move a file/directory on the Jupyter server. Uses PATCH /api/contents/"
        "<old> so sibling files keep their modification time."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "old_path": {"type": "string"},
            "new_path": {"type": "string"},
        },
        "required": ["old_path", "new_path"],
    },
}

JUPYTER_COPY_FILE = {
    "name": "jupyter_copy_file",
    "description": "Server-side copy — faster than upload-then-download — for files and directories.",
    "parameters": {
        "type": "object",
        "properties": {
            "old_path": {"type": "string"},
            "new_path": {"type": "string"},
        },
        "required": ["old_path", "new_path"],
    },
}


# ===========================================================================
# Async execution jobs (added 2026-09-06).
# ===========================================================================

JUPYTER_GET_JOB_RESULT = {
    "name": "jupyter_get_job_result",
    "description": (
        "Poll a fire-and-forget execute for its result. With run_async=true the "
        "execute tools return immediately and put the job's id in the response; "
        "this tool polls that job. Set wait=true with timeout_ms to block (server-"
        "side bound) until the kernel replies or the timeout expires."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string", "description": "Job id returned by run_async execute."},
            "wait": {
                "type": "boolean",
                "default": False,
                "description": "Block on this call until the job reaches a terminal state or timeout_ms expires.",
            },
            "timeout_ms": {
                "type": "integer",
                "default": 15000,
                "description": "Maximum time to wait when wait=true (milliseconds).",
            },
        },
        "required": ["job_id"],
    },
}

JUPYTER_LIST_JOBS = {
    "name": "jupyter_list_jobs",
    "description": (
        "List async-execution jobs (queued, running, succeeded, failed, cancelled). "
        "Optionally filter by status_filter."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "status_filter": {
                "type": "string",
                "enum": ["queued", "running", "succeeded", "failed", "cancelled"],
                "description": "If present, only return jobs in this status.",
            },
        },
        "required": [],
    },
}

JUPYTER_CANCEL_JOB = {
    "name": "jupyter_cancel_job",
    "description": (
        "Cancel a queued/running async execution by interrupting the kernel. The "
        "kernel cancels the in-flight execute_request; the job's status becomes "
        "cancelled once the WebSocket closes."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string", "description": "Job id to cancel."},
        },
        "required": ["job_id"],
    },
}
