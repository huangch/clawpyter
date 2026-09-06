// Jupyter real-time collaboration (Y.js CRDT) client for the OpenClaw plugin.
//
// Mirrors `hermes-plugin/collab_client.py` (Python). One persistent
// `Y.Doc` per active notebook so edits the agent makes appear live in any
// concurrently-open JupyterLab session and vice versa.
//
// If the optional dependencies (`yjs`) are missing, `new CollabRoom()`
// throws and the calling code falls back to the Contents-API path on
// `JupyterDirectClient`. The plugin still loads and runs.
//
// Y-types decoding helpers are adapted from
// `datalayer/jupyter-mcp-server` (BSD-3-Clause) — see ATTRIBUTIONS.md.

// ---------------------------------------------------------------------------
// Lazy dependency probe
// ---------------------------------------------------------------------------

type YjsModule = typeof import("yjs");

let _yjsPromise: Promise<YjsModule | null> | null = null;
let _yjsResolved: YjsModule | null = null;
let _WebSocketResolved: typeof WebSocket | null | undefined;

async function loadYjs(): Promise<YjsModule | null> {
  if (_yjsResolved) return _yjsResolved;
  if (!_yjsPromise) {
    _yjsPromise = (async () => {
      try {
        const mod = (await import(
          /* webpackIgnore: true */ "yjs"
        )) as YjsModule;
        return mod;
      } catch {
        return null;
      }
    })();
  }
  _yjsResolved = await _yjsPromise;
  return _yjsResolved;
}

function getWebSocketCtor(): typeof WebSocket | null {
  if (_WebSocketResolved === undefined) {
    const g = globalThis as unknown as { WebSocket?: typeof WebSocket };
    _WebSocketResolved = g.WebSocket ?? null;
  }
  return _WebSocketResolved ?? null;
}

export function hasWebSocket(): boolean {
  return getWebSocketCtor() !== null;
}

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
  try {
    const arr = v as {
      length: number;
      [k: number]: unknown;
      toArray?: () => unknown[];
    };
    if (typeof arr.toArray === "function") return arr.toArray() as T[];
    const out: T[] = [];
    for (let i = 0; i < arr.length; i++) out.push(arr[i] as T);
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// y-protocols sync framing
// ---------------------------------------------------------------------------

const MESSAGE_SYNC = 0;
// MESSAGE_AWARENESS = 1 reserved for future use (awareness frames are
// silently ignored by `decodeSyncFrame` for now).

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

function encodeSyncFrame(messageType: number, payload: Uint8Array): Uint8Array {
  const typeBytes = encodeVarInt(messageType);
  const out = new Uint8Array(typeBytes.length + payload.length);
  out.set(typeBytes, 0);
  out.set(payload, typeBytes.length);
  return out;
}

function decodeSyncFrame(
  data: ArrayBuffer | Uint8Array,
): [number, Uint8Array] | null {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (view.byteLength === 0) return null;
  let typeByte = view[0];
  let type = typeByte & 0x7f;
  let offset = 1;
  if ((typeByte & 0x80) !== 0) {
    let shift = 7;
    while ((typeByte & 0x80) !== 0 && offset < view.byteLength) {
      typeByte = view[offset++];
      type |= (typeByte & 0x7f) << shift;
      shift += 7;
    }
    if (offset >= view.byteLength) return null;
  }
  return [type, view.subarray(offset)];
}

// ---------------------------------------------------------------------------
// Y.js <-> notebook JSON translation
// ---------------------------------------------------------------------------

const YNOTEBOOK_CELLS = "ycells";

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
  const y = await loadYjs();
  if (y === null || !hasWebSocket()) return false;
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
    return res.status === 200 || res.status === 201;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CollabRoom — one YDoc connection per notebook
// ---------------------------------------------------------------------------

export interface CollabCell {
  cell_type: string;
  source: string;
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

export class CollabRoom {
  readonly path: string;
  private readonly wsUrl: string;
  private readonly Y: YjsModule;
  private readonly WebSocketCtor: typeof WebSocket;
  readonly doc: import("yjs").Doc;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly messageSync = MESSAGE_SYNC;

  constructor(path: string, serverUrl: string, token: string) {
    const wsCtor = getWebSocketCtor();
    if (!_yjsResolved || !wsCtor) {
      throw new Error(
        "Collaboration dependencies missing at CollabRoom construction",
      );
    }
    this.path = path;
    this.wsUrl = this.buildYjsUrl(serverUrl, path, token);
    this.Y = _yjsResolved;
    this.WebSocketCtor = wsCtor;
    this.doc = new this.Y.Doc();
    this.connect();
  }

  private buildYjsUrl(serverUrl: string, _path: string, token: string): string {
    const cleanUrl = serverUrl.replace(/\/$/, "");
    const wsBase = cleanUrl.replace(/^http/, "ws");
    const search = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${wsBase}/api/collaboration/room${search}`;
  }

  private connect(): void {
    if (this.closed) return;
    try {
      this.ws = new this.WebSocketCtor(this.wsUrl, ["yjs"]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.binaryType = "arraybuffer";

    this.ws.addEventListener("open", () => {
      const encoder = this.Y.encodeStateAsUpdate(this.doc);
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
    if (messageType !== this.messageSync) return;
    this.Y.applyUpdate(this.doc, payload, this);
    const encoder = this.Y.encodeStateAsUpdate(this.doc);
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

  readCells(): CollabCell[] {
    const cellsArr = this.doc.getArray(YNOTEBOOK_CELLS);
    const cells: CollabCell[] = [];
    for (let i = 0; i < cellsArr.length; i++) {
      const cellMap = cellsArr.get(i) as unknown as {
        get: (k: string) => unknown;
        toJSON?: () => Record<string, unknown>;
      };
      const cellType = String(cellMap.get("cell_type") ?? "code");
      const source = ytextToStr(cellMap.get("source"));
      const metadata = (
        cellMap.toJSON ? cellMap.toJSON().metadata : {}
      ) as Record<string, unknown>;
      const outputs =
        cellType === "code" ? yArrayToList(cellMap.get("outputs")) : undefined;
      const executionCount =
        cellType === "code"
          ? ((cellMap.get("execution_count") as number | null | undefined) ?? null)
          : undefined;
      cells.push({
        cell_type: cellType,
        source,
        metadata,
        outputs,
        execution_count: executionCount,
      });
    }
    return cells;
  }

  // -------------------------------------------------------------------------
  // Cell-level write API
  // -------------------------------------------------------------------------

  replaceAllCells(cells: CollabCell[]): void {
    this.doc.transact(() => {
      const cellsArr = this.doc.getArray(YNOTEBOOK_CELLS);
      while (cellsArr.length > 0) cellsArr.delete(0, cellsArr.length);
      for (const cell of cells) {
        const cellMap = new this.Y.Map<unknown>();
        cellMap.set("id", cellIdFor(cellsArr.length));
        cellMap.set("cell_type", cell.cell_type);
        const srcText = new this.Y.Text();
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

  async flush(): Promise<void> {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Top-level helpers used by `index.ts`
// ---------------------------------------------------------------------------

export async function hasCollab(): Promise<boolean> {
  const y = await loadYjs();
  return y !== null && hasWebSocket();
}
