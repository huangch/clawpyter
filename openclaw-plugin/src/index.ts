import { Type } from "@sinclair/typebox";
import { JupyterDirectClient, type Notebook } from "./jupyter-client.js";
import {
  CollabRoom,
  hasCollab,
  probeServerCollab,
} from "./collab-client.js";
import {
  registerJob,
  getJob,
  listJobs,
  formatJobOutputs,
  type JobState,
} from "./jobs.js";
import { outputsToCellOutputs } from "./image-outputs.js";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type PluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";

type PluginConfig = {
  jupyterToken?: string;
  jupyterUrl?: string;
  notebookDir?: string;
  defaultNotebook?: string;
  timeoutMs?: number;
  // Snake-case aliases for parity with the Hermes plugin's env-var config.
  jupyter_url?: string;
  jupyter_token?: string;
  notebook_dir?: string;
  default_notebook?: string;
  timeout_ms?: number;
  // Tri-state: "auto" (probe), "on" (require), "off" (Contents-API only).
  collabMode?: "auto" | "on" | "off";
  collab_mode?: "auto" | "on" | "off";
};

/** Resolved, canonical config (all camelCase, all required-or-default). */
type ResolvedConfig = {
  jupyterToken: string;
  jupyterUrl: string;
  notebookDir: string | undefined;
  defaultNotebook: string | undefined;
  timeoutMs: number;
  collabMode: "auto" | "on" | "off";
};

function resolveConfig(raw: PluginConfig): ResolvedConfig {
  const pickString = (
    camel: keyof PluginConfig,
    snake: keyof PluginConfig,
    fallback: string,
  ): string => {
    const a = raw[camel];
    if (typeof a === "string" && a.length > 0) return a;
    const b = raw[snake];
    if (typeof b === "string" && b.length > 0) return b;
    return fallback;
  };
  const pickOptionalString = (
    camel: keyof PluginConfig,
    snake: keyof PluginConfig,
  ): string | undefined => {
    const a = raw[camel];
    if (typeof a === "string" && a.length > 0) return a;
    const b = raw[snake];
    if (typeof b === "string" && b.length > 0) return b;
    return undefined;
  };
  const pickNumber = (
    camel: keyof PluginConfig,
    snake: keyof PluginConfig,
    fallback: number,
  ): number => {
    const a = raw[camel];
    if (typeof a === "number" && Number.isFinite(a)) return a;
    const b = raw[snake];
    if (typeof b === "number" && Number.isFinite(b)) return b;
    return fallback;
  };
  const collabModeRaw = raw.collabMode ?? raw.collab_mode ?? "auto";
  const collabMode: "auto" | "on" | "off" =
    collabModeRaw === "on" || collabModeRaw === "off" ? collabModeRaw : "auto";
  return {
    jupyterToken: pickString("jupyterToken", "jupyter_token", ""),
    jupyterUrl: pickString("jupyterUrl", "jupyter_url", "http://127.0.0.1:8888"),
    notebookDir: pickOptionalString("notebookDir", "notebook_dir"),
    defaultNotebook: pickOptionalString("defaultNotebook", "default_notebook"),
    timeoutMs: pickNumber("timeoutMs", "timeout_ms", 30000),
    collabMode,
  };
}

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

function formatTSV(headers: string[], rows: string[][]): string {
  const lines = [headers.join("\t"), ...rows.map((r) => r.join("\t"))];
  return lines.join("\n");
}

/**
 * Resolve a 0-based cell index given either `cell_index` or `cell_id`.
 *
 * Mirrors jmcp's `cell_ids.resolve`: cell_id wins if both supplied. Returns
 * the resolved integer index, or throws an Error for invalid inputs.
 */
function resolveCellIndex(
  notebook: Notebook,
  cellIndex: number | null | undefined,
  cellId: string | null | undefined,
): number {
  const cells = notebook.cells || [];
  if (cellId !== undefined && cellId !== null && cellId !== "") {
    const idx = cells.findIndex((c) => c && (c as { id?: string }).id === cellId);
    if (idx < 0) {
      throw new Error(
        `No cell with cell_id='${cellId}' (notebook has ${cells.length} cells).`,
      );
    }
    return idx;
  }
  if (cellIndex === undefined || cellIndex === null) {
    throw new Error("Either cell_index or cell_id must be supplied.");
  }
  if (cellIndex < 0 || cellIndex >= cells.length) {
    throw new Error(
      `cell_index ${cellIndex} is out of range (notebook has ${cells.length} cells).`,
    );
  }
  return cellIndex;
}

/**
 * Resolve which notebook a tool invocation targets.
 *
 * Multi-notebook: if `notebook_name` is supplied, use that session; else fall
 * back to the current notebook. Returns the active notebook name, or `null`
 * when no target is found.
 */
function resolveTargetSession(
  client: JupyterDirectClient,
  params: Record<string, unknown>,
): { name: string; session: NonNullable<ReturnType<JupyterDirectClient["getSession"]>> } | null {
  const nameParam = params.notebook_name;
  if (typeof nameParam === "string" && nameParam.length > 0) {
    const session = client.getSession(nameParam);
    if (!session) {
      return null;
    }
    return { name: nameParam, session };
  }
  const current = client.getCurrentNotebook();
  if (!current) return null;
  const session = client.getSession(current);
  if (!session) return null;
  return { name: current, session };
}

/**
 * JSON-Schema declaration of clawpyter's plugin config surface.
 *
 * Mirrors the `configSchema` block in `openclaw.plugin.json` (which is
 * what OpenClaw uses for `plugins.entries.<name>.config` schema validation).
 * Kept here so `definePluginEntry({ configSchema })` can pass it through
 * to the runtime — the runtime shares the same schema between manifest
 * and SDK entry, so edits should stay in sync.
 */
const clawpyterConfigSchema: PluginConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    jupyterToken: {
      type: "string",
      description:
        "Authentication token for the Jupyter server. Generated automatically by start-jpy.sh and saved in environment. Both 'jupyterToken' (camelCase) and 'jupyter_token' (snake_case) are accepted; the resolver honors whichever is set.",
    },
    jupyter_token: {
      type: "string",
      description:
        "Alias for jupyterToken (snake_case form, parity with Hermes env-var config).",
    },
    jupyterUrl: {
      type: "string",
      description:
        "URL of the Jupyter Lab server. Default: http://127.0.0.1:8888. Both 'jupyterUrl' and 'jupyter_url' are accepted.",
    },
    jupyter_url: {
      type: "string",
      description: "Alias for jupyterUrl.",
    },
    notebookDir: {
      type: "string",
      description:
        "Physical directory path where notebooks are stored on the Jupyter server. Used with defaultNotebook to auto-increment notebook names (e.g., ~/.openclaw/jupyter_home). Relative paths are resolved from Jupyter root.",
    },
    defaultNotebook: {
      type: "string",
      description:
        "Default notebook name used when creating new notebooks without explicit path. Defaults to 'Untitled' if not specified. Auto-increments to Untitled-1, Untitled-2, etc. if files exist.",
    },
    timeoutMs: {
      type: "number",
      description:
        "Request timeout in milliseconds for Jupyter operations. Default: 30000 (30 seconds). Increase for slow networks or long-running operations.",
    },
    collabMode: {
      type: "string",
      enum: ["auto", "on", "off"],
      description:
        "Y.js CRDT co-editing policy. Mirrors the Hermes plugin's JUPYTER_COLLAB_MODE. 'auto' (default) probes the server once and uses CRDT when jupyter-collaboration is reachable; 'on' requires CRDT; 'off' forces the Contents-API (whole-file PUT) path. Requires the optional yjs npm dependency at runtime; the plugin loads and runs without it.",
    },
  },
};

/**
 * Plugin entry — uses OpenClaw 2026.9.x `definePluginEntry({ register })`
 * shape so we get the typed `OpenClawPluginApi` (instead of `api: any`)
 * and the runtime can hand us a configSchema-validated `pluginConfig`.
 *
 * The previous `export default function register(api: any)` shape is
 * still accepted by the runtime as `OpenClawPluginModule`, so this is a
 * non-breaking move: it makes the surface explicit and unlocks future
 * capabilities (`reload`, `securityAuditCollectors`, `kind`) that
 * `OpenClawPluginModule` cannot express.
 */
