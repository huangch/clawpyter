---
name: ClawPyter
description: Use ClawPyter for Jupyter notebook, kernel, and file operations. Activate a notebook before cell operations, use notebook_path as the file path, use notebook_name as the active notebook identifier, and follow each tool's exact argument rules.
---

# ClawPyter

## When to use this skill

Use ClawPyter whenever the user wants to work with Jupyter notebooks, kernels, notebook files, or live code execution in a Jupyter environment.

ClawPyter supports three groups of operations (15 tools total), matching the upstream Jupyter MCP Server categorization:

- **Server Management** (3 tools)
  - `jupyter_list_files`
  - `jupyter_list_kernels`
  - `jupyter_connect_to_jupyter`
- **Multi-Notebook** (5 tools)
  - `jupyter_use_notebook`
  - `jupyter_list_notebooks`
  - `jupyter_restart_notebook`
  - `jupyter_unuse_notebook`
  - `jupyter_read_notebook`
- **Cell Tools** (7 tools)
  - `jupyter_insert_cell`
  - `jupyter_overwrite_cell_source`
  - `jupyter_execute_cell`
  - `jupyter_insert_execute_code_cell`
  - `jupyter_read_cell`
  - `jupyter_delete_cell`
  - `jupyter_execute_code`

## Core mental model

### `notebook_path`
`notebook_path` is the notebook file path, relative to the Jupyter server root, such as:

- `Untitled.ipynb`
- `projects/demo/test.ipynb`

Use this when identifying a notebook file on disk.

### `notebook_name`
`notebook_name` is the unique session identifier used by the notebook manager to track an active notebook. It is **required** by the upstream server alongside `notebook_path` when calling `jupyter_use_notebook`.

When the caller does not supply an explicit `notebook_name`, this wrapper automatically uses `notebook_path` as the identifier. Do **not** leave `notebook_name` empty or assume it is optional — an empty string will cause the server to reject or mistrack the session.

Do **not** ask the user to guess `notebook_name` unless troubleshooting requires it. After activation, use `jupyter_list_notebooks` to confirm the identifier the server assigned.

### Active notebook
Most cell operations work on the **currently activated notebook**.
That means the safe default workflow is:

1. locate the file
2. activate the notebook
3. inspect the notebook
4. perform cell operations

## Recommended workflow

When the user refers to a notebook file:

1. Use `jupyter_list_files` if needed to confirm the file exists.
2. Use `jupyter_use_notebook` to activate the notebook.
3. Use `jupyter_read_notebook` to inspect current cells when relevant.
4. Only then use cell-level tools.

Do **not** jump directly to cell operations unless you already know the correct notebook is active.

## Server management tools

### `jupyter_list_files`
List files and directories recursively in the Jupyter-visible filesystem.

Use it to:
- explore notebook locations
- confirm a notebook file exists
- inspect directories before activating a notebook

Arguments:
- `path` (optional): starting path, default `""`
- `max_depth` (optional): recursion depth, default `1`, max `3`
- `start_index` (optional): pagination start, default `0`
- `limit` (optional): page size, default `25`, `0` means no limit
- `pattern` (optional): glob filter

Returns a tab-separated table with:
- `Path`
- `Type`
- `Size`
- `Last_Modified`

### `jupyter_list_kernels`
List available and running kernels.

Use it to:
- inspect kernel state
- check active connections
- troubleshoot kernel availability

Returns a tab-separated table with:
- `ID`
- `Name`
- `Display_Name`
- `Language`
- `State`
- `Connections`
- `Last_Activity`
- `Environment`

### `jupyter_connect_to_jupyter`
Connect to a different Jupyter server dynamically.

Arguments:
- `jupyter_url`
- `jupyter_token` (optional)
- `provider` (optional, default `"jupyter"`)

Use this when:
- switching to another Jupyter server during the same conversation
- the current server is not the one the user wants

**Availability note:** This tool is **not available** when the MCP server is running as a Jupyter server extension. In that deployment mode, connection details must be pre-configured on the server side. If the user is running the extension variant and calls this tool, it will fail — advise them to use server-side configuration instead.

