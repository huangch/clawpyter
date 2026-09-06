// Shared helpers for the OpenClaw-plugin vitest suite.
//
// The 36 `jupyter_*` tools are registered via `api.registerTool(...)` during
// `definePluginEntry({ register: api => ... })`. We don't have a real
// OpenClaw host in the test process, so these helpers stand up a minimal
// fake `api` that captures every tool, then drive `tool.execute(...)` from
// the test body.
//
// Network is stubbed by spying on `JupyterDirectClient.prototype.executeCode`
// (and friends). The spy is installed in `installExecuteCodeStub` and
// restored by `restoreAll()` so test ordering cannot leak state.

import { vi } from "vitest";

import pluginEntry from "./index.js";
import { JupyterDirectClient } from "./jupyter-client.js";

import type {
  AnyAgentTool,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

/** What `_harness.tools.set(name, tool)` records; we capture only what we
 * need for assertions. */
export interface CapturedTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface Harness {
  api: OpenClawPluginApi;
  tools: Map<string, CapturedTool>;
  /** Convenience lookup; throws if a test calls an unregistered name. */
  invoke<T = unknown>(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  /** Reset captured tools / execute spies between tests. */
  reset(): Promise<void>;
}

/** Build a stub OpenClawPluginApi and run the plugin's `register(api)`. */
export async function buildHarness(
  pluginConfig: Record<string, unknown> = {},
): Promise<Harness> {
  const tools = new Map<string, CapturedTool>();

  const api: OpenClawPluginApi = {
    id: "clawpyter-test",
    name: "ClawPyterTest",
    version: "0.0.0-test",
    config: pluginConfig,
    pluginConfig,
    rootDir: "/tmp/clawpyter-test",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    registerTool: (toolOrFactory, _opts) => {
      // The OpenClaw SDK accepts either a tool object or a factory
      // callback that returns one after awaiting. Our handlers register
      // directly (no factory), but be defensive about both forms.
      const record = (t: AnyAgentTool) => {
        tools.set(t.name, {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          execute: t.execute,
        });
      };
      if (
        typeof toolOrFactory === "object" &&
        toolOrFactory !== null &&
        "name" in toolOrFactory
      ) {
        record(toolOrFactory as AnyAgentTool);
      } else if (typeof toolOrFactory === "function") {
        const produced = (toolOrFactory as (a: unknown) => unknown)(api);
        if (produced instanceof Promise) {
          void produced.then(record);
        } else if (produced && typeof produced === "object") {
          record(produced as AnyAgentTool);
        }
      }
    },
  };

  // Run the plugin's register(api). After this, tools is populated.
  if (typeof pluginEntry.register === "function") {
    await pluginEntry.register(api);
  }

  const invoke = async <T = unknown>(
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    const t = tools.get(name);
    if (!t) {
      throw new Error(
        `tool '${name}' not registered. Have: ${[...tools.keys()].join(", ")}`,
      );
    }
    const raw = (await t.execute("test-id", params)) as T;
    // Most handlers return `JupyterDirectClient.asToolText("Title", payload)`
    // which produces `{ content: [{ type: "text", text: "Title\n\n…" }] }`.
    // Flatten that into the underlying string so test assertions read
    // naturally (`toContain("Cell 0 inserted")` instead of digging into
    // the MCP TextResult envelope).
    if (
      raw !== null &&
      typeof raw === "object" &&
      "content" in (raw as Record<string, unknown>)
    ) {
      const content = (raw as { content: unknown[] }).content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        if (
          typeof first === "object" &&
          first !== null &&
          "type" in (first as Record<string, unknown>) &&
          "text" in (first as Record<string, unknown>) &&
          (first as { type: unknown }).type === "text"
        ) {
          return (first as { text: string }).text as unknown as T;
        }
      }
    }
    return raw;
  };

  return {
    api,
    tools,
    invoke,
    async reset() {
      tools.clear();
      vi.restoreAllMocks();
    },
  };
}

/** Stub `client.executeCode` to return canned output chunks. Returns the
 * spy so the test can assert it was called with a specific kernelId + code. */
export function stubExecuteCode(
  returnValue: string[],
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(JupyterDirectClient.prototype, "executeCode")
    .mockResolvedValue(returnValue);
}

/** Stub `client.listFiles` for the server-level list tests. */
export function stubListFiles(
  returnValue: string,
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(JupyterDirectClient.prototype, "listFiles")
    .mockResolvedValue(returnValue);
}

/** Stub `client.listKernels` for jupyter_list_kernels. */
export function stubListKernels(
  returnValue: string,
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(JupyterDirectClient.prototype, "listKernels")
    .mockResolvedValue(returnValue);
}

// ---------------------------------------------------------------------------
// Notebook/cell fixtures
// ---------------------------------------------------------------------------

/** Standard Jupyter /api/contents response shape — note this is the
 *  **already-unwrapped** `data.content` form (which is what
 *  `JupyterDirectClient.getContents` returns after stripping `name` /
 *  `path` / `type`). Two cells, A and B. */
export const TWO_CELL_NOTEBOOK = () => ({
  cells: [
    {
      cell_type: "code",
      id: "cell-A",
      source: "",
      metadata: {},
      outputs: [],
      execution_count: null,
    } as unknown as Record<string, unknown>,
    {
      cell_type: "markdown",
      id: "cell-B",
      source: "# Hi\n",
      metadata: {},
    } as unknown as Record<string, unknown>,
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

/** Empty notebook used by the insertCell tests. */
export const EMPTY_NOTEBOOK = () => ({
  cells: [],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

/** Standard session body used by jupyter_use_notebook flows. */
export const SESSION_BODY = () => ({
  id: "sess-abc-123",
  kernel: { id: "kernel-xyz", name: "python3" },
  path: "/notebooks/demo.ipynb",
});

/** A small spy that records every (method, path, body) call `getContents` or
 * `putContents` would make; return canned notebook + capture PUT bodies. */
export function stubMutateNotebook(opts: {
  notebook?: ReturnType<typeof TWO_CELL_NOTEBOOK>;
} = {}) {
  const notebook = opts.notebook ?? TWO_CELL_NOTEBOOK();
  const puts: unknown[] = [];
  vi.spyOn(JupyterDirectClient.prototype, "getContents").mockResolvedValue(
    notebook as unknown as Awaited<
      ReturnType<JupyterDirectClient["getContents"]>
    >,
  );
  vi.spyOn(JupyterDirectClient.prototype, "putContents").mockImplementation(
    async (_path: string, body: unknown) => {
      puts.push(body);
    },
  );
  return { puts };
}

export function stubUseNotebookNotebook(opts: {
  notebook?: ReturnType<typeof TWO_CELL_NOTEBOOK>;
} = {}) {
  // The probe (ensureCollabProbed) calls probeServerCollab which tries to
  // reach the server over HTTP and fails; we let collabAvailable stay false
  // (the default) instead of stubbing it. The Contents-API fallback is
  // exercised, which is the realistic path most handlers take.
  vi.spyOn(JupyterDirectClient.prototype, "listJupyterSessions").mockResolvedValue(
    [],
  );
  vi.spyOn(JupyterDirectClient.prototype, "createSession").mockResolvedValue(
    SESSION_BODY() as unknown as Awaited<
      ReturnType<JupyterDirectClient["createSession"]>
    >,
  );
  vi.spyOn(JupyterDirectClient.prototype, "createNotebook").mockResolvedValue(
    undefined as unknown as Awaited<
      ReturnType<JupyterDirectClient["createNotebook"]>
    >,
  );
  vi.spyOn(JupyterDirectClient.prototype, "getContents").mockResolvedValue(
    (opts.notebook ?? TWO_CELL_NOTEBOOK()) as unknown as Awaited<
      ReturnType<JupyterDirectClient["getContents"]>
    >,
  );
}

/**
 * Run `jupyter_use_notebook` against the harness so handlers tested afterwards
 * find an active notebook in the state machine. Mirrors how a real agent
 * session would: pick a name + path, then drive subsequent cell-level tools.
 *
 * Also installs the standard Jupyter-method mocks needed by use_notebook
 * (sessions / createSession / createNotebook / getContents) so this is the
 * only setup call a typical test needs before invoking a cell-level tool.
 */
export async function activateNotebook(
  harness: Harness,
  opts: {
    name?: string;
    path?: string;
    notebook?: ReturnType<typeof TWO_CELL_NOTEBOOK>;
    mode?: "connect" | "create";
  } = {},
): Promise<void> {
  stubUseNotebookNotebook({ notebook: opts.notebook });
  await harness.invoke("jupyter_use_notebook", {
    notebook_path: opts.path ?? "demo.ipynb",
    notebook_name: opts.name ?? "demo",
    mode: opts.mode ?? "connect",
  });
}
