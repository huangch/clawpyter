---
name: clawpyter
description: Use ClawPyter for ALL Jupyter notebook, kernel, and file operations. RULE 1 — Before any cell operation, you MUST activate a notebook first. Use jupyter_create_notebook for a new notebook, or jupyter_use_notebook for an existing notebook. RULE 2 — notebook_path is the file path on the Jupyter server. RULE 3 — notebook_name is a label you choose; if unsure, use the same value as notebook_path.
---

# ClawPyter

## When to use this skill

Use ClawPyter for EVERY operation that involves Jupyter notebooks, kernels, or files on a Jupyter server. This includes: listing files, creating notebooks, reading or editing cells, and running code.

---

## Available tools

There are 17 tools in three categories.

**Category 1 — Server tools (4 tools)**
These tools do not require an active notebook. Use them to inspect the server.
- `jupyter_list_files` — list files on the server
- `jupyter_list_kernels` — list running kernels
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

**Category 3 — Cell tools (7 tools)**
These tools REQUIRE an active notebook. They will fail if no notebook is activated.
- `jupyter_insert_cell` — add a new cell at a position
- `jupyter_overwrite_cell_source` — replace the content of an existing cell
- `jupyter_execute_cell` — run an existing cell and save its output
- `jupyter_insert_execute_code_cell` — add a new code cell and run it immediately
- `jupyter_read_cell` — read one cell's content and outputs
- `jupyter_delete_cell` — delete one or more cells
- `jupyter_execute_code` — run code directly in the kernel (output NOT saved to notebook)

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

SECURITY RULE: Do not ask the user for their Jupyter token unless it is strictly required. Tokens are credentials.

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

Note: if the cell is a markdown cell (not a code cell), this tool returns an error.

---

### `jupyter_insert_execute_code_cell`

Inserts a new code cell at the position you specify, then runs it immediately. This tool does both steps in one call. Use this instead of calling `jupyter_insert_cell` followed by `jupyter_execute_cell`. Requires an active notebook.

Arguments:
- `cell_index` (**required**, integer): position where the new cell will be inserted. Use `-1` to append at the end. Cell numbering starts at `0`.
- `cell_source` (**required**): the code to insert and run.
- `timeout` (optional, default `90`): maximum seconds to wait for the code to finish.

Returns: a message confirming the insertion, followed by all execution outputs.

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
