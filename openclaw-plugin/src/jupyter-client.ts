// Direct Jupyter Lab client — replaces the MCP bridge.
// Communicates with Jupyter's REST API and WebSocket kernel channels.

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
};

type NbCell = {
  cell_type: "code" | "markdown" | "raw";
  source: string;
  metadata: Record<string, unknown>;
  outputs?: NbOutput[];
  execution_count?: number | null;
  id?: string;
};

type NbOutput = {
  output_type: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  name?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
  [key: string]: unknown;
};

type Notebook = {
  cells: NbCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
};

type KernelSession = {
  path: string;
  kernelId: string;
  sessionId: string;
};

type JupyterSession = {
  id: string;
  path: string;
  name: string;
  type: string;
  kernel: {
    id: string;
    name: string;
    execution_state: string;
    connections: number;
    last_activity: string;
  };
};

type JupyterKernel = {
  id: string;
  name: string;
  execution_state: string;
  connections: number;
  last_activity: string;
};

type KernelSpec = {
  spec: {
    display_name: string;
    language: string;
    env?: Record<string, string>;
  };
};

type KernelSpecsResponse = {
  default: string;
  kernelspecs: Record<string, KernelSpec>;
};

type ContentsItem = {
  name: string;
  path: string;
  type: "notebook" | "file" | "directory";
  size?: number | null;
  last_modified: string;
  content?: ContentsItem[] | Notebook | null;
};

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return iso;
  }
}

function formatTSV(headers: string[], rows: string[][]): string {
  const lines = [headers.join("\t"), ...rows.map((r) => r.join("\t"))];
  return lines.join("\n");
}

