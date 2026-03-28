import { Type } from "@sinclair/typebox";
import { JupyterDirectClient } from "./jupyter-client.js";
function requireNotebookPath(params, cfg) {
    const explicit = typeof params.notebook_path === "string" ? params.notebook_path : undefined;
    const notebook = explicit ?? cfg.defaultNotebook;
    if (!notebook) {
        throw new Error("No notebook_path provided and no defaultNotebook configured.");
    }
    return notebook;
}
function resolveNotebookIdentifier(params, cfg) {
    const notebookName = typeof params.notebook_name === "string" ? params.notebook_name : undefined;
    if (notebookName && notebookName.trim()) {
        return notebookName;
    }
    return requireNotebookPath(params, cfg);
}
function formatTSV(headers, rows) {
    const lines = [headers.join("\t"), ...rows.map((r) => r.join("\t"))];
    return lines.join("\n");
}
export default function register(api) {
    const cfg = api?.pluginConfig ?? api?.config ?? {};
    const jupyter_url = cfg.jupyterUrl ?? "http://127.0.0.1:8888";
    const jupyter_token = cfg.jupyterToken ?? "";
    const timeout_ms = cfg.timeoutMs ?? 30000;
    const client = new JupyterDirectClient(jupyter_url, jupyter_token, timeout_ms);
    // Helper: Construct a full Jupyter Lab URL with authentication token
    function buildLabUrl(notebookPath) {
        const cleanPath = notebookPath.replace(/^\/+/, "");
        return `${jupyter_url}/lab/tree/${cleanPath}?token=${jupyter_token}`;
    }
    // Helper: Resolve notebook name for creation with conflict detection
    async function resolveNewNotebookName(explicitName, cfg) {
        let baseName = explicitName || cfg.defaultNotebook || "Untitled";
        if (!baseName.endsWith(".ipynb")) {
            baseName += ".ipynb";
        }
        // List existing files to detect conflicts
        const listing = await client.listFiles("", 1, baseName.replace(".ipynb", "") + "*");
        const existingFiles = new Set();
        for (const line of listing.split("\n")) {
            if (line.trim() && !line.startsWith("Path\t") && !line.startsWith("No files")) {
                const parts = line.split("\t");
                if (parts.length > 0 && parts[0]) {
                    existingFiles.add(parts[0]);
                }
            }
        }
        if (!existingFiles.has(baseName)) {
            return baseName;
        }
        const baseWithoutExt = baseName.replace(".ipynb", "");
        let counter = 1;
        while (true) {
            const candidateName = `${baseWithoutExt}-${counter}.ipynb`;
            if (!existingFiles.has(candidateName)) {
                return candidateName;
            }
            counter++;
        }
    }
    // ---------------------------------------------------------------------------
    // jupyter_create_notebook
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_create_notebook",
        description: "Create a new notebook with automatic name conflict detection. If no notebook name is provided, uses defaultNotebook from config or 'Untitled'. If the notebook file already exists, automatically appends a number suffix (-1, -2, etc.) until a unique name is found. Returns success message with the created notebook name and access URL.",
        parameters: Type.Object({
            notebook_name: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_create_notebook", params, _id });
            const explicitName = typeof params.notebook_name === "string" ? params.notebook_name : undefined;
            const resolvedNotebookName = await resolveNewNotebookName(explicitName, cfg);
            await client.createNotebook(resolvedNotebookName);
            const session = await client.createSession(resolvedNotebookName);
            client.addSession(resolvedNotebookName, {
                path: resolvedNotebookName,
                kernelId: session.kernel.id,
                sessionId: session.id,
            });
            client.setCurrentNotebook(resolvedNotebookName);
            const url = buildLabUrl(resolvedNotebookName);
            const message = `Notebook **${resolvedNotebookName}** created successfully.\n\nAccess URL:\n${url}`;
            console.log("Tool result:", { _id, name: "jupyter_create_notebook", result: message });
            return JupyterDirectClient.asToolText("Notebook created", message);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_server_info
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_server_info",
        description: "Retrieve current configuration settings for both Jupyter server and MCP server. Returns the effective connection parameters and timeouts including: Jupyter server URL (jupyter_url) and Jupyter authentication token (jupyter_token). Use this tool to verify server connectivity details, construct notebook URLs, or diagnose connection issues.",
        parameters: Type.Object({}),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_server_info", params, _id });
            const info = { jupyter_url, jupyter_token };
            const result = JSON.stringify(info, null, 2);
            console.log("Tool result:", { _id, name: "jupyter_server_info", result });
            return JupyterDirectClient.asToolText("Jupyter server info", result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_list_files
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_list_files",
        description: "List all files and directories recursively in the Jupyter server's file system. Used to explore the file system structure of the Jupyter server or to find specific files or directories. Returns tab-separated table with columns: Path, Type, Size, Last_Modified. Supports pagination and glob pattern filtering.",
        parameters: Type.Object({
            path: Type.Optional(Type.String()),
            max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
            start_index: Type.Optional(Type.Integer({ minimum: 0 })),
            limit: Type.Optional(Type.Integer({ minimum: 0 })),
            pattern: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_list_files", params, _id });
            const path = typeof params.path === "string" ? params.path : "";
            const maxDepth = typeof params.max_depth === "number" ? params.max_depth : 1;
            const pattern = typeof params.pattern === "string" ? params.pattern : "";
            const startIndex = typeof params.start_index === "number" ? params.start_index : 0;
            const limit = typeof params.limit === "number" ? params.limit : 25;
            const result = await client.listFiles(path, maxDepth, pattern);
            // Apply pagination to result lines (skip TSV header)
            const lines = result.split("\n");
            if (lines.length > 1 && lines[0].startsWith("Path\t")) {
                const header = lines[0];
                const rows = lines.slice(1);
                const total = rows.length;
                const end = limit > 0 ? Math.min(startIndex + limit, total) : total;
                const paginated = rows.slice(startIndex, end);
                const pagResult = `Showing ${startIndex}-${end} of ${total} files\n\n${header}\n${paginated.join("\n")}`;
                console.log("Tool result:", { _id, name: "jupyter_list_files" });
                return JupyterDirectClient.asToolText("Jupyter files", pagResult);
            }
            console.log("Tool result:", { _id, name: "jupyter_list_files" });
            return JupyterDirectClient.asToolText("Jupyter files", result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_list_kernels
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_list_kernels",
        description: "List all available kernels in the Jupyter server. This tool shows all running and available kernel sessions on the Jupyter server, including their IDs, names, states, connection information, and kernel specifications. Useful for monitoring kernel resources and identifying specific kernels for connection. Returns tab-separated table with columns: ID, Name, Display_Name, Language, State, Connections, Last_Activity, Environment.",
        parameters: Type.Object({}),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_list_kernels", params, _id });
            const result = await client.listKernels();
            console.log("Tool result:", { _id, name: "jupyter_list_kernels" });
            return JupyterDirectClient.asToolText("Jupyter kernels", result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_connect_to_jupyter
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_connect_to_jupyter",
        description: "Connect to a Jupyter server dynamically with URL and token. This tool allows you to connect to different Jupyter servers without needing to restart the MCP server or modify configuration files. Not available when running MCP server as a Jupyter extension; use pre-configured connection details in that case. Returns connection status message confirming successful connection.",
        parameters: Type.Object({
            jupyter_url: Type.String(),
            jupyter_token: Type.Optional(Type.String()),
            provider: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_connect_to_jupyter", params, _id });
            const url = String(params.jupyter_url ?? "");
            const token = typeof params.jupyter_token === "string" ? params.jupyter_token : "";
            client.updateUrl(url, token);
            const result = `Connected to Jupyter server at ${url}`;
            console.log("Tool result:", { _id, name: "jupyter_connect_to_jupyter", result });
            return JupyterDirectClient.asToolText(`Connect to Jupyter: ${url}`, result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_use_notebook
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_use_notebook",
        description: "Use a notebook and activate it for following cell operations. Provide notebook_name as a unique identifier for the notebook and notebook_path as the file path relative to the Jupyter server root. Select mode: 'connect' to connect to existing notebook or 'create' to create new notebook (default: 'connect'). Optionally specify kernel_id to attach a specific kernel. Returns success message with notebook information including activation status, kernel details, and notebook overview.",
        parameters: Type.Object({
            notebook_path: Type.String(),
            notebook_name: Type.String(),
            mode: Type.Optional(Type.Union([Type.Literal("connect"), Type.Literal("create")])),
            kernel_id: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_use_notebook", params, _id });
            const notebookPath = String(params.notebook_path ?? "");
            const notebookName = String(params.notebook_name ?? "");
            const mode = params.mode === "create" ? "create" : "connect";
            const requestedKernelId = typeof params.kernel_id === "string" ? params.kernel_id : undefined;
            const infoLines = [];
            // Check if already tracked
            const existing = client.getSession(notebookName);
            if (existing) {
                if (mode === "create" && existing.path === notebookPath) {
                    return JupyterDirectClient.asToolText(`Use notebook: ${notebookPath}`, `Notebook '${notebookName}' (path: ${notebookPath}) is already created. DO NOT CREATE AGAIN.`);
                }
                if (existing.path === notebookPath) {
                    if (notebookName === client.getCurrentNotebook()) {
                        return JupyterDirectClient.asToolText(`Use notebook: ${notebookPath}`, `Notebook '${notebookName}' is already activated now. DO NOT REACTIVATE AGAIN.`);
                    }
                    infoLines.push(`[INFO] Reactivating notebook '${notebookName}'`);
                    client.setCurrentNotebook(notebookName);
                }
                else {
                    return JupyterDirectClient.asToolText(`Use notebook: ${notebookPath}`, `The path '${notebookPath}' is not the correct path for notebook '${notebookName}'. Do you mean connect to '${existing.path}'?`);
                }
            }
            else {
                if (mode === "create") {
                    await client.createNotebook(notebookPath);
                    infoLines.push(`[INFO] Notebook file '${notebookPath}' created.`);
                }
                const session = await client.createSession(notebookPath, requestedKernelId);
                client.addSession(notebookName, {
                    path: notebookPath,
                    kernelId: session.kernel.id,
                    sessionId: session.id,
                });
                client.setCurrentNotebook(notebookName);
                infoLines.push(`[INFO] Connected to kernel '${session.kernel.id}'.`);
                infoLines.push(`[INFO] Successfully activated notebook '${notebookName}'.`);
            }
            // Return notebook overview
            try {
                const nb = await client.getContents(notebookPath);
                infoLines.push(`\nNotebook has ${nb.cells.length} cells.`);
                infoLines.push(`Showing first ${Math.min(20, nb.cells.length)} cells:\n`);
                infoLines.push(JupyterDirectClient.formatCells(nb, "brief", 0, 20));
            }
            catch {
                // Best-effort
            }
            const result = infoLines.join("\n");
            console.log("Tool result:", { _id, name: "jupyter_use_notebook" });
            return JupyterDirectClient.asToolText(`Use notebook: ${notebookPath}`, result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_list_notebooks
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_list_notebooks",
        description: "List all notebooks that have been used via use_notebook tool. Returns TSV formatted table with notebook information: Name (unique identifier), Path (file path), Kernel_ID (associated kernel), Kernel_Status (kernel status), and Activate (✓ if currently active). Use this to inspect notebook session state after activating or switching notebooks.",
        parameters: Type.Object({}),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_list_notebooks", params, _id });
            const sessions = client.getAllSessions();
            if (sessions.size === 0) {
                return JupyterDirectClient.asToolText("Jupyter notebooks", "No notebooks currently in use.");
            }
            const current = client.getCurrentNotebook();
            const rows = [];
            for (const [name, sess] of sessions.entries()) {
                rows.push([
                    name,
                    sess.path,
                    sess.kernelId,
                    "unknown",
                    name === current ? "✓" : "",
                ]);
            }
            const result = formatTSV(["Name", "Path", "Kernel_ID", "Kernel_Status", "Activate"], rows);
            console.log("Tool result:", { _id, name: "jupyter_list_notebooks" });
            return JupyterDirectClient.asToolText("Jupyter notebooks", result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_restart_notebook
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_restart_notebook",
        description: "Restart the kernel for a specific notebook. Requires notebook_name (notebook identifier as reported by list_notebooks). Returns success message confirming the kernel has been restarted and memory state cleared.",
        parameters: Type.Object({
            notebook_name: Type.String(),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_restart_notebook", params, _id });
            const notebookName = String(params.notebook_name ?? "");
            const sess = client.getSession(notebookName);
            if (!sess) {
                return JupyterDirectClient.asToolText(`Restart notebook: ${notebookName}`, `Notebook '${notebookName}' is not connected.`);
            }
            await client.restartKernel(sess.kernelId);
            const result = `Kernel for notebook '${notebookName}' restarted successfully.`;
            console.log("Tool result:", { _id, name: "jupyter_restart_notebook" });
            return JupyterDirectClient.asToolText(`Restart notebook: ${notebookName}`, result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_restart_notebook_compat
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_restart_notebook_compat",
        description: "(Compatibility wrapper) Restart the kernel for a specific notebook. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
        parameters: Type.Object({
            notebook_name: Type.Optional(Type.String()),
            notebook_path: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_restart_notebook_compat", params, _id });
            const notebookName = resolveNotebookIdentifier(params, cfg);
            const sess = client.getSession(notebookName);
            if (!sess) {
                return JupyterDirectClient.asToolText(`Restart notebook: ${notebookName}`, `Notebook '${notebookName}' is not connected.`);
            }
            await client.restartKernel(sess.kernelId);
            const result = `Kernel for notebook '${notebookName}' restarted successfully.`;
            console.log("Tool result:", { _id, name: "jupyter_restart_notebook_compat" });
            return JupyterDirectClient.asToolText(`Restart notebook: ${notebookName}`, result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_unuse_notebook
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_unuse_notebook",
        description: "Unuse from a specific notebook and release its resources. Requires notebook_name (notebook identifier as reported by list_notebooks). Returns success message confirming the notebook has been disconnected and resources released.",
        parameters: Type.Object({
            notebook_name: Type.String(),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_unuse_notebook", params, _id });
            const notebookName = String(params.notebook_name ?? "");
            const sess = client.getSession(notebookName);
            if (!sess) {
                return JupyterDirectClient.asToolText(`Unuse notebook: ${notebookName}`, `Notebook '${notebookName}' is not connected.`);
            }
            await client.deleteSession(sess.sessionId);
            client.removeSession(notebookName);
            const result = `Notebook '${notebookName}' disconnected and resources released.`;
            console.log("Tool result:", { _id, name: "jupyter_unuse_notebook" });
            return JupyterDirectClient.asToolText(`Unuse notebook: ${notebookName}`, result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_unuse_notebook_compat
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_unuse_notebook_compat",
        description: "(Compatibility wrapper) Unuse from a specific notebook and release its resources. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
        parameters: Type.Object({
            notebook_name: Type.Optional(Type.String()),
            notebook_path: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_unuse_notebook_compat", params, _id });
            const notebookName = resolveNotebookIdentifier(params, cfg);
            const sess = client.getSession(notebookName);
            if (!sess) {
                return JupyterDirectClient.asToolText(`Unuse notebook: ${notebookName}`, `Notebook '${notebookName}' is not connected.`);
            }
            await client.deleteSession(sess.sessionId);
            client.removeSession(notebookName);
            const result = `Notebook '${notebookName}' disconnected and resources released.`;
            console.log("Tool result:", { _id, name: "jupyter_unuse_notebook_compat" });
            return JupyterDirectClient.asToolText(`Unuse notebook: ${notebookName}`, result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_read_notebook
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_read_notebook",
        description: "Read a notebook and return index, source content, type, execution count of each cell. Using brief format returns first line and line count (useful for quick overview), detailed format returns full cell source (useful for debugging). Recommended workflow: use brief format with larger limit to get overview, then use detailed format with exact index and limit for specific cells. Returns notebook content with cell details, metadata, and pagination information.",
        parameters: Type.Object({
            notebook_name: Type.String(),
            response_format: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("detailed")])),
            start_index: Type.Optional(Type.Integer({ minimum: 0 })),
            limit: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_read_notebook", params, _id });
            const notebookName = String(params.notebook_name ?? "");
            const sess = client.getSession(notebookName);
            if (!sess) {
                return JupyterDirectClient.asToolText(`Read notebook: ${notebookName}`, `Notebook '${notebookName}' is not connected.`);
            }
            const format = params.response_format === "detailed" ? "detailed" : "brief";
            const startIndex = typeof params.start_index === "number" ? params.start_index : 0;
            const limit = typeof params.limit === "number" ? params.limit : 20;
            const nb = await client.getContents(sess.path);
            const output = `Notebook ${notebookName} has ${nb.cells.length} cells.\n\n` +
                JupyterDirectClient.formatCells(nb, format, startIndex, limit);
            console.log("Tool result:", { _id, name: "jupyter_read_notebook" });
            return JupyterDirectClient.asToolText(`Read notebook: ${notebookName}`, output);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_read_notebook_compat
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_read_notebook_compat",
        description: "(Compatibility wrapper) Read a notebook. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
        parameters: Type.Object({
            notebook_name: Type.Optional(Type.String()),
            notebook_path: Type.Optional(Type.String()),
            response_format: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("detailed")])),
            start_index: Type.Optional(Type.Integer({ minimum: 0 })),
            limit: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_read_notebook_compat", params, _id });
            const notebookName = resolveNotebookIdentifier(params, cfg);
            const sess = client.getSession(notebookName);
            if (!sess) {
                return JupyterDirectClient.asToolText(`Read notebook: ${notebookName}`, `Notebook '${notebookName}' is not connected.`);
            }
            const format = params.response_format === "detailed" ? "detailed" : "brief";
            const startIndex = typeof params.start_index === "number" ? params.start_index : 0;
            const limit = typeof params.limit === "number" ? params.limit : 20;
            const nb = await client.getContents(sess.path);
            const output = `Notebook ${notebookName} has ${nb.cells.length} cells.\n\n` +
                JupyterDirectClient.formatCells(nb, format, startIndex, limit);
            console.log("Tool result:", { _id, name: "jupyter_read_notebook_compat" });
            return JupyterDirectClient.asToolText(`Read notebook: ${notebookName}`, output);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_insert_cell
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_insert_cell",
        description: "Insert a cell to specified position from the currently activated notebook. Requires cell_index (0-based, use -1 to append at end), cell_type ('code' or 'markdown'), and cell_source (cell content). Returns success message with insertion confirmation and structure of surrounding cells (up to 5 cells above and below).",
        parameters: Type.Object({
            cell_index: Type.Integer({ minimum: -1 }),
            cell_type: Type.Union([
                Type.Literal("code"),
                Type.Literal("markdown"),
            ]),
            cell_source: Type.String(),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_insert_cell", params, _id });
            const current = client.getCurrentNotebook();
            if (!current) {
                return JupyterDirectClient.asToolText("Insert cell", "No active notebook. Use jupyter_use_notebook first.");
            }
            const sess = client.getSession(current);
            const nb = await client.getContents(sess.path);
            const totalCells = nb.cells.length;
            const cellIndex = typeof params.cell_index === "number" ? params.cell_index : -1;
            if (cellIndex < -1 || cellIndex > totalCells) {
                return JupyterDirectClient.asToolText("Insert cell", `Index ${cellIndex} is outside valid range [-1, ${totalCells}]. Use -1 to append at end.`);
            }
            const actualIndex = cellIndex === -1 ? totalCells : cellIndex;
            const cellType = String(params.cell_type ?? "code");
            const cellSource = String(params.cell_source ?? "");
            const newCell = {
                cell_type: cellType,
                source: cellSource,
                metadata: {},
            };
            if (cellType === "code") {
                newCell.outputs = [];
                newCell.execution_count = null;
            }
            nb.cells.splice(actualIndex, 0, newCell);
            await client.putContents(sess.path, nb);
            const newTotal = nb.cells.length;
            const startCtx = Math.max(0, actualIndex - 5);
            const output = [
                `Cell inserted successfully at index ${actualIndex} (${cellType})!`,
                `Notebook now has ${newTotal} cells, showing surrounding cells:`,
                JupyterDirectClient.formatCells(nb, "brief", startCtx, 10),
            ].join("\n");
            console.log("Tool result:", { _id, name: "jupyter_insert_cell" });
            return JupyterDirectClient.asToolText("Insert cell", output);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_overwrite_cell_source
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_overwrite_cell_source",
        description: "Overwrite the source of a specific cell from the currently activated notebook. Returns diff style comparison (+ for new lines, - for deleted lines) of the cell's content. Requires cell_index (0-based) and cell_source (new complete cell source).",
        parameters: Type.Object({
            cell_index: Type.Integer({ minimum: 0 }),
            cell_source: Type.String(),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_overwrite_cell_source", params, _id });
            const current = client.getCurrentNotebook();
            if (!current) {
                return JupyterDirectClient.asToolText("Overwrite cell", "No active notebook. Use jupyter_use_notebook first.");
            }
            const sess = client.getSession(current);
            const nb = await client.getContents(sess.path);
            const cellIndex = typeof params.cell_index === "number" ? params.cell_index : 0;
            if (cellIndex >= nb.cells.length) {
                return JupyterDirectClient.asToolText(`Overwrite cell ${cellIndex}`, `Cell index ${cellIndex} is out of range. Notebook has ${nb.cells.length} cells.`);
            }
            const cell = nb.cells[cellIndex];
            const oldSource = cell.source;
            const newSource = String(params.cell_source ?? "");
            cell.source = newSource;
            if (cell.cell_type === "code") {
                cell.outputs = [];
                cell.execution_count = null;
            }
            await client.putContents(sess.path, nb);
            const diff = JupyterDirectClient.diffSource(oldSource, newSource);
            console.log("Tool result:", { _id, name: "jupyter_overwrite_cell_source" });
            return JupyterDirectClient.asToolText(`Overwrite cell ${cellIndex}`, diff);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_execute_cell
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_execute_cell",
        description: "Execute a cell from the currently activated notebook with timeout and return its outputs. Requires cell_index (0-based). Optional timeout (default: 90 seconds) controls maximum wait. Optional stream (default: false) enables streaming progress updates; progress_interval (default: 5 seconds) controls update frequency for long-running cells. Returns list of outputs including text, HTML, and images.",
        parameters: Type.Object({
            cell_index: Type.Integer({ minimum: 0 }),
            timeout: Type.Optional(Type.Integer({ minimum: 1 })),
            stream: Type.Optional(Type.Boolean()),
            progress_interval: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_execute_cell", params, _id });
            const current = client.getCurrentNotebook();
            if (!current) {
                return JupyterDirectClient.asToolText("Execute cell", "No active notebook. Use jupyter_use_notebook first.");
            }
            const sess = client.getSession(current);
            const nb = await client.getContents(sess.path);
            const cellIndex = typeof params.cell_index === "number" ? params.cell_index : 0;
            if (cellIndex >= nb.cells.length) {
                return JupyterDirectClient.asToolText(`Execute cell ${cellIndex}`, `Cell index ${cellIndex} is out of range. Notebook has ${nb.cells.length} cells.`);
            }
            const cell = nb.cells[cellIndex];
            if (cell.cell_type !== "code") {
                return JupyterDirectClient.asToolText(`Execute cell ${cellIndex}`, `Cell ${cellIndex} is not a code cell (type: ${cell.cell_type}).`);
            }
            const timeoutMs = (typeof params.timeout === "number" ? params.timeout : 90) * 1000;
            const outputs = await client.executeCode(sess.kernelId, cell.source, timeoutMs);
            // Write outputs back to the notebook
            cell.outputs = outputs.map((text) => ({
                output_type: "stream",
                name: "stdout",
                text,
            }));
            cell.execution_count = (cell.execution_count ?? 0) + 1;
            await client.putContents(sess.path, nb);
            console.log("Tool result:", { _id, name: "jupyter_execute_cell" });
            return JupyterDirectClient.asToolText(`Execute cell ${cellIndex}`, outputs);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_insert_execute_code_cell
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_insert_execute_code_cell",
        description: "Insert a cell at specified index from the currently activated notebook and then execute it. This is the preferred shortcut when you want to insert a cell and execute it at the same time. Requires cell_index (0-based, -1 to append) and cell_source (code). Optional timeout (default: 90 seconds) controls execution wait. Returns both insertion confirmation and execution results including outputs.",
        parameters: Type.Object({
            cell_index: Type.Integer({ minimum: -1 }),
            cell_source: Type.String(),
            timeout: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_insert_execute_code_cell", params, _id });
            const current = client.getCurrentNotebook();
            if (!current) {
                return JupyterDirectClient.asToolText("Insert + execute code cell", "No active notebook. Use jupyter_use_notebook first.");
            }
            const sess = client.getSession(current);
            const nb = await client.getContents(sess.path);
            const totalCells = nb.cells.length;
            const cellIndex = typeof params.cell_index === "number" ? params.cell_index : -1;
            if (cellIndex < -1 || cellIndex > totalCells) {
                return JupyterDirectClient.asToolText("Insert + execute code cell", `Index ${cellIndex} is outside valid range [-1, ${totalCells}]. Use -1 to append at end.`);
            }
            const actualIndex = cellIndex === -1 ? totalCells : cellIndex;
            const cellSource = String(params.cell_source ?? "");
            // Insert the cell
            const newCell = {
                cell_type: "code",
                source: cellSource,
                metadata: {},
                outputs: [],
                execution_count: null,
            };
            nb.cells.splice(actualIndex, 0, newCell);
            await client.putContents(sess.path, nb);
            // Execute
            const timeoutMs = (typeof params.timeout === "number" ? params.timeout : 90) * 1000;
            const outputs = await client.executeCode(sess.kernelId, cellSource, timeoutMs);
            // Write outputs back (re-fetch to avoid stale state)
            const freshNb = await client.getContents(sess.path);
            const insertedCell = freshNb.cells[actualIndex];
            if (insertedCell) {
                insertedCell.outputs = outputs.map((text) => ({
                    output_type: "stream",
                    name: "stdout",
                    text,
                }));
                insertedCell.execution_count = 1;
                await client.putContents(sess.path, freshNb);
            }
            const result = [
                `Cell inserted at index ${actualIndex} and executed.`,
                "Outputs:",
                ...outputs,
            ].join("\n");
            console.log("Tool result:", { _id, name: "jupyter_insert_execute_code_cell" });
            return JupyterDirectClient.asToolText(`Insert + execute code cell at ${actualIndex}`, result);
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_read_cell
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_read_cell",
        description: "Read a specific cell from the currently activated notebook and return its metadata (index, type, execution count), source and outputs (for code cells). Requires cell_index (0-based). Optional include_outputs (default: true) includes outputs for code cells only. Returns list containing cell metadata, source code, and outputs (if applicable).",
        parameters: Type.Object({
            cell_index: Type.Integer({ minimum: 0 }),
            include_outputs: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_read_cell", params, _id });
            const current = client.getCurrentNotebook();
            if (!current) {
                return JupyterDirectClient.asToolText("Read cell", "No active notebook. Use jupyter_use_notebook first.");
            }
            const sess = client.getSession(current);
            const nb = await client.getContents(sess.path);
            const cellIndex = typeof params.cell_index === "number" ? params.cell_index : 0;
            if (cellIndex >= nb.cells.length) {
                return JupyterDirectClient.asToolText(`Read cell ${cellIndex}`, `Cell index ${cellIndex} is out of range. Notebook has ${nb.cells.length} cells.`);
            }
            const cell = nb.cells[cellIndex];
            const includeOutputs = params.include_outputs !== false;
            const lines = [
                `Index: ${cellIndex}`,
                `Type: ${cell.cell_type}`,
                `Execution count: ${cell.execution_count ?? "-"}`,
                `Source:\n${cell.source}`,
            ];
            if (includeOutputs && cell.cell_type === "code" && cell.outputs && cell.outputs.length > 0) {
                lines.push("Outputs:");
                for (const out of cell.outputs) {
                    if (out.text) {
                        lines.push(Array.isArray(out.text) ? out.text.join("") : out.text);
                    }
                    else if (out.data) {
                        const plain = out.data["text/plain"];
                        if (plain)
                            lines.push(String(plain));
                    }
                }
            }
            console.log("Tool result:", { _id, name: "jupyter_read_cell" });
            return JupyterDirectClient.asToolText(`Read cell ${cellIndex}`, lines.join("\n"));
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_delete_cell
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_delete_cell",
        description: "Delete a specific cell or multiple cells from the currently activated notebook. Requires cell_indices (list of 0-based indices). Optional include_source (default: true) includes the source code of deleted cells. IMPORTANT: When deleting many cells, delete them in descending order of their index to avoid index shifting. Returns success message with deletion confirmation and source code of deleted cells (if include_source=true).",
        parameters: Type.Object({
            cell_indices: Type.Array(Type.Integer({ minimum: 0 })),
            include_source: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_delete_cell", params, _id });
            const current = client.getCurrentNotebook();
            if (!current) {
                return JupyterDirectClient.asToolText("Delete cells", "No active notebook. Use jupyter_use_notebook first.");
            }
            const sess = client.getSession(current);
            const nb = await client.getContents(sess.path);
            const rawIndices = Array.isArray(params.cell_indices) ? params.cell_indices : [];
            const includeSource = params.include_source !== false;
            // Sort descending to avoid index shifting
            const indices = [...rawIndices].sort((a, b) => b - a);
            const deletedSources = [];
            for (const idx of indices) {
                if (idx >= 0 && idx < nb.cells.length) {
                    if (includeSource) {
                        deletedSources.push(`[${idx}] ${nb.cells[idx].source}`);
                    }
                    nb.cells.splice(idx, 1);
                }
            }
            await client.putContents(sess.path, nb);
            const lines = [`Deleted ${indices.length} cell(s). Notebook now has ${nb.cells.length} cells.`];
            if (includeSource && deletedSources.length > 0) {
                lines.push("Deleted cell sources:");
                lines.push(...deletedSources);
            }
            console.log("Tool result:", { _id, name: "jupyter_delete_cell" });
            return JupyterDirectClient.asToolText("Delete cells", lines.join("\n"));
        },
    }, { optional: true });
    // ---------------------------------------------------------------------------
    // jupyter_execute_code
    // ---------------------------------------------------------------------------
    api.registerTool({
        name: "jupyter_execute_code",
        description: "Execute code directly in the kernel (not saved to notebook) on the current activated notebook. Support magic commands with % and shell commands with !. Recommended for: executing Jupyter magic commands (%timeit, %pip install), performance profiling and debugging, viewing intermediate variable values, temporary calculations, shell commands. Do NOT use for: importing modules or variable assignments affecting subsequent execution, executing dangerous code without permission, replacing proper notebook edits. Requires code. Optional timeout (default: 30, max: 60 seconds). Returns list of outputs including text, HTML, images, and shell command results.",
        parameters: Type.Object({
            code: Type.String(),
            timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
        }),
        async execute(_id, params) {
            console.log("Tool execution:", { name: "jupyter_execute_code", params, _id });
            const current = client.getCurrentNotebook();
            if (!current) {
                return JupyterDirectClient.asToolText("Execute code", "No active notebook. Use jupyter_use_notebook first.");
            }
            const sess = client.getSession(current);
            const code = String(params.code ?? "");
            const timeoutMs = (typeof params.timeout === "number" ? Math.min(params.timeout, 60) : 30) * 1000;
            const outputs = await client.executeCode(sess.kernelId, code, timeoutMs);
            console.log("Tool result:", { _id, name: "jupyter_execute_code" });
            return JupyterDirectClient.asToolText("Execute code", outputs);
        },
    }, { optional: true });
}
