import { Type, type TSchema } from "@sinclair/typebox";
import { JupyterMcpClient } from "./jupyter-mcp-client.js";

type PluginConfig = {
  mcpUrl?: string;
  jupyterToken?: string;
  jupyterUrl?: string;
  notebookDir?: string;
  defaultNotebook?: string;
  timeoutMs?: number;
};

type ToolDef = {
  openclawName: string;
  mcpName: string;
  description: string;
  parameters: TSchema;
  buildArgs: (
    params: Record<string, unknown>,
    cfg: PluginConfig,
  ) => Record<string, unknown>;
  title: (params: Record<string, unknown>) => string;
};

function requireNotebookPath(
  params: Record<string, unknown>,
  cfg: PluginConfig,
): string {
  const explicit =
    typeof params.notebook_path === "string" ? params.notebook_path : undefined;
  const notebook = explicit ?? cfg.defaultNotebook;

  if (!notebook) {
    throw new Error(
      "No notebook_path provided and no defaultNotebook configured.",
    );
  }

  return notebook;
}

function resolveNotebookIdentifier(
  params: Record<string, unknown>,
  cfg: PluginConfig,
): string {
  const notebookName =
    typeof params.notebook_name === "string" ? params.notebook_name : undefined;

  if (notebookName && notebookName.trim()) {
    return notebookName;
  }

  return requireNotebookPath(params, cfg);
}

