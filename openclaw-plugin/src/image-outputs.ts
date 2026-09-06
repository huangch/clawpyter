// Image-aware output rendering helpers.
//
// Jupyter kernels commonly emit display_data / execute_result payloads that
// contain an image (PNG / JPEG / SVG / GIF) alongside or instead of
// text/plain. Without an image-aware path the rendered cell looks empty for
// the agent and the image is silently dropped from the handler's text
// response. We surface image payloads as a fenced `data:` URI markdown block
// so any markdown-capable consumer (the agent runtime, the dashboard, log
// printers, …) renders the pixel content inline.

const _IMAGE_MIMES_BASE64: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
};

const _IMAGE_MIMES_TEXT: ReadonlyArray<string> = ["image/svg+xml"];

// Inline image payload budget: 256 KB matches a typical chart figure. Larger
// payloads are surfaced with a `[truncated]` marker instead of bloating the
// tool-result string.
const MAX_IMAGE_BYTES = 256 * 1024;

export type IopubMsgType = "stream" | "execute_result" | "display_data" | "error";

/**
 * Pick the most-valuable image MIME in a display_data / execute_result payload.
 * Returns null when the payload has no image data we can render.
 *
 * Order: SVG (vector), PNG, JPEG, GIF.
 */
export function preferredImageMime(
  data: Record<string, unknown> | undefined | null,
): string | null {
  if (!data || typeof data !== "object") return null;
  const order = ["image/svg+xml", "image/png", "image/jpeg", "image/jpg", "image/gif"];
  for (const m of order) {
    const v = data[m];
    if (typeof v === "string" && v.length > 0) return m;
  }
  return null;
}

/** Render one image MIME payload as an inline data-URI markdown block. */
export function renderImagePayload(
  data: Record<string, unknown>,
  mime: string,
): string {
  const raw = data[mime];
  const payload = typeof raw === "string" ? raw : String(raw);
  if (mime in _IMAGE_MIMES_BASE64) {
    if (payload.length > MAX_IMAGE_BYTES) {
      return (
        `[IMAGE: ${mime} truncated] ` +
        `(${payload.length} bytes base64 exceeds the ${Math.floor(MAX_IMAGE_BYTES / 1024)} KB ` +
        "inline budget; rerun the cell with a smaller figure or save the " +
        "figure to disk and reference it by path.)"
      );
    }
    return `[IMAGE: ${mime}]\n![output](data:${mime};base64,${payload})\n[/IMAGE]`;
  }
  if (_IMAGE_MIMES_TEXT.includes(mime)) {
    const byteLen = new TextEncoder().encode(payload).byteLength;
    if (byteLen > MAX_IMAGE_BYTES) {
      return (
        `[IMAGE: ${mime} truncated] ` +
        `(${byteLen} bytes utf-8 exceeds the ${Math.floor(MAX_IMAGE_BYTES / 1024)} KB ` +
        "inline budget.)"
      );
    }
    return `[IMAGE: ${mime}]\n![output](data:image/svg+xml;utf8,${payload})\n[/IMAGE]`;
  }
  return `[IMAGE: ${mime} ignored]`;
}

/**
 * Convert one iopub message into a list of string chunks the agent runtime
 * can render in its tool-result block.
 */
export function formatIopubForAgent(
  msgType: IopubMsgType,
  content: Record<string, unknown>,
): string[] {
  if (msgType === "stream") {
    const text = String(content.text ?? "");
    const name = String(content.name ?? "stdout").toLowerCase();
    if (!text) return [];
    return [`[${name.toUpperCase()}]\n${text}\n[/${name.toUpperCase()}]`];
  }
  if (msgType === "error") {
    const ename = String(content.ename ?? "Error");
    const evalue = String(content.evalue ?? "");
    return [`[ERROR: ${ename}: ${evalue}]`];
  }
  if (msgType === "execute_result" || msgType === "display_data") {
    const chunks: string[] = [];
    const data = (content.data ?? {}) as Record<string, unknown>;
    const mime = preferredImageMime(data);
    if (mime) chunks.push(renderImagePayload(data, mime));
    let text: string | undefined;
    if (typeof data["text/plain"] === "string") {
      text = data["text/plain"] as string;
    }
    // Fall back to a short text/html rendering for image-only display.
    if (!text) {
      const html = data["text/html"];
      if (typeof html === "string" && html.length > 0) {
        const firstLine = html.split("\n", 1)[0] ?? "";
        text = firstLine.slice(0, 200);
      }
    }
    if (text) {
      const tag = msgType === "execute_result" ? "RESULT" : "DISPLAY";
      chunks.push(`[${tag}]\n${text}\n[/${tag}]`);
    }
    return chunks;
  }
  return [];
}

