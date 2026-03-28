---
name: ClawPyter
description: MUST use ClawPyter for all Jupyter notebook, kernel, and file operations. ALWAYS activate a notebook before cell operations. MUST use notebook_path as the file path relative to server root. MUST use notebook_name as the active notebook session identifier. ALWAYS follow each tool's exact argument rules precisely.
---

# ClawPyter

## CRITICAL: When to use this skill

ALWAYS use ClawPyter whenever the user performs ANY operation involving Jupyter notebooks, kernels, notebook files, or live code execution in a Jupyter environment.

ClawPyter provides three tool categories (16 core tools + 3 compatibility wrappers):

**Server Management (4 tools)** — MUST use for file and kernel inspection
- `jupyter_list_files`
- `jupyter_list_kernels`
- `jupyter_connect_to_jupyter`
- `jupyter_server_info`

**Notebook Management (6 tools + 3 compatibility wrappers)** — MUST use before all cell operations
- `jupyter_create_notebook` (Use when user wants to create a new notebook)
- `jupyter_use_notebook` (REQUIRED first step for existing notebooks)
- `jupyter_list_notebooks`
- `jupyter_restart_notebook` / `jupyter_restart_notebook_compat`
- `jupyter_unuse_notebook` / `jupyter_unuse_notebook_compat`
- `jupyter_read_notebook` / `jupyter_read_notebook_compat`

**Cell Operations (7 tools)** — ALWAYS operate on active notebook only
- `jupyter_insert_cell`
- `jupyter_overwrite_cell_source`
- `jupyter_execute_cell`
- `jupyter_insert_execute_code_cell`
- `jupyter_read_cell`
- `jupyter_delete_cell`
- `jupyter_execute_code`

## MANDATORY: Core mental model

### `notebook_path` — ALWAYS required
`notebook_path` is the **path to the notebook file relative to the Jupyter server root**. Examples:
- `Untitled.ipynb`
- `projects/demo/test.ipynb`

**MUST use this when identifying a notebook file on disk.**

### `notebook_name` — client-side session key
`notebook_name` is a **client-side key** used locally by ClawPyter to track active sessions in memory. It is NOT sent to the Jupyter server — it is only used to look up an in-memory session record.

**CRITICAL RULES:**
- `notebook_path` and `notebook_name` are BOTH required to activate a notebook via `jupyter_use_notebook`
- NEVER send an empty string for `notebook_name` — ClawPyter will silently fall back to `notebook_path` as the key, which may cause confusion
- When the user provides only a file path, pass `notebook_path` for both parameters
- ALWAYS confirm active sessions by calling `jupyter_list_notebooks` after activation

### Active notebook — MANDATORY context for cell operations
Cell operations (insert, edit, execute, delete) work ONLY on the **currently activated notebook**.

**ABSOLUTE WORKFLOW REQUIREMENT:**
1. Identify the file → use `jupyter_list_files` if needed
2. **ACTIVATE the notebook** → use `jupyter_use_notebook` (NEVER skip this step)
3. Inspect the structure → use `jupyter_read_notebook` when cell positions are uncertain
4. Perform cell operations → use cell tools

**VIOLATION OF THIS SEQUENCE WILL CAUSE FAILURES.** Do NOT attempt cell operations without first calling `jupyter_use_notebook`.

---

## Server Management Tools

### `jupyter_list_files`
**PURPOSE:** List files and directories recursively in the Jupyter server's file system.

**Arguments (all optional):**
- `path` (optional, default: `""` = root): starting directory path
- `max_depth` (optional, default: `1`, max: `3`): recursion depth
- `start_index` (optional, default: `0`): pagination start position
- `limit` (optional, default: `25`, `0` = no limit): results per page
- `pattern` (optional): glob pattern filter (e.g., `*.ipynb`)

**Returns:** Tab-separated table with columns:
- `Path` — file/directory path
- `Type` — `"file"`, `"directory"`, or `"notebook"`
- `Size` — formatted as B, KB, or MB (empty for directories)
- `Last_Modified` — YYYY-MM-DD HH:MM:SS format

