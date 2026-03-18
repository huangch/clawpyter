---
name: ClawPyter
description: MUST use ClawPyter for all Jupyter notebook, kernel, and file operations. ALWAYS activate a notebook before cell operations. MUST use notebook_path as the file path relative to server root. MUST use notebook_name as the active notebook session identifier. ALWAYS follow each tool's exact argument rules precisely.
---

# ClawPyter

## CRITICAL: When to use this skill

ALWAYS use ClawPyter whenever the user performs ANY operation involving Jupyter notebooks, kernels, notebook files, or live code execution in a Jupyter environment.

ClawPyter provides three mandatory tool categories (16 core tools + 3 compatibility wrappers):

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
`notebook_path` is the **absolute, relative-to-server-root path** to the notebook file. Examples:
- `Untitled.ipynb`
- `projects/demo/test.ipynb`

**MUST use this when identifying a notebook file on disk.**

### `notebook_name` — ALWAYS required for server operations
`notebook_name` is the **unique session identifier** the Jupyter server uses to manage an active notebook session. It is **MANDATORY** when calling `jupyter_use_notebook`.

**CRITICAL RULES:**
- `notebook_path` and `notebook_name` are BOTH required to activate a notebook
- NEVER send an empty string for `notebook_name` — the upstream server WILL reject it
- When the user provides only a file path, MUST pass `notebook_path` for both parameters
- ALWAYS confirm the assigned `notebook_name` by calling `jupyter_list_notebooks` immediately after activation

**Do NOT assume the server will auto-assign a name.** The server requires BOTH values with non-empty content.

### Active notebook — MANDATORY context for cell operations
Cell operations (insert, edit, execute, delete) work ONLY on the **currently activated notebook**. 

**ABSOLUTE WORKFLOW REQUIREMENT:**
1. Identify the file → use `jupyter_list_files` if needed
2. **ACTIVATE the notebook** → use `jupyter_use_notebook` (NEVER skip this step)
3. Inspect the structure → use `jupyter_read_notebook` when cell positions are uncertain
4. Perform cell operations → use cell tools

**VIOLATION OF THIS SEQUENCE WILL CAUSE FAILURES.** Do NOT attempt cell operations without first calling `jupyter_use_notebook`.

## Server Management Tools — MUST use for initial inspection

### `jupyter_list_files`
**PURPOSE:** List files and directories recursively in the Jupyter server's file system.

**MUST use this to:**
- Explore notebook file locations on the server
- Confirm a notebook file exists before activation
- Inspect directory structure

**Arguments (all optional but documented):**
- `path` (optional, default: `""` = root): starting directory path
- `max_depth` (optional, default: `1`, max: `3`): recursion depth
- `start_index` (optional, default: `0`): pagination start position
- `limit` (optional, default: `25`, `0` = no limit): results per page
- `pattern` (optional): glob pattern filter (e.g., `*.ipynb`)

**Returns:** Tab-separated table with EXACT columns:
- `Path` — file/directory path
- `Type` — "file", "directory", "notebook", or "error"
- `Size` — formatted as B, KB, or MB (empty for directories)
- `Last_Modified` — YYYY-MM-DD HH:MM:SS format

**Example:** Use `max_depth: 2, pattern: "*.ipynb"` to find all notebooks up to 2 levels deep.

### `jupyter_list_kernels`
**PURPOSE:** List all available and running kernels on the Jupyter server.

**MUST use this to:**
- Inspect kernel availability and state
- Check for stuck or idle kernels
- Verify kernel resources before activation
- Obtain kernel IDs for manual kernel attachment

**Arguments:** None (no parameters needed)

**Returns:** Tab-separated table with EXACT columns:
- `ID` — unique kernel identifier
- `Name` — kernel name/type (e.g., "python3", "ir")
- `Display_Name` — human-readable kernel name
- `Language` — programming language (e.g., "python", "R")
- `State` — current state: "idle", "busy", or "unknown"
- `Connections` — number of active connections
- `Last_Activity` — YYYY-MM-DD HH:MM:SS timestamp
- `Environment` — kernel environment variables (truncated if long)