Do **not** casually ask the user to paste tokens unless necessary.

## Multi-Notebook tools

### `jupyter_use_notebook`
Activate a notebook for later notebook and cell operations.

Arguments:
- `notebook_path` (**required**): notebook file path relative to the server root
- `notebook_name` (**required** by upstream server): unique session identifier for the notebook. When not explicitly provided, this wrapper uses `notebook_path` as the value. Do **not** send an empty string — the upstream server requires a non-empty identifier.
- `mode` (optional): `"connect"` or `"create"`, default `"connect"`
- `kernel_id` (optional): specific kernel to use

Important:
- This is usually the **first notebook-specific tool** to call.
- Both `notebook_path` and `notebook_name` are sent to the server. When you only know the file path, pass it as both values or rely on the wrapper's automatic fallback.
- After activation, use `jupyter_list_notebooks` to confirm the `notebook_name` the server is tracking.

Typical use:
- open an existing notebook
- create a new notebook
- switch to another notebook

### `jupyter_list_notebooks`
List notebooks that have already been activated through `jupyter_use_notebook`.

Returns a table with:
- `Name`
- `Path`
- `Kernel_ID`
- `Kernel_Status`
- `Activate`

Important:
- This is **not** a raw filesystem listing.
- It only shows notebooks already known to the notebook manager.

### `jupyter_restart_notebook`
Restart the kernel for a specific notebook.

Arguments:
- `notebook_name` (required): the identifier reported by `jupyter_list_notebooks`

Use it when:
- the kernel is stuck
- the user wants a clean state
- memory state should be cleared

### `jupyter_unuse_notebook`
Disconnect from a specific notebook and release resources.

Arguments:
- `notebook_name` (required): the identifier reported by `jupyter_list_notebooks`

Use it when:
- the user is done with a notebook session
- resources should be released
- the current active notebook should be cleared

### `jupyter_read_notebook`
Read notebook cells from a specific notebook.

Arguments:
- `notebook_name` (required): the identifier reported by `jupyter_list_notebooks`
- `response_format` (optional): `"brief"` or `"detailed"`, default `"brief"`
- `start_index` (optional): pagination start, default `0`
- `limit` (optional): maximum number of cells, default `20`, `0` means no limit

Recommended usage:
- use `"brief"` with larger limits to get notebook structure overview
- then use `"detailed"` with narrow ranges when exact cell content matters

Use it when:
- locating cells before editing, deleting, or running them
- reviewing notebook structure
- checking execution counts and cell ordering

## Cell tools

All cell tools below operate on the **currently activated notebook** unless otherwise stated.

### `jupyter_insert_cell`
Insert a new cell at a specified position.

Arguments:
- `cell_index`: target insertion index, `-1` means append at end
- `cell_type`: `"code"` or `"markdown"`
- `cell_source`: source text for the new cell

Use it when:
- adding a new code cell
- adding a markdown explanation cell
- inserting a cell at a precise location

Important:
- Prefer `cell_source`, not plain `source`
- Prefer `cell_index`, not plain `index`

### `jupyter_overwrite_cell_source`
Replace the entire source of an existing cell.

Arguments:
- `cell_index`
- `cell_source`

Returns a diff-style comparison of the change.

Use it when:
- updating code in an existing cell
- replacing markdown content
- rewriting a cell completely

### `jupyter_execute_cell`
Execute an existing cell by index.

Arguments:
- `cell_index`
- `timeout` (optional): default `90`
- `stream` (optional): default `false`
- `progress_interval` (optional): default `5`

Use it when:
- the cell already exists and should now run
- a just-edited cell needs execution
- outputs need to be refreshed

Returns outputs, which may include:
- text
- HTML
- images

### `jupyter_insert_execute_code_cell`
Insert a code cell and execute it immediately.

Arguments:
- `cell_index`
- `cell_source`
- `timeout` (optional): default `90`

Use it when:
- the user wants code inserted and run in one step
- a quick one-shot action should still be saved in the notebook

This is usually better than calling insert then execute separately.