**Example:** Use `max_depth: 2, pattern: "*.ipynb"` to find all notebooks up to 2 levels deep.

---

### `jupyter_list_kernels`
**PURPOSE:** List all running kernels on the Jupyter server.

**Arguments:** None

**Returns:** Tab-separated table with columns:
- `ID` — unique kernel identifier
- `Name` — kernel name/type (e.g., `"python3"`, `"ir"`)
- `Display_Name` — human-readable kernel name
- `Language` — programming language (e.g., `"python"`, `"R"`)
- `State` — current state: `"idle"`, `"busy"`, or `"unknown"`
- `Connections` — number of active connections
- `Last_Activity` — YYYY-MM-DD HH:MM:SS timestamp
- `Environment` — kernel environment variables (truncated at 100 chars)

---

### `jupyter_connect_to_jupyter`
**PURPOSE:** Connect to a different Jupyter server dynamically without restarting.

**Arguments:**
- `jupyter_url` (**required**): Full Jupyter server URL (e.g., `http://localhost:8888`)
- `jupyter_token` (optional): Authentication token for the server
- `provider` (optional): Provider type hint (informational only, not used by the client)

**SECURITY NOTE:** Do NOT casually ask users to paste tokens. Only request when absolutely necessary for debugging.

---

### `jupyter_server_info`
**PURPOSE:** Retrieve the current Jupyter connection settings in use.

**Arguments:** None

**Returns:** JSON object with EXACT fields:
- `jupyter_url` — the active Jupyter server URL (e.g., `http://127.0.0.1:8888`)
- `jupyter_token` — the authentication token currently in use

**CRITICAL: Constructing Notebook URLs**

When providing users with URLs to access notebooks, ALWAYS include the authentication token. Use this exact format:

```
{jupyter_url}/lab/tree/{notebook_path}?token={jupyter_token}
```

**Examples:**
- `http://192.168.1.196:8888/lab/tree/notebook2.ipynb?token=abc123def456`
- `http://127.0.0.1:8888/lab/tree/projects/demo.ipynb?token=xyz789uvw012`

Note: `jupyter_create_notebook` automatically constructs and returns the authenticated URL — call `jupyter_server_info` only when constructing URLs manually.

---

## Notebook Management Tools — MANDATORY before all cell operations

### `jupyter_create_notebook`
**PURPOSE:** Create a new notebook with automatic filename conflict detection. Also creates a kernel session and sets this notebook as the active notebook.

**AUTOMATIC NAMING LOGIC (when user does not specify name):**
1. Use `notebook_name` if provided explicitly
2. Fall back to `defaultNotebook` from plugin config if not provided
3. Fall back to `"Untitled"` if config has no default
4. **Conflict detection:** If the target filename exists, automatically append suffix:
   - First conflict: `filename-1.ipynb`
   - Second conflict: `filename-2.ipynb`
   - Continue incrementing until a unique name is found

**Arguments:**
- `notebook_name` (optional): Explicit notebook name. If not provided, uses naming logic above.

**Returns:** Success message with the resolved notebook name and authenticated access URL.

**IMPORTANT:** After `jupyter_create_notebook` succeeds, the new notebook is already activated as the current notebook. You do NOT need to call `jupyter_use_notebook` after creating.

---

### `jupyter_use_notebook`
**PURPOSE:** Activate an existing notebook (or create one) for subsequent cell operations.

**Arguments:**
- `notebook_path` (**required**): File path relative to Jupyter server root (e.g., `demo.ipynb`)
- `notebook_name` (**required**): Client-side session key for this notebook. Pass `notebook_path` if you have no other name.
- `mode` (optional, default: `"connect"`): `"connect"` to open an existing notebook; `"create"` to create a new file first
- `kernel_id` (optional): Attach a specific existing kernel by ID

**Returns:** Activation status, kernel details, and an overview of the first 20 cells (brief format).

**IMPORTANT GUARDS:**
- If the notebook is already activated, the tool returns immediately without re-connecting (DO NOT call again).
- If the notebook is already created with `mode: "create"`, the tool returns immediately (DO NOT CREATE AGAIN).
- If `notebook_path` does not match the session's stored path, the tool reports an error.