### `jupyter_connect_to_jupyter`
**PURPOSE:** Connect to a different Jupyter server dynamically without restarting.

**CRITICAL AVAILABILITY NOTE:** This tool is **NOT available** when running as a Jupyter server extension. If used in extension mode, it WILL fail. Advise users to use server-side pre-configuration instead.

**Arguments (case-sensitive):**
- `jupyter_url` (**required**): Full Jupyter server URL (e.g., `http://localhost:8888`)
- `jupyter_token` (optional): Authentication token for the server
- `provider` (optional, default: `"jupyter"`): Provider type

**Use this when:**
- Switching to a different Jupyter server during the conversation
- The default server is not the target server
- Multiple Jupyter instances are available

**SECURITY NOTE:** Do NOT casually ask users to paste tokens. Only request when absolutely necessary for debugging.

### `jupyter_server_info`
**PURPOSE:** Retrieve current configuration settings for both Jupyter and MCP servers.

**MUST use this to:**
- Verify active server URLs and connection parameters
- Obtain Jupyter authentication token for URL construction
- Diagnose connection issues by inspecting effective settings
- Construct access URLs for the Jupyter Lab web interface
- Document server configuration for logging or debugging

**Arguments:** None (no parameters needed)

**Returns:** JSON object with EXACT fields:
- `jupyter_url` — the active Jupyter server URL (e.g., `http://127.0.0.1:8888`)
- `jupyterToken` — the authentication token for the Jupyter server
- `mcpUrl` — the MCP server URL (e.g., `http://127.0.0.1:4040`)
- `timeoutMs` — request timeout in milliseconds (default: 30000)

**CRITICAL: Constructing Notebook URLs**

When providing users with URLs to access notebooks, ALWAYS include the authentication token in the URL. Use this exact format:

```
{jupyter_url}/lab/tree/{notebook_path}?token={jupyterToken}
```

**Examples:**
- `http://192.168.1.196:8888/lab/tree/notebook2.ipynb?token=abc123def456`
- `http://127.0.0.1:8888/lab/tree/projects/demo.ipynb?token=xyz789uvw012`

**REQUIRED COMPONENTS:**
1. `jupyter_url` — The server URL (from jupyter_server_info)
2. `/lab/tree/` — The Jupyter Lab path (DO NOT use direct file paths)
3. `notebook_path` — The notebook file path relative to server root
4. `?token=` — Query parameter with the authentication token (from jupyter_server_info)

**Common use cases:**
- When creating or activating notebooks, always call `jupyter_server_info` first
- Share complete URLs with authentication tokens included
- If URL doesn't include the token, users will get authentication errors
- Verifying server connectivity before other operations
- Providing user-friendly documentation of current server endpoints
- Troubleshooting authentication or timeout issues

**Example workflow:**
1. Call `jupyter_create_notebook` (it automatically handles URL construction)
2. The tool returns both the resolved notebook name and complete authenticated URL
3. Provide the returned URL directly to the user

Note: `jupyter_create_notebook` internals use `jupyter_server_info` to fetch the credentials and `list_files` to detect conflicts, so users don't need to manually handle these steps.

## Notebook Management Tools — MANDATORY before all cell operations

### `jupyter_create_notebook`
**PURPOSE:** Create a new notebook with automatic filename conflict detection.

