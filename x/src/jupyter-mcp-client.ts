type TextResult = {
  content: Array<{ type: "text"; text: string }>;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

export class JupyterMcpClient {
  constructor(
    private readonly mcpUrl: string,
    private readonly timeoutMs: number = 30000,
  ) {}

  private async post(path: string, body: unknown): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      };

      const res = await fetch(`${this.mcpUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      if (!text) return {};

      // Handle streamable-http / SSE-ish response
      if (text.startsWith("event:") || text.includes("\ndata:")) {
        const dataLines = text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter(Boolean);

        if (dataLines.length === 0) {
          return { result: { raw: text } };
        }

        const combined = dataLines.join("\n");
        return JSON.parse(combined) as JsonRpcResponse;
      }

      return JSON.parse(text) as JsonRpcResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async listTools(): Promise<JsonRpcResponse> {
    return this.post("/mcp", {
      jsonrpc: "2.0",
      id: "tools-list-1",
      method: "tools/list",
      params: {},
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    return this.post("/mcp", {
      jsonrpc: "2.0",
      id: `tool-${name}-${Date.now()}`,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    });
  }

  static unwrap(response: JsonRpcResponse): unknown {
    if (response.error) {
      return {
        status: "error",
        error: response.error,
      };
    }
    return response.result ?? response;
  }

  static asToolText(title: string, payload: unknown): TextResult {
    return {
      content: [
        {
          type: "text",
          text: `${title}\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    };
  }
}