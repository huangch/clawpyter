---
name: clawpyter
description: Use ClawPyter for ALL Jupyter notebook, kernel, and file operations. RULE 1 — Before any cell operation, you MUST activate a notebook first. Use jupyter_create_notebook for a new notebook, or jupyter_use_notebook for an existing notebook. RULE 2 — notebook_path is the file path on the Jupyter server. RULE 3 — notebook_name is a label you choose; if unsure, use the same value as notebook_path.
---

# ClawPyter

## When to use this skill

Use ClawPyter for EVERY operation that involves Jupyter notebooks, kernels, or files on a Jupyter server. This includes: listing files, creating notebooks, reading or editing cells, and running code.

---

## Connecting to a Jupyter server

Before doing ANY Jupyter work, you need a running Jupyter server with a known URL and token. **You should start one yourself** using the bundled `clawpyter.sh` lifecycle script — do not ask the user to start it unless they have explicitly told you they want to manage Jupyter themselves. The lifecycle script lives at:

```
/workspace/wsinsight/clawpyter/clawpyter.sh
```

It manages BOTH backends (native `jupyter lab` on the host, or a Docker container) and records instances per-project in `<notebook_dir>/.clawpyter/instances.json`.

### Recipe — start a Jupyter server

When the user asks to do notebook work, identify the project directory first (the one containing the `.ipynb` files the user wants to work with; if not stated, ask). Then:

**Step 1 — check if a server is already running on that directory:**

```bash
bash /workspace/wsinsight/clawpyter/clawpyter.sh status -d <notebook_dir>
```

If it prints a row for a live instance, skip to "connect" below.

**Step 2 — choose a backend:**

- If `docker` CLI is on PATH AND `docker info` works → use `-b docker`
- Else if `jupyter` is on AND `jupyter server extension list | grep -q jupyter_server_ydoc` → use `-b native` (the conda env must have `jupyter-collaboration` installed; if not, run `bash /workspace/wsinsight/clawpyter/conda-setup.sh <env>` first). The OpenClaw plugin needs the optional `yjs` runtime dep for the CRDT path; without `yjs` the plugin still loads and silently falls back to Contents-API.
- Otherwise, ask the user which backend they want.

**Step 3 — start the server (auto-picks free port starting at 8888; auto-generates a token):**

```bash
bash /workspace/wsinsight/clawpyter/clawpyter.sh start -b <native|docker> -d <notebook_dir>
```

The script prints two critical lines:

```
ClawPyter (docker) running on port 8888 (container abc123)
  URL:   http://127.0.0.1:8888/?token=<TOKEN>
  AI:    Connect to Jupyter at http://127.0.0.1:8888 with token <TOKEN>
  Log:   /path/to/.clawpyter/8888.log
```

**Step 4 — connect to it.** Call `jupyter_connect_to_jupyter` with the URL and token from the `AI:` line above.

### Recipe — stop a Jupyter server

When the user is done (or asks to stop / shut down / clean up):

```bash
bash /workspace/wsinsight/clawpyter/clawpyter.sh stop -b <backend> -d <notebook_dir>
```

### Recipe — what to do if you can't reach Jupyter

- **`Connection refused`** — server not running or port changed. Re-run `clawpyter.sh status -d <dir>`; if no live instance, start one.
- **`port 8888 already in use`** — `clawpyter.sh start` auto-picks the next free port (8889, 8890, ...). Read the actual port from stdout.
- **`Error: 'jupyter' is not on PATH`** — for native backend, the conda env was not activated. Tell the user to activate the env, or pick `-b docker` instead.
- **`Error: docker daemon is unreachable`** — for docker backend, the daemon is down. Fall back to `-b native` if available.

### Decision tree (when in doubt)

1. Do you already have a URL and token from this conversation? → call `jupyter_connect_to_jupyter` with them. → done.
2. Did you already start a Jupyter server for this `<notebook_dir>` in this session via `clawpyter.sh start`? → read `instances.json` at `<notebook_dir>/.clawpyter/instances.json` for the URL+token. → done.
3. Otherwise → run the recipe above (`status` → `start` → `connect_to_jupyter`).
4. Last resort: ask the user for the URL and token. (Only do this if Step 3 keeps failing — usually Docker isn't set up, or you don't have permission.)

