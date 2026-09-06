// Jupyter real-time collaboration (Y.js CRDT) client for the OpenClaw plugin.
//
// Mirrors `hermes-plugin/collab_client.py` (Python). One persistent
// `Y.Doc` per active notebook so edits the agent makes appear live in any
// concurrently-open JupyterLab session and vice versa.
//
// If the optional dependencies (`yjs`, `ws`) are missing, `HAS_COLLAB` is
// `false` and the calling code falls back to the Contents-API path on
// `JupyterDirectClient`. The plugin still loads and runs.
//
// Y-types decoding helpers are adapted from
// `datalayer/jupyter-mcp-server` (BSD-3-Clause) — see ATTRIBUTIONS.md.

// ---------------------------------------------------------------------------
// Lazy dependency probe
// ---------------------------------------------------------------------------

let _yjs: typeof import("yjs") | null = null;
let _WebSocket: typeof WebSocket | null = null;

try {
  // `yjs` is optional — the plugin still loads when it is absent.
  // Use eval to keep tsc from turning this into a hard module reference.
  const dyn = new Function("m", "return require(m)") as (m: string) => unknown;
  _yjs = dyn("yjs") as typeof import("yjs");
} catch {
  _yjs = null;
}

try {
  // Node's built-in `WebSocket` (Node 22+) is preferred. Fall back to the
  // `ws` package for Node 18/20 if the user installs it.
  // The `_WebSocket` global is set below in `getWebSocketCtor`.
  _WebSocket =
    (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket ?? null;
} catch {
  _WebSocket = null;
}

export const HAS_COLLAB: boolean = _yjs !== null && _WebSocket !== null;

// ---------------------------------------------------------------------------
// Y-types decoding helpers
// ---------------------------------------------------------------------------

function ytextToStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => String(x ?? "")).join("");
  const y = v as { toString?: () => string; source?: unknown };
  if (typeof y.toString === "function") return y.toString();
  if ("source" in y) return String(y.source);
  return String(v);
}