### `jupyter_read_cell`
Read one cell from the currently activated notebook.

Arguments:
- `cell_index`
- `include_outputs` (optional): default `true`

Returns:
- cell metadata
- source
- outputs for code cells if enabled

Use it when:
- the user wants one specific cell
- verifying content before overwrite
- checking outputs of one cell

### `jupyter_delete_cell`
Delete one or more cells from the currently activated notebook.

Arguments:
- `cell_indices`: list of indices
- `include_source` (optional): default `true`

Important:
- When deleting many cells, delete in **descending index order** to avoid index shifting.
- If the user mentions only one cell, convert internally to a one-element list if needed.

### `jupyter_execute_code`
Execute code directly in the current notebook kernel without saving it as a notebook cell.

Arguments:
- `code`
- `timeout` (optional): default `30`, max `60`

Use it for:
- Jupyter magic commands such as `%timeit`
- shell commands such as `!git status`
- performance profiling and debugging
- checking variable values
- quick temporary calculations

Do **not** use it to:
- import new modules or perform variable assignments that affect subsequent notebook execution
- run dangerous code without permission
- silently replace proper notebook edits when the user explicitly wants the notebook changed

## Practical operating rules

- Start from `notebook_path` when identifying files.
- Use `jupyter_use_notebook` before notebook reads or cell operations unless you already know the correct notebook is active.
- Always supply a non-empty `notebook_name` to `jupyter_use_notebook`; when omitting it, the wrapper falls back to `notebook_path` automatically.
- Use `jupyter_list_notebooks` to inspect tracked notebook sessions and confirm the active `notebook_name`.
- Use `jupyter_read_notebook` before cell edits when cell positions are uncertain.
- Use `jupyter_insert_execute_code_cell` when the user wants both insertion and execution.
- Use `jupyter_execute_code` for temporary, unsaved execution.
- Use `jupyter_delete_cell` with descending indices when deleting multiple cells.

## Recommended operating sequences

### To inspect a notebook
1. `jupyter_list_files`
2. `jupyter_use_notebook`
3. `jupyter_read_notebook`

### To insert a new cell
1. `jupyter_use_notebook`
2. `jupyter_insert_cell`
3. optionally `jupyter_execute_cell`

### To modify an existing cell
1. `jupyter_use_notebook`
2. `jupyter_read_notebook`
3. `jupyter_overwrite_cell_source`
4. optionally `jupyter_execute_cell`

### To insert and run code immediately
1. `jupyter_use_notebook`
2. `jupyter_insert_execute_code_cell`

### To run temporary code without changing notebook structure
1. `jupyter_use_notebook`
2. `jupyter_execute_code`

### To remove cells
1. `jupyter_use_notebook`
2. `jupyter_delete_cell`

### To switch servers
1. `jupyter_connect_to_jupyter`
2. `jupyter_list_files`
3. `jupyter_use_notebook`

## Error interpretation

### "Field required"
Interpret this as a schema mismatch or wrong argument name.

Common causes:
- using `source` when the tool expects `cell_source`
- using `cell_index` when the tool expects `cell_indices`
- providing notebook-path-style input to a tool that now expects `notebook_name`
- trying a notebook-management tool before the notebook has been properly activated

### "quote_from_bytes() expected bytes"
Interpret this as a backend runtime failure after the request already reached the tool handler.

Usually suspect:
- wrong notebook identifier format
- incomplete active notebook state
- a mismatch between the current active notebook and the tool being called

This is usually **not** an HTTP header problem if the request already succeeded at the transport level.

### Notebook file exists but notebook operations still fail
Use this sequence:
1. `jupyter_list_files`
2. `jupyter_use_notebook`
3. `jupyter_list_notebooks`
4. `jupyter_read_notebook`

This separates:
- "file exists on disk"
from
- "server has an active handle to that notebook"

## Final operating rule

Treat ClawPyter as a notebook-aware Jupyter operator, not just a code runner. Prefer explicit notebook activation and notebook inspection before cell mutations, and follow each tool's exact argument rules rather than assuming names are interchangeable.
