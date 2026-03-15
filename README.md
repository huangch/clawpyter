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

## Available Tools (What the AI Can Do)

ClawPyter gives the AI 15 tools organized into three groups:

### Server Management
| Tool | What It Does |
|---|---|
| `jupyter_list_files` | Browse files and folders in your Jupyter workspace |
| `jupyter_list_kernels` | List all running computation engines (kernels) |
| `jupyter_connect_to_jupyter` | Switch to a different Jupyter server during a session |

### Notebook Management
| Tool | What It Does |
|---|---|
| `jupyter_use_notebook` | Open/activate a notebook so the AI can work with it |
| `jupyter_list_notebooks` | See which notebooks are currently open and active |
| `jupyter_read_notebook` | Read the cells of an open notebook |
| `jupyter_restart_notebook` | Restart the kernel and clear the notebook's memory |
| `jupyter_unuse_notebook` | Close and release a notebook session |

### Cell Operations
| Tool | What It Does |
|---|---|
| `jupyter_insert_cell` | Insert a new code or text cell at any position |
| `jupyter_overwrite_cell_source` | Replace the contents of an existing cell |
| `jupyter_execute_cell` | Run a specific cell and return its output |
| `jupyter_insert_execute_code_cell` | Insert a new cell and run it immediately |
| `jupyter_read_cell` | Read one specific cell including its output |
| `jupyter_delete_cell` | Delete one or more cells |
| `jupyter_execute_code` | Run code temporarily without saving it to the notebook |

---

## Typical Workflow

When the AI works with a notebook, it follows a safe sequence:

1. **Locate the file** — confirm the notebook exists in your workspace
2. **Open the notebook** — activate it so subsequent operations target the right file
3. **Read the notebook** — scan its current cells to understand context
4. **Perform operations** — insert, edit, run, or delete cells as needed

This prevents the AI from accidentally modifying the wrong notebook or operating on stale information.

---

## Troubleshooting

**The AI says it can't reach Jupyter.**
Make sure you've run `./start_jpy.sh` and that both JupyterLab (port 8888) and jupyter-mcp-server (port 4040) are running. You can check with:
```bash
curl http://127.0.0.1:4040
```

**Rebuild fails with permission errors.**
The `rebuild.sh` script requires `sudo` for some steps. Make sure your user account has sudo privileges.

**Notebook operations fail even though the file exists.**
The AI needs to explicitly *open* a notebook before it can read or edit its cells. If something feels stuck, ask the AI to "re-open the notebook" or restart the kernel.

**JupyterLab logs.**
If something isn't working as expected, you can inspect the logs:
```bash
cat /tmp/jupyterlab.log
cat /tmp/jupytermcp.log
```

---

## Project Structure

```
clawpyter/
├── src/
│   ├── index.ts                # Plugin entry point — registers all 15 tools with OpenClaw
│   └── jupyter-mcp-client.ts   # HTTP client that talks to jupyter-mcp-server
├── skills/
│   └── ClawPyter/
│       └── SKILL.md            # Instructions that teach the AI how to use these tools
├── openclaw.plugin.json        # Plugin metadata and configuration schema
├── package.json                # Node.js project definition
├── tsconfig.json               # TypeScript compiler settings
├── install.sh                  # Build and install script
├── start_jpy.sh                # Start JupyterLab + bridge server
└── stop_jpy.sh                 # Stop JupyterLab + bridge server
```

---

## License

See the repository for license details.

---

## Credits

ClawPyter integrates with:
- [OpenClaw](https://openclaw.ai) — the AI agent platform this plugin extends
- [JupyterLab](https://jupyter.org) — the interactive notebook environment
- [jupyter-mcp-tools](https://pypi.org/project/jupyter-mcp-tools/) — the Jupyter MCP server that bridges AI and Jupyter
