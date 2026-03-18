# ClawPyter

**ClawPyter** is a TypeScript plugin for [OpenClaw](https://openclaw.ai) that bridges OpenClaw's AI capabilities to Jupyter notebooks through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). The plugin enables Claude or any AI running inside OpenClaw to actively read, write, edit, and execute code in Jupyter notebooks — all in natural language, without manual interface interaction.

![ClawPyter](docs/_static/clawpyter.png)

---

## What Can It Do?

ClawPyter exposes **19 tools** (16 core + 3 compatibility wrappers) that allow the AI to fully manage Jupyter notebooks:

**Server & File Operations:**
- Browse notebook files and filesystem structure
- Connect to different Jupyter server instances dynamically
- List available kernels and their status

**Notebook Lifecycle:**
- Open (use) and close (unuse) notebooks
- Switch between active notebooks
- Restart notebook kernels
- List all active notebook sessions

**Cell Operations:**
- Read cell contents (brief or detailed format)
- Insert new code or Markdown cells
- Edit existing cell source code
- Delete one or multiple cells
- Execute individual cells with timeout and streaming support
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
        │ ← Makes JSON-RPC calls
        ▼
  jupyter-mcp-server (MCP server)
        │ ← REST/HTTP API
        ▼
  JupyterLab (local instance)
        │ ← Python Jupyter API
        ▼
  Your .ipynb notebooks & kernels
```

**Key Components:**
- **ClawPyter Plugin** (this repo): TypeScript/Node.js OpenClaw extension that exposes 19 Jupyter-related tools
- **jupyter-mcp-server**: Separate MCP server process that translates tool calls into Jupyter API operations
- **JupyterLab**: Local Jupyter installation providing the notebook runtime and kernel management
- **Communication**: Plugin → MCP Server uses HTTP POST with JSON-RPC; MCP Server → JupyterLab uses Python Jupyter client libraries

---

## Prerequisites

Before installing ClawPyter, ensure you have:

- **OpenClaw** installed and running ([openclaw.ai](https://openclaw.ai))
- **Python** 3.9 or later
- **pip** (Python package manager)
- **Node.js** and **npm** (for building the plugin — [nodejs.org](https://nodejs.org))
- **conda** (for environment isolation — [conda.io](https://conda.io))
- **uvx** (part of the [uv](https://docs.astral.sh/uv/) Python toolchain — used to launch `jupyter-mcp-server`)

---

## Installation

### Step 1 — Set Up the Python Environment

Create a dedicated conda environment for Jupyter dependencies:

```bash
conda create -n openclaw-jpy python=3.11
conda activate openclaw-jpy
```

Install required packages:

```bash
pip install jupyterlab==4.4.1 jupyter-collaboration==4.0.2 jupyter-mcp-tools>=0.1.4 ipykernel
pip uninstall -y pycrdt datalayer_pycrdt
pip install datalayer_pycrdt==0.12.17
```

> **Important:** The version constraints ensure compatibility between JupyterLab, the MCP server bridge, and the kernel. The uninstall-reinstall step resolves dependency conflicts.

---

### Step 2 — Build and Install the ClawPyter Plugin

Navigate to the clawpyter repository and run:

```bash
npm install
npm run build
```

Then integrate the plugin into OpenClaw:

```bash
./build.sh
```

This compiles the TypeScript source (`src/`) into `dist/index.js`, which OpenClaw loads as a plugin.

---

### Step 3 — Start the Jupyter Environment

Each time you want to use ClawPyter, initialize the Jupyter and MCP servers:

```bash
./start_jpy.sh -n ~/.openclaw/jupyter_home
```

**What this script does:**
1. Stops any previously running JupyterLab or jupyter-mcp-server instances
2. Generates a secure random authentication token for Jupyter
3. Starts **JupyterLab** on port 8888 with the specified notebook directory
4. Waits until JupyterLab is fully responsive
5. Starts **jupyter-mcp-server** on port 4040 (the MCP bridge)
6. Displays the Jupyter access URL (with embedded token)
7. Prints the plugin configuration to inject into OpenClaw's manifest
8. Updates the OpenClaw configuration file automatically (via jq or Python)

**Output example:**
```
http://gpustation1:8888/?token=a1b2c3d4-e5f6-g7h8-i9j0k1l2m3n4

# ---------
# Plugin configuration to use:
# ---------
        "config": {
          "jupyterUrl": "http://gpustation1:8888",
          "jupyterToken": "a1b2c3d4-e5f6-g7h8-i9j0k1l2m3n4",
          "notebookDir": "/home/user/.openclaw/jupyter_home"
        }
```

Logs are written to `/tmp/jupyterlab.log` and `/tmp/jupytermcp.log` for debugging.

**Advanced options:**
```bash
./start_jpy.sh -h  # View all options
./start_jpy.sh -n <path> -o <manifest_path> -t <custom_token>
```

---

### Step 4 — Stop the Services

When done, cleanly shut down both services:

```bash
./stop_jpy.sh
```

This safely terminates JupyterLab and jupyter-mcp-server, verifying PIDs before killing to avoid errors.

## Configuration

ClawPyter automatically configures itself based on output from `start_jpy.sh`. However, you can override settings in OpenClaw's plugin configuration:

| Option | Default | Description |
|---|---|---|
| `mcpUrl` | `http://127.0.0.1:4040` | Address of the jupyter-mcp-server instance |
| `jupyterUrl` | `http://127.0.0.1:8888` | Address of the JupyterLab server |
| `jupyterToken` | _(empty)_ | Authentication token for Jupyter (set by `start_jpy.sh`) |
| `notebookDir` | _(none)_ | Default directory for notebooks (set by `start_jpy.sh`) |
| `defaultNotebook` | _(none)_ | Notebook name to activate automatically on startup |
| `timeoutMs` | `30000` (30 seconds) | Default timeout for tool execution |

The `start_jpy.sh` script automatically updates these values in your OpenClaw configuration file.

---

## Usage Examples

Once everything is running, simply chat with the AI in OpenClaw. Here are typical requests:

**Exploration:**
> "List my notebooks in the Jupyter home directory."
> "Show me all running kernels."

**Notebook Operations:**
> "Open the notebook `analysis.ipynb` and show me its cells in brief format."
> "List all notebooks I'm currently working with."

**Cell Edits:**
> "Insert a new code cell at the end that plots a histogram of the `age` column."
> "Replace cell 5 with a function that calculates the mean of column X."
> "Delete cells 10 through 12."

**Execution:**
> "Run cell 3 and show me what it outputs."
> "Execute this code snippet: `import pandas as pd; print(pd.__version__)`"
> "Install numpy using pip and then verify the installation."

**Maintenance:**
> "Restart the notebook kernel to clear all variables."
> "Run all cells from the beginning to regenerate outputs."

The AI understands context, reads cell outputs, and iteratively refines code — all without manual copy-paste.

## Complete Tool Reference

ClawPyter exposes **19 tools** organized into four categories. All tool names are prefixed with `jupyter_` (e.g., `jupyter_list_files`).

### Server & Connection Tools (4 tools)

#### `jupyter_list_files`
List files and directories in the Jupyter server's filesystem recursively.

**Parameters:**
- `path` (optional): Directory path to list; defaults to root
- `max_depth` (optional): Recursion depth (1-3); default: 1
- `start_index` (optional): Pagination start index; default: 0
- `limit` (optional): Maximum results to return; default: 25
- `pattern` (optional): Glob pattern to filter files

**Returns:** Tab-separated table with columns: `Path`, `Type`, `Size`, `Last_Modified`

---

#### `jupyter_list_kernels`
Show all available and running kernels with their status and statistics.

**Returns:** Tab-separated table with columns: `ID`, `Name`, `Display_Name`, `Language`, `State`, `Connections`, `Last_Activity`, `Environment`

---

#### `jupyter_connect_to_jupyter`
Dynamically connect to a different Jupyter server without restarting the MCP server.

**Parameters:**
- `jupyter_url` (required): URL of the Jupyter server (e.g., `http://localhost:8888`)
- `jupyter_token` (optional): Authentication token
- `provider` (optional): Connection provider type; default: `jupyter`

**Returns:** Connection status confirmation

---

#### `jupyter_info`
Retrieve current Jupyter and MCP server configuration and connection details.

**Returns:** JSON object with `jupyter_url`, `jupyter_token`, and other connection parameters

---

### Notebook Session Management (6 tools)

#### `jupyter_use_notebook`
Open and activate a notebook for subsequent cell operations.

**Parameters:**
- `notebook_path` (required): Relative path to the notebook file from Jupyter root
- `notebook_name` (required): Unique identifier for this notebook session
- `mode` (optional): `'connect'` (open existing) or `'create'` (create new); default: `'connect'`
- `kernel_id` (optional): Specific kernel to attach (uses default if omitted)

**Returns:** Notebook metadata including kernel info, activation status, and cell overview

---

#### `jupyter_list_notebooks`
List all notebooks currently loaded in the MCP server with their session status.

**Returns:** Tab-separated table with columns: `Name`, `Path`, `Kernel_ID`, `Kernel_Status`, `Activate` (✓ if active)

---

#### `jupyter_unuse_notebook`
Close and release a notebook session's resources.

**Parameters:**
- `notebook_name` (required): Notebook identifier from `list_notebooks`

**Returns:** Confirmation of disconnection and resource release

---

#### `jupyter_restart_notebook`
Restart the kernel of a specific notebook, clearing all variables and state.

**Parameters:**
- `notebook_name` (required): Notebook identifier

**Returns:** Confirmation that kernel has been restarted

---

#### `jupyter_unuse_notebook_compat`
*(Compatibility wrapper)* Close a notebook. Accepts either `notebook_name` or `notebook_path` (falls back to path if name is omitted).

---

#### `jupyter_restart_notebook_compat`
*(Compatibility wrapper)* Restart a notebook kernel. Accepts either `notebook_name` or `notebook_path` (falls back to path if name is omitted).

---

### Notebook Content & Reading (2 tools + 1 wrapper)

#### `jupyter_read_notebook`
Read the full contents of an active notebook, retrieving all cell metadata, sources, and outputs.

**Parameters:**
- `notebook_name` (required): Notebook identifier
- `response_format` (optional): `'brief'` (first line + count) or `'detailed'` (full source); default: `'brief'`
- `start_index` (optional): Cell index to start from; default: 0
- `limit` (optional): Maximum cells to return; default: 20

**Returns:** Notebook metadata, cell details (index, type, execution count), sources, and pagination info

**Best Practice:** Use `brief` format with larger limit for an overview, then `detailed` format with exact indices for specific cells.

---

#### `jupyter_read_cell`
Read a single cell from the active notebook with full details.

**Parameters:**
- `cell_index` (required): 0-based cell position
- `include_outputs` (optional): Include execution outputs for code cells; default: `true`

**Returns:** Cell metadata (type, execution count), source code, and outputs (if applicable)

---

#### `jupyter_read_notebook_compat`
*(Compatibility wrapper)* Read a notebook. Accepts either `notebook_name` or `notebook_path` (falls back to path if name is omitted).

---

### Cell Operations (6 tools)

#### `jupyter_insert_cell`
Insert a new cell at a specified position in the active notebook.

**Parameters:**
- `cell_index` (required): 0-based position; use `-1` to append at the end
- `cell_type` (required): `'code'` or `'markdown'`
- `cell_source` (required): Cell content (Python code or Markdown text)

**Returns:** Insertion confirmation with surrounding cell structure (±5 cells for context)

---

#### `jupyter_overwrite_cell_source`
Replace the source code of an existing cell.

**Parameters:**
- `cell_index` (required): 0-based cell position
- `cell_source` (required): New complete cell source code

**Returns:** Diff-style comparison showing deleted lines (−) and added lines (+)

---

#### `jupyter_delete_cell`
Delete one or multiple cells from the active notebook.

**Parameters:**
- `cell_indices` (required): List of 0-based cell indices to delete
- `include_source` (optional): Include source code of deleted cells in response; default: `true`

**Returns:** Deletion confirmation with sources (if requested)

**Important Note:** When deleting multiple cells, provide indices in **descending order** to avoid index shifting issues.

---

#### `jupyter_execute_cell`
Run a single cell and return its execution outputs.

**Parameters:**
- `cell_index` (required): 0-based cell position
- `timeout` (optional): Maximum execution time in seconds; default: 90
- `stream` (optional): Enable streaming progress updates for long operations; default: `false`
- `progress_interval` (optional): Streaming update frequency in seconds; default: 5

**Returns:** List of outputs (text, HTML, images, error tracebacks)

---

#### `jupyter_insert_execute_code_cell`
Insert a code cell at a specified position and immediately execute it (shortcut combining insert + execute).

**Parameters:**
- `cell_index` (required): 0-based position; `-1` to append
- `cell_source` (required): Python code
- `timeout` (optional): Execution timeout in seconds; default: 90

**Returns:** Insertion confirmation plus execution results

---

#### `jupyter_execute_code`
Execute arbitrary code directly in the kernel without saving it to the notebook.

**Parameters:**
- `code` (required): Python code, Jupyter magic commands (%), or shell commands (!)
- `timeout` (optional): Execution timeout in seconds (1-60); default: 30

**Returns:** Execution output (text, HTML, images, shell results)

**Supported Commands:**
- Standard Python: `import pandas as pd; df = pd.read_csv('file.csv')`
- Jupyter magics: `%timeit`, `%pip install`, `%matplotlib inline`
- Shell commands: `!ls -la`, `!python script.py`, `!npm list`

**Use Cases:** 
- Check intermediate variable values without permanent changes
- Temporary debugging and performance profiling
- Install packages and verify versions
- Run shell commands for system interaction

**Do NOT use for:** Persistent variable assignments, module imports (use notebook cells instead), executing untrusted code

---

## Project Structure

```
clawpyter/
├── src/
│   ├── index.ts              # Main plugin file with all 19 tool definitions
│   └── jupyter-mcp-client.ts # HTTP client for communicating with jupyter-mcp-server
├── dist/                     # Compiled JavaScript (generated by npm run build)
├── start_jpy.sh             # Launch JupyterLab + jupyter-mcp-server
├── stop_jpy.sh              # Stop both services
├── package.json             # Node.js dependencies and build config
├── tsconfig.json            # TypeScript compiler settings
├── build.sh                 # OpenClaw plugin build/install script
├── README.md                # This file
└── docs/                    # Documentation assets
```

**Build Process:**
1. `npm install` — Install dependencies (@sinclair/typebox, TypeScript)
2. `npm run build` — Compile TypeScript src/ → dist/index.js
3. `./build.sh` — Integrate compiled plugin into OpenClaw

**Key parameters:** `jupyter_url` (required), `jupyter_token` (optional), `provider` (default: jupyter)

**Important:** Not available when running as a Jupyter extension.

---

#### `jupyter_info`
**Purpose:** Retrieve current Jupyter and MCP server configuration settings.

**When to use:**
- Verify active server URLs and connection details
- Obtain Jupyter authentication token for URL construction
- Diagnose connection issues by inspecting effective settings
- Construct Jupyter Lab access URLs for manual inspection
- Document current server configuration for logging/debugging

**Key parameters:** None (no parameters needed)

**Returns:** JSON object with configuration details:
- `effectiveJupyterUrl` — The active Jupyter server URL (e.g., `http://127.0.0.1:8888`)
- `effectiveJupyterToken` — The authentication token for Jupyter server
- `effectiveMcpUrl` — The MCP server URL (e.g., `http://127.0.0.1:4040`)
- `effectiveTimeoutMs` — Request timeout in milliseconds (default: 30000)

**Example use case:** Call this to get the Jupyter URL and token, then construct a shareable notebook link:
```
http://[jupyter_host]:8888/?token=[jupyter_token]/lab/tree/[notebook_path]
```

---

### Notebook Management Tools (5 core + 3 compatibility)
These tools manage notebook sessions, activation, and inspection.

#### `jupyter_use_notebook` ⭐ REQUIRED FIRST STEP
**Purpose:** Activate a notebook for all subsequent cell operations.

**CRITICAL:** Call this FIRST before ANY cell operations. Never skip this step.

**Key parameters (ALL REQUIRED):**
- `notebook_path`: File path relative to server root (e.g., `analysis.ipynb`)
- `notebook_name`: Unique session identifier (MUST be non-empty)
- `mode` (optional): `"connect"` or `"create"` (default: `"connect"`)
- `kernel_id` (optional): Specific kernel to attach

---

#### `jupyter_list_notebooks`
**Purpose:** List all notebooks currently managed by the session handler.

**When to use:** Verify active notebook, confirm activation, see all open sessions.

**Returns:** Table with notebook name, path, kernel ID, kernel status, and active indicator.

---

#### `jupyter_read_notebook`
**Purpose:** Read notebook structure and cell contents.

**When to use:** Inspect cells before editing, understand notebook structure, review content.

**Key parameters:**
- `notebook_name` (required): Identifier from `jupyter_list_notebooks`
- `response_format` (optional): `"brief"` (fast overview) or `"detailed"` (full source)
- Pagination options: `start_index`, `limit`

**Best practice:** First call with `brief` to scan, then `detailed` for specific cells.

---

#### `jupyter_restart_notebook`
**Purpose:** Restart the kernel and clear memory state.

**When to use:** Reset to clean state, fix stuck kernels, clear variables and outputs.

**Key parameters:** `notebook_name` (required)

---

#### `jupyter_unuse_notebook`
**Purpose:** Disconnect from and release a notebook session.

**When to use:** Finish notebook work, free resources, clear active notebook.

**Key parameters:** `notebook_name` (required)

---

#### Compatibility Wrappers (3 tools)
For backward compatibility:
- `jupyter_restart_notebook_compat` — Falls back to `notebook_path` if needed
- `jupyter_unuse_notebook_compat` — Falls back to `notebook_path` if needed
- `jupyter_read_notebook_compat` — Falls back to `notebook_path` if needed

**Recommendation:** Prefer strict versions (without `_compat`) for new code.

---

### Cell Operations (7 tools)
These tools manipulate and execute cells in the active notebook.

#### `jupyter_insert_cell`
**Purpose:** Insert a new cell at a specified position.

**Parameters:** `cell_index` (0-based, -1=append), `cell_type` (code/markdown), `cell_source`

**Returns:** Success message with surrounding cell structure.

---

#### `jupyter_overwrite_cell_source`
**Purpose:** Replace the entire content of an existing cell.

**Parameters:** `cell_index` (0-based), `cell_source` (complete new content)

**Returns:** Diff-style comparison (+ for additions, - for deletions).

---

#### `jupyter_execute_cell`
**Purpose:** Run a specific cell and return its outputs.

**Parameters:** `cell_index` (0-based), `timeout` (default: 90), `stream` (for long tasks)

**Returns:** Cell outputs (text, HTML, images, errors).

---

#### `jupyter_insert_execute_code_cell` ⭐ PREFERRED
**Purpose:** Insert a code cell AND execute it immediately (preferred over separate calls).

**Parameters:** `cell_index` (-1=append), `cell_source`, `timeout`

**Returns:** Both insertion confirmation and execution outputs.

---

#### `jupyter_read_cell`
**Purpose:** Read a single cell with metadata and outputs.

**Parameters:** `cell_index` (0-based), `include_outputs` (default: true)

**Returns:** Cell metadata, source, and outputs (if applicable).

---

#### `jupyter_delete_cell`
**Purpose:** Delete one or more cells.

**Parameters:** `cell_indices` (list of 0-based positions), `include_source` (default: true)

**CRITICAL:** Delete in DESCENDING order to prevent index shifting.

---

#### `jupyter_execute_code`
**Purpose:** Execute code in kernel WITHOUT saving to notebook.

**When to use:** Magic commands (`%timeit`, `%pip`), shell commands (`!git`), debugging, profiling.

**Parameters:** `code` (required), `timeout` (default: 30, max: 60)

**Examples:** `%pip install pandas`, `!git status`, `print(df.head())`

---

## Mandatory Operating Sequences

For reliable notebook operations, always follow these sequences:

### Sequence 1: Inspect a notebook
```
1. jupyter:list_files           → Find the notebook file
2. jupyter:use_notebook         → Activate it (REQUIRED)
3. jupyter:list_notebooks       → Confirm activation
4. jupyter:read_notebook        → Inspect cells and structure
```

### Sequence 2: Modify an existing cell
```
1. jupyter:use_notebook         → Ensure correct notebook is active
2. jupyter:read_notebook        → Find exact cell index
3. jupyter:overwrite_cell_source → Replace cell content
4. jupyter:execute_cell         → Run the updated cell (optional)
```

### Sequence 3: Add and run code (preferred)
```
1. jupyter:use_notebook              → Activate notebook
2. jupyter:insert_execute_code_cell  → Insert and run simultaneously
```

### Sequence 4: Delete cells safely
```
1. jupyter:use_notebook    → Activate notebook
2. jupyter:read_notebook   → Identify exact indices
3. jupyter:delete_cell     → Delete in DESCENDING index order ONLY
```

### Sequence 5: Run temporary code
```
1. jupyter:use_notebook → Activate notebook
2. jupyter:execute_code → Run code without saving to notebook
```

### Sequence 6: Switch servers
```
1. jupyter:connect_to_jupyter → Connect to new server
2. jupyter:list_files         → Verify access to files
3. jupyter:use_notebook       → Activate notebook on new server
```

### Sequence 7: Retrieve server information (for debugging/documentation)
```
1. jupyter:info → Get current Jupyter URL, MCP URL, token, and timeout
2. Use the returned values to construct notebook URLs or diagnose issues
```

**Critical Rules:**
- ALWAYS call `jupyter_use_notebook` first before ANY cell operations
- ALWAYS delete cells in DESCENDING index order
- ALWAYS use 0-based indexing (first cell = 0, not 1)
- ALWAYS use `jupyter_insert_execute_code_cell` when inserting and running together

---

## Troubleshooting & Common Issues

### Connection Issues

**The AI says it can't reach Jupyter.**

Make sure:
1. You've run `./start_jpy.sh`
2. Both JupyterLab (port 8888) and jupyter-mcp-server (port 4040) are running

Test connectivity:
```bash
curl http://127.0.0.1:4040
curl http://127.0.0.1:8888
```

If either fails, check the logs:
```bash
cat /tmp/jupyterlab.log
cat /tmp/jupytermcp.log
```

---

### Permission & Build Issues

**Rebuild fails with permission errors.**

The `install.sh` script requires `sudo` for some steps. Make sure your user account has sudo privileges.

---

### Cell Operation Failures

**"Field required" or schema validation error**

You're using an incorrect parameter name. Check the tool documentation:
- Use `cell_source` (not `source`)
- Use `cell_index` (not `index`)
- Use `cell_indices` for delete (not `cell_index`)
- Use colon format: `jupyter_tool_name` (not `jupyter_tool_name`)

---

**Notebook operations fail even though the file exists**

You MUST explicitly open a notebook before operating on its cells:
1. Call `jupyter_use_notebook` with the notebook path and name
2. Call `jupyter_list_notebooks` to confirm activation
3. Then perform cell operations

The server cannot read or edit cells in a notebook that hasn't been activated.

---

**"Notebook not found" error**

Diagnostic sequence:
```
1. jupyter:list_files            → Confirm notebook file exists on disk
2. jupyter:use_notebook          → Activate the notebook
3. jupyter:list_notebooks        → Verify active notebook state
4. jupyter:read_notebook         → Confirm server has valid handle
```

This separates "file exists on disk" from "server has active handle."

---

**Cell index errors**

Remember:
- Cell indices are **0-based** (first cell = 0, not 1)
- Use `cell_index: -1` to append at the end
- When deleting multiple cells, use **descending order** to prevent index shifting

Example: Delete cells [5, 3, 1] in that order, NOT [1, 3, 5].

---

**Long-running cell hangs**

Use the `timeout` parameter to set maximum execution time:
```
jupyter:execute_cell with timeout: 120
```

Or enable streaming for progress updates:
```
jupyter:execute_cell with stream: true, progress_interval: 5
```

---

### Debugging

**View logs for detailed error information:**
```bash
tail -f /tmp/jupyterlab.log        # JupyterLab activity
tail -f /tmp/jupytermcp.log        # Bridge server activity
```

**Check running processes:**
```bash
ps aux | grep jupyter
```

**Verify server endpoints are accessible:**
```bash
curl -v http://127.0.0.1:4040/health
curl -v http://127.0.0.1:8888/lab
```

**Restart everything fresh:**
```bash
./stop_jpy.sh
sleep 2
./start_jpy.sh
```

---

## Advanced Configuration

For most users, the defaults work fine. But if you need custom settings, you can configure ClawPyter in OpenClaw:

| Setting | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:4040` | Address of jupyter-mcp-server |
| `authToken` | _(none)_ | Authentication token if your server requires one |
| `defaultNotebook` | _(none)_ | A notebook path to open automatically |
| `timeoutMs` | `30000` | How long (milliseconds) to wait for responses |

Example (if needed): Set `defaultNotebook` to `analysis.ipynb` to always open that notebook on startup.

---

## Project Structure

```
clawpyter/
├── src/
│   ├── index.ts                # Plugin entry point
│   │                           # Registers all 18 tools (15 core + 3 compat)
│   │                           # Maps OpenClaw API to jupyter-mcp-server
│   └── jupyter-mcp-client.ts   # HTTP client for server communication
│
├── skills/
│   └── ClawPyter/
│       └── SKILL.md            # Comprehensive skill instructions
│                               # Teaches AI how, when, and why to use tools
│                               # Mandatory operating sequences
│                               # Diagnostic troubleshooting procedures
│
├── docs/
│   └── _static/
│       └── clawpyter.png       # Architecture diagram
│
├── openclaw.plugin.json        # Plugin metadata and configuration
├── package.json                # Node.js dependencies and scripts
├── tsconfig.json               # TypeScript compiler settings
├── build.sh                    # Compile TypeScript to JavaScript
├── install.sh                  # Build and install into OpenClaw
├── start_jpy.sh                # Launch JupyterLab + mcp-server
├── stop_jpy.sh                 # Stop JupyterLab + mcp-server
├── README.md                   # This file
└── LICENSE                     # MIT License
```

### Key Files Explained

**`src/index.ts`** — The plugin's main entry point. Defines all 18 tools with:
- OpenClaw tool names (`jupyter_*` format)
- Parameter specifications and validation
- Description text for the AI
- Translation logic between OpenClaw and jupyter-mcp-server formats

**`skills/ClawPyter/SKILL.md`** — The AI's operating manual. Contains:
- Detailed instructions for each tool
- Mandatory operating sequences with step-by-step procedures
- Critical rules and constraints
- Troubleshooting diagnostics for common failures
- Context-dependent design explanation

**`openclaw.plugin.json`** — Plugin metadata:
- Tool descriptions and names
- Configuration schema for optional settings
- Version and author information

**`start_jpy.sh` and `stop_jpy.sh`** — Control scripts:
- Start: Launches JupyterLab (port 8888) and jupyter-mcp-server (port 4040)
- Stop: Gracefully shut down both services
- Always run these before/after using ClawPyter

---

## License

This project is licensed under the MIT License. See the LICENSE file in the repository for the full text.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## Troubleshooting

### Services Won't Start

**Problem:** Running `start_jpy.sh -n <path>` fails or processes don't start.

**Solutions:**
1. Check conda environment: `conda activate openclaw-jpy`
2. Verify JupyterLab installation: `python -m jupyter lab --version`
3. Check for port conflicts: `lsof -i :8888` and `lsof -i :4040`
4. Review logs: `cat /tmp/jupyterlab.log` and `cat /tmp/jupytermcp.log`
5. Kill stale processes: `pkill -f jupyterlab` and `pkill -f jupyter-mcp-server`

---

### Connection Refused Errors

**Problem:** ClawPyter reports "HTTP 127.0.0.1:4040: Connection refused"

**Causes & Fixes:**
- jupyter-mcp-server not running: Run `./start_jpy.sh` with appropriate notebook directory
- MCP server on different port: Update `mcpUrl` in OpenClaw plugin config
- Firewall blocking localhost connections: Disable firewall or allow localhost

---

### Notebook Operations Fail

**Problem:** Tools like `jupyter_use_notebook` or `jupyter_execute_cell` return errors.

**Check:**
1. Is a notebook currently active? Use `jupyter_list_notebooks` first
2. Is the notebook path correct? Use `jupyter_list_files` to verify
3. Are cell indices in valid range? Use `jupyter_read_notebook` to inspect
4. Is the kernel still responsive? Try `jupyter_list_kernels`

---

### Kernel Errors / Code Won't Execute

**Problem:** Cell execution fails with "Kernel error" or timeout.

**Solutions:**
1. Restart the kernel: `jupyter_restart_notebook` clears state and memory
2. Check timeout settings: Increase `timeout` parameter for long-running cells
3. Review execution output: Full error messages appear in cell output
4. Check kernel language: Use `jupyter_list_kernels` to verify Python/environment

---

### Token & Authentication Issues

**Problem:** Jupyter reports "403 Forbidden" or "Token does not match"

**Fix:**
The `start_jpy.sh` script auto-generates a unique token and injects it into the plugin config. If you modify tokens manually:
1. Run `stop_jpy.sh` to terminate old sessions
2. Run `start_jpy.sh` again to generate and inject a new token
3. Verify `jupyterToken` in OpenClaw plugin config matches script output

---

### Resource Exhaustion

**Problem:** OpenClaw becomes slow or unresponsive; notebooks don't save changes.

**Possible Causes:**
- Multiple notebook sessions open: Use `jupyter_list_notebooks` and close unused ones with `jupyter_unuse_notebook`
- Kernel exhausted memory: Restart kernel with `jupyter_restart_notebook`
- Long-running cells blocking: Increase timeout or run `stop_jpy.sh` to reset

---

### Plugin Not Appearing in OpenClaw

**Problem:** ClawPyter tools don't appear after running `./build.sh`.

**Steps:**
1. Verify build succeeded: `cat dist/index.js` should show compiled JavaScript
2. Restart OpenClaw daemon completely (not just reload)
3. Check OpenClaw plugin directory for clawpyter entry
4. Review build logs for TypeScript compilation errors: `npm run build`

---

## Reference: MCP Server Specification

ClawPyter implements the **[jupyter-mcp-server](https://github.com/anthropics/jupyter-mcp-server)** specification with full tool coverage:

| Category | Core Tools | Compatibility Wrappers | Total |
|---|:---:|:---:|:---:|
| Server & Connection | 4 | 0 | 4 |
| Notebook Session Management | 4 | 3 | 7 |
| Notebook Content & Reading | 2 | 1 | 3 |
| Cell Operations | 6 | 0 | 6 |
| Special | 1 | 0 | 1 |
| **Total** | **17** | **3** | **19** |

All parameter names, types, requirements, and return values strictly follow the upstream reference. For complete technical documentation, see the [jupyter-mcp-server GitHub repository](https://github.com/anthropics/jupyter-mcp-server).

---

## Credits & Dependencies

ClawPyter integrates with:

- **[OpenClaw](https://openclaw.ai)** — the AI agent platform this plugin extends
- **[JupyterLab 4.4.1](https://jupyter.org)** — the interactive notebook environment
- **[jupyter-mcp-server](https://github.com/anthropics/jupyter-mcp-server)** — the Model Context Protocol bridge between AI and Jupyter
- **[jupyter-mcp-tools](https://pypi.org/project/jupyter-mcp-tools/)** — JupyterLab integration commands
- **[jupyter-collaboration 4.0.2](https://github.com/jupyter-server/jupyter_collaboration)** — Real-time collaborative features

---

## Next Steps

1. **Install:** Run `./install.sh` to build and install the plugin
2. **Start:** Run `./start_jpy.sh` to launch Jupyter and the bridge server
3. **Explore:** Check `skills/ClawPyter/SKILL.md` for detailed operating instructions
4. **Use:** Open OpenClaw and start working with notebooks through the AI
5. **Stop:** Run `./stop_jpy.sh` when done

For questions or issues, refer to the Troubleshooting section above or check the logs in `/tmp/`.
