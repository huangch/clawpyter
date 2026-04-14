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
        "cell_index is 0-based. cell_source is the complete new content. "
        "Returns a diff showing added (+) and removed (-) lines."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "cell_index": {
                "type": "integer",
                "description": "0-based index of the cell to overwrite",
                "minimum": 0,
            },
            "cell_source": {
                "type": "string",
                "description": "New complete source for the cell",
            },
        },
        "required": ["cell_index", "cell_source"],
    },
}

JUPYTER_EXECUTE_CELL = {
    "name": "jupyter_execute_cell",
    "description": (
        "Execute an existing code cell in the currently activated notebook and return its outputs. "
        "cell_index is 0-based. timeout controls the maximum wait in seconds (default: 90). "
        "Returns text, display, and error outputs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "cell_index": {
                "type": "integer",
                "description": "0-based index of the code cell to execute",
                "minimum": 0,
            },
            "timeout": {
                "type": "integer",
                "description": "Maximum execution time in seconds (default: 90)",
                "minimum": 1,
            },
        },
        "required": ["cell_index"],
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
        },
        "required": ["cell_index", "cell_source"],
    },
}

JUPYTER_READ_CELL = {
    "name": "jupyter_read_cell",
    "description": (
        "Read a single cell from the currently activated notebook, returning its metadata "
        "(index, type, execution count), source, and outputs (for code cells). "
        "cell_index is 0-based."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "cell_index": {
                "type": "integer",
                "description": "0-based index of the cell to read",
                "minimum": 0,
            },
            "include_outputs": {
                "type": "boolean",
                "description": "Include cell outputs for code cells (default: true)",
            },
        },
        "required": ["cell_index"],
    },
}

JUPYTER_DELETE_CELL = {
    "name": "jupyter_delete_cell",
    "description": (
        "Delete one or more cells from the currently activated notebook. "
        "cell_indices is a list of 0-based indices to delete. "
        "IMPORTANT: cells are deleted in descending index order automatically to avoid shifting. "
        "Returns deletion confirmation and optionally the deleted cell sources."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "cell_indices": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0},
                "description": "List of 0-based cell indices to delete",
            },
            "include_source": {
                "type": "boolean",
                "description": "Include deleted cell sources in the response (default: true)",
            },
        },
        "required": ["cell_indices"],
    },
}

JUPYTER_EXECUTE_CODE = {
    "name": "jupyter_execute_code",
    "description": (
        "Execute code directly in the kernel without saving to the notebook. "
        "Supports magic commands (%, %%) and shell commands (!). "
        "Use for: magic commands (%timeit, %pip install), ephemeral calculations, "
        "shell commands, debugging variable state. "
        "Do NOT use for: code that should persist in the notebook, long-running tasks. "
        "Maximum timeout is 60 seconds."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "Code to execute in the kernel",
            },
            "timeout": {
                "type": "integer",
                "description": "Maximum execution time in seconds (default: 30, max: 60)",
                "minimum": 1,
                "maximum": 60,
            },
        },
        "required": ["code"],
    },
}
