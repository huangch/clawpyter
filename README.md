# ClawPyter

**ClawPyter** is a TypeScript plugin for [OpenClaw](https://openclaw.ai) that gives the AI direct access to JupyterLab. It enables Claude or any AI running inside OpenClaw to read, write, edit, and execute code in Jupyter notebooks — all in natural language, without manual interface interaction.

![ClawPyter](docs/_static/clawpyter.png)

---

## What Can It Do?

ClawPyter exposes **17 tools** (14 core + 3 compatibility wrappers) that allow the AI to fully manage Jupyter notebooks:

**Server & File Operations:**
- Browse notebook files and filesystem structure
- Connect to different Jupyter server instances dynamically
- List running kernels and their status
- Inspect active connection settings

**Notebook Lifecycle:**
- Create new notebooks (with automatic name conflict resolution)
- Open (use) and close (unuse) notebooks
- Switch between active notebooks
- Restart notebook kernels
- List all active notebook sessions

**Cell Operations:**
- Read cell contents (brief or detailed format)
- Insert new code or Markdown cells
- Edit existing cell source code
- Delete one or multiple cells
- Execute individual cells with configurable timeout
- Run arbitrary code snippets directly in the kernel
- Insert and execute code cells in a single operation

**Execution Control:**
- Support for Jupyter magic commands (`%timeit`, `%pip install`, etc.)
- Shell command execution in the kernel (`!` commands)
- Configurable timeouts and streaming progress updates
- Capture and return execution outputs (text, HTML, images)

---

## Architecture

```
User (in OpenClaw chat)
        │
        ▼
  OpenClaw Application
        │
        ▼
  ClawPyter Plugin (TypeScript)
        │ ← Jupyter REST API + WebSocket
        ▼
  JupyterLab (local instance, port 8888)
        │
        ▼
  Your .ipynb notebooks & kernels
```

ClawPyter communicates directly with JupyterLab's REST API for file and session management, and uses WebSocket kernel channels for code execution. There is no intermediate MCP server.

**Key files:**
- **`src/index.ts`** — Main plugin file. Registers all 17 tools with OpenClaw.
- **`src/jupyter-client.ts`** — `JupyterDirectClient` class. Handles all REST API and WebSocket communication with JupyterLab.
- **`skills/clawpyter/SKILL.md`** — Operating instructions that teach the AI how and when to use each tool.

---

## Prerequisites

- **OpenClaw** installed and running ([openclaw.ai](https://openclaw.ai))
- **Node.js** and **npm** ([nodejs.org](https://nodejs.org))
- **JupyterLab** 4.x with a Python kernel (`pip install jupyterlab ipykernel`)

---

## Installation

### Step 1 — Install JupyterLab

```bash
pip install jupyterlab ipykernel
```

### Step 2 — Build and Install the ClawPyter Plugin

```bash
npm install
npm run build
```

Then integrate the plugin into OpenClaw:

```bash
./build.sh
```

`build.sh` installs npm dependencies, compiles `src/` to `dist/index.js`, uninstalls any previous version, and reinstalls the plugin into OpenClaw.

### Step 3 — Start JupyterLab

Each time you want to use ClawPyter, start JupyterLab with the helper script:

```bash
./start_jpy.sh -n ~/.openclaw/jupyter_home
```

**What this script does:**
1. Stops any previously running JupyterLab instance
2. Generates a secure random authentication token
3. Starts JupyterLab on port 8888 bound to all network interfaces (`0.0.0.0`)
4. Waits until JupyterLab is fully responsive
5. Prints the access URL (with token) and the `config` block to inject into OpenClaw
6. Automatically writes the `config` block into `~/.openclaw/openclaw.json`

**Output example:**
```
# ---------------------------------------------------------------------------
# The `config` object to be injected into the openclaw configuration
# ---------------------------------------------------------------------------
        "config": {
          "jupyterUrl": "http://192.168.1.10:8888",
          "jupyterToken": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          "notebookDir": "/home/user/.openclaw/jupyter_home"
        }

# ---------------------------------------------------------------------------
# URL to access Jupyter Lab (with token for authentication)
# ---------------------------------------------------------------------------
http://192.168.1.10:8888/?token=a1b2c3d4-e5f6-7890-abcd-ef1234567890

# ---------------------------------------------------------------------------
# To complete setup, restart openclaw with:
# ---------------------------------------------------------------------------
openclaw gateway stop && openclaw gateway install --force && openclaw gateway restart
```

Logs are written to `/tmp/jupyterlab.log`.

**Script options:**
```
Usage: ./start_jpy.sh -n <notebook_directory> [-o <manifest_path>] [-t <jupyter_token>]

  -n <path>    Required. Directory where notebooks are stored.
  -o <path>    Optional. Path to openclaw.json. Default: ~/.openclaw/openclaw.json
  -t <token>   Optional. Use a specific token instead of generating one.
  -h           Show this help message.

Examples:
  ./start_jpy.sh -n ~/.openclaw/jupyter_home
  ./start_jpy.sh -n ~/.openclaw/jupyter_home -o ~/.openclaw/openclaw.json
  ./start_jpy.sh -n ~/.openclaw/jupyter_home -t mytoken123
```

After `start_jpy.sh` runs, restart OpenClaw to load the new config:

```bash
openclaw gateway stop && openclaw gateway install --force && openclaw gateway restart
```

### Step 4 — Stop JupyterLab

When done, shut down JupyterLab:

```bash
./stop_jpy.sh
```

This reads the PID from `/tmp/jupyterlab.pid` and terminates the process safely.

---

## Configuration

ClawPyter reads its settings from the `config` block in `~/.openclaw/openclaw.json` under `plugins.entries.clawpyter`. The `start_jpy.sh` script writes this block automatically.

| Option | Default | Description |
|---|---|---|
| `jupyterUrl` | `http://127.0.0.1:8888` | URL of the JupyterLab server |
| `jupyterToken` | _(empty)_ | Authentication token for Jupyter. Set automatically by `start_jpy.sh`. |
| `notebookDir` | _(none)_ | Directory path where notebooks are stored. Used for conflict detection when naming new notebooks. |
| `defaultNotebook` | _(none)_ | Default notebook filename used by `jupyter_create_notebook` when no name is given. |
| `timeoutMs` | `30000` | Default timeout in milliseconds for all Jupyter operations. |

**Example `openclaw.json` fragment:**
```json
"clawpyter": {
  "enabled": true,
  "config": {
    "jupyterUrl": "http://192.168.1.10:8888",
    "jupyterToken": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "notebookDir": "/home/user/.openclaw/jupyter_home"
  }
}
```

---

## Usage Examples

Once everything is running, chat with the AI in OpenClaw:

**Exploration:**
> "List my notebooks in the Jupyter home directory."
> "Show me all running kernels."

**Notebook Operations:**
> "Create a new notebook called `analysis.ipynb`."
> "Open the notebook `analysis.ipynb` and show me its cells."
> "List all notebooks I have open."

**Cell Edits:**
> "Insert a new code cell at the end that plots a histogram of the `age` column."
> "Replace cell 5 with a function that calculates the mean of column X."
> "Delete cells 10, 11, and 12."

**Execution:**
> "Run cell 3 and show me what it outputs."
> "Install pandas using pip."
> "Execute this snippet: `import pandas as pd; print(pd.__version__)`"

**Maintenance:**
> "Restart the notebook kernel."
> "Connect to the Jupyter server at `http://gpu-box:8888` with token `abc123`."

---

## Tool Reference

All 17 tools are prefixed with `jupyter_`.

### Server Tools (4 tools)

#### `jupyter_list_files`
List files and directories on the Jupyter server.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `path` | no | `""` (root) | Directory to list |
| `max_depth` | no | `1` | How many folder levels deep to search (max 3) |
| `start_index` | no | `0` | Pagination start position |
| `limit` | no | `25` | Max results to return. `0` = no limit. |
| `pattern` | no | — | Glob filter, e.g. `*.ipynb` |

Returns a tab-separated table: `Path`, `Type`, `Size`, `Last_Modified`

---

#### `jupyter_list_kernels`
List all running kernels on the Jupyter server.

No parameters. Returns a tab-separated table: `ID`, `Name`, `Display_Name`, `Language`, `State`, `Connections`, `Last_Activity`, `Environment`

---

#### `jupyter_connect_to_jupyter`
Switch ClawPyter to a different Jupyter server.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `jupyter_url` | yes | — | Full URL of the Jupyter server, e.g. `http://localhost:8888` |
| `jupyter_token` | no | `""` | Authentication token |
| `provider` | no | — | Informational label only |

---

#### `jupyter_server_info`
Return the URL and token ClawPyter is currently using.

No parameters. Returns a JSON object:
```json
{
  "jupyter_url": "http://127.0.0.1:8888",
  "jupyter_token": "abc123..."
}
```

Use the returned values to build a notebook URL:
```
{jupyter_url}/lab/tree/{notebook_path}?token={jupyter_token}
```

---

### Notebook Tools (6 core tools + 3 compatibility wrappers)

#### `jupyter_create_notebook`
Create a new notebook file. Also starts a kernel session and activates the notebook automatically. After this call you do NOT need to call `jupyter_use_notebook`.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `notebook_name` | no | `defaultNotebook` or `"Untitled"` | Filename for the new notebook. `.ipynb` is added automatically if missing. If the name already exists, a numbered suffix is appended (`-1`, `-2`, etc.). |

Returns a success message with the final filename and an authenticated access URL.

---

#### `jupyter_use_notebook`
Open an existing notebook and activate it as the current notebook for cell operations.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `notebook_path` | yes | — | File path relative to Jupyter server root, e.g. `demo.ipynb` |
| `notebook_name` | yes | — | A label you choose to identify this notebook in ClawPyter. If unsure, use the same value as `notebook_path`. |
| `mode` | no | `"connect"` | `"connect"` to open an existing file; `"create"` to create the file first |
| `kernel_id` | no | — | Attach a specific kernel by ID. Server picks automatically if omitted. |

The tool activates the notebook and returns an overview of the first 20 cells.

**Guards:** If the notebook is already active, the tool returns immediately without reconnecting.

---

#### `jupyter_list_notebooks`
List all notebooks currently open in the ClawPyter session.

No parameters. Returns a tab-separated table: `Name`, `Path`, `Kernel_ID`, `Kernel_Status`, `Activate` (✓ = currently active)

---

#### `jupyter_restart_notebook`
Restart the kernel for an open notebook. Clears all kernel state and variables.

| Parameter | Required | Description |
|---|---|---|
| `notebook_name` | yes | The label from `jupyter_list_notebooks` |

---

#### `jupyter_unuse_notebook`
Close a notebook and delete its server session. The notebook file is not deleted.

| Parameter | Required | Description |
|---|---|---|
| `notebook_name` | yes | The label from `jupyter_list_notebooks` |

---

#### `jupyter_read_notebook`
Read the cell structure and content of an open notebook.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `notebook_name` | yes | — | The label from `jupyter_list_notebooks` |
| `response_format` | no | `"brief"` | `"brief"` = first line + line count per cell. `"detailed"` = full source of each cell. |
| `start_index` | no | `0` | First cell to return (0-based) |
| `limit` | no | `20` | Number of cells to return. `0` = all. |

---

#### Compatibility wrappers
Three tools have a `_compat` variant that accepts either `notebook_name` or `notebook_path` (falls back to `notebook_path` if `notebook_name` is empty):

- `jupyter_restart_notebook_compat`
- `jupyter_unuse_notebook_compat`
- `jupyter_read_notebook_compat`

Use the `_compat` version only when you are unsure which argument to supply. Prefer the regular versions otherwise.

---

### Cell Tools (7 tools)

All cell tools require an active notebook. They operate on whichever notebook was most recently activated via `jupyter_use_notebook` or `jupyter_create_notebook`. All cell indices are **0-based** (the first cell is index `0`).

#### `jupyter_insert_cell`
Insert a new cell at a specific position.

| Parameter | Required | Description |
|---|---|---|
| `cell_index` | yes | Position to insert. Use `-1` to append at the end. |
| `cell_type` | yes | `"code"` or `"markdown"` |
| `cell_source` | yes | The cell content |

---

#### `jupyter_overwrite_cell_source`
Replace the full content of an existing cell. For code cells, also clears outputs and execution count.

| Parameter | Required | Description |
|---|---|---|
| `cell_index` | yes | 0-based index of the cell to replace |
| `cell_source` | yes | Complete new content |

Returns a diff showing removed (`-`) and added (`+`) lines.

---

#### `jupyter_execute_cell`
Run an existing code cell and save its outputs to the notebook file.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `cell_index` | yes | — | 0-based index |
| `timeout` | no | `90` | Max seconds to wait |
| `stream` | no | `false` | Send progress updates while running |
| `progress_interval` | no | `5` | Seconds between progress updates |

Non-code cells return an error.

---

#### `jupyter_insert_execute_code_cell`
Insert a new code cell and immediately execute it. Use this instead of calling `jupyter_insert_cell` + `jupyter_execute_cell` separately.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `cell_index` | yes | — | Position to insert. Use `-1` to append at the end. |
| `cell_source` | yes | — | The code to insert and run |
| `timeout` | no | `90` | Max seconds to wait |

---

#### `jupyter_read_cell`
Read the content and outputs of one cell.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `cell_index` | yes | — | 0-based index |
| `include_outputs` | no | `true` | Include outputs for code cells |

---

#### `jupyter_delete_cell`
Delete one or more cells.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `cell_indices` | yes | — | Array of 0-based indices, e.g. `[0, 2, 5]` |
| `include_source` | no | `true` | Return the deleted cell content |

The tool automatically processes indices from largest to smallest to prevent index shifting. You do not need to sort the indices.

---

#### `jupyter_execute_code`
Run code directly in the kernel without inserting it into the notebook. Output is returned but not saved.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `code` | yes | — | Code to run |
| `timeout` | no | `30` | Max seconds to wait (maximum: 60) |

Use for: `%pip install`, `%timeit`, `!ls`, quick variable inspection.

Do NOT use for code that needs to be saved in the notebook — use `jupyter_insert_execute_code_cell` instead.

---

## Common Workflows

### Open an existing notebook and edit a cell

```
1. jupyter_list_files            → confirm the file exists
2. jupyter_use_notebook          → activate it (notebook_path + notebook_name)
3. jupyter_list_notebooks        → confirm activation
4. jupyter_read_notebook         → inspect cell structure (brief format)
5. jupyter_overwrite_cell_source → replace a cell
   or jupyter_insert_cell        → add a new cell
6. jupyter_execute_cell          → run the changed cell
```

### Create a new notebook and run code

```
1. jupyter_create_notebook           → creates file, starts kernel, activates notebook
2. jupyter_insert_execute_code_cell  → add code and run it in one step
```

### Switch between open notebooks

```
1. jupyter_list_notebooks  → see all open notebooks, find the target
2. jupyter_use_notebook    → activate the target notebook
```

### Install a package and verify it

```
1. jupyter_use_notebook  → activate any open notebook
2. jupyter_execute_code  → run %pip install pandas
3. jupyter_execute_code  → run import pandas; print(pandas.__version__)
```

---

## Troubleshooting

### AI gets a 403 Forbidden error

The `jupyterToken` in `openclaw.json` is empty or wrong. Run `./start_jpy.sh -n <path>` again and restart OpenClaw. The script writes the correct token automatically.

### AI says "No active notebook"

You must activate a notebook before using any cell tool. Call `jupyter_use_notebook` (for an existing notebook) or `jupyter_create_notebook` (for a new one) before any cell operation.

### JupyterLab did not start

Check the log:
```bash
cat /tmp/jupyterlab.log
```

Common causes: port 8888 already in use, or the notebook directory does not exist. Create the directory first:
```bash
mkdir -p ~/.openclaw/jupyter_home
./start_jpy.sh -n ~/.openclaw/jupyter_home
```

### Verify JupyterLab is running

```bash
curl -s http://127.0.0.1:8888/api/status -H "Authorization: token YOUR_TOKEN"
```

### Check running processes

```bash
ps aux | grep jupyter
cat /tmp/jupyterlab.pid
```

### Restart everything

```bash
./stop_jpy.sh
./start_jpy.sh -n ~/.openclaw/jupyter_home
openclaw gateway stop && openclaw gateway install --force && openclaw gateway restart
```

---

## Project Structure

```
clawpyter/
├── src/
│   ├── index.ts              # Registers all 17 tools with OpenClaw
│   └── jupyter-client.ts     # JupyterDirectClient: REST API + WebSocket client
├── dist/                     # Compiled JavaScript (generated by npm run build)
├── skills/
│   └── clawpyter/
│       └── SKILL.md          # Operating instructions for the AI
├── docs/
│   └── _static/
│       └── clawpyter.png
├── openclaw.plugin.json      # Plugin metadata and config schema
├── package.json
├── tsconfig.json
├── build.sh                  # Build and install into OpenClaw
├── start_jpy.sh              # Start JupyterLab
├── stop_jpy.sh               # Stop JupyterLab
└── README.md
```