/**
 * Parse a marker-prefixed chunk produced by `formatIopubForAgent` back into
 * a JupyterLab cell-output list. Image chunks become `display_data` entries
 * the Notebook server can render; plain `[STDOUT]`/`[STDERR]` blocks become
 * `stream` entries.
 */
export interface NbCellOutput {
  output_type: "stream" | "display_data" | "error" | "execute_result";
  name?: "stdout" | "stderr";
  text?: string;
  data?: Record<string, string>;
  metadata?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  execution_count?: number | null;
}

// Regex constants are constructed via `new RegExp` rather than regex
// literals: TypeScript's lexer flags `\[/…]` patterns inside a literal as
// "invalid character" even though the same pattern parses fine via the
// constructor. The runtime semantics are identical.
const IMAGE_BLOCK = new RegExp(
  '^\\[IMAGE:\\s*(?<mime>image\\/[a-z+]+)\\]\\s*\\n?(?<body>.*?)\\n?\\[/IMAGE\\]\\s*$',
  's',
);
const STDOUT_BLOCK = new RegExp(
  '^\\[STDOUT\\]\\n?(?<body>[\\s\\S]*?)\\n?\\[\/STDOUT\\]\\s*$',
);
const STDERR_BLOCK = new RegExp(
  '^\\[STDERR\\]\\n?(?<body>[\\s\\S]*?)\\n?\\[\/STDERR\\]\\s*$',
);
const TEXT_BLOCK = new RegExp(
  '^\\[(?<tag>RESULT|DISPLAY)\\]\\n?(?<body>[\\s\\S]*?)\\n?\\[\/(?<tag2>RESULT|DISPLAY)\\]\\s*$',
);
const DATA_URL = new RegExp(
  '^data:(?<mime>[a-z/+\\-]+)(?:;(?<enc>base64|utf8))?,(?<value>.*)$',
  's',
);

export function outputsToCellOutputs(outputs: string[]): NbCellOutput[] {
  const cells: NbCellOutput[] = [];
  for (const chunk of outputs) {
    if (!chunk) continue;
    const m = IMAGE_BLOCK.exec(chunk);
    if (m && m.groups) {
      const mime = (m.groups["mime"] ?? "").trim();
      const body = (m.groups["body"] ?? "").trim();
      let dataValue = body;
      // Strip the `![output](…)` markdown wrapper to get the URL.
      if (body.startsWith("![") && body.endsWith(")")) {
        const inner = body.slice(body.indexOf("(") + 1, -1).trim();
        const dm = DATA_URL.exec(inner);
        if (dm && dm.groups) {
          dataValue = dm.groups["value"] ?? inner;
        } else {
          dataValue = inner;
        }
      }
      cells.push({
        output_type: "display_data",
        data: { [mime]: dataValue },
        metadata: {},
      });
      continue;
    }
    const so = STDOUT_BLOCK.exec(chunk);
    if (so && so.groups) {
      cells.push({
        output_type: "stream",
        name: "stdout",
        text: (so.groups["body"] ?? "").replace(/^\n+|\n+$/g, ""),
      });
      continue;
    }
    const se = STDERR_BLOCK.exec(chunk);
    if (se && se.groups) {
      cells.push({
        output_type: "stream",
        name: "stderr",
        text: (se.groups["body"] ?? "").replace(/^\n+|\n+$/g, ""),
      });
      continue;
    }
    const tb = TEXT_BLOCK.exec(chunk);
    if (tb && tb.groups) {
      cells.push({
        output_type: "display_data",
        data: { "text/plain": (tb.groups["body"] ?? "").replace(/^\n+|\n+$/g, "") },
        metadata: {},
      });
      continue;
    }
    cells.push({
      output_type: "stream",
      name: "stdout",
      text: chunk,
    });
  }
  return cells;
}