---

## Available tools

There are 36 tools in five categories.

| Category | Needs an active notebook? | Tools |
|---|---|---|
| 1 — Server | no | 5 (added `jupyter_list_kernelspecs`) |
| 2 — Notebook session | no (these are what activate one) | 6 + 3 `_compat` wrappers = 9 |
| 3 — Cell | **yes** | 11 (added `jupyter_edit_cell_source`, `jupyter_clear_cell_outputs`, `jupyter_clear_cell_output` singular, `jupyter_move_cell`, `jupyter_interrupt_cell`) |
| 4 — File & server-wide operations | no | 8 (`jupyter_nbconvert`, `_upload_file`, `_save_file`, `_mkdir`, `_delete_file`, `_rename_file`, `_copy_file`) |
| 5 — Async execution control | no | 3 (`jupyter_get_job_result`, `jupyter_list_jobs`, `jupyter_cancel_job`) — see [Async execution](#async-execution-run_async) |

**Category 1 — Server tools (5 tools)**
These tools do not require an active notebook. Use them to inspect the server.
- `jupyter_list_files` — list files on the server
- `jupyter_list_kernels` — list running kernels
- `jupyter_list_kernelspecs` — list available kernel types (`python3`, `ir`, `julia-1.10`, …); use to pick `kernel_id` for `jupyter_use_notebook`
- `jupyter_connect_to_jupyter` — switch to a different Jupyter server
- `jupyter_server_info` — show the current server URL and token

**Category 2 — Notebook tools (6 tools + 3 compatibility wrappers = 9 tools)**
These tools manage notebook sessions. You must use one of these before doing any cell operations.
- `jupyter_create_notebook` — create a new notebook (also activates it automatically)
- `jupyter_use_notebook` — open and activate an existing notebook
- `jupyter_list_notebooks` — list all notebooks currently open in this session
- `jupyter_restart_notebook` — restart the kernel for an open notebook
- `jupyter_restart_notebook_compat` — same as above, but accepts either argument name
- `jupyter_unuse_notebook` — close a notebook and free its resources
- `jupyter_unuse_notebook_compat` — same as above, but accepts either argument name
- `jupyter_read_notebook` — read cell contents of an open notebook
- `jupyter_read_notebook_compat` — same as above, but accepts either argument name

**Category 3 — Cell tools (11 tools)**
These tools REQUIRE an active notebook. They will fail if no notebook is activated.
- `jupyter_insert_cell` — add a new cell at a position
- `jupyter_overwrite_cell_source` — replace the content of an existing cell
- `jupyter_edit_cell_source` — find-and-replace inside one cell's source (surgical edits)
- `jupyter_clear_cell_outputs` — drop stdout / image / execution_count without removing cells (accepts a list of `cell_indices`; empty clears all code cells)
- `jupyter_clear_cell_output` — jmcp-compatible singular: clear one cell by `cell_index` OR `cell_id` (no list)
- `jupyter_move_cell` — relocate one cell to a new index (uses `target_index`; `destination_index` accepted as a legacy alias)
- `jupyter_execute_cell` — run an existing cell and save its output (supports `run_async=true`)
- `jupyter_interrupt_cell` — SIGINT a running cell without restarting the kernel
- `jupyter_insert_execute_code_cell` — add a new code cell and run it immediately
- `jupyter_read_cell` — read one cell's content and outputs
- `jupyter_delete_cell` — delete one or more cells
- `jupyter_execute_code` — run code directly in the kernel (output NOT saved to notebook; supports `run_async=true`)

**Category 5 — Async execution control (3 tools) — companion to `run_async=true`.** Do not need an active notebook.
- `jupyter_get_job_result` — poll / wait for a fire-and-forget execute. `wait=true` blocks up to `timeout_ms` server-side; defaults to a single read.
- `jupyter_list_jobs` — enumerate every job (optionally filtered by status: `queued | running | succeeded | failed | cancelled`).
- `jupyter_cancel_job` — interrupt the kernel of a running job; the job's status becomes `cancelled` once the WebSocket closes; outputs collected so far are preserved.

**Category 4 — File & server-wide tools (8 tools)** — close the remaining REST-API surface (notebook conversion, generic file ops). Do not need an active notebook.
- `jupyter_nbconvert` — convert a notebook to HTML / Python / MarkDown / PDF / RST / LaTeX / AsciiDoc / `script`
- `jupyter_upload_file` — PUT text or base64 content at an arbitrary server path
- `jupyter_save_file` — text-friendly alias of `jupyter_upload_file`
- `jupyter_mkdir` — create a directory
- `jupyter_delete_file` — `DELETE /api/contents/<path>` (files OR directories)
- `jupyter_rename_file` — `PATCH /api/contents/<old>` (preserves sibling mtimes)
- `jupyter_copy_file` — server-side copy (faster than upload-then-download)

---

## Two arguments you will use in almost every tool

### `notebook_path`

`notebook_path` is the path to the notebook file on the Jupyter server, starting from the server's root folder.

Examples:
- `notes.ipynb` — a file in the server root folder
- `projects/demo/analysis.ipynb` — a file in a subfolder

Use this to identify which file you are working with.

### `notebook_name`

`notebook_name` is a short label YOU choose to identify the notebook inside ClawPyter. ClawPyter uses it to track open notebooks. The Jupyter server never sees this value.

Rules for `notebook_name`:
- Do NOT pass an empty string. If you have no specific label in mind, set `notebook_name` to the same string value as `notebook_path`.
- Example: if `notebook_path` is `demo.ipynb`, set `notebook_name` to `demo.ipynb` as well.
- Once you assign a `notebook_name`, use the same value every time you refer to that notebook.

---
## Addressing cells: `cell_index` vs `cell_id`

Five tools (`jupyter_overwrite_cell_source`, `jupyter_read_cell`, `jupyter_edit_cell_source`, `jupyter_execute_cell`, `jupyter_clear_cell_output`) accept either:

- `cell_index` — 0-based positional index. Fast to write, but any insertion above the target silently shifts it.
- `cell_id` — `nbformat 4.5` stable `id` string. Safe under concurrent edits. **`cell_id` wins when both are supplied.**

Default to `cell_id` whenever the notebook has been edited by anyone else (human, agent, or another model). Drop back to `cell_index` for trivial single-author loops if it saves typing.

## Multi-notebook addressing: cell tools accept `notebook_name`

Cell tools default to the *currently active* notebook (set by `jupyter_use_notebook` / `jupyter_create_notebook`). To target a different notebook that is already open in this session, pass an optional `notebook_name` argument:

- `jupyter_overwrite_cell_source(notebook_name="analysis.ipynb", cell_id="abc123", cell_source="…")`
- `jupyter_execute_cell(notebook_name="scratch.ipynb", cell_index=2, run_async=true)`
- `jupyter_read_cell(notebook_name="scratch.ipynb", cell_id="…")` — switches silently if `notebook_name` resolves; otherwise falls back to current.

If the supplied `notebook_name` is not known to ClawPyter, the tool returns an explicit "Unknown notebook_name" error rather than silently mutating the current notebook.

---
## MANDATORY RULE: You must activate a notebook before using any cell tool

Cell tools (Category 3) operate on the currently active notebook. If no notebook is active, every cell tool will return an error.

**How to activate a notebook — pick ONE of the two cases below:**

**Case A — You are creating a new notebook:**
Call `jupyter_create_notebook`. It creates the file AND activates it automatically.
Do NOT call `jupyter_use_notebook` afterwards. The notebook is already active.

**Case B — You are opening an existing notebook:**
Call `jupyter_use_notebook`. This opens the file and activates it.

After activation, call `jupyter_list_notebooks` to confirm the notebook is active.

---

## Async execution (`run_async`)

The standard execute tools (`jupyter_execute_code`, `jupyter_execute_cell`) **block the agent session** until the kernel replies — a 30 min cell means 30 min of dead-air. To avoid this, every execute tool accepts a `run_async=true` flag.

When `run_async=true` the tool:
1. Sends the `execute_request` to the kernel over WebSocket.
2. Returns immediately with:

   ```
   Job queued: job-1725600000000-abc12345
   notebook: /workspace/notes.ipynb
   kernel:  3a1b...

   Poll: jupyter_get_job_result(job_id="job-1725600000000-abc12345", wait=true)
   ```

3. Buffers stdout / stderr / display_data / error chunks in a module-level
   job registry (30-minute TTL after completion).
4. Once the kernel returns `execute_reply`, the job is marked
   `succeeded` / `failed`, outputs are written back to the cell (cell path),
   and the `jupyter_get_job_result` tool can serve the buffered chunks.

Three companion tools drive the registry:

- `jupyter_get_job_result(job_id, wait=false, timeout_ms=15000)` — read once or
  block up to `timeout_ms` waiting for terminal status.
- `jupyter_list_jobs(status_filter=...)` — enumerate; useful for dashboards
  and "what's still running" reconciliation.
- `jupyter_cancel_job(job_id)` — SIGINT the kernel; the WebSocket closes,
  the job transitions to `cancelled`, and outputs already buffered are
  preserved on the job record.

Cancelled jobs are first-class: unlike a plain timeout (which used to lose
all output), `cancelled` retains everything streamed so far and is surfaced
by `jupyter_list_jobs`.

---

## Co-editing with a human

If the Jupyter server has `jupyter-collaboration` installed (and the
optional `yjs` dependency is present in the OpenClaw plugin runtime),
ClawPyter opens a shared Y.js CRDT room for each notebook you activate.
Practical consequences:

- A human watching the notebook in JupyterLab sees your edits land cell-by-cell
  in real time. Likewise, **the user may edit the same notebook while you are
  working** — your next `jupyter_read_notebook` or `jupyter_read_cell` will see
  their latest edits without you having to refetch the file.
- Therefore: when the user mentions they "just changed something," do not
  blindly overwrite — call `jupyter_read_notebook` or `jupyter_read_cell` first
  and merge intelligently.
- If the server does not have `jupyter-collaboration`, ClawPyter silently falls
  back to whole-notebook PUTs. In that mode, the user should not edit the
  notebook in their browser while you are working — last writer wins. When in
  doubt, see the server URL+token returned by `jupyter_server_info` for the
  active connection's effective mode. Servers created by ClawPyter's own
  tooling (the `/workspace/wsinsight/clawpyter/clawpyter.sh` lifecycle
  script, or the `huangchtw/clawpyter` Docker image) always have
  `jupyter_server_ydoc` loaded, so REST mode normally means you were pointed
  at a foreign Jupyter server.

The plugin ships a `collabMode` config knob (`"auto"`/`"on"`/`"off"`) that
matches the Hermes-side `JUPYTER_COLLAB_MODE` env var. `"auto"` is the
default: probe once, then prefer CRDT when reachable.

---

## Compatibility wrappers (`_compat` tools)

Three tools have a `_compat` version: `jupyter_restart_notebook_compat`, `jupyter_unuse_notebook_compat`, and `jupyter_read_notebook_compat`.

**When to use the `_compat` version:** Use it when you are unsure whether to supply `notebook_name` or `notebook_path`. The `_compat` version accepts either — it will use `notebook_name` if you provide it, and fall back to `notebook_path` otherwise.

**When to use the regular version:** Use the regular version when you already know the `notebook_name` from `jupyter_list_notebooks`. The regular version requires only `notebook_name`.

---

## Tool reference

### `jupyter_list_files`

Lists files on the Jupyter server.

Arguments:
- `path` (optional, default `""`): folder to start listing from. Empty string means the root folder.
- `max_depth` (optional, default `1`, maximum `3`): how many folder levels deep to look. `1` means only the top folder. `2` means the top folder and one level of subfolders.
- `start_index` (optional, default `0`): skip this many results before returning. Use for pagination.
- `limit` (optional, default `25`): maximum number of results to return. Set to `0` to return all results.
- `pattern` (optional): filename filter using wildcard characters. Example: `*.ipynb` returns only notebook files.

Returns a table with four columns:
- `Path` — full path to the file or folder
- `Type` — one of: `"file"`, `"directory"`, `"notebook"`
- `Size` — file size in B, KB, or MB. Empty for directories.
- `Last_Modified` — date and time in YYYY-MM-DD HH:MM:SS format

---

### `jupyter_list_kernels`

Lists all kernels currently running on the Jupyter server.

Arguments: none

Returns a table with eight columns:
- `ID` — unique identifier for this kernel
- `Name` — kernel type name (example: `python3`)
- `Display_Name` — human-readable kernel name (example: `Python 3`)
- `Language` — programming language (example: `python`)
- `State` — current state: `"idle"`, `"busy"`, or `"unknown"`
- `Connections` — number of clients connected to this kernel
- `Last_Activity` — date and time in YYYY-MM-DD HH:MM:SS format
- `Environment` — kernel environment variables, truncated to 100 characters

---

### `jupyter_connect_to_jupyter`

Switches ClawPyter to connect to a different Jupyter server. Use this when the server URL or token has changed, or when you need to work with a different machine.

Arguments:
- `jupyter_url` (**required**): full URL of the Jupyter server, for example `http://localhost:8888`
- `jupyter_token` (optional): authentication token for the new server
- `provider` (optional): a text label for the server type. This value is not used by ClawPyter — it is for your reference only.

Returns: a message confirming the new server URL.

SECURITY NOTE: The token is a credential — do not log or display it unnecessarily. However, you MUST ask the user for it if you do not already have it. Never attempt to connect without a token.

---

### `jupyter_server_info`

Returns the URL and token that ClawPyter is currently using to connect to Jupyter.

Arguments: none

Returns a JSON object with exactly two fields:
- `jupyter_url` — the current server URL (example: `http://127.0.0.1:8888`)
- `jupyter_token` — the current authentication token

**How to build a link to a notebook for the user:**
Use this exact URL format:
```
{jupyter_url}/lab/tree/{notebook_path}?token={jupyter_token}
```
Example: `http://127.0.0.1:8888/lab/tree/demo.ipynb?token=abc123`

Note: `jupyter_create_notebook` already builds and returns this URL automatically. Only call `jupyter_server_info` if you need to build the URL yourself.

---

### `jupyter_create_notebook`

Creates a new notebook file on the server. Also starts a kernel and activates the notebook as the current notebook.

After this tool succeeds, do NOT call `jupyter_use_notebook`. The notebook is already active.

Arguments:
- `notebook_name` (optional): the filename to use for the new notebook. If you include `.ipynb` it is used as-is. If you do not include `.ipynb`, it is added automatically.

If you do not provide `notebook_name`, the tool uses:
1. The `defaultNotebook` value from the plugin configuration, if one is set.
2. Otherwise the name `"Untitled"`.

If the chosen filename already exists, the tool adds a number suffix automatically:
- `demo.ipynb` exists → tries `demo-1.ipynb`
- `demo-1.ipynb` also exists → tries `demo-2.ipynb`
- Continues until it finds a name that does not exist.

Returns: a message with the final filename and a URL to open the notebook.

---

### `jupyter_use_notebook`

Opens an existing notebook and activates it as the current notebook. Call this before using any cell tool on an existing notebook.

Do NOT call this tool after `jupyter_create_notebook`. The notebook is already active.

Arguments:
- `notebook_path` (**required**): path to the notebook file on the server (example: `demo.ipynb`)
- `notebook_name` (**required**): the label you are assigning to this notebook in ClawPyter. If you have no specific label, use the same value as `notebook_path`.
- `mode` (optional, default `"connect"`):
  - `"connect"` — open an existing file. Use this in almost all cases.
  - `"create"` — create the file if it does not exist, then connect.
- `kernel_id` (optional): attach a specific kernel by its ID. If not provided, the server picks a kernel automatically.

Returns: a message with the activation status, the kernel ID, and a brief overview of the first 20 cells.

Special cases the tool handles automatically:
- If the notebook is already active with the same name and path, the tool returns immediately. Do not call it again.
- If `mode` is `"create"` but the notebook was already created, the tool returns immediately. Do not call it again.
- If `notebook_path` does not match the path stored for that `notebook_name`, the tool returns an error message.

---

### `jupyter_list_notebooks`

Lists all notebooks that are currently open in this ClawPyter session.

Arguments: none

Returns a table with five columns:
- `Name` — the `notebook_name` label
- `Path` — the `notebook_path` value
- `Kernel_ID` — the kernel attached to this notebook
- `Kernel_Status` — always shows `"unknown"` (live kernel status is not fetched by this tool)
- `Activate` — shows `✓` for the notebook that is currently active

Use this tool to: confirm which notebook is active, look up a notebook's `kernel_id`, and verify that activation succeeded.

---

### `jupyter_restart_notebook`

Restarts the kernel for a notebook. This clears all variables and state in the kernel.

Arguments:
- `notebook_name` (**required**): the label for the notebook, as shown in `jupyter_list_notebooks`

Returns: a message confirming the kernel was restarted.

---

### `jupyter_restart_notebook_compat`

Same function as `jupyter_restart_notebook`. Use this version when you are not sure whether to use `notebook_name` or `notebook_path`.

Arguments (provide at least one):
- `notebook_name` (optional)
- `notebook_path` (optional)

The tool uses `notebook_name` if you provide it. If `notebook_name` is missing or empty, it uses `notebook_path` instead.

---

### `jupyter_unuse_notebook`

Closes a notebook and deletes its session on the Jupyter server. The notebook file is not deleted — only the active session is ended.

Arguments:
- `notebook_name` (**required**): the label for the notebook, as shown in `jupyter_list_notebooks`

Returns: a message confirming the session was closed.

---

### `jupyter_unuse_notebook_compat`

Same function as `jupyter_unuse_notebook`. Use this version when you are not sure whether to use `notebook_name` or `notebook_path`.

Arguments (provide at least one):
- `notebook_name` (optional)
- `notebook_path` (optional)

The tool uses `notebook_name` if you provide it. If `notebook_name` is missing or empty, it uses `notebook_path` instead.

---

### `jupyter_read_notebook`

Reads the contents of an open notebook. The notebook must be open (activated via `jupyter_use_notebook` or created via `jupyter_create_notebook`).

Arguments:
- `notebook_name` (**required**): the label for the notebook
- `response_format` (optional, default `"brief"`):
  - `"brief"` — shows the first line and total line count of each cell. Use this for a quick overview.
  - `"detailed"` — shows the full source of each cell. Use this when you need to read the exact code.
- `start_index` (optional, default `0`): index of the first cell to return. Cell numbering starts at `0`.
- `limit` (optional, default `20`): number of cells to return. Set to `0` to return all cells.

Returns: the total cell count, followed by the cell listing.

Recommended steps: first call with `response_format: "brief"` and a large `limit` to see the full structure. Then call with `response_format: "detailed"` and a small `start_index` + `limit` to read specific cells.

---

### `jupyter_read_notebook_compat`

Same function as `jupyter_read_notebook`. Use this version when you are not sure whether to use `notebook_name` or `notebook_path`.

Arguments (provide at least one of the first two):
- `notebook_name` (optional)
- `notebook_path` (optional)
- `response_format` (optional)
- `start_index` (optional)
- `limit` (optional)

---

### `jupyter_insert_cell`

Inserts a new cell into the active notebook at the position you specify. Requires an active notebook.

Arguments:
- `cell_index` (**required**, integer): position where the new cell will be inserted. Cell numbering starts at `0`. Use `-1` to append the cell at the end.
- `cell_type` (**required**): `"code"` for a code cell, or `"markdown"` for a text/documentation cell.
- `cell_source` (**required**): the content of the new cell.

Returns: a message confirming the insertion, and a brief listing of the cells around the new cell (up to 5 above and 5 below).

---

### `jupyter_overwrite_cell_source`

Replaces the content of an existing cell in the active notebook. Requires an active notebook. For code cells, this also clears all previous outputs and resets the execution count.

Arguments:
- `cell_index` (**required**, integer ≥ 0): 0-based index of the cell to overwrite.
- `cell_source` (**required**): the new content to write into the cell. This replaces ALL existing content in the cell.

Returns: a diff showing what was removed (`-` lines) and what was added (`+` lines).

---

### `jupyter_execute_cell`

Runs an existing code cell and saves the outputs to the notebook file. The cell must already exist in the active notebook. Requires an active notebook.

Arguments:
- `cell_index` (**required**, integer ≥ 0): 0-based index of the cell to run.
- `timeout` (optional, default `90`): maximum seconds to wait for the cell to finish. If the cell takes longer, execution stops and an error is returned.
- `stream` (optional, default `false`): set to `true` to receive progress updates while the cell is running. Useful for long-running cells.
- `progress_interval` (optional, default `5`): when `stream` is `true`, how many seconds between progress updates.

Returns: all outputs produced by the cell (text, HTML, images).

Image MIME payloads (`image/png`, `image/jpeg`, `image/gif`, `image/svg+xml`)
are surfaced as inline `data:` URI markdown blocks the host UI can render
directly, and the cell itself stores the same image so JupyterLab re-renders
it on next load. A 256 KB inline budget applies; payloads above the budget
return a `[IMAGE: <mime> truncated]` marker instead of dropping silently —
save oversized figures to disk and reference them by path.

Note: if the cell is a markdown cell (not a code cell), this tool returns an error.

---

### `jupyter_insert_execute_code_cell`

Inserts a new code cell at the position you specify, then runs it immediately. This tool does both steps in one call. Use this instead of calling `jupyter_insert_cell` followed by `jupyter_execute_cell`. Requires an active notebook.

Arguments:
- `cell_index` (**required**, integer): position where the new cell will be inserted. Use `-1` to append at the end. Cell numbering starts at `0`.
- `cell_source` (**required**): the code to insert and run.
- `timeout` (optional, default `90`): maximum seconds to wait for the code to finish.

Returns: a message confirming the insertion, followed by all execution outputs.

Image MIME payloads (`image/png`, `image/jpeg`, `image/gif`, `image/svg+xml`)
are surfaced as inline `data:` URI markdown blocks the host UI can render
directly, and the inserted cell stores the same image so JupyterLab
re-renders it on next load.

---

### `jupyter_read_cell`

Reads the content and outputs of a single cell in the active notebook. Requires an active notebook.

Arguments:
- `cell_index` (**required**, integer ≥ 0): 0-based index of the cell to read.
- `include_outputs` (optional, default `true`): set to `false` to skip outputs. Outputs are only returned for code cells.

Returns: the cell's index, type, execution count, source text, and (if `include_outputs` is `true`) its outputs.

---

### `jupyter_delete_cell`

Deletes one or more cells from the active notebook. Requires an active notebook.

Arguments:
- `cell_indices` (**required**): a list of 0-based cell indices to delete. Example: `[0, 2, 5]`.
- `include_source` (optional, default `true`): set to `false` to skip returning the deleted cell content.

Returns: the number of cells deleted, and (if `include_source` is `true`) the source text of each deleted cell.

IMPORTANT: You do NOT need to sort the indices. The tool automatically processes indices from largest to smallest to prevent index shifting.

---

### `jupyter_execute_code`

Runs code directly in the active kernel. The code runs, but it is NOT inserted into the notebook and outputs are NOT saved to the notebook file. Requires an active notebook.

Use this tool for:
- Running a quick check or inspection (example: print a variable value)
- Installing packages: `%pip install pandas`
- Timing code: `%timeit my_function()`
- Shell commands: `!ls -la`

Do NOT use this tool for:
- Code that defines variables or imports that other cells will depend on. That code will not be saved to the notebook. Use `jupyter_insert_execute_code_cell` instead.

Arguments:
- `code` (**required**): the code to run.
- `timeout` (optional, default `30`, maximum `60`): maximum seconds to wait. Cannot exceed 60 seconds.

Returns: all execution outputs.

Image MIME payloads (`image/png`, `image/jpeg`, `image/gif`, `image/svg+xml`)
are surfaced as inline `data:` URI markdown blocks the host UI can render
directly. (Unlike `jupyter_execute_cell`, this tool does not write back into
the cell — it runs in the kernel only.) A 256 KB inline budget applies;
payloads above the budget return a `[IMAGE: <mime> truncated]` marker.

The fire-and-forget async path (`run_async=true`) also preserves inline
images: each OutputChunk carries the raw bytes on its `image` field, and
`jupyter_get_job_result` re-emits them as `data:` URI blocks along with the
text.

---

## Step-by-step workflows

### Workflow A: Open an existing notebook and edit a cell

1. Call `jupyter_list_files` to confirm the notebook file exists. Note its path.
2. Call `jupyter_use_notebook` with `notebook_path` set to that path, and `notebook_name` set to the same value.
3. Call `jupyter_list_notebooks` to confirm the notebook is now active.
4. Call `jupyter_read_notebook` with `response_format: "brief"` to see the cell structure.
5. Call `jupyter_overwrite_cell_source` (to replace a cell) or `jupyter_insert_cell` (to add a cell).
6. Call `jupyter_execute_cell` to run the changed cell.

### Workflow B: Create a new notebook and run code

1. Call `jupyter_create_notebook` with the desired filename. The notebook is now active.
2. Call `jupyter_insert_execute_code_cell` to add code and run it in one step.

### Workflow C: Switch to a different notebook

1. Call `jupyter_list_notebooks` to see all open notebooks and find the one you want.
2. Call `jupyter_use_notebook` with the target `notebook_path` and `notebook_name`. If it is already tracked, ClawPyter switches to it immediately.

---

## Mistakes to avoid

| Mistake | What happens | Correct action |
|---|---|---|
| Calling any cell tool before activating a notebook | Error: "No active notebook" | Always call `jupyter_use_notebook` or `jupyter_create_notebook` first |
| Calling `jupyter_use_notebook` after `jupyter_create_notebook` | Tool returns "already activated" and stops | Do not call `jupyter_use_notebook` after `jupyter_create_notebook` — the notebook is already active |
| Passing an empty string for `notebook_name` | ClawPyter uses `notebook_path` as the name instead, which may create duplicate sessions | Always pass a non-empty value for `notebook_name`. When unsure, use the same value as `notebook_path` |
| Using `jupyter_execute_code` to set up variables for later cells | The variables exist in the kernel but are not saved in the notebook | Use `jupyter_insert_execute_code_cell` so the code is saved in the notebook |
| Passing cell indices to `jupyter_delete_cell` in ascending order and expecting correct results | Not a problem — the tool handles ordering automatically | Pass all indices you want to delete in a single call; order does not matter |
| Calling any tool before the URL and token are set | The call fails, or silently hits the wrong server | Ask the user for the URL and token, then `jupyter_connect_to_jupyter` |
| Letting a long cell hit the default 90 s timeout | Execution stops and an error is returned; the kernel may still be busy | Raise `timeout` on `jupyter_execute_cell`, and set `stream: true` to watch progress |
| Using `jupyter_execute_code` for something slow | It caps at 60 s and cannot be raised | Put the code in a cell and use `jupyter_execute_cell` with a larger `timeout` |
| Overwriting a cell the user just edited | Their change is lost | Read the cell first (`jupyter_read_cell`) and merge |