---

### `jupyter_list_notebooks`
**PURPOSE:** List all notebooks currently tracked in the ClawPyter session (i.e., notebooks activated via `jupyter_use_notebook` or created via `jupyter_create_notebook`).

**Arguments:** None

**Returns:** Tab-separated table with columns:
- `Name` — the client-side session key
- `Path` — notebook file path
- `Kernel_ID` — the associated kernel ID
- `Kernel_Status` — always `"unknown"` (status is not live-fetched)
- `Activate` — `✓` if this is the currently active notebook

**Use this to:** confirm which notebook is active, get kernel IDs, and verify sessions after activation.

---

### `jupyter_restart_notebook`
**PURPOSE:** Restart the kernel for a notebook tracked in the current session.

**Arguments:**
- `notebook_name` (**required**): The session key (as shown in `jupyter_list_notebooks`)

**Returns:** Confirmation that the kernel has been restarted. All in-memory kernel state is cleared.

---

### `jupyter_restart_notebook_compat`
*(Compatibility wrapper)* Same as `jupyter_restart_notebook` but accepts either `notebook_name` or `notebook_path`. If `notebook_name` is absent or empty, falls back to `notebook_path`.

**Arguments:**
- `notebook_name` (optional)
- `notebook_path` (optional)

---

### `jupyter_unuse_notebook`
**PURPOSE:** Disconnect from a notebook and release its Jupyter session/kernel resources.

**Arguments:**
- `notebook_name` (**required**): The session key (as shown in `jupyter_list_notebooks`)

**Returns:** Confirmation that the session has been deleted and removed from tracking.

---

### `jupyter_unuse_notebook_compat`
*(Compatibility wrapper)* Same as `jupyter_unuse_notebook` but accepts either `notebook_name` or `notebook_path`.

**Arguments:**
- `notebook_name` (optional)
- `notebook_path` (optional)

---

### `jupyter_read_notebook`
**PURPOSE:** Read the structure and content of a tracked notebook.

**Arguments:**
- `notebook_name` (**required**): The session key
- `response_format` (optional, default: `"brief"`): `"brief"` returns first line + line count per cell; `"detailed"` returns full cell source
- `start_index` (optional, default: `0`): First cell index to return
- `limit` (optional, default: `20`): Number of cells to return (`0` = all)

**Returns:** Total cell count, followed by formatted cell listing.

**Recommended workflow:** Use `brief` format with a large `limit` for an overview, then `detailed` format with specific `start_index` and `limit` for targeted inspection.

---

### `jupyter_read_notebook_compat`
*(Compatibility wrapper)* Same as `jupyter_read_notebook` but accepts either `notebook_name` or `notebook_path`.

**Arguments:**
- `notebook_name` (optional)
- `notebook_path` (optional)
- `response_format` (optional)
- `start_index` (optional)
- `limit` (optional)

---

## Cell Operation Tools — All require an active notebook

All cell tools operate on the **currently active notebook** (set by `jupyter_use_notebook` or `jupyter_create_notebook`). All cell indices are **0-based**.

### `jupyter_insert_cell`
**PURPOSE:** Insert a new cell at a specific position in the active notebook.

**Arguments:**
- `cell_index` (**required**, integer ≥ -1): Position to insert. Use `-1` to append at the end.
- `cell_type` (**required**): `"code"` or `"markdown"`
- `cell_source` (**required**): The cell content

**Returns:** Confirmation with the insertion index and a brief listing of up to 5 cells above and below the new cell.

---

### `jupyter_overwrite_cell_source`
**PURPOSE:** Replace the source of an existing cell. Clears outputs and execution count for code cells.

**Arguments:**
- `cell_index` (**required**, integer ≥ 0): 0-based index of the cell to overwrite
- `cell_source` (**required**): Complete new source content

**Returns:** A diff-style comparison (`+` for new lines, `-` for deleted lines).

---

### `jupyter_execute_cell`
**PURPOSE:** Execute an existing code cell by index. Saves outputs back to the notebook file.