export default function register(api: any) {
  const cfg: PluginConfig = api?.pluginConfig ?? api?.config ?? {};

  const mcp_url = cfg.mcpUrl ?? "http://127.0.0.1:4040";
  const jupyter_url = cfg.jupyterUrl ?? "http://127.0.0.1:8888";
  const jupyter_token = cfg.jupyterToken ?? "";
  const timeout_ms = cfg.timeoutMs ?? 30000;

  const client = new JupyterMcpClient(
    mcp_url,
    timeout_ms,
  );

  // Helper: Construct a full Jupyter Lab URL with authentication token
  function buildLabUrl(notebookPath: string): string {
    const cleanPath = notebookPath.replace(/^\/+/, "");
    return `${jupyter_url}/lab/tree/${cleanPath}?token=${jupyter_token}`;
  }

  // Helper: Resolve notebook name for creation with conflict detection
  async function resolveNewNotebookName(
    explicitName: string | undefined,
    cfg: PluginConfig,
  ): Promise<string> {
    // Use explicit name if provided, otherwise use defaultNotebook, fallback to "Untitled"
    let baseName = explicitName || cfg.defaultNotebook || "Untitled";
    // Ensure .ipynb extension
    if (!baseName.endsWith(".ipynb")) {
      baseName += ".ipynb";
    }

    // Check for file conflicts by listing files
    const listResponse = await client.callTool("list_files", {
      path: "",
      max_depth: 1,
      pattern: baseName.replace(".ipynb", "") + "*",
    });

    // Parse the response to extract file names
    const result = JupyterMcpClient.unwrap(listResponse);
    const lines = (typeof result === "string" ? result : JSON.stringify(result) || "")
      .split("\n");
    const existingFiles = new Set<string>();
    for (const line of lines) {
      if (line.trim()) {
        const parts = line.split("\t");
        if (parts.length > 0) {
          existingFiles.add(parts[0]);
        }
      }
    }

    // If baseName doesn't exist, use it
    if (!existingFiles.has(baseName)) {
      return baseName;
    }

    // Otherwise, find the next available numbered version
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

  api.registerTool(
    {
      name: "jupyter_create_notebook",
      description:
        "Create a new notebook with automatic name conflict detection. If no notebook name is provided, uses defaultNotebook from config or 'Untitled'. If the notebook file already exists, automatically appends a number suffix (-1, -2, etc.) until a unique name is found. Returns success message with the created notebook name and access URL.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", {
          name: "jupyter_create_notebook",
          params,
          _id,
        });

        const explicitName =
          typeof params.notebook_name === "string"
            ? params.notebook_name
            : undefined;
        const resolvedNotebookName = await resolveNewNotebookName(
          explicitName,
          cfg,
        );

        // Create and activate the notebook
        const response = await client.callTool("use_notebook", {
          notebook_path: resolvedNotebookName,
          notebook_name: resolvedNotebookName,
          mode: "create",
        });

        const result = JupyterMcpClient.unwrap(response);
        const url = buildLabUrl(resolvedNotebookName);

        const message = `Notebook **${resolvedNotebookName}** created successfully.\n\nAccess URL:\n${url}`;
        console.log("Tool result:", { _id, name: "jupyter_create_notebook", result });
        return JupyterMcpClient.asToolText("Notebook created", message);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "jupyter_server_info",
      description:
        "Retrieve current configuration settings for both Jupyter server and MCP server. Returns the effective connection parameters and timeouts including: Jupyter server URL (jupyter_url) and Jupyter authentication token (jupyter_token). Use this tool to verify server connectivity details, construct notebook URLs, or diagnose connection issues.",
      parameters: Type.Object({}),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", {
          name: "jupyter_server_info",
          description: "Retrieve current configuration settings for both Jupyter server and MCP server.",
          params,
          _id,
        });
        const info = {
          jupyter_url,
          jupyter_token,
        };
        const result = JSON.stringify(info, null, 2);
        console.log("Tool result:", { _id, name: "jupyter_server_info", result });
        return JupyterMcpClient.asToolText("Jupyter server info", result);
      },
    },
    { optional: true },
  );

  const toolDefs: ToolDef[] = [
    {
      openclawName: "jupyter_list_files",
      mcpName: "list_files",
      description:
        "List all files and directories recursively in the Jupyter server's file system. Used to explore the file system structure of the Jupyter server or to find specific files or directories. Returns tab-separated table with columns: Path, Type, Size, Last_Modified. Supports pagination and glob pattern filtering.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        start_index: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 0 })),
        pattern: Type.Optional(Type.String()),
      }),
      buildArgs: (params) => ({
        path: params.path ?? "",
        max_depth: params.max_depth ?? 1,
        start_index: params.start_index ?? 0,
        limit: params.limit ?? 25,
        pattern: params.pattern ?? "",
      }),
      title: () => "Jupyter files",
    },
    {
      openclawName: "jupyter_list_kernels",
      mcpName: "list_kernels",
      description:
        "List all available kernels in the Jupyter server. This tool shows all running and available kernel sessions on the Jupyter server, including their IDs, names, states, connection information, and kernel specifications. Useful for monitoring kernel resources and identifying specific kernels for connection. Returns tab-separated table with columns: ID, Name, Display_Name, Language, State, Connections, Last_Activity, Environment.",
      parameters: Type.Object({}),
      buildArgs: () => ({}),
      title: () => "Jupyter kernels",
    },
    {
      openclawName: "jupyter_connect_to_jupyter",
      mcpName: "connect_to_jupyter",
      description:
        "Connect to a Jupyter server dynamically with URL and token. This tool allows you to connect to different Jupyter servers without needing to restart the MCP server or modify configuration files. Not available when running MCP server as a Jupyter extension; use pre-configured connection details in that case. Returns connection status message confirming successful connection.",
      parameters: Type.Object({
        jupyter_url: Type.String(),
        jupyter_token: Type.Optional(Type.String()),
        provider: Type.Optional(Type.String()),
      }),
      buildArgs: (params) => ({
        jupyter_url: params.jupyter_url,
        jupyter_token: params.jupyter_token,
        provider: params.provider ?? "jupyter",
      }),
      title: (params) =>
        `Connect to Jupyter: ${String(params.jupyter_url ?? "")}`,
    },
    {
      openclawName: "jupyter_use_notebook",
      mcpName: "use_notebook",
      description:
        "Use a notebook and activate it for following cell operations. Provide notebook_name as a unique identifier for the notebook and notebook_path as the file path relative to the Jupyter server root. Select mode: 'connect' to connect to existing notebook or 'create' to create new notebook (default: 'connect'). Optionally specify kernel_id to attach a specific kernel. Returns success message with notebook information including activation status, kernel details, and notebook overview.",
      parameters: Type.Object({
        notebook_path: Type.String(),
        notebook_name: Type.String(),
        mode: Type.Optional(
          Type.Union([Type.Literal("connect"), Type.Literal("create")]),
        ),
        kernel_id: Type.Optional(Type.String()),
      }),
      buildArgs: (params) => {
        return {
          notebook_name: params.notebook_name,
          notebook_path: params.notebook_path,
          mode: params.mode ?? "connect",
          kernel_id: params.kernel_id,
        };
      },
      title: (params) => `Use notebook: ${String(params.notebook_path ?? "")}`,
    },
    {
      openclawName: "jupyter_list_notebooks",
      mcpName: "list_notebooks",
      description:
        "List all notebooks that have been used via use_notebook tool. Returns TSV formatted table with notebook information: Name (unique identifier), Path (file path), Kernel_ID (associated kernel), Kernel_Status (kernel status), and Activate (✓ if currently active). Use this to inspect notebook session state after activating or switching notebooks.",
      parameters: Type.Object({}),
      buildArgs: () => ({}),
      title: () => "Jupyter notebooks",
    },
    {
      openclawName: "jupyter_restart_notebook",
      mcpName: "restart_notebook",
      description:
        "Restart the kernel for a specific notebook. Requires notebook_name (notebook identifier as reported by list_notebooks). Returns success message confirming the kernel has been restarted and memory state cleared.",
      parameters: Type.Object({
        notebook_name: Type.String(),
      }),
      buildArgs: (params) => ({
        notebook_name: params.notebook_name,
      }),
      title: (params) =>
        `Restart notebook: ${String(params.notebook_name ?? "")}`,
    },
    {
      openclawName: "jupyter_restart_notebook_compat",
      mcpName: "restart_notebook",
      description:
        "(Compatibility wrapper) Restart the kernel for a specific notebook. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        notebook_path: Type.Optional(Type.String()),
      }),
      buildArgs: (params, cfg) => ({
        notebook_name: resolveNotebookIdentifier(params, cfg),
      }),
      title: (params) =>
        `Restart notebook: ${String(params.notebook_name ?? params.notebook_path ?? "")}`,
    },
    {
      openclawName: "jupyter_unuse_notebook",
      mcpName: "unuse_notebook",
      description:
        "Unuse from a specific notebook and release its resources. Requires notebook_name (notebook identifier as reported by list_notebooks). Returns success message confirming the notebook has been disconnected and resources released.",
      parameters: Type.Object({
        notebook_name: Type.String(),
      }),
      buildArgs: (params) => ({
        notebook_name: params.notebook_name,
      }),
      title: (params) =>
        `Unuse notebook: ${String(params.notebook_name ?? "")}`,
    },
    {
      openclawName: "jupyter_unuse_notebook_compat",
      mcpName: "unuse_notebook",
      description:
        "(Compatibility wrapper) Unuse from a specific notebook and release its resources. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        notebook_path: Type.Optional(Type.String()),
      }),
      buildArgs: (params, cfg) => ({
        notebook_name: resolveNotebookIdentifier(params, cfg),
      }),
      title: (params) =>
        `Unuse notebook: ${String(params.notebook_name ?? params.notebook_path ?? "")}`,
    },
    {
      openclawName: "jupyter_read_notebook",
      mcpName: "read_notebook",
      description:
        "Read a notebook and return index, source content, type, execution count of each cell. Using brief format returns first line and line count (useful for quick overview), detailed format returns full cell source (useful for debugging). Recommended workflow: use brief format with larger limit to get overview, then use detailed format with exact index and limit for specific cells. Returns notebook content with cell details, metadata, and pagination information.",
      parameters: Type.Object({
        notebook_name: Type.String(),
        response_format: Type.Optional(
          Type.Union([Type.Literal("brief"), Type.Literal("detailed")]),
        ),
        start_index: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      buildArgs: (params) => ({
        notebook_name: params.notebook_name,
        response_format: params.response_format ?? "brief",
        start_index: params.start_index ?? 0,
        limit: params.limit ?? 20,
      }),
      title: (params) =>
        `Read notebook: ${String(params.notebook_name ?? "")}`,
    },
    {
      openclawName: "jupyter_read_notebook_compat",
      mcpName: "read_notebook",
      description:
        "(Compatibility wrapper) Read a notebook. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        notebook_path: Type.Optional(Type.String()),
        response_format: Type.Optional(
          Type.Union([Type.Literal("brief"), Type.Literal("detailed")]),
        ),
        start_index: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      buildArgs: (params, cfg) => ({
        notebook_name: resolveNotebookIdentifier(params, cfg),
        response_format: params.response_format ?? "brief",
        start_index: params.start_index ?? 0,
        limit: params.limit ?? 20,
      }),
      title: (params) =>
        `Read notebook: ${String(params.notebook_name ?? params.notebook_path ?? "")}`,
    },
    {
      openclawName: "jupyter_insert_cell",
      mcpName: "insert_cell",
      description:
        "Insert a cell to specified position from the currently activated notebook. Requires cell_index (0-based, use -1 to append at end), cell_type ('code' or 'markdown'), and cell_source (cell content). Returns success message with insertion confirmation and structure of surrounding cells (up to 5 cells above and below).",
      parameters: Type.Object({
        cell_index: Type.Integer({ minimum: -1 }),
        cell_type: Type.Union([
          Type.Literal("code"),
          Type.Literal("markdown"),
        ]),
        cell_source: Type.String(),
      }),
      buildArgs: (params) => ({
        cell_index: params.cell_index,
        cell_type: params.cell_type,
        cell_source: params.cell_source,
      }),
      title: () => "Insert cell",
    },
    {
      openclawName: "jupyter_overwrite_cell_source",
      mcpName: "overwrite_cell_source",
      description:
        "Overwrite the source of a specific cell from the currently activated notebook. Returns diff style comparison (+ for new lines, - for deleted lines) of the cell's content. Requires cell_index (0-based) and cell_source (new complete cell source).",
      parameters: Type.Object({
        cell_index: Type.Integer({ minimum: 0 }),
        cell_source: Type.String(),
      }),
      buildArgs: (params) => ({
        cell_index: params.cell_index,
        cell_source: params.cell_source,
      }),
      title: (params) => `Overwrite cell ${String(params.cell_index ?? "")}`,
    },
    {
      openclawName: "jupyter_execute_cell",
      mcpName: "execute_cell",
      description:
        "Execute a cell from the currently activated notebook with timeout and return its outputs. Requires cell_index (0-based). Optional timeout (default: 90 seconds) controls maximum wait. Optional stream (default: false) enables streaming progress updates; progress_interval (default: 5 seconds) controls update frequency for long-running cells. Returns list of outputs including text, HTML, and images.",
      parameters: Type.Object({
        cell_index: Type.Integer({ minimum: 0 }),
        timeout: Type.Optional(Type.Integer({ minimum: 1 })),
        stream: Type.Optional(Type.Boolean()),
        progress_interval: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      buildArgs: (params) => ({
        cell_index: params.cell_index,
        timeout: params.timeout ?? 90,
        stream: params.stream ?? false,
        progress_interval: params.progress_interval ?? 5,
      }),
      title: (params) => `Execute cell ${String(params.cell_index ?? "")}`,
    },
    {
      openclawName: "jupyter_insert_execute_code_cell",
      mcpName: "insert_execute_code_cell",
      description:
        "Insert a cell at specified index from the currently activated notebook and then execute it. This is the preferred shortcut when you want to insert a cell and execute it at the same time. Requires cell_index (0-based, -1 to append) and cell_source (code). Optional timeout (default: 90 seconds) controls execution wait. Returns both insertion confirmation and execution results including outputs.",
      parameters: Type.Object({
        cell_index: Type.Integer({ minimum: -1 }),
        cell_source: Type.String(),
        timeout: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      buildArgs: (params) => ({
        cell_index: params.cell_index,
        cell_source: params.cell_source,
        timeout: params.timeout ?? 90,
      }),
      title: (params) =>
        `Insert + execute code cell at ${String(params.cell_index ?? "")}`,
    },
    {
      openclawName: "jupyter_read_cell",
      mcpName: "read_cell",
      description:
        "Read a specific cell from the currently activated notebook and return its metadata (index, type, execution count), source and outputs (for code cells). Requires cell_index (0-based). Optional include_outputs (default: true) includes outputs for code cells only. Returns list containing cell metadata, source code, and outputs (if applicable).",
      parameters: Type.Object({
        cell_index: Type.Integer({ minimum: 0 }),
        include_outputs: Type.Optional(Type.Boolean()),
      }),
      buildArgs: (params) => ({
        cell_index: params.cell_index,
        include_outputs: params.include_outputs ?? true,
      }),
      title: (params) => `Read cell ${String(params.cell_index ?? "")}`,
    },
    {
      openclawName: "jupyter_delete_cell",
      mcpName: "delete_cell",
      description:
        "Delete a specific cell or multiple cells from the currently activated notebook. Requires cell_indices (list of 0-based indices). Optional include_source (default: true) includes the source code of deleted cells. IMPORTANT: When deleting many cells, delete them in descending order of their index to avoid index shifting. Returns success message with deletion confirmation and source code of deleted cells (if include_source=true).",
      parameters: Type.Object({
        cell_indices: Type.Array(Type.Integer({ minimum: 0 })),
        include_source: Type.Optional(Type.Boolean()),
      }),
      buildArgs: (params) => ({
        cell_indices: params.cell_indices,
        include_source: params.include_source ?? true,
      }),
      title: () => "Delete cells",
    },
    {
      openclawName: "jupyter_execute_code",
      mcpName: "execute_code",
      description:
        "Execute code directly in the kernel (not saved to notebook) on the current activated notebook. Support magic commands with % and shell commands with !. Recommended for: executing Jupyter magic commands (%timeit, %pip install), performance profiling and debugging, viewing intermediate variable values, temporary calculations, shell commands. Do NOT use for: importing modules or variable assignments affecting subsequent execution, executing dangerous code without permission, replacing proper notebook edits. Requires code. Optional timeout (default: 30, max: 60 seconds). Returns list of outputs including text, HTML, images, and shell command results.",
      parameters: Type.Object({
        code: Type.String(),
        timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      }),
      buildArgs: (params) => ({
        code: params.code,
        timeout: params.timeout ?? 30,
      }),
      title: () => "Execute code",
    },
  ];

  for (const def of toolDefs) {
    api.registerTool(
      {
        name: def.openclawName,
        description: def.description,
        parameters: def.parameters,
        async execute(_id: string, params: Record<string, unknown>) {
          console.log("Tool execution:", {
            name: def.openclawName,
            description: def.description,
            parameters: def.parameters,
            params,
            _id,
          });
          const response = await client.callTool(
            def.mcpName,
            def.buildArgs(params, cfg),
          );
          const result = JupyterMcpClient.unwrap(response);
          console.log("Tool result:", { _id, name: def.openclawName, result });
          return JupyterMcpClient.asToolText(def.title(params), result);
        },
      },
      { optional: true },
    );
  }
}
