# ClawPyter

**ClawPyter** is a plugin for [OpenClaw](https://openclaw.ai) that lets you control Jupyter notebooks using AI. Once installed, you can ask Claude (or any AI running inside OpenClaw) to read, write, and run code in your notebooks — all in plain English, without touching the notebook manually.

![ClawPyter](docs/_static/clawpyter.png)

---

## What Does It Do?

Normally, to work with a Jupyter notebook, you open it in a browser and interact with it yourself. ClawPyter bridges OpenClaw's AI to your Jupyter environment, so the AI can:

- **Browse** your notebook files and folders
- **Open** any notebook
- **Read** the contents of cells
- **Insert** new code or text cells
- **Edit** existing cells
- **Run** cells and see their output
- **Delete** cells
- **Restart** the notebook kernel (the computation engine)
- **Run quick code snippets** without permanently changing the notebook

This is especially useful for scientific workflows, data analysis, and iterative coding where you want an AI assistant to actively work inside your notebook, not just give you suggestions to paste in yourself.

---

## How It Works (Simple Version)

```
You (in OpenClaw chat)
        │
        ▼
   OpenClaw AI  ──► ClawPyter Plugin
                          │
                          ▼
               jupyter-mcp-server (background process)
                          │
                          ▼
                  JupyterLab (running locally)
                          │
                          ▼
                   Your .ipynb notebooks
```

1. You start JupyterLab and a small bridge server (`jupyter-mcp-server`) in the background using the provided `start_jpy.sh` script.
2. ClawPyter is installed into OpenClaw as a plugin.
3. When you chat with the AI in OpenClaw and ask it to do something with your notebook, ClawPyter translates that request into Jupyter API calls and sends them to the bridge server.
4. The bridge server executes those actions in JupyterLab, and the results come back to you in the chat.

---

## Requirements

Before installing ClawPyter, make sure you have:

- **OpenClaw** installed and working ([openclaw.ai](https://openclaw.ai))
- **Python** (3.9 or later recommended)
- **pip** (Python package manager — comes with Python)
- **Node.js** and **npm** (for building the plugin — [nodejs.org](https://nodejs.org))
- **uvx** (part of the [uv](https://docs.astral.sh/uv/) Python toolchain — used to run `jupyter-mcp-server`)

---

## Installation

### Step 1 — Install the Python/Jupyter dependencies

Open a terminal and run the following commands one by one:

```bash
pip install jupyterlab==4.4.1 jupyter-collaboration==4.0.2 jupyter-mcp-tools>=0.1.4 ipykernel
```

```bash
pip uninstall -y pycrdt datalayer_pycrdt
pip install datalayer_pycrdt==0.12.17
```

> **Why the specific versions?**
> `jupyter-mcp-tools` requires compatible versions of `jupyterlab` and `datalayer_pycrdt`. The uninstall-and-reinstall step ensures you have the exact version that works correctly with the bridge server.

---

### Step 2 — Build and Install the ClawPyter Plugin

Navigate to the `clawpyter` project folder in your terminal, then run:

```bash
./install.sh
```

This script does the following automatically:

1. Restarts the Ollama service (if you use local AI models)
2. Stops the OpenClaw daemon
3. Installs Node.js dependencies (`npm install`)
4. Compiles the TypeScript source code (`npm run build`)
5. Uninstalls any old version of ClawPyter from OpenClaw
6. Installs the freshly built plugin
7. Restarts the OpenClaw daemon

> **Note:** The script uses `sudo` for some steps, so you may be prompted for your system password.

After this step, ClawPyter will appear as an installed plugin inside OpenClaw.

---

### Step 3 — Start Jupyter and the Bridge Server

Each time you want to use ClawPyter, start the Jupyter environment by running:

```bash
./start_jpy.sh
```

This script:
- Launches **JupyterLab** on port `8888` (using `~/.openclaw/jupyter_home` as the notebook directory)
- Generates a secure random token for authentication
- Waits until JupyterLab is ready
- Launches **jupyter-mcp-server** on port `4040` — this is the bridge between ClawPyter and JupyterLab

Both processes run quietly in the background, logging to `/tmp/jupyterlab.log` and `/tmp/jupytermcp.log`.

To stop everything when you're done:

```bash
./stop_jpy.sh
```

---

## Configuration (Optional)

ClawPyter works out of the box with default settings. If you need to customize it, you can set the following options in OpenClaw's plugin configuration for ClawPyter:

| Option | Default | Description |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:4040` | Address of the jupyter-mcp-server |
| `authToken` | _(none)_ | Authentication token, if your server requires one |
| `defaultNotebook` | _(none)_ | A notebook to open automatically |
| `timeoutMs` | `30000` (30 seconds) | How long to wait for Jupyter responses |

Most users don't need to change any of these.

---

## Using ClawPyter

Once everything is running, just talk to the AI in OpenClaw as you normally would. Here are some examples of what you can ask:

> *"List the notebooks in my Jupyter home folder."*

> *"Open the notebook `analysis.ipynb` and show me its cells."*

> *"Add a new cell at the end that plots a histogram of the `age` column."*

> *"Run cell 3 and tell me what it outputs."*

> *"Fix the bug in cell 5 and rerun it."*

> *"Delete cells 10 and 11."*

> *"Restart the notebook kernel and rerun everything from the top."*

The AI understands the context of your notebook and operates on it step by step — no copy-pasting required.

---

## Available Tools (Complete Reference)

ClawPyter provides **18 tools** (15 core + 3 compatibility wrappers) organized into three categories. All tools use the format `jupyter:TOOLNAME`.

### Server Management Tools (3 tools)
These tools inspect the Jupyter server's filesystem and kernel state.

#### `jupyter:list_files`
**Purpose:** Explore and list files/directories in the Jupyter server's workspace.

**When to use:** Locate notebook files, explore directory structure, check file existence.

**Key parameters:** `path`, `max_depth` (1-3), `pattern` (glob filter), `limit` (default: 25)

**Returns:** Tab-separated table with file path, type, size, and modification timestamp.

---

#### `jupyter:list_kernels`
**Purpose:** List all available and running kernels (computation engines).

**When to use:** Check kernel availability/status, monitor kernel resources, identify kernel IDs.

**Returns:** Table with kernel ID, name, language, state (idle/busy), connections, and last activity.

---

#### `jupyter:connect_to_jupyter`
**Purpose:** Dynamically connect to a different Jupyter server without restarting.

**When to use:** Switch to another Jupyter server instance, connect with authentication token.

**Key parameters:** `jupyter_url` (required), `jupyter_token` (optional), `provider` (default: jupyter)

**Important:** Not available when running as a Jupyter extension.

---

### Notebook Management Tools (5 core + 3 compatibility)
These tools manage notebook sessions, activation, and inspection.

#### `jupyter:use_notebook` ⭐ REQUIRED FIRST STEP
**Purpose:** Activate a notebook for all subsequent cell operations.

**CRITICAL:** Call this FIRST before ANY cell operations. Never skip this step.

**Key parameters (ALL REQUIRED):**
- `notebook_path`: File path relative to server root (e.g., `analysis.ipynb`)
- `notebook_name`: Unique session identifier (MUST be non-empty)
- `mode` (optional): `"connect"` or `"create"` (default: `"connect"`)
- `kernel_id` (optional): Specific kernel to attach

---

#### `jupyter:list_notebooks`
**Purpose:** List all notebooks currently managed by the session handler.

**When to use:** Verify active notebook, confirm activation, see all open sessions.

**Returns:** Table with notebook name, path, kernel ID, kernel status, and active indicator.

---

#### `jupyter:read_notebook`
**Purpose:** Read notebook structure and cell contents.

**When to use:** Inspect cells before editing, understand notebook structure, review content.

**Key parameters:**
- `notebook_name` (required): Identifier from `jupyter:list_notebooks`
- `response_format` (optional): `"brief"` (fast overview) or `"detailed"` (full source)
- Pagination options: `start_index`, `limit`

**Best practice:** First call with `brief` to scan, then `detailed` for specific cells.

---

#### `jupyter:restart_notebook`
**Purpose:** Restart the kernel and clear memory state.

**When to use:** Reset to clean state, fix stuck kernels, clear variables and outputs.

**Key parameters:** `notebook_name` (required)

---

#### `jupyter:unuse_notebook`
**Purpose:** Disconnect from and release a notebook session.

**When to use:** Finish notebook work, free resources, clear active notebook.

**Key parameters:** `notebook_name` (required)

---

#### Compatibility Wrappers (3 tools)
For backward compatibility:
- `jupyter:restart_notebook_compat` — Falls back to `notebook_path` if needed
- `jupyter:unuse_notebook_compat` — Falls back to `notebook_path` if needed
- `jupyter:read_notebook_compat` — Falls back to `notebook_path` if needed

**Recommendation:** Prefer strict versions (without `_compat`) for new code.

---

### Cell Operations (7 tools)
These tools manipulate and execute cells in the active notebook.

#### `jupyter:insert_cell`
**Purpose:** Insert a new cell at a specified position.

**Parameters:** `cell_index` (0-based, -1=append), `cell_type` (code/markdown), `cell_source`

**Returns:** Success message with surrounding cell structure.

---

#### `jupyter:overwrite_cell_source`
**Purpose:** Replace the entire content of an existing cell.

**Parameters:** `cell_index` (0-based), `cell_source` (complete new content)

**Returns:** Diff-style comparison (+ for additions, - for deletions).

---

#### `jupyter:execute_cell`
**Purpose:** Run a specific cell and return its outputs.

**Parameters:** `cell_index` (0-based), `timeout` (default: 90), `stream` (for long tasks)

**Returns:** Cell outputs (text, HTML, images, errors).

---

#### `jupyter:insert_execute_code_cell` ⭐ PREFERRED
**Purpose:** Insert a code cell AND execute it immediately (preferred over separate calls).

**Parameters:** `cell_index` (-1=append), `cell_source`, `timeout`

**Returns:** Both insertion confirmation and execution outputs.

---

#### `jupyter:read_cell`
**Purpose:** Read a single cell with metadata and outputs.

**Parameters:** `cell_index` (0-based), `include_outputs` (default: true)

**Returns:** Cell metadata, source, and outputs (if applicable).

---

#### `jupyter:delete_cell`
**Purpose:** Delete one or more cells.

**Parameters:** `cell_indices` (list of 0-based positions), `include_source` (default: true)

**CRITICAL:** Delete in DESCENDING order to prevent index shifting.

---

#### `jupyter:execute_code`
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

**Critical Rules:**
- ALWAYS call `jupyter:use_notebook` first before ANY cell operations
- ALWAYS delete cells in DESCENDING index order
- ALWAYS use 0-based indexing (first cell = 0, not 1)
- ALWAYS use `jupyter:insert_execute_code_cell` when inserting and running together

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
- Use colon format: `jupyter:tool_name` (not `jupyter_tool_name`)

---

**Notebook operations fail even though the file exists**

You MUST explicitly open a notebook before operating on its cells:
1. Call `jupyter:use_notebook` with the notebook path and name
2. Call `jupyter:list_notebooks` to confirm activation
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
- OpenClaw tool names (`jupyter:*` format)
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

## Reference: MCP Server Specification

ClawPyter implements the **[jupyter-mcp-server](https://github.com/anthropics/jupyter-mcp-server)** specification:

| Category | Core Tools | Compatibility Wrappers | Total |
|---|:---:|:---:|:---:|
| Server Management | 3 | 0 | 3 |
| Notebook Management | 5 | 3 | 8 |
| Cell Operations | 7 | 0 | 7 |
| **Total** | **15** | **3** | **18** |

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