**Arguments:**
- `cell_index` (**required**, integer ≥ 0): 0-based index of the cell to execute
- `timeout` (optional, default: `90`): Maximum wait time in seconds
- `stream` (optional, default: `false`): Enable streaming progress updates
- `progress_interval` (optional, default: `5`): Seconds between progress updates when streaming

**Returns:** All execution outputs (text, HTML, images). Non-code cells will return an error.

---

### `jupyter_insert_execute_code_cell`
**PURPOSE:** Insert a new code cell and immediately execute it in a single operation. Prefer this over calling `jupyter_insert_cell` + `jupyter_execute_cell` separately.

**Arguments:**
- `cell_index` (**required**, integer ≥ -1): Position to insert. Use `-1` to append at the end.
- `cell_source` (**required**): The code to insert and run
- `timeout` (optional, default: `90`): Maximum wait time in seconds

**Returns:** Insertion confirmation and execution outputs.

---

### `jupyter_read_cell`
**PURPOSE:** Read a single cell's metadata, source, and outputs.

**Arguments:**
- `cell_index` (**required**, integer ≥ 0): 0-based index
- `include_outputs` (optional, default: `true`): Include outputs for code cells

**Returns:** Index, type, execution count, source, and (if `include_outputs=true`) outputs.

---

### `jupyter_delete_cell`
**PURPOSE:** Delete one or more cells from the active notebook.

**Arguments:**
- `cell_indices` (**required**): Array of 0-based cell indices to delete
- `include_source` (optional, default: `true`): Include deleted cell sources in the response

**Returns:** Count of deleted cells and (if `include_source=true`) the source of each deleted cell.

**IMPORTANT:** The tool automatically sorts indices in descending order before deletion to prevent index shifting. You do NOT need to sort them yourself.

---

### `jupyter_execute_code`
**PURPOSE:** Execute an arbitrary code snippet directly in the active notebook's kernel **without inserting or saving it as a cell**. Useful for one-off inspections, magic commands, and shell commands.

**Arguments:**
- `code` (**required**): Code to execute
- `timeout` (optional, default: `30`, max: `60`): Maximum wait time in seconds

**Returns:** All execution outputs.

**Use for:** `%timeit`, `%pip install`, `!ls`, inspecting variable values, temporary calculations.

**Do NOT use for:** code that sets variables or imports that need to persist in subsequent notebook cells — use `jupyter_insert_execute_code_cell` instead.

---

## Common Workflows

### Opening and editing an existing notebook

```
1. jupyter_list_files                   → confirm the file exists
2. jupyter_use_notebook                 → activate it (notebook_path + notebook_name)
3. jupyter_list_notebooks               → confirm activation and note kernel_id
4. jupyter_read_notebook                → inspect cell structure (brief format)
5. jupyter_overwrite_cell_source        → edit an existing cell
   or jupyter_insert_cell               → add a new cell
6. jupyter_execute_cell                 → run the edited cell
```

### Creating a new notebook and running code

```
1. jupyter_create_notebook              → creates file, kernel session, and activates it
2. jupyter_insert_execute_code_cell     → insert + run code in one step
```

### Switching between notebooks

```
1. jupyter_list_notebooks               → see all tracked notebooks and their session keys
2. jupyter_use_notebook                 → activate the target notebook (already tracked = instant switch)
```

---

## Common Pitfalls

| Mistake | Consequence | Fix |
|---|---|---|
| Calling cell tools without `jupyter_use_notebook` | "No active notebook" error | Always activate first |
| Calling `jupyter_use_notebook` after `jupyter_create_notebook` | "Already created/activated" guard fires | `jupyter_create_notebook` auto-activates — skip `use_notebook` |
| Passing empty `notebook_name` | Falls back to `notebook_path` as key, may cause session confusion | Always pass a non-empty value |
| Deleting cells with ascending indices manually | Index shifting corrupts which cells get deleted | Pass all indices at once; the tool sorts descending automatically |
| Using `jupyter_execute_code` for persistent variable setup | Code runs but is not saved to the notebook | Use `jupyter_insert_execute_code_cell` instead |
