export class JupyterMcpClient {
    mcpUrl;
    jupyterUrl;
    jupyterToken;
    timeoutMs;
    constructor(mcpUrl, jupyterUrl, jupyterToken, timeoutMs = 30000) {
        this.mcpUrl = mcpUrl;
        this.jupyterUrl = jupyterUrl;
        this.jupyterToken = jupyterToken;
        this.timeoutMs = timeoutMs;
    }
    async post(path, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const headers = {
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
            if (!text)
                return {};
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
                return JSON.parse(combined);
            }
            return JSON.parse(text);
        }
        finally {
            clearTimeout(timer);
        }
    }
    async listTools() {
        return this.post("/mcp", {
            jsonrpc: "2.0",
            id: "tools-list-1",
            method: "tools/list",
            params: {},
        });
    }
    async callTool(name, args = {}) {
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
    static unwrap(response) {
        if (response.error) {
            return {
                status: "error",
                error: response.error,
            };
        }
        return response.result ?? response;
    }
    static asToolText(title, payload) {
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