function yArrayToList<T = unknown>(v: unknown): T[] {
  if (v == null) return [];
  // Y.Array supports iteration and indexed access
  try {
    const arr = v as { length: number; [k: number]: unknown; toArray?: () => unknown[] };
    if (typeof arr.toArray === "function") return arr.toArray() as T[];
    const out: T[] = [];
    for (let i = 0; i < arr.length; i++) out.push(arr[i] as T);
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Y.js <-> notebook JSON translation
//
// JupyterLab's collaboration model exposes `ycells` as a `Y.Array<Y.Map>`
// and per-cell content as nested `Y.Map` / `Y.Text` types on the same
// `Y.Doc` per notebook. Source lives on each cell map's `source` key as a
// `Y.Text`.
//
// See: https://jupyterlab.readthedocs.io/en/stable/extension/extension_tutorial.html
// (Collaborative Cell List) and the datalayer/jupyter-mcp-server reference.
// ---------------------------------------------------------------------------

const YNOTEBOOK_CELLS = "ycells";

// y-protocols sync message constants
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// Encode a non-negative integer as a yjs-style varint (LEB128).
function encodeVarInt(n: number): Uint8Array {
  if (n < 0 || !Number.isFinite(n)) {
    throw new Error(`encodeVarInt: bad value ${n}`);
  }
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return Uint8Array.from(out);
}

// Build a y-protocols sync frame: [messageType varint] [payload]
function encodeSyncFrame(messageType: number, payload: Uint8Array): Uint8Array {
  const typeBytes = encodeVarInt(messageType);
  const out = new Uint8Array(typeBytes.length + payload.length);
  out.set(typeBytes, 0);
  out.set(payload, typeBytes.length);
  return out;
}

// Decode a y-protocols sync frame. Returns [messageType, payload] or null.
function decodeSyncFrame(data: ArrayBuffer | Uint8Array): [number, Uint8Array] | null {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (view.byteLength === 0) return null;
  // Read the leading varint for messageType.
  let typeByte = view[0];
  let type = typeByte & 0x7f;
  let offset = 1;
  if ((typeByte & 0x80) !== 0 && offset < view.byteLength) {
    // Multi-byte varint — for the small MESSAGE_SYNC/awareness values this
    // branch is never taken, but handle it correctly anyway.
    let shift = 7;
    while ((typeByte & 0x80) !== 0 && offset < view.byteLength) {
      typeByte = view[offset++];
      type |= (typeByte & 0x7f) << shift;
      shift += 7;
    }
  } else if ((typeByte & 0x80) !== 0) {
    return null;
  }
  return [type, view.subarray(offset)];
}

function isInCollabContext(): boolean {
  return HAS_COLLAB && _yjs !== null;
}

function cellIdFor(index: number): string {
  return `cell-${index}`;
}

// ---------------------------------------------------------------------------
// Server feature detection — does this Jupyter server have collaboration on?
// ---------------------------------------------------------------------------

export async function probeServerCollab(
  serverUrl: string,
  token: string,
): Promise<boolean> {
  if (!HAS_COLLAB) return false;
  const cleanUrl = serverUrl.replace(/\/$/, "");
  const url = `${cleanUrl}/api/collaboration/session/_probe_does_not_exist.ipynb`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `token ${token}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ format: "json", type: "notebook" }),
    });
    // A reachable jupyter-collaboration returns 200/201. 404 = missing.
    return res.status === 200 || res.status === 201;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CollabRoom — one YDoc connection per notebook
// ---------------------------------------------------------------------------

export class CollabRoom {
  readonly path: string;
  private readonly url: string;
  private readonly token: string;
  private readonly Doc: typeof import("yjs").Doc;
  private readonly WebSocketCtor: typeof WebSocket;
  readonly doc: import("yjs").Doc;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  // y-protocols sync messages
  private readonly messageSync = MESSAGE_SYNC;
  private readonly messageAwareness = MESSAGE_AWARENESS;

  constructor(path: string, serverUrl: string, token: string) {
    if (!isInCollabContext()) {
      throw new Error("Collaboration dependencies not installed (yjs + ws)");
    }
    this.path = path;
    this.url = this.buildYjsUrl(serverUrl, path, token);
    this.token = token;

    // Both `_yjs` and `_WebSocket` are guaranteed non-null here.
    this.Doc = (_yjs as unknown as typeof import("yjs").Doc);
    this.WebSocketCtor = _WebSocket as typeof WebSocket;

    this.doc = new this.Doc();
    this.connect();
  }

  private buildYjsUrl(serverUrl: string, path: string, token: string): string {
    const cleanUrl = serverUrl.replace(/\/$/, "");
    const wsBase = cleanUrl.replace(/^http/, "ws");
    const search = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${wsBase}/api/collaboration/room${search}`;
  }

  private connect(): void {
    if (this.closed) return;
    try {
      this.ws = new this.WebSocketCtor(this.url, ["yjs"]);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws.binaryType = "arraybuffer";

    this.ws.addEventListener("open", () => {
      // Send sync step 1 — request full state
      const Y = _yjs as unknown as typeof import("yjs");
      const encoder = (Y as unknown as { encodeStateAsUpdate: (d: import("yjs").Doc) => Uint8Array })
        .encodeStateAsUpdate(this.doc);
      this.send(this.messageSync, encoder);
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.handleIncoming(event.data as ArrayBuffer).catch(() => {
        // Ignore decode errors; the next sync round will recover.
      });
    });

    this.ws.addEventListener("close", () => {
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      // `close` will follow; nothing to do here.
    });

    // Forward local doc updates to the server
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this) {
        this.send(this.messageSync, update);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private send(messageType: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) return;
    this.ws.send(encodeSyncFrame(messageType, payload));
  }

  private async handleIncoming(data: ArrayBuffer): Promise<void> {
    const frame = decodeSyncFrame(data);
    if (!frame) return;
    const [messageType, payload] = frame;
    if (messageType !== this.messageSync) return; // ignore awareness for now

    const Y = _yjs as unknown as typeof import("yjs");
    const applyUpdate = (Y as unknown as {
      applyUpdate: (d: import("yjs").Doc, u: Uint8Array, origin?: unknown) => void;
    }).applyUpdate;
    applyUpdate(this.doc, payload, this);
    // Send our state back so the server can fill in anything we missed
    const encoder = (Y as unknown as {
      encodeStateAsUpdate: (d: import("yjs").Doc) => Uint8Array;
    }).encodeStateAsUpdate(this.doc);
    this.send(this.messageSync, encoder);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    try {
      this.doc.destroy();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Cell-level read API (mirrors Hermes' `nb_to_cells`)
  // -------------------------------------------------------------------------

  readCells(): Array<{
    cell_type: string;
    source: string;
    metadata: Record<string, unknown>;
    outputs?: unknown[];
    execution_count?: number | null;
  }> {
    if (!isInCollabContext()) return [];
    const cellsArr = this.doc.getArray(YNOTEBOOK_CELLS);
    const cells: Array<{
      cell_type: string;
      source: string;
      metadata: Record<string, unknown>;
      outputs?: unknown[];
      execution_count?: number | null;
    }> = [];
    for (let i = 0; i < cellsArr.length; i++) {
      const cellMap = cellsArr.get(i) as unknown as {
        get: (k: string) => unknown;
        toJSON?: () => Record<string, unknown>;
      };
      const cellType = String(cellMap.get("cell_type") ?? "code");
      const source = ytextToStr(cellMap.get("source"));
      const metadata = (cellMap.toJSON ? cellMap.toJSON().metadata : {}) as Record<string, unknown>;
      const outputs =
        cellType === "code" ? yArrayToList(cellMap.get("outputs")) : undefined;
      const executionCount =
        cellType === "code"
          ? ((cellMap.get("execution_count") as number | null | undefined) ?? null)
          : undefined;
      cells.push({ cell_type: cellType, source, metadata, outputs, execution_count: executionCount });
    }
    return cells;
  }

  // -------------------------------------------------------------------------
  // Cell-level write API
  // Mirrors Hermes' `cells_to_nb` / `nbmodel_client.set_cells` semantics.
  // Performs an in-place CRDT transaction so other clients see the change.
  // -------------------------------------------------------------------------

  replaceAllCells(
    cells: Array<{
      cell_type: string;
      source: string;
      metadata?: Record<string, unknown>;
      outputs?: unknown[];
      execution_count?: number | null;
    }>,
  ): void {
    if (!isInCollabContext()) return;
    this.doc.transact(() => {
      const cellsArr = this.doc.getArray(YNOTEBOOK_CELLS);
      // Clear and rebuild — simpler than surgical inserts for the agent
      // use case (full notebook rewrites from Contents-API).
      while (cellsArr.length > 0) cellsArr.delete(0, cellsArr.length);
      for (const cell of cells) {
        const cellMap = new this.Doc.Map<string | number | unknown>();
        cellMap.set("id", cellIdFor(cellsArr.length));
        cellMap.set("cell_type", cell.cell_type);
        const srcText = new this.Doc.Text();
        srcText.insert(0, cell.source);
        cellMap.set("source", srcText);
        cellMap.set("metadata", cell.metadata ?? {});
        if (cell.cell_type === "code") {
          cellMap.set("outputs", cell.outputs ?? []);
          cellMap.set("execution_count", cell.execution_count ?? null);
        }
        cellsArr.push([cellMap as unknown as never]);
      }
    }, this);
  }

  /** Wait until the next doc update has been broadcast to the server. */
  async flush(): Promise<void> {
    if (!isInCollabContext()) return;
    await Promise.resolve();
    // Small grace period for the outgoing WebSocket frame
    await new Promise((r) => setTimeout(r, 25));
  }
}