**AUTOMATIC NAMING LOGIC (when user doesn't specify name):**
1. Use `notebook_name` if provided explicitly
2. Fall back to `defaultNotebook` from plugin config if not provided
3. Fall back to `"Untitled"` if config has no default
4. **Conflict detection:** If the target filename exists, automatically append suffix:
   - First conflict: `filename-1.ipynb`
   - Second conflict: `filename-2.ipynb`
   - Continue incrementing until unique name found

**Arguments:**
- `notebook_name` (optional): Explicit notebook name to create. If not provided, uses default naming logic above.

**Returns:** Success message with:
- Resolved notebook name (accounting for any conflicts)
- Complete Jupyter Lab URL with authentication token
- Format: `{jupyter_url}/lab/tree/{notebook_name}?token={jupyterToken}`

**WORKFLOW:**
1. User requests notebook creation without or with a name
2. Tool resolves the final filename (with conflict detection)
3. Creates notebook via `jupyter_use_notebook` with `mode: "create"`
4. Returns both the resolved name AND the full working URL

**Examples:**
- User: "Create a notebook" → Creates `Untitled.ipynb` (or `Untitled-1.ipynb` if exists)
- User: "Create notebook named mywork" → Creates `mywork.ipynb` (or `mywork-1.ipynb` if exists)
- Config has `defaultNotebook: "Analysis"` → Creates `Analysis.ipynb` when no name specified

---

### `jupyter_use_notebook`
**PURPOSE:** Activate a notebook for all subsequent notebook and cell operations.

**CRITICAL:** This is the FIRST tool to call when working with any notebook. Do NOT skip this step.

**Arguments (all REQUIRED):**
- `notebook_path` (**required**): File path relative to server root (e.g., `Untitled.ipynb`, `projects/test.ipynb`)
- `notebook_name` (**required**): Unique session identifier (MUST be non-empty string; NEVER an empty string or null)
- `mode` (optional, default: `"connect"`): Either `"connect"` to connect existing or `"create"` to create new
- `kernel_id` (optional): Specific kernel ID to attach (if omitted, server assigns one)

**ABSOLUTE REQUIREMENTS:**
- BOTH `notebook_path` and `notebook_name` MUST be provided as non-empty strings
- NEVER send empty string for `notebook_name`
- ALWAYS call `jupyter_list_notebooks` immediately after to confirm activation

**Arguments breakdown:**
- For existing notebook: use `mode: "connect"`
- For new notebook: use `mode: "create"`
- When user provides only file path, pass it as both `notebook_path` and `notebook_name`

**Returns:** Success message with activation status, kernel ID, and notebook overview.

**IMMEDIATE NEXT STEP:** Call `jupyter_list_notebooks` to confirm the `notebook_name` the server assigned.

---

### `jupyter_list_notebooks`
**PURPOSE:** List all notebooks currently managed by the notebook session handler.

**CRITICAL:** Use immediately after `jupyter_use_notebook` to confirm activation and identify the active notebook.

**Arguments:** None (no parameters needed)

**Returns:** Tab-separated table with EXACT columns:
- `Name` — notebook session identifier
- `Path` — notebook file path
- `Kernel_ID` — attached kernel ID
- `Kernel_Status` — kernel status (idle, busy, dead, etc.)
- `Activate` — "✓" if currently active, empty otherwise

**Important constraint:** This tool returns ONLY notebooks already activated through `jupyter_use_notebook`. It is NOT a raw filesystem listing.

---

### `jupyter_restart_notebook`
**PURPOSE:** Restart the kernel for a specific notebook and clear memory state.

**Arguments:**
- `notebook_name` (**required**): The exact notebook identifier from `jupyter_list_notebooks`

**Use this when:**
- The kernel is stuck or unresponsive
- User needs a clean memory state
- Previous cell executions should be cleared

**Returns:** Success message confirming kernel restart and memory state cleared.

---

### `jupyter_restart_notebook_compat` (Compatibility wrapper)
**PURPOSE:** Restart notebook kernel with optional fallback to notebook_path.

**Arguments:**
- `notebook_name` (optional)
- `notebook_path` (optional)

**Use this when:** Legacy code provides only notebook_path. Prefers notebook_name; falls back to notebook_path if notebook_name is empty.

**Recommendation:** Use the strict `jupyter_restart_notebook` version instead when possible.

---

### `jupyter_unuse_notebook`
**PURPOSE:** Disconnect from a specific notebook and release all resources.

**Arguments:**
- `notebook_name` (**required**): The exact notebook identifier from `jupyter_list_notebooks`

**Use this when:**
- User is done with a notebook session
- Resources must be released
- Switching to a different notebook

**Returns:** Success message confirming disconnection and resource release.

---

### `jupyter_unuse_notebook_compat` (Compatibility wrapper)
**PURPOSE:** Unuse notebook with optional fallback to notebook_path.

**Arguments:**
- `notebook_name` (optional)
- `notebook_path` (optional)

**Use this when:** Legacy code provides only notebook_path. Prefers notebook_name; falls back to notebook_path if notebook_name is empty.

**Recommendation:** Use the strict `jupyter_unuse_notebook` version instead when possible.

---

### `jupyter_read_notebook`
**PURPOSE:** Read notebook structure and cell contents.

**CRITICAL:** Use BEFORE any cell edits to understand cell positions and structure.

**Arguments:**
- `notebook_name` (**required**): The exact notebook identifier from `jupyter_list_notebooks`
- `response_format` (optional, default: `"brief"`): 
  - `"brief"` — returns first line and line count (fast, for overview)
  - `"detailed"` — returns full cell source (slower, for editing)
- `start_index` (optional, default: `0`): pagination start index
- `limit` (optional, default: `20`, `0` = no limit): max cells to return

**RECOMMENDED WORKFLOW:**
1. First call with `response_format: "brief", limit: 50+` to get notebook structure
2. Then call with `response_format: "detailed", start_index: X, limit: 5` for specific cells

**Returns:** Notebook content with cell index, type, source, execution count, and metadata.

---

### `jupyter_read_notebook_compat` (Compatibility wrapper)
**PURPOSE:** Read notebook with optional fallback to notebook_path.

**Arguments:**
- `notebook_name` (optional)
- `notebook_path` (optional)
- `response_format` (optional, default: `"brief"`)
- `start_index` (optional, default: `0`)
- `limit` (optional, default: `20`)

**Use this when:** Legacy code provides only notebook_path. Prefers notebook_name; falls back to notebook_path if notebook_name is empty.

**Recommendation:** Use the strict `jupyter_read_notebook` version instead when possible.

## Cell Tools — ALWAYS operate on the activated notebook only

**CRITICAL CONSTRAINT:** All cell tools below operate EXCLUSIVELY on the currently activated notebook. Do NOT attempt to specify a different notebook in these tools. If the wrong notebook is active, MUST call `jupyter_use_notebook` to switch first.

### `jupyter_insert_cell`
**PURPOSE:** Insert a new cell at a specified position in the active notebook.

**Arguments (all REQUIRED):**
- `cell_index` (**required**): Target insertion position (0-based). MUST use `-1` to append at the end
- `cell_type` (**required**): MUST be exactly `"code"` or `"markdown"` (lowercase)
- `cell_source` (**required**): Complete source text for the new cell

**EXACT PARAMETER NAMES:** Use `cell_index`, `cell_type`, `cell_source` — NOT `index`, `source`, or `type`.

**Use this when:**
- Adding a new code cell at a specific position
- Adding markdown documentation or explanations
- Inserting a cell between existing cells

**Returns:** Success message with insertion confirmation and surrounding cell structure (up to 5 cells above/below).

---

### `jupyter_overwrite_cell_source`
**PURPOSE:** Replace the entire content of an existing cell.

**Arguments (all REQUIRED):**
- `cell_index` (**required**): Cell position (0-based) to overwrite
- `cell_source` (**required**): Complete new source text (replaces ALL existing content)

**Returns:** Diff-style comparison showing changes:
- Lines with `+` are added
- Lines with `-` are deleted
- Unchanged lines have no prefix

**Use this when:**
- Updating code in an existing cell
- Replacing markdown content completely
- Rewriting a cell without inserting new cells

---

### `jupyter_execute_cell`
**PURPOSE:** Execute an existing cell and return its outputs.

**Arguments:**
- `cell_index` (**required**): Cell position (0-based) to execute
- `timeout` (optional, default: `90`): Maximum execution time in seconds
- `stream` (optional, default: `false`): Enable streaming progress for long-running cells
- `progress_interval` (optional, default: `5`): Seconds between progress updates when streaming

**Returns:** List of outputs including:
- Text output
- HTML/rendered content
- Images and other media
- Error messages if execution fails

**Use this when:**
- The cell already exists and needs execution
- A newly edited cell should run immediately
- Cell outputs need refreshing

---

### `jupyter_insert_execute_code_cell`
**PURPOSE:** Insert a code cell AND execute it in one operation (preferred shortcut).

**Arguments:**
- `cell_index` (**required**): Target position (0-based). MUST use `-1` to append
- `cell_source` (**required**): Code to insert and execute
- `timeout` (optional, default: `90`): Maximum execution time in seconds

**Returns:** Both insertion confirmation AND execution results (outputs, errors).

**CRITICAL RULE:** ALWAYS use this instead of separate `insert_cell` + `execute_cell` calls when the user wants both operations. This is more efficient and saves state.

**Use this when:**
- User requests: "add this code and run it"
- Quick test code should be saved and executed immediately
- New cells should be immediately verified

---

### `jupyter_read_cell`
**PURPOSE:** Read a single specific cell with metadata and optionally outputs.

**Arguments:**
- `cell_index` (**required**): Cell position (0-based) to read
- `include_outputs` (optional, default: `true`): Include execution outputs (code cells only)

**Returns:** List containing:
- Cell metadata (index, type, execution_count)
- Full source code
- Execution outputs if `include_outputs: true` and cell is code type

**Use this when:**
- Verifying cell content before editing
- Checking outputs of a single cell
- Need exact cell details for debugging

---

### `jupyter_delete_cell`
**PURPOSE:** Delete one or more cells from the active notebook.

**Arguments:**
- `cell_indices` (**required**): Array of cell positions to delete (0-based)
- `include_source` (optional, default: `true`): Include deleted cell source in response

**CRITICAL DELETION RULE:** When deleting MULTIPLE cells, MUST delete in DESCENDING index order to avoid index shifting. Example: delete indices [5, 3, 1] in that order, NOT [1, 3, 5].

**Returns:** Success message with deletion confirmation and deleted cell source code (if requested).

**Use this when:**
- User wants to remove cells
- Cleaning up notebook structure
- Deleting failed experiments

---

### `jupyter_execute_code`
**PURPOSE:** Execute code directly in the kernel WITHOUT saving to notebook structure.

**Arguments:**
- `code` (**required**): Code to execute (supports magic and shell commands)
- `timeout` (optional, default: `30`, max: `60`): Execution timeout in seconds

**Returns:** List of outputs (text, HTML, images, shell results).

**EXPLICIT USE CASES — MUST use for these:**
- Jupyter magic commands: `%timeit`, `%pip install`, `%matplotlib inline`, etc.
- Shell commands: `!git status`, `!ls ~/projects`, etc.
- Performance profiling and debugging
- Variable inspection: `print(df.head())`, `print(type(var))`
- Quick temporary calculations: `np.mean([1,2,3])`

**EXPLICIT PROHIBITIONS — MUST NOT use for these:**
- Importing new modules or setting variables that affect subsequent notebook execution
- Dangerous code that might harm the server without explicit permission
- Replacing proper notebook edits when user explicitly wants cells modified

**Example:** `%timeit sum(range(1000))` or `!git log --oneline | head -5`

## MANDATORY Operating Rules — ALWAYS follow precisely

1. **ALWAYS identify files first** using `jupyter_list_files` when notebook path is uncertain
2. **ALWAYS call `jupyter_use_notebook` first** before ANY notebook or cell operations (no exceptions)
3. **ALWAYS verify activation** by calling `jupyter_list_notebooks` immediately after `jupyter_use_notebook`
4. **ALWAYS confirm notebook_name** from `jupyter_list_notebooks` for subsequent operations
5. **ALWAYS read notebook structure** with `jupyter_read_notebook` before cell edits when cell positions are uncertain
6. **ALWAYS use `jupyter_insert_execute_code_cell`** when user wants both insertion and execution (do not use separate calls)
7. **ALWAYS use `jupyter_execute_code`** for magic commands, shell commands, and temporary unsaved code
8. **ALWAYS delete cells in descending index order** when deleting multiple cells (prevent index shifting)
9. **ALWAYS verify cell_index is 0-based** (first cell is index 0, not 1)
10. **NEVER skip notebook activation** — cell tools require an active notebook context

## PRESCRIBED Operating Sequences — MUST follow in exact order

### Sequence 1: Inspect a notebook (START HERE for file exploration)
1. `jupyter_list_files` — Find the notebook file
2. `jupyter_use_notebook` — Activate it (REQUIRED)
3. `jupyter_list_notebooks` — Confirm activation
4. `jupyter_read_notebook` — Inspect structure and cells

### Sequence 2: Insert a new cell
1. `jupyter_use_notebook` — Ensure correct notebook is active
2. `jupyter_read_notebook` — (optional) Check where to insert
3. `jupyter_insert_cell` — Add the cell
4. `jupyter_execute_cell` — (optional) Run if needed

### Sequence 3: Modify an existing cell (SAFE approach)
1. `jupyter_use_notebook` — Activate notebook
2. `jupyter_read_notebook` — Locate exact cell index and review content
3. `jupyter_overwrite_cell_source` — Replace cell content
4. `jupyter_execute_cell` — Run the updated cell

### Sequence 4: Insert AND execute in one step (PREFERRED shortcut)
1. `jupyter_use_notebook` — Activate notebook
2. `jupyter_insert_execute_code_cell` — Insert and run immediately (better than separate calls)

### Sequence 5: Run temporary code without saving
1. `jupyter_use_notebook` — Activate notebook
2. `jupyter_execute_code` — Execute code in kernel (not saved to notebook)

### Sequence 6: Delete cells safely
1. `jupyter_use_notebook` — Activate notebook
2. `jupyter_read_notebook` — Identify exact indices to delete
3. `jupyter_delete_cell` — Delete in DESCENDING index order only

### Sequence 7: Switch Jupyter servers
1. `jupyter_connect_to_jupyter` — Connect to new server
2. `jupyter_list_files` — Verify access to files on new server
3. `jupyter_use_notebook` — Activate notebook on new server

## Troubleshooting — Diagnostic error responses

### "Field required" or schema validation error
**CAUSE:** Incorrect parameter name or missing required argument.

**COMMON MISTAKES:**
- Using `source` instead of `cell_source`
- Using `index` instead of `cell_index` or `cell_indices`
- Using `nb_name` or `notebook_id` instead of `notebook_name`
- Passing empty string for `notebook_name`
- Missing `-1` when appending (use `cell_index: -1` to append)

**SOLUTION:** Check tool documentation carefully. Use EXACT parameter names and ensure all required arguments are provided.

---

### "Notebook not found" or "Active notebook not set"
**CAUSE:** Cell operation attempted without first calling `jupyter_use_notebook`.

**DIAGNOSTIC SEQUENCE:**
1. Call `jupyter_list_notebooks` to check if any notebook is active
2. If no active notebook, MUST call `jupyter_use_notebook` first
3. Confirm with `jupyter_list_notebooks` again
4. Retry the cell operation

**SOLUTION:** Always call `jupyter_use_notebook` before cell operations.

---

### "quote_from_bytes() expected bytes" or similar backend error
**CAUSE:** Runtime failure after request reached the tool handler. Usually indicates state mismatch.

**LIKELY ISSUES:**
- Wrong notebook identifier format (invalid characters or encoding)
- Incomplete active notebook state
- Mismatch between the activated notebook and the tool being called
- Notebook file deleted or moved on server

**DIAGNOSTIC SEQUENCE:**
1. `jupyter_list_notebooks` — Verify active notebook state
2. `jupyter_list_files` — Confirm notebook file still exists
3. `jupyter_use_notebook` — Re-establish notebook session
4. `jupyter_read_notebook` — Verify notebook is readable
5. Retry the failing operation

---

### Notebook file exists but operations still fail
**DIAGNOSTIC SEQUENCE (REQUIRED):**
1. `jupyter_list_files` — Confirm file exists on disk
2. `jupyter_use_notebook` — Activate the notebook
3. `jupyter_list_notebooks` — Confirm activation and check assigned notebook_name
4. `jupyter_read_notebook` — Verify server has valid handle to notebook
5. THEN retry the operation

This separates "file exists on disk" from "server has active handle to notebook".

---

### Cell operations fail with index errors
**CHECK:**
- Is the cell index 0-based? (first cell = 0, not 1)
- Does the cell index exist? (use `jupyter_read_notebook` to list all indices)
- When deleting multiple cells, are they in DESCENDING order?

**SOLUTION:** Use `jupyter_read_notebook` to see exact cell indices.

---

## Accessing the Jupyter Server UI — MUST construct URL correctly

### Constructing the notebook URL

The complete URL format combines the server connection details with the notebook path:

```
[jupyter_url]?token=[jupyter_token]/lab/tree/[notebook_path]
```

**URL Components:**
- `[jupyter_url]`: Server IP address or hostname (from `jupyter_connect_to_jupyter` or configuration)
- `[jupyter_token]`: Authentication token (generated at startup or from `jupyter_connect_to_jupyter`)
- `[notebook_path]`: Relative path to notebook file from Jupyter root (obtained from `use_notebook` or `list_notebooks`)
- `:8888`: Default Jupyter port (adjust if configured differently)

### Example

If the server is running at `http://192.168.0.1:8888` with token `01234567-89ab-cdef-0123-456789abcdef` and the notebook is `projects/data_analysis.ipynb`:

```
http://192.168.0.1:8888?token=01234567-89ab-cdef-0123-456789abcdef/lab/tree/projects/data_analysis.ipynb
```

**Protocol Flow:**
1. Use `jupyter_list_notebooks` or `use_notebook` to obtain the notebook file path
2. Extract the Jupyter server URL and token from your configuration or connection response
3. Construct the URL using the format above
4. Share the URL or open it in a browser for visual inspection and interactive work

## CRITICAL SUMMARY — Absolute requirements for correct operation

### The Five Absolute Rules — NEVER violate these
1. **ALWAYS activate first** — NEVER attempt cell operations without calling `jupyter_use_notebook` first
2. **ALWAYS use both paths** — MUST provide BOTH `notebook_path` AND `notebook_name` to `jupyter_use_notebook` (NEVER empty)
3. **ALWAYS verify activation** — IMMEDIATELY call `jupyter_list_notebooks` after `jupyter_use_notebook` to confirm the server's assigned notebook_name
4. **ALWAYS use descending order** — MUST delete cells in DESCENDING index order to prevent index shifting errors
5. **ALWAYS follow sequences** — MUST follow the prescribed operating sequences IN ORDER

### State-Aware Design
ClawPyter is a **context-dependent operator**, not a stateless API:
- **File context** (jupyter_list_files) → informs notebook selection
- **Session context** (jupyter_use_notebook) → establishes active notebook
- **Structure context** (jupyter_read_notebook) → precedes all mutations
- **Operation context** (cell tools) → execute on active notebook only
- **Persistence context** (insert_execute_code_cell vs execute_code) → controls cell persistence

**Consequence:** Violating context sequencing WILL cause operation failures. Always follow the prescribed sequences.

