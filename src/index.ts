import { Type, type TSchema } from "@sinclair/typebox";
import { JupyterMcpClient } from "./jupyter-mcp-client.js";

type PluginConfig = {
  baseUrl?: string;
  authToken?: string;
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

  const effectiveBaseUrl = cfg.baseUrl ?? "http://127.0.0.1:4040";
  const effectiveTimeoutMs = cfg.timeoutMs ?? 30000;

  const client = new JupyterMcpClient(
    effectiveBaseUrl,
    cfg.authToken,
    effectiveTimeoutMs,
  );

  const toolDefs: ToolDef[] = [
    {
      openclawName: "jupyter_list_files",
      mcpName: "list_files",
      description:
        "List files and directories recursively in the Jupyter server file system. Use this to explore the server-side filesystem, find notebooks, confirm whether a notebook file exists, or inspect directory structure before activating a notebook. Supports pagination and glob filtering. Example arguments: { path: '', max_depth: 1, start_index: 0, limit: 25, pattern: '*.ipynb' }.",
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
        "List all available and running Jupyter kernels, including kernel ID, name, display name, language, state, connection count, last activity, and kernel environment information. Use this to inspect kernel state, identify a kernel for notebook attachment, or debug server-side execution state.",
      parameters: Type.Object({}),
      buildArgs: () => ({}),
      title: () => "Jupyter kernels",
    },
    {
      openclawName: "jupyter_connect_to_jupyter",
      mcpName: "connect_to_jupyter",
      description:
        "Connect to a different Jupyter server dynamically without restarting the integration. Use this when switching to another Jupyter URL or token during a session. Note: this tool is NOT available when running the MCP server as a Jupyter server extension — use pre-configured connection details in that case. Example arguments: { jupyter_url: 'http://127.0.0.1:8888', jupyter_token: '...', provider: 'jupyter' }.",
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
        "Activate or connect to a notebook so later cell operations target it. This is the first notebook-specific tool to call before reading, inserting, overwriting, executing, or deleting cells. Both notebook_path and notebook_name are required by the upstream server: notebook_path is the file path relative to the Jupyter server root, and notebook_name is a unique session identifier. When notebook_name is not explicitly provided, this wrapper uses notebook_path as the identifier. Advanced inputs: mode as 'connect' or 'create', and optional kernel_id to attach a specific kernel. Example arguments: { notebook_path: 'Untitled.ipynb', notebook_name: 'Untitled', mode: 'connect' }.",
      parameters: Type.Object({
        notebook_path: Type.Optional(Type.String()),
        notebook_name: Type.Optional(Type.String()),
        mode: Type.Optional(
          Type.Union([Type.Literal("connect"), Type.Literal("create")]),
        ),
        kernel_id: Type.Optional(Type.String()),
      }),
      buildArgs: (params, cfg) => {
        const notebookPath = requireNotebookPath(params, cfg);
        // Fix: fall back to notebookPath as the identifier rather than empty string,
        // because the upstream server requires a non-empty notebook_name.
        const notebookName =
          typeof params.notebook_name === "string" && (params.notebook_name as string).trim()
            ? (params.notebook_name as string)
            : notebookPath;
        return {
          notebook_name: notebookName,
          notebook_path: notebookPath,
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
        "List all notebooks that have been activated or used through notebook activation. Returns notebook name, path, kernel ID, kernel status, and whether the notebook is currently active. Use this to inspect notebook session state after activating or switching notebooks.",
      parameters: Type.Object({}),
      buildArgs: () => ({}),
      title: () => "Jupyter notebooks",
    },
    {
      openclawName: "jupyter_restart_notebook",
      mcpName: "restart_notebook",
      description:
        "Restart the kernel for a specific activated notebook and clear its memory state. Requires notebook_name, which is the notebook identifier reported by list_notebooks. If notebook_name is not supplied, this wrapper falls back to notebook_path/default notebook for compatibility. Example arguments: { notebook_name: 'default' }.",
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
        "Disconnect from a specific activated notebook and release its resources. Requires notebook_name, which is the notebook identifier reported by list_notebooks. If notebook_name is not supplied, this wrapper falls back to notebook_path/default notebook for compatibility.",
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
        "Read an activated notebook and return each cell's index, source, type, and execution count. Use response_format='brief' for a compact overview and response_format='detailed' for full cell source. Supports pagination with start_index and limit. Requires notebook_name, which is the notebook identifier reported by list_notebooks. If notebook_name is not supplied, this wrapper falls back to notebook_path/default notebook for compatibility. Recommended workflow: activate notebook first, read in brief mode to locate cells, then read in detailed mode for exact cells. Example arguments: { notebook_name: 'default', response_format: 'brief', start_index: 0, limit: 20 }.",
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
        "Insert a code or markdown cell into the currently activated notebook. Operates on the active notebook only; do not pass notebook arguments here. Requires cell_index, cell_type, and cell_source. Use cell_index = -1 to append at the end. Example arguments: { cell_index: -1, cell_type: 'code', cell_source: 'print(1+1)' }.",
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
        "Overwrite the entire source content of a specific cell in the currently activated notebook. Operates on the active notebook only. Requires cell_index and cell_source. Returns a diff-style comparison of the change. Example arguments: { cell_index: 0, cell_source: 'print(42)' }.",
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
        "Execute a specific cell in the currently activated notebook and return its outputs. Operates on the active notebook only. Requires cell_index. Optional timeout controls maximum wait time. Optional stream and progress_interval enable progress updates for long-running execution. Example arguments: { cell_index: 0, timeout: 90, stream: false }.",
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
        "Insert a new code cell into the currently activated notebook and execute it immediately. This is the preferred shortcut when you want to both add and run a saved code cell in one step. Operates on the active notebook only. Requires cell_index and cell_source. Optional timeout controls execution wait time. Example arguments: { cell_index: -1, cell_source: 'print(1+1)', timeout: 90 }.",
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
        "Read a specific cell from the currently activated notebook and return its metadata, full source, and optionally outputs. Operates on the active notebook only. Requires cell_index. Optional include_outputs defaults to true and only affects code cells. Example arguments: { cell_index: 0, include_outputs: true }.",
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
        "Delete one or more cells from the currently activated notebook. Operates on the active notebook only. Requires cell_indices as a list of cell indices. Optional include_source controls whether deleted cell source is returned. When deleting many cells, delete them in descending index order to avoid index shifting. Example arguments: { cell_indices: [3, 2, 1], include_source: true }.",
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
        "Execute code directly in the kernel of the currently activated notebook without saving it as a notebook cell. Use this for magic commands, shell commands, quick tests, temporary calculations, performance profiling, debugging, and inspecting intermediate values. Do not use it to import new modules or perform variable assignments that affect subsequent notebook execution, run dangerous code without permission, or silently replace proper notebook edits when the user explicitly wants the notebook changed. Operates on the active notebook only. Requires code. Optional timeout defaults to 30 seconds, maximum 60 seconds. Example arguments: { code: '%timeit sum(range(1000))', timeout: 30 }.",
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
          const response = await client.callTool(
            def.mcpName,
            def.buildArgs(params, cfg),
          );
          const result = JupyterMcpClient.unwrap(response);
          return JupyterMcpClient.asToolText(def.title(params), result);
        },
      },
      { optional: true },
    );
  }
}
