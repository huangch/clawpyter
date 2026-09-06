// Tests for the image-aware output rendering helpers.
//
// Mirrors hermes-plugin/tests/test_image_outputs.py so any drift between the
// Python and TypeScript runtimes fails a test. Both runtimes must:
//   - emit a [STDOUT]/[STDERR]/[RESULT]/[DISPLAY]/[IMAGE: ...] chunk shape;
//   - prefer SVG > PNG > JPEG > GIF when several image MIME types are
//     available together;
//   - clamp payloads to MAX_IMAGE_BYTES with a [truncated] marker.
//
// `_format_iopub_for_agent` and `outputsToCellOutputs` are exported pure
// functions, so the suite stays hermetic (no HTTP, no WebSocket, no plugin
// API surface).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  preferredImageMime,
  renderImagePayload,
  formatIopubForAgent,
  outputsToCellOutputs,
  MAX_IMAGE_BYTES,
} from "./image-outputs.js";

// ---------------------------------------------------------------------------
// preferredImageMime
// ---------------------------------------------------------------------------

describe("preferredImageMime", () => {
  it("prefers SVG over PNG over JPEG over JPEG+extension over GIF", () => {
    expect(
      preferredImageMime({
        "image/png": "pn",
        "image/jpeg": "jp",
        "image/jpg": "jpg-ext",
        "image/svg+xml": "<svg/>",
        "image/gif": "gi",
      }),
    ).toBe("image/svg+xml");
    expect(
      preferredImageMime({ "image/png": "pn", "image/jpeg": "jp" }),
    ).toBe("image/png");
    expect(preferredImageMime({ "image/jpeg": "jp" })).toBe("image/jpeg");
    expect(preferredImageMime({ "image/jpg": "jpgext" })).toBe("image/jpg");
    expect(preferredImageMime({ "image/gif": "gi" })).toBe("image/gif");
  });

  it("returns null when no image payload is present", () => {
    expect(preferredImageMime({ "text/plain": "hi" })).toBeNull();
    expect(preferredImageMime(undefined)).toBeNull();
    expect(preferredImageMime(null)).toBeNull();
  });

  it("ignores empty-string payload and picks the next-best MIME", () => {
    expect(
      preferredImageMime({ "image/svg+xml": "", "image/png": "real" }),
    ).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// renderImagePayload
// ---------------------------------------------------------------------------

describe("renderImagePayload", () => {
  it("encodes PNG payload as data:image/png;base64,… markdown URL", () => {
    const text = renderImagePayload(
      { "image/png": "AAAA" },
      "image/png",
    );
    expect(text).toMatch(/^\[IMAGE: image\/png\]/);
    expect(text).toMatch(/!\[output\]\(data:image\/png;base64,AAAA\)/);
    expect(text).toMatch(/\[\/IMAGE\]$/);
  });

  it("encodes SVG via the utf-8 form so the markup round-trips", () => {
    const text = renderImagePayload(
      { "image/svg+xml": "<svg>hi</svg>" },
      "image/svg+xml",
    );
    expect(text).toContain("data:image/svg+xml;utf8,<svg>hi</svg>");
  });

  it("marks oversized payloads as truncated with the byte budget", () => {
    const huge = "A".repeat(MAX_IMAGE_BYTES + 1);
    const truncated = renderImagePayload(
      { "image/png": huge },
      "image/png",
    );
    expect(truncated).toContain("[IMAGE: image/png truncated]");
    expect(truncated).toContain(
      `exceeds the ${Math.floor(MAX_IMAGE_BYTES / 1024)} KB`,
    );
  });

  it("ignores unknown MIME types without crashing", () => {
    const out = renderImagePayload({ "image/tiff": "x" }, "image/tiff");
    expect(out).toContain("[IMAGE: image/tiff ignored]");
  });
});

// ---------------------------------------------------------------------------
// formatIopubForAgent
// ---------------------------------------------------------------------------

describe("formatIopubForAgent(stream)", () => {
  it("wraps a stdout stream in [STDOUT]…[/STDOUT]", () => {
    expect(
      formatIopubForAgent("stream", { text: "hello\n", name: "stdout" }),
    ).toEqual(["[STDOUT]\nhello\n\n[/STDOUT]"]);
  });

  it("wraps a stderr stream in [STDERR]…[/STDERR]", () => {
    expect(
      formatIopubForAgent("stream", { text: "boom\n", name: "stderr" }),
    ).toEqual(["[STDERR]\nboom\n\n[/STDERR]"]);
  });

  it("returns no chunk for empty text", () => {
    expect(
      formatIopubForAgent("stream", { text: "", name: "stdout" }),
    ).toEqual([]);
  });
});

describe("formatIopubForAgent(error)", () => {
  it("renders [ERROR: <ename>: <evalue>]", () => {
    expect(
      formatIopubForAgent("error", {
        ename: "ZeroDivisionError",
        evalue: "div by zero",
      }),
    ).toEqual(["[ERROR: ZeroDivisionError: div by zero]"]);
  });
});

describe("formatIopubForAgent(execute_result + image)", () => {
  it("emits the image payload first when text/plain is also present", () => {
    const chunks = formatIopubForAgent("execute_result", {
      execution_count: 7,
      data: {
        "text/plain": "<Figure size 800x600 with 1 Axes>",
        "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA=",
      },
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/^\[IMAGE: image\/png\]/);
    expect(chunks[0]).toContain("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA=");
    expect(chunks[1]).toMatch(/^\[RESULT\]/);
    expect(chunks[1]).toContain("<Figure size 800x600 with 1 Axes>");
  });

  it("image-only display_data has no [RESULT]/[DISPLAY] chunk", () => {
    expect(
      formatIopubForAgent("display_data", { data: { "image/png": "AAAA" } }),
    ).toHaveLength(1);
  });

  it("prefers SVG MIME over PNG when both are present", () => {
    const chunks = formatIopubForAgent("display_data", {
      data: {
        "image/png": "png-payload",
        "image/jpeg": "jpeg-payload",
        "image/svg+xml": "<svg/>",
      },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("image/svg+xml");
    expect(chunks[0]).toContain("<svg/>");
  });

  it("text-only execute_result just emits the [RESULT] chunk", () => {
    expect(
      formatIopubForAgent("execute_result", {
        execution_count: 1,
        data: { "text/plain": "42" },
      }),
    ).toEqual(["[RESULT]\n42\n[/RESULT]"]);
  });
});

// ---------------------------------------------------------------------------
// outputsToCellOutputs
// ---------------------------------------------------------------------------

describe("outputsToCellOutputs", () => {
  it("converts [STDOUT] chunks to nbformat-4 stream outputs", () => {
    expect(
      outputsToCellOutputs([
        "[STDOUT]\nhello\n\n[/STDOUT]",
        "[STDERR]\nboom\n\n[/STDERR]",
      ]),
    ).toEqual([
      { output_type: "stream", name: "stdout", text: "hello" },
      { output_type: "stream", name: "stderr", text: "boom" },
    ]);
  });

  it("converts [IMAGE: ...] chunks to display_data with bare base64", () => {
    expect(
      outputsToCellOutputs([
        "[IMAGE: image/png]\n![output](data:image/png;base64,iVBORw0K)\n[/IMAGE]",
      ]),
    ).toEqual([
      {
        output_type: "display_data",
        data: { "image/png": "iVBORw0K" },
        metadata: {},
      },
    ]);
  });

  it("converts [IMAGE: ...] chunks for SVG with bare svg markup", () => {
    expect(
      outputsToCellOutputs([
        "[IMAGE: image/svg+xml]\n![output](data:image/svg+xml;utf8,<svg/>)\n[/IMAGE]",
      ]),
    ).toEqual([
      {
        output_type: "display_data",
        data: { "image/svg+xml": "<svg/>" },
        metadata: {},
      },
    ]);
  });

  it("converts [RESULT] chunks to display_data with text/plain", () => {
    expect(
      outputsToCellOutputs(["[RESULT]\n42\n[/RESULT]"]),
    ).toEqual([
      {
        output_type: "display_data",
        data: { "text/plain": "42" },
        metadata: {},
      },
    ]);
  });

  it("preserves the round-trip order of an image+text execute_result", () => {
    const chunks = formatIopubForAgent("execute_result", {
      execution_count: 9,
      data: { "image/png": "png-bytes", "text/plain": "<Figure>" },
    });
    expect(outputsToCellOutputs(chunks)).toEqual([
      {
        output_type: "display_data",
        data: { "image/png": "png-bytes" },
        metadata: {},
      },
      {
        output_type: "display_data",
        data: { "text/plain": "<Figure>" },
        metadata: {},
      },
    ]);
  });

  it("falls back to a stdout stream for an unknown chunk shape", () => {
    expect(outputsToCellOutputs(["just a raw line"])).toEqual([
      { output_type: "stream", name: "stdout", text: "just a raw line" },
    ]);
  });

  it("ignores empty chunks", () => {
    expect(outputsToCellOutputs(["", "[STDOUT]\nhi\n\n[/STDOUT]"]))
      .toEqual([
        { output_type: "stream", name: "stdout", text: "hi" },
      ]);
  });
});

// ---------------------------------------------------------------------------
// MAX_IMAGE_BYTES invariant (sanity: stays at a sensible default)
// ---------------------------------------------------------------------------

describe("MAX_IMAGE_BYTES", () => {
  it("ships at 256 KB so a 30-megapixel figure does not bloat the tool-result", () => {
    expect(MAX_IMAGE_BYTES).toBe(256 * 1024);
  });
});

describe("renderImagePayload truncation", () => {
  // We test the truncation path by feeding a payload larger than the
  // real MAX_IMAGE_BYTES value directly; this avoids mutating the module
  // export and keeps the test hermetic.
  it("marks oversized payloads as truncated", () => {
    const huge = "A".repeat(MAX_IMAGE_BYTES + 1);
    const out = renderImagePayload({ "image/png": huge }, "image/png");
    expect(out).toContain("[IMAGE: image/png truncated]");
    expect(out).toContain(
      `exceeds the ${Math.floor(MAX_IMAGE_BYTES / 1024)} KB`,
    );
  });

  it("does NOT mark payloads <= MAX_IMAGE_BYTES as truncated", () => {
    const edge = "A".repeat(MAX_IMAGE_BYTES);
    const out = renderImagePayload({ "image/png": edge }, "image/png");
    expect(out).not.toContain("truncated");
    expect(out).toContain("![output](data:image/png;base64,");
  });
});