function uuid(): string {
  // crypto.randomUUID is available in Node 19+ and modern browsers
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: manual UUID v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class JupyterDirectClient {
  jupyterUrl: string;
  jupyterToken: string;
  private readonly timeoutMs: number;

  // In-memory state
  private currentNotebook: string | null = null;
  private sessions: Map<string, KernelSession> = new Map();

  constructor(jupyterUrl: string, jupyterToken: string, timeoutMs: number = 30000) {
    this.jupyterUrl = jupyterUrl.replace(/\/$/, "");
    this.jupyterToken = jupyterToken;
    this.timeoutMs = timeoutMs;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.jupyterToken) {
      h["Authorization"] = `token ${this.jupyterToken}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.jupyterUrl}${path}`, {
        method,
        headers: this.authHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  getCurrentNotebook(): string | null {
    return this.currentNotebook;
  }

  setCurrentNotebook(name: string): void {
    this.currentNotebook = name;
  }

  getSession(name: string): KernelSession | undefined {
    return this.sessions.get(name);
  }

  getAllSessions(): Map<string, KernelSession> {
    return this.sessions;
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
    if (this.currentNotebook === name) {
      // Fall back to another session if available
      const remaining = this.sessions.keys().next();
      this.currentNotebook = remaining.done ? null : remaining.value;
    }
  }

  addSession(name: string, session: KernelSession): void {
    this.sessions.set(name, session);
  }

  // -------------------------------------------------------------------------
  // REST API methods
  // -------------------------------------------------------------------------

  /** Recursively list files/directories up to maxDepth. Returns TSV string. */
  async listFiles(
    path: string = "",
    maxDepth: number = 1,
    pattern: string = "",
  ): Promise<string> {
    const files: { path: string; type: string; size: string; last_modified: string }[] = [];

    const traverse = async (dirPath: string, depth: number): Promise<void> => {
      const encoded = encodeURIComponent(dirPath).replace(/%2F/g, "/");
      const url = `/api/contents/${encoded}?content=1`;
      let data: ContentsItem;
      try {
        data = await this.request<ContentsItem>("GET", url);
      } catch {
        return;
      }
      const items = Array.isArray(data.content) ? (data.content as ContentsItem[]) : [];
      for (const item of items) {
        files.push({
          path: item.path,
          type: item.type,
          size: formatSize(item.size),
          last_modified: formatDate(item.last_modified),
        });
        if (item.type === "directory" && depth < maxDepth) {
          await traverse(item.path, depth + 1);
        }
      }
    };

    await traverse(path, 0);
    files.sort((a, b) => a.path.localeCompare(b.path));

    let filtered = files;
    if (pattern) {
      const re = new RegExp(
        "^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
      );
      filtered = files.filter((f) => re.test(f.path));
    }

    if (filtered.length === 0) {
      return pattern
        ? `No files matching pattern '${pattern}' found in path '${path || "root"}'`
        : `No files found in path '${path || "root"}'`;
    }

    return formatTSV(
      ["Path", "Type", "Size", "Last_Modified"],
      filtered.map((f) => [f.path, f.type, f.size, f.last_modified]),
    );
  }

  /** List all running kernels with spec info. Returns TSV string. */
  async listKernels(): Promise<string> {
    const [kernels, specsResponse] = await Promise.all([
      this.request<JupyterKernel[]>("GET", "/api/kernels"),
      this.request<KernelSpecsResponse>("GET", "/api/kernelspecs").catch(() => ({
        default: "",
        kernelspecs: {} as Record<string, KernelSpec>,
      })),
    ]);

    if (!kernels || kernels.length === 0) {
      return "No kernels found on the Jupyter server.";
    }

    const specs = specsResponse.kernelspecs ?? {};
    const rows = kernels.map((k) => {
      const spec = specs[k.name]?.spec;
      const displayName = spec?.display_name ?? "unknown";
      const language = spec?.language ?? "unknown";
      const envDict = spec?.env ?? {};
      const envStr = Object.entries(envDict)
        .map(([key, val]) => `${key}=${val}`)
        .join("; ");
      const env = envStr.length > 100 ? envStr.slice(0, 100) + "..." : envStr || "unknown";

      return [
        k.id,
        k.name,
        displayName,
        language,
        k.execution_state ?? "unknown",
        String(k.connections ?? "unknown"),
        formatDate(k.last_activity),
        env,
      ];
    });

    return formatTSV(
      ["ID", "Name", "Display_Name", "Language", "State", "Connections", "Last_Activity", "Environment"],
      rows,
    );
  }

  /** Get notebook contents from Jupyter. */
  async getContents(path: string): Promise<Notebook> {
    const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
    const data = await this.request<ContentsItem>("GET", `/api/contents/${encoded}?content=1`);
    return data.content as Notebook;
  }

  /** Save notebook contents to Jupyter. */
  async putContents(path: string, notebook: Notebook): Promise<void> {
    const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
    await this.request("PUT", `/api/contents/${encoded}`, {
      type: "notebook",
      content: notebook,
    });
  }

  /** Create a new empty notebook at the given path. */
  async createNotebook(path: string): Promise<void> {
    const scaffold: Notebook = {
      cells: [
        {
          cell_type: "markdown",
          metadata: {},
          source: "New Notebook Created by ClawPyter",
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 4,
    };
    const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
    await this.request("PUT", `/api/contents/${encoded}`, {
      type: "notebook",
      content: scaffold,
    });
  }

  /** List all active sessions. */
  async listJupyterSessions(): Promise<JupyterSession[]> {
    return this.request<JupyterSession[]>("GET", "/api/sessions");
  }

  /** Create a new session (associates a kernel with a notebook path). */
  async createSession(path: string, kernelId?: string): Promise<JupyterSession> {
    const body: Record<string, unknown> = {
      path,
      type: "notebook",
      name: path,
      kernel: kernelId ? { id: kernelId } : {},
    };
    return this.request<JupyterSession>("POST", "/api/sessions", body);
  }

  /** Delete a session by ID. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/api/sessions/${sessionId}`);
  }

  /** Restart a kernel by ID. */
  async restartKernel(kernelId: string): Promise<void> {
    await this.request("POST", `/api/kernels/${kernelId}/restart`, {});
  }

  /** Update the target Jupyter server (for connect_to_jupyter). */
  updateUrl(url: string, token: string): void {
    this.jupyterUrl = url.replace(/\/$/, "");
    this.jupyterToken = token ?? "";
  }

  // -------------------------------------------------------------------------
  // WebSocket code execution
  // -------------------------------------------------------------------------

  /**
   * Execute code on a kernel via the Jupyter WebSocket channel protocol.
   * Returns an array of output strings.
   */
  async executeCode(kernelId: string, code: string, timeoutMs?: number): Promise<string[]> {
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;

    // Build the WebSocket URL — convert http(s) to ws(s)
    const wsBase = this.jupyterUrl.replace(/^http/, "ws");
    const tokenParam = this.jupyterToken ? `?token=${encodeURIComponent(this.jupyterToken)}` : "";
    const wsUrl = `${wsBase}/api/kernels/${kernelId}/channels${tokenParam}`;

    const msgId = uuid();
    const sessionId = uuid();

    const executeRequest = {
      header: {
        msg_id: msgId,
        msg_type: "execute_request",
        username: "",
        session: sessionId,
        date: new Date().toISOString(),
        version: "5.3",
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
      },
      channel: "shell",
    };

    return new Promise<string[]>((resolve, reject) => {
      const outputs: string[] = [];
      let done = false;

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error(`[TIMEOUT ERROR: Execution exceeded ${effectiveTimeout}ms]`));
        }
      }, effectiveTimeout);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws.send(JSON.stringify(executeRequest));
      };

      ws.onmessage = (event) => {
        if (done) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        const header = msg.header as Record<string, string> | undefined;
        const msgType = header?.msg_type ?? "";
        const channel = (msg.channel as string) ?? "";
        const content = (msg.content ?? {}) as Record<string, unknown>;

        if (channel === "iopub") {
          if (msgType === "stream") {
            const text = String(content.text ?? "");
            if (text) outputs.push(text);
          } else if (msgType === "execute_result" || msgType === "display_data") {
            const data = (content.data ?? {}) as Record<string, unknown>;
            const text =
              typeof data["text/plain"] === "string"
                ? data["text/plain"]
                : JSON.stringify(data);
            if (text) outputs.push(text);
          } else if (msgType === "error") {
            const ename = String(content.ename ?? "Error");
            const evalue = String(content.evalue ?? "");
            outputs.push(`[ERROR: ${ename}: ${evalue}]`);
          }
        } else if (channel === "shell" && msgType === "execute_reply") {
          done = true;
          clearTimeout(timer);
          ws.close();
          resolve(outputs.length > 0 ? outputs : ["[No output generated]"]);
        }
      };

      ws.onerror = (event) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket error: ${String(event)}`));
        }
      };

      ws.onclose = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          // Closed before execute_reply — resolve with whatever we have
          resolve(outputs.length > 0 ? outputs : ["[No output generated]"]);
        }
      };
    });
  }

  // -------------------------------------------------------------------------
  // Notebook cell helpers
  // -------------------------------------------------------------------------

  /** Format notebook cells as a TSV-like string (brief or detailed). */
  static formatCells(
    notebook: Notebook,
    format: "brief" | "detailed",
    startIndex: number,
    limit: number,
  ): string {
    const cells = notebook.cells;
    const total = cells.length;
    const end = limit > 0 ? Math.min(startIndex + limit, total) : total;
    const slice = cells.slice(startIndex, end);

    const lines: string[] = [`Showing cells ${startIndex}-${end - 1} of ${total}`];
    for (let i = 0; i < slice.length; i++) {
      const cell = slice[i];
      const idx = startIndex + i;
      const source = cell.source ?? "";
      if (format === "brief") {
        const firstLine = source.split("\n")[0] ?? "";
        const lineCount = source.split("\n").length;
        lines.push(`[${idx}] ${cell.cell_type} | exec:${cell.execution_count ?? "-"} | ${lineCount} lines | ${firstLine}`);
      } else {
        lines.push(`[${idx}] ${cell.cell_type} | exec:${cell.execution_count ?? "-"}`);
        lines.push(source);
        lines.push("---");
      }
    }
    return lines.join("\n");
  }

  /** Build a diff of two source strings (unified diff style). */
  static diffSource(oldSource: string, newSource: string): string {
    const oldLines = oldSource.split("\n");
    const newLines = newSource.split("\n");
    const diffLines: string[] = [];

    // Simple line-level diff
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const o = oldLines[i];
      const n = newLines[i];
      if (o === undefined) {
        diffLines.push(`+ ${n}`);
      } else if (n === undefined) {
        diffLines.push(`- ${o}`);
      } else if (o !== n) {
        diffLines.push(`- ${o}`);
        diffLines.push(`+ ${n}`);
      } else {
        diffLines.push(`  ${o}`);
      }
    }
    return diffLines.join("\n") || "no changes detected";
  }

  // -------------------------------------------------------------------------
  // Static output helpers (same interface as JupyterMcpClient)
  // -------------------------------------------------------------------------

  static asToolText(title: string, payload: unknown): TextResult {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    return {
      content: [
        {
          type: "text",
          text: `${title}\n\n${text}`,
        },
      ],
    };
  }
}