export default definePluginEntry({
  id: "clawpyter",
  name: "ClawPyter",
  description: "Jupyter integration for OpenClaw (36 tools, REST + Y.js CRDT).",
  configSchema: clawpyterConfigSchema,
  register(api: OpenClawPluginApi) {
  const rawCfg: PluginConfig = api?.pluginConfig ?? api?.config ?? {};
  const cfg = resolveConfig(rawCfg);

  const jupyter_url = cfg.jupyterUrl;
  const jupyter_token = cfg.jupyterToken;
  const timeout_ms = cfg.timeoutMs;

  const client = new JupyterDirectClient(jupyter_url, jupyter_token, timeout_ms);

  // ---------------------------------------------------------------------------
  // Collaboration (Y.js CRDT) manager — mirrors `Hermes _state.collab_*`.
  //
  // One persistent `CollabRoom` per active notebook path. Tri-state mode:
  //   "auto" — probe on first use; CRDT if available, else Contents-API.
  //   "on"   — require CRDT, error if unavailable.
  //   "off"  — never use CRDT; force Contents-API path.
  // ---------------------------------------------------------------------------
  type NbCellT = {
    cell_type: "code" | "markdown" | "raw";
    source: string;
    metadata: Record<string, unknown>;
    outputs?: unknown[];
    execution_count?: number | null;
  };
  type NotebookCells = NbCellT[];

  const collabRooms: Map<string, CollabRoom> = new Map();
  let collabProbed = false;
  let collabAvailable: boolean | null = null;

  async function ensureCollabProbed(): Promise<boolean> {
    if (cfg.collabMode === "off") return false;
    if (collabProbed) return collabAvailable ?? false;
    collabProbed = true;
    // Cheap synchronous probe first — fail fast if deps are missing.
    if (!(await hasCollab())) {
      collabAvailable = false;
      return false;
    }
    if (cfg.collabMode === "on") {
      collabAvailable = true;
      return true;
    }
    // "auto": ask the server whether jupyter-collaboration is reachable.
    collabAvailable = await probeServerCollab(jupyter_url, jupyter_token);
    return collabAvailable;
  }

  function getCollabRoom(path: string): CollabRoom | undefined {
    return collabRooms.get(path);
  }

  async function getOrMakeCollabRoom(path: string): Promise<CollabRoom> {
    const existing = collabRooms.get(path);
    if (existing) return existing;
    const room = new CollabRoom(path, jupyter_url, jupyter_token);
    collabRooms.set(path, room);
    return room;
  }

  function dropCollabRoom(path: string): void {
    const room = collabRooms.get(path);
    if (!room) return;
    room.close();
    collabRooms.delete(path);
  }

  // Load the notebook as a JS array of cells, preferring CRDT when available.
  // Returns either a list of cells (CRDT path) or null when the caller must
  // use the Contents-API path.
  async function loadCells(path: string): Promise<NotebookCells | null> {
    if (await ensureCollabProbed()) {
      try {
        const room = await getOrMakeCollabRoom(path);
        await room.flush();
        return room.readCells() as unknown as NotebookCells;
      } catch (e) {
        console.warn(
          "Falling back to Contents-API for load (collab error):",
          String(e),
        );
        collabAvailable = false;
      }
    }
    return null;
  }

  // Save the notebook cells, preferring CRDT when available.
  // Returns true on the CRDT path, false when Contents-API was used by the caller.
  async function saveCells(
    path: string,
    cells: NotebookCells,
  ): Promise<boolean> {
    if (await ensureCollabProbed()) {
      try {
        const room = await getOrMakeCollabRoom(path);
        room.replaceAllCells(cells);
        await room.flush();
        return true;
      } catch (e) {
        console.warn(
          "Falling back to Contents-API for save (collab error):",
          String(e),
        );
        collabAvailable = false;
      }
    }
    return false;
  }

  // Wrapper used by tools that today call `client.getContents(sess.path)`.
  // Returns the full notebook JSON; falls back to Contents-API when CRDT
  // fails or is disabled. This is used for read-only / preview operations.
  async function loadNotebookFull(path: string): Promise<Notebook> {
    const cells = await loadCells(path);
    if (cells) {
      // CRDT path returns NotebookCells; re-shape into the full `Notebook`
      // type the rest of the tool bodies expect.
      return {
        cells: cells as unknown as Notebook["cells"],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 4,
      };
    }
    return client.getContents(path);
  }

  /**
   * Mutate a notebook using either the CRDT path (preferred) or Contents-API
   * (fallback). On the CRDT path, the `cell mutator` runs locally against a
   * Y.Array<Y.Map> via the CollabRoom helper; on the fallback path it runs
   * against a plain JSON document that we then PUT back to the server.
   *
   * The mutator returns either:
   *   - `"continue"`         → save back using whichever path we read from, OR
   *   - the (possibly mutated) cells to save explicitly.
   *
   * Throwing inside the mutator aborts the save.
   */
  async function mutateNotebook(
    path: string,
    mutator: (cells: NotebookCells) => Promise<NotebookCells | "continue"> | NotebookCells | "continue",
  ): Promise<void> {
    const onCrdt = await ensureCollabProbed();
    if (onCrdt) {
      try {
        const room = await getOrMakeCollabRoom(path);
        await room.flush();
        const cells = room.readCells() as unknown as NotebookCells;
        const result = await mutator(cells);
        const next: NotebookCells =
          result === "continue" ? cells : (result as NotebookCells);
        room.replaceAllCells(next);
        await room.flush();
        return;
      } catch (e) {
        console.warn(
          "mutateNotebook: CRDT path failed, falling back to Contents-API:",
          String(e),
        );
        collabAvailable = false;
      }
    }
    // Contents-API fallback.
    const nb = await client.getContents(path);
    const cells = nb.cells as unknown as NotebookCells;
    const result = await mutator(cells);
    const next: NotebookCells =
      result === "continue" ? cells : (result as NotebookCells);
    nb.cells = next as unknown as typeof nb.cells;
    await client.putContents(path, nb);
  }

  // Helper: Construct a full Jupyter Lab URL with authentication token.
  // Reads from client so it stays correct after jupyter_connect_to_jupyter.
  function buildLabUrl(notebookPath: string): string {
    const cleanPath = notebookPath.replace(/^\/+/, "");
    return `${client.jupyterUrl}/lab/tree/${cleanPath}?token=${client.jupyterToken}`;
  }

  // Helper: Resolve notebook name for creation with conflict detection
  async function resolveNewNotebookName(
    explicitName: string | undefined,
    cfg: PluginConfig,
  ): Promise<string> {
    let baseName = explicitName || cfg.defaultNotebook || "Untitled";
    if (!baseName.endsWith(".ipynb")) {
      baseName += ".ipynb";
    }

    // List existing files to detect conflicts
    const listing = await client.listFiles("", 1, baseName.replace(".ipynb", "") + "*");
    const existingFiles = new Set<string>();
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
  api.registerTool(
    {
      name: "jupyter_create_notebook",
      description:
        "Create a new notebook with automatic name conflict detection. If no notebook name is provided, uses defaultNotebook from config or 'Untitled'. If the notebook file already exists, automatically appends a number suffix (-1, -2, etc.) until a unique name is found. Returns success message with the created notebook name and access URL.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_create_notebook", params, _id });

        const explicitName =
          typeof params.notebook_name === "string" ? params.notebook_name : undefined;
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
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_server_info
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_server_info",
      description:
        "Return the Jupyter server URL and token that ClawPyter is currently connected to. Use this to verify the active connection after calling jupyter_connect_to_jupyter, or to construct notebook access URLs.",
      parameters: Type.Object({}),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_server_info", params, _id });
        const info = { jupyter_url: client.jupyterUrl, jupyter_token: client.jupyterToken };
        const result = JSON.stringify(info, null, 2);
        console.log("Tool result:", { _id, name: "jupyter_server_info", result });
        return JupyterDirectClient.asToolText("Jupyter server info", result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_list_files
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_list_files",
      description:
        "List all files and directories recursively in the Jupyter server's file system. Used to explore the file system structure of the Jupyter server or to find specific files or directories. Returns tab-separated table with columns: Path, Type, Size, Last_Modified. Supports pagination and glob pattern filtering.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        start_index: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 0 })),
        pattern: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
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
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_list_kernels
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_list_kernels",
      description:
        "List all available kernels in the Jupyter server. This tool shows all running and available kernel sessions on the Jupyter server, including their IDs, names, states, connection information, and kernel specifications. Useful for monitoring kernel resources and identifying specific kernels for connection. Returns tab-separated table with columns: ID, Name, Display_Name, Language, State, Connections, Last_Activity, Environment.",
      parameters: Type.Object({}),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_list_kernels", params, _id });
        const result = await client.listKernels();
        console.log("Tool result:", { _id, name: "jupyter_list_kernels" });
        return JupyterDirectClient.asToolText("Jupyter kernels", result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_connect_to_jupyter
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_connect_to_jupyter",
      description:
        "Connect to a Jupyter server dynamically with URL and token. This tool allows you to connect to different Jupyter servers without needing to restart the MCP server or modify configuration files. Not available when running MCP server as a Jupyter extension; use pre-configured connection details in that case. Returns connection status message confirming successful connection.",
      parameters: Type.Object({
        jupyter_url: Type.String(),
        jupyter_token: Type.Optional(Type.String()),
        provider: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_connect_to_jupyter", params, _id });
        const url = String(params.jupyter_url ?? "");
        const token = typeof params.jupyter_token === "string" ? params.jupyter_token : "";
        client.updateUrl(url, token);
        const result = `Connected to Jupyter server at ${url}`;
        console.log("Tool result:", { _id, name: "jupyter_connect_to_jupyter", result });
        return JupyterDirectClient.asToolText(`Connect to Jupyter: ${url}`, result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_use_notebook
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_use_notebook",
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
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_use_notebook", params, _id });

        const notebookPath = String(params.notebook_path ?? "");
        const notebookName = String(params.notebook_name ?? "");
        const mode = params.mode === "create" ? "create" : "connect";
        const requestedKernelId =
          typeof params.kernel_id === "string" ? params.kernel_id : undefined;

        const infoLines: string[] = [];

        // Check if already tracked
        const existing = client.getSession(notebookName);
        if (existing) {
          if (mode === "create" && existing.path === notebookPath) {
            return JupyterDirectClient.asToolText(
              `Use notebook: ${notebookPath}`,
              `Notebook '${notebookName}' (path: ${notebookPath}) is already created. DO NOT CREATE AGAIN.`,
            );
          }
          if (existing.path === notebookPath) {
            if (notebookName === client.getCurrentNotebook()) {
              return JupyterDirectClient.asToolText(
                `Use notebook: ${notebookPath}`,
                `Notebook '${notebookName}' is already activated now. DO NOT REACTIVATE AGAIN.`,
              );
            }
            infoLines.push(`[INFO] Reactivating notebook '${notebookName}'`);
            client.setCurrentNotebook(notebookName);
          } else {
            return JupyterDirectClient.asToolText(
              `Use notebook: ${notebookPath}`,
              `The path '${notebookPath}' is not the correct path for notebook '${notebookName}'. Do you mean connect to '${existing.path}'?`,
            );
          }
        } else {
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
          const nb = await loadNotebookFull(notebookPath);
          infoLines.push(`\nNotebook has ${nb.cells.length} cells.`);
          infoLines.push(`Showing first ${Math.min(20, nb.cells.length)} cells:\n`);
          infoLines.push(JupyterDirectClient.formatCells(nb, "brief", 0, 20));
        } catch {
          // Best-effort
        }

        const result = infoLines.join("\n");
        console.log("Tool result:", { _id, name: "jupyter_use_notebook" });
        return JupyterDirectClient.asToolText(`Use notebook: ${notebookPath}`, result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_list_notebooks
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_list_notebooks",
      description:
        "List all notebooks that have been used via use_notebook tool. Returns TSV formatted table with notebook information: Name (unique identifier), Path (file path), Kernel_ID (associated kernel), Kernel_Status (kernel status), and Activate (✓ if currently active). Use this to inspect notebook session state after activating or switching notebooks.",
      parameters: Type.Object({}),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_list_notebooks", params, _id });

        const sessions = client.getAllSessions();
        if (sessions.size === 0) {
          return JupyterDirectClient.asToolText("Jupyter notebooks", "No notebooks currently in use.");
        }

        const current = client.getCurrentNotebook();
        const rows: string[][] = [];
        for (const [name, sess] of sessions.entries()) {
          rows.push([
            name,
            sess.path,
            sess.kernelId,
            "unknown",
            name === current ? "✓" : "",
          ]);
        }

        const result = formatTSV(
          ["Name", "Path", "Kernel_ID", "Kernel_Status", "Activate"],
          rows,
        );
        console.log("Tool result:", { _id, name: "jupyter_list_notebooks" });
        return JupyterDirectClient.asToolText("Jupyter notebooks", result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_restart_notebook
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_restart_notebook",
      description:
        "Restart the kernel for a specific notebook. Requires notebook_name (notebook identifier as reported by list_notebooks). Returns success message confirming the kernel has been restarted and memory state cleared.",
      parameters: Type.Object({
        notebook_name: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_restart_notebook", params, _id });
        const notebookName = String(params.notebook_name ?? "");
        const sess = client.getSession(notebookName);
        if (!sess) {
          return JupyterDirectClient.asToolText(
            `Restart notebook: ${notebookName}`,
            `Notebook '${notebookName}' is not connected.`,
          );
        }
        await client.restartKernel(sess.kernelId);
        const result = `Kernel for notebook '${notebookName}' restarted successfully.`;
        console.log("Tool result:", { _id, name: "jupyter_restart_notebook" });
        return JupyterDirectClient.asToolText(`Restart notebook: ${notebookName}`, result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_restart_notebook_compat
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_restart_notebook_compat",
      description:
        "(Compatibility wrapper) Restart the kernel for a specific notebook. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        notebook_path: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_restart_notebook_compat", params, _id });
        const notebookName = resolveNotebookIdentifier(params, cfg);
        const sess = client.getSession(notebookName);
        if (!sess) {
          return JupyterDirectClient.asToolText(
            `Restart notebook: ${notebookName}`,
            `Notebook '${notebookName}' is not connected.`,
          );
        }
        await client.restartKernel(sess.kernelId);
        const result = `Kernel for notebook '${notebookName}' restarted successfully.`;
        console.log("Tool result:", { _id, name: "jupyter_restart_notebook_compat" });
        return JupyterDirectClient.asToolText(`Restart notebook: ${notebookName}`, result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_unuse_notebook
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_unuse_notebook",
      description:
        "Unuse from a specific notebook and release its resources. Requires notebook_name (notebook identifier as reported by list_notebooks). Returns success message confirming the notebook has been disconnected and resources released.",
      parameters: Type.Object({
        notebook_name: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_unuse_notebook", params, _id });
        const notebookName = String(params.notebook_name ?? "");
        const sess = client.getSession(notebookName);
        if (!sess) {
          return JupyterDirectClient.asToolText(
            `Unuse notebook: ${notebookName}`,
            `Notebook '${notebookName}' is not connected.`,
          );
        }
        await client.deleteSession(sess.sessionId);
        client.removeSession(notebookName);
        dropCollabRoom(sess.path);
        const result = `Notebook '${notebookName}' disconnected and resources released.`;
        console.log("Tool result:", { _id, name: "jupyter_unuse_notebook" });
        return JupyterDirectClient.asToolText(`Unuse notebook: ${notebookName}`, result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_unuse_notebook_compat
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_unuse_notebook_compat",
      description:
        "(Compatibility wrapper) Unuse from a specific notebook and release its resources. Accepts either notebook_name or notebook_path. If notebook_name is not supplied, falls back to notebook_path for compatibility.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        notebook_path: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_unuse_notebook_compat", params, _id });
        const notebookName = resolveNotebookIdentifier(params, cfg);
        const sess = client.getSession(notebookName);
        if (!sess) {
          return JupyterDirectClient.asToolText(
            `Unuse notebook: ${notebookName}`,
            `Notebook '${notebookName}' is not connected.`,
          );
        }
        await client.deleteSession(sess.sessionId);
        client.removeSession(notebookName);
        dropCollabRoom(sess.path);
        const result = `Notebook '${notebookName}' disconnected and resources released.`;
        console.log("Tool result:", { _id, name: "jupyter_unuse_notebook_compat" });
        return JupyterDirectClient.asToolText(`Unuse notebook: ${notebookName}`, result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_read_notebook
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_read_notebook",
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
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_read_notebook", params, _id });
        const notebookName = String(params.notebook_name ?? "");
        const sess = client.getSession(notebookName);
        if (!sess) {
          return JupyterDirectClient.asToolText(
            `Read notebook: ${notebookName}`,
            `Notebook '${notebookName}' is not connected.`,
          );
        }
        const format = params.response_format === "detailed" ? "detailed" : "brief";
        const startIndex = typeof params.start_index === "number" ? params.start_index : 0;
        const limit = typeof params.limit === "number" ? params.limit : 20;

        const nb = await loadNotebookFull(sess.path);
        const output =
          `Notebook ${notebookName} has ${nb.cells.length} cells.\n\n` +
          JupyterDirectClient.formatCells(nb, format, startIndex, limit);

        console.log("Tool result:", { _id, name: "jupyter_read_notebook" });
        return JupyterDirectClient.asToolText(`Read notebook: ${notebookName}`, output);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_read_notebook_compat
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_read_notebook_compat",
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
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_read_notebook_compat", params, _id });
        const notebookName = resolveNotebookIdentifier(params, cfg);
        const sess = client.getSession(notebookName);
        if (!sess) {
          return JupyterDirectClient.asToolText(
            `Read notebook: ${notebookName}`,
            `Notebook '${notebookName}' is not connected.`,
          );
        }
        const format = params.response_format === "detailed" ? "detailed" : "brief";
        const startIndex = typeof params.start_index === "number" ? params.start_index : 0;
        const limit = typeof params.limit === "number" ? params.limit : 20;

        const nb = await loadNotebookFull(sess.path);
        const output =
          `Notebook ${notebookName} has ${nb.cells.length} cells.\n\n` +
          JupyterDirectClient.formatCells(nb, format, startIndex, limit);

        console.log("Tool result:", { _id, name: "jupyter_read_notebook_compat" });
        return JupyterDirectClient.asToolText(`Read notebook: ${notebookName}`, output);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_insert_cell
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_insert_cell",
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
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_insert_cell", params, _id });

        const current = client.getCurrentNotebook();
        if (!current) {
          return JupyterDirectClient.asToolText("Insert cell", "No active notebook. Use jupyter_use_notebook first.");
        }
        const sess = client.getSession(current)!;

        const cellIndex = typeof params.cell_index === "number" ? params.cell_index : -1;
        const cellType = String(params.cell_type ?? "code") as "code" | "markdown";
        const cellSource = String(params.cell_source ?? "");

        // Resolve actualIndex from the live notebook via the collab-aware loader.
        // We deliberately do NOT mutate here — this is a read pass for the
        // index validation. The actual insert happens in mutateNotebook below.
        const preview = await loadNotebookFull(sess.path);
        const total = preview.cells.length;
        if (cellIndex < -1 || cellIndex > total) {
          return JupyterDirectClient.asToolText(
            "Insert cell",
            `Index ${cellIndex} is outside valid range [-1, ${total}]. Use -1 to append at end.`,
          );
        }
        const actualIndex = cellIndex === -1 ? total : cellIndex;

        const newCell: NotebookCells[number] = {
          cell_type: cellType,
          source: cellSource,
          metadata: {},
          outputs: cellType === "code" ? [] : undefined,
          execution_count: cellType === "code" ? null : undefined,
        };

        await mutateNotebook(sess.path, (cells) => {
          // Re-resolve because index may have shifted due to concurrent edits.
          const freshTotal = cells.length;
          if (cellIndex < -1 || cellIndex > freshTotal) {
            throw new Error(`IndexOutOfRange: ${cellIndex} outside [-1, ${freshTotal}]`);
          }
          const freshActual = cellIndex === -1 ? freshTotal : cellIndex;
          cells.splice(freshActual, 0, newCell);
          return "continue";
        });

        // Re-read once more for the post-insert preview window.
        const refreshed = await loadNotebookFull(sess.path);
        const newTotal = refreshed.cells.length;
        const startCtx = Math.max(0, actualIndex - 5);
        const output = [
          `Cell inserted successfully at index ${actualIndex} (${cellType})!`,
          `Notebook now has ${newTotal} cells, showing surrounding cells:`,
          JupyterDirectClient.formatCells(refreshed, "brief", startCtx, 10),
        ].join("\n");

        console.log("Tool result:", { _id, name: "jupyter_insert_cell" });
        return JupyterDirectClient.asToolText("Insert cell", output);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_overwrite_cell_source
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_overwrite_cell_source",
      description:
        "Overwrite the source of a specific cell in the currently activated notebook. Specify the cell by `cell_index` (0-based) OR `cell_id` (nbformat 4.5 id; preferred when collaborators may shift indices). Returns diff style comparison (+ for new lines, - for deleted lines) plus the new cell source.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_index: Type.Optional(Type.Integer({ minimum: 0 })),
        cell_source: Type.String(),
        cell_id: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_overwrite_cell_source", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Overwrite cell", `No target notebook.${nbHint}`);
        }
        const sess = target.session;
        const nbName = target.name;

        const cellIndex = typeof params.cell_index === "number" ? params.cell_index : null;
        const cellId = typeof params.cell_id === "string" ? params.cell_id : null;
        const newSource = String(params.cell_source ?? "");

        const preview = await loadNotebookFull(sess.path);
        let resolvedIndex: number;
        try {
          resolvedIndex = resolveCellIndex(preview, cellIndex, cellId);
        } catch (e) {
          return JupyterDirectClient.asToolText("Overwrite cell", `[ERROR] ${String(e)}`);
        }
        const cellOldSource = preview.cells[resolvedIndex].source;

        await mutateNotebook(sess.path, (cells) => {
          if (resolvedIndex >= cells.length) return "continue";
          const target = cells[resolvedIndex];
          if (!target) return "continue";
          target.source = newSource;
          if (target.cell_type === "code") {
            target.outputs = [];
            target.execution_count = null;
          }
          return "continue";
        });

        const diff = JupyterDirectClient.diffSource(cellOldSource, newSource);

        console.log("Tool result:", { _id, name: "jupyter_overwrite_cell_source" });
        return JupyterDirectClient.asToolText(`Overwrite cell ${resolvedIndex}`, diff);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_execute_cell
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_execute_cell",
      description:
        "Execute a cell from the currently activated notebook. Synchronous by default — returns outputs when the cell finishes. Pass run_async=true to fire-and-forget: returns immediately with a job_id and you poll with jupyter_get_job_result. The synchronous path always writes outputs back into the cell; the async path writes outputs back when the kernel returns execute_reply. Specify the cell by `cell_index` (0-based) OR `cell_id` (preferred). " +
        "On the synchronous path, image MIME payloads (image/png, image/jpeg, image/gif, image/svg+xml) are surfaced as inline `data:` URI blocks you can paste " +
        "into a downstream renderer, and the cell itself is updated with the same image so JupyterLab renders it.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_index: Type.Optional(Type.Integer({ minimum: 0 })),
        cell_id: Type.Optional(Type.String()),
        timeout: Type.Optional(Type.Integer({ minimum: 1 })),
        stream: Type.Optional(Type.Boolean()),
        progress_interval: Type.Optional(Type.Integer({ minimum: 1 })),
        run_async: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_execute_cell", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Execute cell", `No target notebook.${nbHint}`);
        }
        const sess = target.session;
        const current = target.name;

        const cellIndex = typeof params.cell_index === "number" ? params.cell_index : null;
        const cellId = typeof params.cell_id === "string" ? params.cell_id : null;
        const runAsync = params.run_async === true;

        const preview = await loadNotebookFull(sess.path);
        let resolvedIndex: number;
        try {
          resolvedIndex = resolveCellIndex(preview, cellIndex, cellId);
        } catch (e) {
          return JupyterDirectClient.asToolText("Execute cell", `[ERROR] ${String(e)}`);
        }
        const sourceForExec = preview.cells[resolvedIndex].source ?? "";
        if (preview.cells[resolvedIndex].cell_type !== "code") {
          return JupyterDirectClient.asToolText(
            `Execute cell ${resolvedIndex}`,
            `Cell ${resolvedIndex} is not a code cell (type: ${preview.cells[resolvedIndex].cell_type}).`,
          );
        }
        const prevExecCount = preview.cells[resolvedIndex].execution_count ?? 0;

        if (runAsync) {
          const jobId = `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          registerJob({
            id: jobId,
            notebookName: current,
            notebookPath: sess.path,
            kernelId: sess.kernelId,
            code: sourceForExec,
            persistCellIndex: resolvedIndex,
            status: "queued",
            startedAt: Date.now(),
            endedAt: null,
            outputs: [],
            errorMessage: null,
          });
          client.executeCodeAsync(sess.kernelId, sourceForExec, {
            jobId,
            notebookName: current,
            notebookPath: sess.path,
            persistCellIndex: resolvedIndex,
            onComplete: async (job: JobState, _status: string) => {
              try {
                await mutateNotebook(sess.path, (cells) => {
                  const target = cells[resolvedIndex];
                  if (!target) return "continue";
                  target.outputs = job.outputs.map((o) => ({
                    output_type: o.stream === "stderr" ? "stream" : o.stream,
                    name: o.stream === "stderr" ? "stderr" : "stdout",
                    text: o.text,
                  })) as unknown as NotebookCells[number]["outputs"];
                  const lastResult = [...job.outputs].reverse()
                    .find((o) => o.stream === "result" || o.stream === "display");
                  if (lastResult?.execution_count !== undefined) {
                    target.execution_count = lastResult.execution_count ?? null;
                  } else {
                    target.execution_count = (prevExecCount ?? 0) + 1;
                  }
                  return "continue";
                });
              } catch {
                /* best-effort persistence */
              }
            },
          });
          return JupyterDirectClient.asToolText(
            `Execute cell ${resolvedIndex} (async)`,
            `Job queued: ${jobId}\n` +
            `Cell will be updated in-place when the kernel completes.\n\n` +
            `Poll: jupyter_get_job_result(job_id="${jobId}", wait=true)`,
          );
        }

        const timeoutMs = (typeof params.timeout === "number" ? params.timeout : 90) * 1000;
        const outputs = await client.executeCode(sess.kernelId, sourceForExec, timeoutMs);

        const cellOutputs = outputsToCellOutputs(outputs);
        await mutateNotebook(sess.path, (cells) => {
          const target = cells[resolvedIndex];
          if (!target) return "continue";
          target.outputs = cellOutputs as unknown as NotebookCells[number]["outputs"];
          target.execution_count = (prevExecCount ?? 0) + 1;
          return "continue";
        });

        console.log("Tool result:", { _id, name: "jupyter_execute_cell" });
        return JupyterDirectClient.asToolText(`Execute cell ${resolvedIndex}`, outputs);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_insert_execute_code_cell
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_insert_execute_code_cell",
      description:
        "Insert a cell at specified index from the currently activated notebook and then execute it. This is the preferred shortcut when you want to insert a cell and execute it at the same time. Requires cell_index (0-based, -1 to append) and cell_source (code). Optional timeout (default: 90 seconds) controls execution wait. Returns both insertion confirmation and execution results including outputs. " +
        "Image MIME payloads (image/png, image/jpeg, image/gif, image/svg+xml) are surfaced as inline `data:` URI blocks.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_index: Type.Integer({ minimum: -1 }),
        cell_source: Type.String(),
        timeout: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_insert_execute_code_cell", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText(
            "Insert + execute code cell",
            `No target notebook.${nbHint}`,
          );
        }
        const sess = target.session;
        const current = target.name;

        const cellIndex = typeof params.cell_index === "number" ? params.cell_index : -1;
        const cellSource = String(params.cell_source ?? "");

        const preview = await loadNotebookFull(sess.path);
        const totalCells = preview.cells.length;
        if (cellIndex < -1 || cellIndex > totalCells) {
          return JupyterDirectClient.asToolText(
            "Insert + execute code cell",
            `Index ${cellIndex} is outside valid range [-1, ${totalCells}]. Use -1 to append at end.`,
          );
        }
        const actualIndex = cellIndex === -1 ? totalCells : cellIndex;

        // Insert first via mutator, then execute, then write outputs/result.
        await mutateNotebook(sess.path, (cells) => {
          const fresh = cells.length;
          if (cellIndex < -1 || cellIndex > fresh) return "continue";
          const idx = cellIndex === -1 ? fresh : cellIndex;
          cells.splice(idx, 0, {
            cell_type: "code" as const,
            source: cellSource,
            metadata: {},
            outputs: [],
            execution_count: null,
          });
          return "continue";
        });

        const timeoutMs = (typeof params.timeout === "number" ? params.timeout : 90) * 1000;
        const outputs = await client.executeCode(sess.kernelId, cellSource, timeoutMs);

        const cellOutputs = outputsToCellOutputs(outputs);
        await mutateNotebook(sess.path, (cells) => {
          const idx = Math.min(actualIndex, cells.length - 1);
          const target = cells[idx];
          if (!target) return "continue";
          target.outputs = cellOutputs as unknown as NotebookCells[number]["outputs"];
          target.execution_count = 1;
          return "continue";
        });

        const result = [
          `Cell inserted at index ${actualIndex} and executed.`,
          "Outputs:",
          ...outputs,
        ].join("\n");

        console.log("Tool result:", { _id, name: "jupyter_insert_execute_code_cell" });
        return JupyterDirectClient.asToolText(`Insert + execute code cell at ${actualIndex}`, result);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_read_cell
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_read_cell",
      description:
        "Read a specific cell from the currently activated notebook and return its metadata (index, id, type, execution count), source and outputs (for code cells). Specify the cell by `cell_index` (0-based) OR `cell_id` (nbformat 4.5). Optional include_outputs (default: true) includes outputs for code cells only. Returns the cell metadata, source code, and outputs (if applicable).",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_index: Type.Optional(Type.Integer({ minimum: 0 })),
        cell_id: Type.Optional(Type.String()),
        include_outputs: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_read_cell", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Read cell", `No target notebook.${nbHint}`);
        }
        const sess = target.session;

        // Prefer CRDT-backed read so the agent sees the latest collaboration state.
        const nb = await loadNotebookFull(sess.path);

        const cellIndex = typeof params.cell_index === "number" ? params.cell_index : null;
        const cellId = typeof params.cell_id === "string" ? params.cell_id : null;
        let resolvedIndex: number;
        try {
          resolvedIndex = resolveCellIndex(nb, cellIndex, cellId);
        } catch (e) {
          return JupyterDirectClient.asToolText("Read cell", `[ERROR] ${String(e)}`);
        }

        const cell = nb.cells[resolvedIndex];
        const includeOutputs = params.include_outputs !== false;
        const lines: string[] = [
          `Index: ${resolvedIndex}`,
          `ID: ${(cell as unknown as { id?: string }).id ?? "(none)"}`,
          `Type: ${cell.cell_type}`,
          `Execution count: ${cell.execution_count ?? "-"}`,
          `Source:\n${cell.source}`,
        ];

        if (includeOutputs && cell.cell_type === "code" && cell.outputs && cell.outputs.length > 0) {
          lines.push("Outputs:");
          for (const out of cell.outputs) {
            if (out.text) {
              lines.push(Array.isArray(out.text) ? out.text.join("") : out.text);
            } else if (out.data) {
              const plain = out.data["text/plain"];
              if (plain) lines.push(String(plain));
            }
          }
        }

        console.log("Tool result:", { _id, name: "jupyter_read_cell" });
        return JupyterDirectClient.asToolText(`Read cell ${resolvedIndex}`, lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_delete_cell
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_delete_cell",
      description:
        "Delete one or more cells from the currently activated notebook. Specify targets by `cell_indices` (list of 0-based indices) OR by `cell_ids_to_delete` (list of nbformat 4.5 cell ids). Both lists can be supplied — they are merged and deduplicated; ids win on a tie. Cells are deleted in descending index order automatically to avoid shifting, and every id is checked up front so a single bad id fails the whole call rather than partially deleting the notebook. Returns success message and source code of deleted cells (if include_source=true).",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_indices: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
        cell_ids_to_delete: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        include_source: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_delete_cell", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Delete cells", `No active notebook.${nbHint}`);
        }
        const sess = target.session;

        const rawIndices = Array.isArray(params.cell_indices)
          ? (params.cell_indices as unknown[]).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 0)
          : [];
        const rawIds = Array.isArray(params.cell_ids_to_delete)
          ? (params.cell_ids_to_delete as unknown[]).map((v) => String(v))
          : [];
        const includeSource = params.include_source !== false;

        if (rawIndices.length === 0 && rawIds.length === 0) {
          return JupyterDirectClient.asToolText(
            "Delete cells",
            "Provide at least one of cell_indices or cell_ids_to_delete.",
          );
        }

        // Validate + capture deleted sources BEFORE the mutator runs.
        const preview = await loadNotebookFull(sess.path);
        let indices: number[];
        if (rawIds.length > 0) {
          // jmcp-compat atomic semantic: every id validated up front; if any
          // are missing abort the whole call (mirrors jmcp's resolve_many).
          const idToIdx = new Map<string, number>();
          preview.cells.forEach((c, i) => {
            const cid = (c as { id?: string }).id;
            if (cid) idToIdx.set(cid, i);
          });
          const missing = rawIds.filter((id) => !idToIdx.has(id));
          if (missing.length > 0) {
            return JupyterDirectClient.asToolText(
              "Delete cells",
              `[ERROR] The following cell_ids_to_delete were not found: ${JSON.stringify(missing)}. No cells were deleted (atomic semantic).`,
            );
          }
          const idSet = new Set<number>(rawIds.map((id) => idToIdx.get(id) as number).filter((n) => Number.isInteger(n)));
          const merged = new Set<number>([...rawIndices, ...idSet]);
          indices = [...merged].sort((a, b) => b - a);
        } else {
          indices = [...rawIndices].sort((a, b) => b - a);
        }
        // Capture deleted sources BEFORE the mutator runs (desc-sorted ids are
        // still valid against the original snapshot).
        const deletedSources: string[] = [];
        if (includeSource) {
          for (const idx of indices) {
            if (idx >= 0 && idx < preview.cells.length) {
              const src = preview.cells[idx].source ?? "";
              deletedSources.push(`[${idx}] ${src}`);
            }
          }
        }

        await mutateNotebook(sess.path, (cells) => {
          // Iterate the same desc-sorted list, but the mutator may see a
          // different snapshot due to concurrent CRDT edits; clamp each idx.
          const sorted = [...indices].sort((a, b) => b - a);
          for (const idx of sorted) {
            if (idx >= 0 && idx < cells.length) {
              cells.splice(idx, 1);
            }
          }
          return "continue";
        });

        const refreshed = await loadNotebookFull(sess.path);
        const lines = [`Deleted ${indices.length} cell(s). Notebook now has ${refreshed.cells.length} cells.`];
        if (includeSource && deletedSources.length > 0) {
          lines.push("Deleted cell sources:");
          lines.push(...deletedSources);
        }

        console.log("Tool result:", { _id, name: "jupyter_delete_cell" });
        return JupyterDirectClient.asToolText("Delete cells", lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_execute_code — supports sync (default) and async (run_async=true)
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_execute_code",
      description:
        "Execute code directly in the kernel (not saved to notebook). Without kernel_id it uses the current activated notebook's kernel; with kernel_id it bypasses the notebook and runs on a raw kernel (useful when you only want a scratchpad kernel for shell commands, %pip installs, etc., without polluting state). Supports magic commands with % and shell commands with !. Synchronous by default — returns outputs when the cell finishes. Pass run_async=true to fire-and-forget; the call returns immediately with a job_id, and you poll with jupyter_get_job_result / jupyter_list_jobs / jupyter_cancel_job. Do NOT use for code whose assignments need to persist unless run_async=false AND you read the result. " +
        "On the synchronous path, image MIME payloads (image/png, image/jpeg, image/gif, image/svg+xml) are surfaced as inline `data:` URI blocks.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        code: Type.String(),
        timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
        run_async: Type.Optional(Type.Boolean()),
        kernel_id: Type.Optional(Type.String()),
        progress_interval: Type.Optional(Type.Integer({ minimum: 1 })),
        stream: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_execute_code", params, _id });

        const code = String(params.code ?? "");
        const runAsync = params.run_async === true;
        const timeoutSec = typeof params.timeout === "number" ? Math.min(params.timeout, 60) : 30;

        const kernelIdFromParam = typeof params.kernel_id === "string" && params.kernel_id.length > 0
          ? params.kernel_id
          : null;

        let activeNotebook: string | null = null;
        let notebookPath: string | null = null;
        let kernelId: string | null = null;
        if (kernelIdFromParam) {
          kernelId = kernelIdFromParam;
        } else {
          // Resolve target notebook: notebook_name takes precedence, falls back to current.
          const target = resolveTargetSession(client, params);
          if (!target) {
            const nbHint =
              typeof params.notebook_name === "string"
                ? ` Unknown notebook_name "${params.notebook_name}".`
                : " Use jupyter_use_notebook first.";
            return JupyterDirectClient.asToolText(
              "Execute code",
              `No target notebook and no kernel_id supplied.${nbHint}`,
            );
          }
          const current = target.name;
          const sess = target.session;
          activeNotebook = current;
          notebookPath = sess.path;
          kernelId = sess.kernelId;
        }

        if (runAsync) {
          const jobId = `code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          registerJob({
            id: jobId,
            notebookName: activeNotebook ?? "",
            notebookPath: notebookPath ?? "",
            kernelId: kernelId ?? "",
            code,
            persistCellIndex: null,
            status: "queued",
            startedAt: Date.now(),
            endedAt: null,
            outputs: [],
            errorMessage: null,
          });
          client.executeCodeAsync(kernelId ?? "", code, {
            jobId,
            notebookName: activeNotebook ?? "",
            notebookPath: notebookPath ?? "",
            persistCellIndex: null,
          });
          return JupyterDirectClient.asToolText(
            "Execute code (async)",
            `Job queued: ${jobId}\nnotebook: ${notebookPath ?? "(raw kernel)"}\nkernel: ${kernelId ?? ""}\n\n` +
            `Poll: jupyter_get_job_result(job_id="${jobId}", wait=true)`,
          );
        }

        const outputs = await client.executeCode(kernelId ?? "", code, timeoutSec * 1000);
        console.log("Tool result:", { _id, name: "jupyter_execute_code" });
        return JupyterDirectClient.asToolText("Execute code", outputs);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_edit_cell_source — find-and-replace (no full overwrite needed)
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_edit_cell_source",
      description:
        "Apply a literal find-and-replace to one cell's source. Useful for surgical edits (import line, variable rename) when overwriting the whole source via jupyter_overwrite_cell_source is wasteful or risky. Specify the cell by `cell_index` (0-based) OR `cell_id` (preferred). Set `replace_all=true` to swap every occurrence. Returns the diff (- / + lines) plus the new cell source.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_index: Type.Optional(Type.Integer({ minimum: 0 })),
        old_string: Type.String(),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
        cell_id: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_edit_cell_source", params, _id });

        const tgt = resolveTargetSession(client, params);
        if (!tgt) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Edit cell", `No target notebook.${nbHint}`);
        }
        const sess = tgt.session;

        const cellIndex = typeof params.cell_index === "number" ? params.cell_index : null;
        const cellId = typeof params.cell_id === "string" ? params.cell_id : null;
        const oldStr = String(params.old_string ?? "");
        const newStr = String(params.new_string ?? "");
        const replaceAll = params.replace_all === true;

        const preview = await loadNotebookFull(sess.path);
        let resolvedIndex: number;
        try {
          resolvedIndex = resolveCellIndex(preview, cellIndex, cellId);
        } catch (e) {
          return JupyterDirectClient.asToolText("Edit cell", `[ERROR] ${String(e)}`);
        }
        const cellOldSource = preview.cells[resolvedIndex].source;

        let occurrences = 0;
        let newSource = cellOldSource;
        if (replaceAll) {
          occurrences = cellOldSource.split(oldStr).length - 1;
          newSource = cellOldSource.split(oldStr).join(newStr);
        } else if (cellOldSource.includes(oldStr)) {
          occurrences = 1;
          newSource = cellOldSource.replace(oldStr, newStr);
        }

        if (occurrences === 0) {
          return JupyterDirectClient.asToolText(
            "Edit cell",
            `No occurrence of old_string found in cell ${resolvedIndex}. Use jupyter_read_cell to inspect.`,
          );
        }

        await mutateNotebook(sess.path, (cells) => {
          const target = cells[resolvedIndex];
          if (!target) return "continue";
          target.source = newSource;
          return "continue";
        });

        const diff = JupyterDirectClient.diffSource(cellOldSource, newSource);
        const message = `Replaced ${occurrences} occurrence(s) in cell ${resolvedIndex}.\n\n${diff}\n\n[New cell source]\n${newSource}`;
        return JupyterDirectClient.asToolText(`Edit cell ${resolvedIndex}`, message);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_clear_cell_outputs
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_clear_cell_outputs",
      description:
        "Clear outputs of one or more code cells without removing the cells themselves. Accepts cell_indices (list of 0-based indices) — empty list clears ALL code cells in the active notebook. Returns the number of cells cleared.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_indices: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_clear_cell_outputs", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Clear cell outputs", `No target notebook.${nbHint}`);
        }
        const sess = target.session;

        const rawIndices = Array.isArray(params.cell_indices) ? (params.cell_indices as number[]) : null;
        const targetsAll = rawIndices === null;

        const preview = await loadNotebookFull(sess.path);
        const totalCode = preview.cells.filter((c) => c.cell_type === "code").length;
        let clearedCount = 0;

        await mutateNotebook(sess.path, (cells) => {
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (cell.cell_type !== "code") continue;
            const match = targetsAll || (rawIndices && rawIndices.includes(i));
            if (!match) continue;
            cell.outputs = [];
            cell.execution_count = null;
            clearedCount++;
          }
          return "continue";
        });

        return JupyterDirectClient.asToolText(
          "Clear cell outputs",
          targetsAll
            ? `Cleared outputs from ${clearedCount} code cell(s) (of ${totalCode} total).`
            : `Cleared outputs from ${clearedCount} cell(s).`,
        );
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_clear_cell_output — singular variant (jmcp-compatible: cell_index only)
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_clear_cell_output",
      description:
        "Clear the outputs of a single cell (no removal). Specify the cell by `cell_index` (0-based) or `cell_id`. Thin wrapper around jupyter_clear_cell_outputs that takes a single target. Returns the cleared cell index.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        cell_index: Type.Optional(Type.Integer({ minimum: 0 })),
        cell_id: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_clear_cell_output", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Clear cell output", `No target notebook.${nbHint}`);
        }
        const sess = target.session;

        const cellIndex = typeof params.cell_index === "number" ? params.cell_index : null;
        const cellId = typeof params.cell_id === "string" ? params.cell_id : null;
        const preview = await loadNotebookFull(sess.path);
        let resolvedIndex: number;
        try {
          resolvedIndex = resolveCellIndex(preview, cellIndex, cellId);
        } catch (e) {
          return JupyterDirectClient.asToolText("Clear cell output", `[ERROR] ${String(e)}`);
        }
        // Mirror the Hermes handler: clear_cell_output only makes sense for
        // code cells (markdown/raw cells don't have outputs/execution_count
        // to clear), and silently rewriting those fields on a markdown cell
        // is misleading. Reject the request with a clear message — same as
        // jupyter_execute_cell / jupyter_execute_code do.
        if (preview.cells[resolvedIndex].cell_type !== "code") {
          return JupyterDirectClient.asToolText(
            "Clear cell output",
            `Cell ${resolvedIndex} is not a code cell (type: ${preview.cells[resolvedIndex].cell_type}).`,
          );
        }

        await mutateNotebook(sess.path, (cells) => {
          const target = cells[resolvedIndex];
          if (!target) return "continue";
          target.outputs = [];
          target.execution_count = null;
          return "continue";
        });

        return JupyterDirectClient.asToolText(
          "Clear cell output",
          `Cleared outputs from cell ${resolvedIndex}.`,
        );
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_move_cell — relocate one cell (each endpoint via index OR cell_id)
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_move_cell",
      description:
        "Move a cell inside the currently activated notebook. Specify each endpoint by 0-based index OR by nbformat 4.5 cell id; `cell_id`s win when both are supplied. `destination_index` is accepted as a legacy alias for `target_index`. After removal of the source cell, the target index is applied (standard array splice). Indices are 0-based.",
      parameters: Type.Object({
        notebook_name: Type.Optional(Type.String()),
        source_index: Type.Optional(Type.Integer({ minimum: 0 })),
        source_cell_id: Type.Optional(Type.String({ minLength: 1 })),
        target_index: Type.Optional(Type.Integer({ minimum: 0 })),
        target_cell_id: Type.Optional(Type.String({ minLength: 1 })),
        destination_index: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_move_cell", params, _id });

        const target = resolveTargetSession(client, params);
        if (!target) {
          const nbHint =
            typeof params.notebook_name === "string"
              ? ` Unknown notebook_name "${params.notebook_name}".`
              : " Use jupyter_use_notebook first.";
          return JupyterDirectClient.asToolText("Move cell", `No active notebook.${nbHint}`);
        }
        const sess = target.session;

        const sourceId = typeof params.source_cell_id === "string" ? params.source_cell_id : null;
        const targetId = typeof params.target_cell_id === "string" ? params.target_cell_id : null;
        const hasSourceIdx = typeof params.source_index === "number";
        const hasTargetIdx =
          typeof params.target_index === "number" ||
          typeof params.destination_index === "number";

        if (!sourceId && !hasSourceIdx) {
          return JupyterDirectClient.asToolText(
            "Move cell",
            "Provide either source_index or source_cell_id.",
          );
        }
        if (!targetId && !hasTargetIdx) {
          return JupyterDirectClient.asToolText(
            "Move cell",
            "Provide target_index, target_cell_id, or destination_index.",
          );
        }

        const preview = await loadNotebookFull(sess.path);

        // Resolve source first so the target id (if any) resolves against the
        // pre-move state (jmcp parity — resolve both against the unchanged
        // notebook before mutating).
        let src: number;
        try {
          src = resolveCellIndex(preview, hasSourceIdx ? (params.source_index as number) : null, sourceId);
        } catch (e) {
          return JupyterDirectClient.asToolText("Move cell", `[ERROR] ${String(e)}`);
        }
        let dst: number;
        if (targetId !== null) {
          try {
            dst = resolveCellIndex(preview, null, targetId);
          } catch (e) {
            return JupyterDirectClient.asToolText("Move cell", `[ERROR] ${String(e)}`);
          }
        } else if (typeof params.target_index === "number") {
          dst = params.target_index;
        } else {
          dst = params.destination_index as number;
        }

        if (src < 0 || src >= preview.cells.length) {
          return JupyterDirectClient.asToolText(
            "Move cell",
            `source ${src} is out of range. Notebook has ${preview.cells.length} cells.`,
          );
        }
        if (dst < 0 || dst >= preview.cells.length) {
          return JupyterDirectClient.asToolText(
            "Move cell",
            `target ${dst} is out of range. Notebook has ${preview.cells.length} cells.`,
          );
        }
        if (src === dst) {
          return JupyterDirectClient.asToolText("Move cell", "source and destination are identical; nothing moved.");
        }

        let movedIndex = -1;
        await mutateNotebook(sess.path, (cells) => {
          const s = Math.min(src, cells.length - 1);
          const [moved] = cells.splice(s, 1);
          if (!moved) return "continue";
          let d = dst;
          if (d > s) d -= 1;
          d = Math.min(d, cells.length);
          cells.splice(d, 0, moved);
          movedIndex = d;
          return "continue";
        });

        return JupyterDirectClient.asToolText(
          "Move cell",
          `Moved cell from index ${src} to index ${movedIndex >= 0 ? movedIndex : dst}.`,
        );
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_interrupt_cell — interrupt a currently-running cell
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_interrupt_cell",
      description:
        "Interrupt (SIGINT-style) the kernel attached to the currently activated notebook without restarting it. Use this to cancel a long-running cell while preserving kernel state. The interruption is non-blocking — returns immediately.",
      parameters: Type.Object({}),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_interrupt_cell", params, _id });
        const current = client.getCurrentNotebook();
        if (!current) return JupyterDirectClient.asToolText("Interrupt cell", "No active notebook. Use jupyter_use_notebook first.");
        const sess = client.getSession(current)!;
        try {
          await client.interruptKernel(sess.kernelId);
          return JupyterDirectClient.asToolText(
            "Interrupt cell",
            `Interrupt signal sent to kernel ${sess.kernelId}.`,
          );
        } catch (e) {
          return JupyterDirectClient.asToolText(
            "Interrupt cell",
            `[ERROR] interrupt kernel failed: ${String(e)}`,
          );
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_list_kernelspecs — list python3/r/julia/etc. available on the server
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_list_kernelspecs",
      description:
        "List all kernel specifications this Jupyter server supports (e.g. python3, ir, julia-1.10, xpython). Useful when jupyter_use_notebook kernel_id=… needs a specific kernel type. Returns TSV with name / display_name / language / codemirror_mode / env.",
      parameters: Type.Object({}),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_list_kernelspecs", params, _id });
        const tsv = await client.listKernelspecs();
        return JupyterDirectClient.asToolText("Jupyter kernelspecs", tsv);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_nbconvert — convert notebooks to html/python/script/pdf/...
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_nbconvert",
      description:
        "Convert a notebook to another format via /api/nbconvert (html | python | script | markdown | rst | latex | asciidoc | slides | pdf). Returned as text/plain preview (first 4096 chars). Pass download_as to also get a binary hint. Path is relative to the Jupyter server root.",
      parameters: Type.Object({
        notebook_path: Type.String(),
        format: Type.Union([
          Type.Literal("html"),
          Type.Literal("python"),
          Type.Literal("script"),
          Type.Literal("markdown"),
          Type.Literal("rst"),
          Type.Literal("latex"),
          Type.Literal("asciidoc"),
          Type.Literal("slides"),
          Type.Literal("pdf"),
        ]),
        download_as: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_nbconvert", params, _id });
        const path = String(params.notebook_path ?? "");
        const format = String(params.format ?? "html") as
          "html" | "python" | "script" | "markdown" | "rst" | "latex" | "asciidoc" | "slides" | "pdf";
        const downloadAs = typeof params.download_as === "string" ? params.download_as : "";
        if (!path) {
          return JupyterDirectClient.asToolText("nbconvert", "notebook_path is required.");
        }
        try {
          const body = await client.nbconvert(path, format, downloadAs);
          return JupyterDirectClient.asToolText(`nbconvert ${path} → ${format}`, body);
        } catch (e) {
          return JupyterDirectClient.asToolText(
            `nbconvert ${path} → ${format}`,
            `[ERROR] nbconvert failed: ${String(e)}`,
          );
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_upload_file — write text/base64 content to a server path
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_upload_file",
      description:
        "Upload plain text or base64-encoded file content to the Jupyter server at a path under its root. Use format='text' for source/scripts/logs, 'base64' for binary data. Creates a new file or overwrites an existing one.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
        format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("base64")])),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_upload_file", params, _id });
        const path = String(params.path ?? "");
        const content = String(params.content ?? "");
        const format = (params.format === "base64" ? "base64" : "text") as "text" | "base64";
        if (!path) {
          return JupyterDirectClient.asToolText("Upload file", "path is required.");
        }
        try {
          await client.uploadFile(path, content, format);
          return JupyterDirectClient.asToolText(
            "Upload file",
            `Uploaded ${content.length} chars (${format}) to ${path}.`,
          );
        } catch (e) {
          return JupyterDirectClient.asToolText("Upload file", `[ERROR] ${String(e)}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_save_file — alias of jupyter_upload_file (text-friendly name)
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_save_file",
      description:
        "Save plain-text or base64-encoded content to the Jupyter server at the given path. Convenience alias for jupyter_upload_file when the intent is 'create a notebook text file under the server root'. Set format='base64' for binary.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
        format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("base64")])),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_save_file", params, _id });
        const path = String(params.path ?? "");
        const content = String(params.content ?? "");
        const format = (params.format === "base64" ? "base64" : "text") as "text" | "base64";
        if (!path) {
          return JupyterDirectClient.asToolText("Save file", "path is required.");
        }
        try {
          await client.saveFile(path, content, format);
          return JupyterDirectClient.asToolText(
            "Save file",
            `Saved ${content.length} chars (${format}) to ${path}.`,
          );
        } catch (e) {
          return JupyterDirectClient.asToolText("Save file", `[ERROR] ${String(e)}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_mkdir
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_mkdir",
      description: "Create a new directory on the Jupyter server at the given path.",
      parameters: Type.Object({
        path: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_mkdir", params, _id });
        const path = String(params.path ?? "");
        if (!path) return JupyterDirectClient.asToolText("mkdir", "path is required.");
        try {
          await client.mkdir(path);
          return JupyterDirectClient.asToolText("mkdir", `Created directory ${path}.`);
        } catch (e) {
          return JupyterDirectClient.asToolText("mkdir", `[ERROR] ${String(e)}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_delete_file — DELETE /api/contents/<path>
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_delete_file",
      description: "Delete a file or directory from the Jupyter server. Path is relative to the Jupyter server root.",
      parameters: Type.Object({
        path: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_delete_file", params, _id });
        const path = String(params.path ?? "");
        if (!path) return JupyterDirectClient.asToolText("Delete file", "path is required.");
        try {
          await client.deleteFile(path);
          return JupyterDirectClient.asToolText("Delete file", `Deleted ${path}.`);
        } catch (e) {
          return JupyterDirectClient.asToolText("Delete file", `[ERROR] ${String(e)}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_rename_file — PATCH /api/contents/<old>
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_rename_file",
      description:
        "Rename or move a file/directory on the Jupyter server. Both old_path and new_path are relative to the Jupyter server root. Uses PATCH /api/contents so the modification time of sibling files is preserved.",
      parameters: Type.Object({
        old_path: Type.String(),
        new_path: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_rename_file", params, _id });
        const oldPath = String(params.old_path ?? "");
        const newPath = String(params.new_path ?? "");
        if (!oldPath || !newPath) {
          return JupyterDirectClient.asToolText("Rename file", "old_path and new_path are required.");
        }
        try {
          await client.renameFile(oldPath, newPath);
          return JupyterDirectClient.asToolText(
            "Rename file",
            `Renamed ${oldPath} → ${newPath}.`,
          );
        } catch (e) {
          return JupyterDirectClient.asToolText("Rename file", `[ERROR] ${String(e)}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_copy_file — POST /api/contents/<old>/copy
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_copy_file",
      description: "Server-side copy — faster than upload-then-download — for files and directories.",
      parameters: Type.Object({
        old_path: Type.String(),
        new_path: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        console.log("Tool execution:", { name: "jupyter_copy_file", params, _id });
        const oldPath = String(params.old_path ?? "");
        const newPath = String(params.new_path ?? "");
        if (!oldPath || !newPath) {
          return JupyterDirectClient.asToolText("Copy file", "old_path and new_path are required.");
        }
        try {
          await client.copyFile(oldPath, newPath);
          return JupyterDirectClient.asToolText("Copy file", `Copied ${oldPath} → ${newPath}.`);
        } catch (e) {
          return JupyterDirectClient.asToolText("Copy file", `[ERROR] ${String(e)}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_get_job_result — poll a fire-and-forget execute for its result
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_get_job_result",
      description:
        "Fetch the status and outputs of an asynchronous Jupyter code-execution job. With run_async=true the execute tools return immediately and put the job's id in the response; this tool polls that job. Set wait=true with a timeout to block (server-side bound) until the kernel replies or the timeout expires.",
      parameters: Type.Object({
        job_id: Type.String(),
        wait: Type.Optional(Type.Boolean()),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const jobId = String(params.job_id ?? "");
        if (!jobId) {
          return JupyterDirectClient.asToolText("Get job", "job_id is required.");
        }
        const wait = params.wait === true;
        const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 15000;
        let job = getJob(jobId);
        if (!job) {
          return JupyterDirectClient.asToolText(
            "Get job",
            `No job with id ${jobId}. It may have expired (TTL ${30 * 60 * 1000 / 60000} min) or been deleted.`,
          );
        }
        if (wait && (job.status === "queued" || job.status === "running")) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
            const cur = getJob(jobId);
            if (!cur) break;
            if (cur.status !== "queued" && cur.status !== "running") {
              job = cur;
              break;
            }
          }
        }
        job = getJob(jobId);
        if (!job) {
          return JupyterDirectClient.asToolText("Get job", `Job ${jobId} expired during wait.`);
        }
        const summary = [
          `status        : ${job.status}`,
          `kernel        : ${job.kernelId}`,
          `notebook      : ${job.notebookPath ?? "(detached)"}`,
          `started       : ${Math.round((Date.now() - job.startedAt) / 1000)}s ago`,
          "outputs:",
          formatJobOutputs(job),
        ].join("\n");
        if (job.errorMessage) {
          return JupyterDirectClient.asToolText(`Job ${job.id}`, `${summary}\n\nerror: ${job.errorMessage}`);
        }
        return JupyterDirectClient.asToolText(`Job ${job.id}`, summary);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_list_jobs — enumerate in-flight and recent jobs
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_list_jobs",
      description:
        "List all known async-execution jobs (queued, running, succeeded, failed, cancelled). Each entry shows id, kernel, notebook path, status, age, code preview, and buffered output chunk count.",
      parameters: Type.Object({
        status_filter: Type.Optional(
          Type.Union([
            Type.Literal("queued"),
            Type.Literal("running"),
            Type.Literal("succeeded"),
            Type.Literal("failed"),
            Type.Literal("cancelled"),
          ]),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const filter = String(params.status_filter ?? "");
        let jobs = listJobs();
        if (filter) jobs = jobs.filter((j) => j.status === filter);
        if (jobs.length === 0) {
          return JupyterDirectClient.asToolText(
            "Jobs",
            filter ? `No jobs with status='${filter}'.` : "No jobs recorded.",
          );
        }
        const lines: string[] = [`${jobs.length} job(s):`];
        for (const j of jobs) {
          lines.push(`  ${j.id}  ${j.status.padEnd(11)}  kernel=${j.kernelId}  ` +
            `chunks=${j.outputs.length}  ` +
            `started=${Math.round((Date.now() - j.startedAt) / 1000)}s ago  ` +
            `notebook=${j.notebookPath ?? "(detached)"}`);
        }
        return JupyterDirectClient.asToolText("Jobs", lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // jupyter_cancel_job — cancel an async execution by closing its kernel
  // channel (the kernel returns an aborted execute_reply, kernel state is kept)
  // ---------------------------------------------------------------------------
  api.registerTool(
    {
      name: "jupyter_cancel_job",
      description:
        "Cancel a running async Jupyter execution job. Closes the kernel channel the job's WebSocket was using; the Jupyter kernel cancels the in-flight execute_request but does NOT restart. Use jupyter_interrupt_cell if you want to keep the job record for inspection; this tool also removes the job from the registry.",
      parameters: Type.Object({
        job_id: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const jobId = String(params.job_id ?? "");
        if (!jobId) return JupyterDirectClient.asToolText("Cancel job", "job_id is required.");
        const job = getJob(jobId);
        if (!job) {
          return JupyterDirectClient.asToolText("Cancel job", `No job with id ${jobId}.`);
        }
        if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
          return JupyterDirectClient.asToolText(
            "Cancel job",
            `Job ${jobId} already terminal (${job.status}); nothing to cancel.`,
          );
        }
        try {
          await client.interruptKernel(job.kernelId);
        } catch (e) {
          return JupyterDirectClient.asToolText("Cancel job", `[ERROR] interrupt failed: ${String(e)}`);
        }
        // The async coroutine's ws.onclose handler will transition to "cancelled".
        // Give it a brief moment to finalise, then return summary.
        await new Promise((r) => setTimeout(r, 250));
        const final = getJob(jobId);
        if (!final) return JupyterDirectClient.asToolText("Cancel job", `Cancelled job ${jobId} (no further info).`);
        const outputs = formatJobOutputs(final);
        return JupyterDirectClient.asToolText(
          `Cancel job ${jobId}`,
          `status=${final.status}\n\noutputs:\n${outputs}`.trim(),
        );
      },
    },
    { optional: true },
  );
  },
});
