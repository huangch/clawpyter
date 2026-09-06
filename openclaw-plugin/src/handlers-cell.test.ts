// Tests for the cell-level jupyter_* handlers.
//
// Mirrors hermes-plugin/tests/test_handlers_cell.py so both runtimes prove
// the cell_id closure surface: `overwrite_cell_source`, `move_cell`, and
// `delete_cell` accept either `cell_index` OR `cell_id` (preferred when
// concurrent edits may shift indices); the others (`insert_cell`,
// `read_cell`, `clear_cell_outputs`) accept cell_id alongside the legacy
// cell_index lookup.

import { beforeEach, afterEach, describe, it, expect } from "vitest";

import {
  buildHarness,
  stubMutateNotebook,
  activateNotebook,
  EMPTY_NOTEBOOK,
  type Harness,
} from "./test-utils.js";

let harness: Harness;

beforeEach(async () => {
  harness = await buildHarness();
  // Activate "demo" with a default 2-cell notebook; individual tests
  // re-stub `getContents` with their own fixture when they need a
  // different starting state.
  await activateNotebook(harness);
});

afterEach(async () => {
  await harness.reset();
});

describe("jupyter_insert_cell", () => {
  it("inserts a code cell at index 0 of an empty notebook", async () => {
    const { puts } = stubMutateNotebook({
      notebook: EMPTY_NOTEBOOK(),
    });
    const result = await harness.invoke(
      "jupyter_insert_cell",
      { cell_index: 0, cell_type: "code", cell_source: "print(1)" },
    );
    expect(String(result)).toContain("successfully");
    expect(String(result)).toContain("index 0");
    expect(puts).toHaveLength(1);
  });

  it("returns a clear error when the index is out of range", async () => {
    stubMutateNotebook();
    const result = await harness.invoke(
      "jupyter_insert_cell",
      { cell_index: 99, cell_type: "code", cell_source: "x" },
    );
    expect(String(result)).toMatch(/out of range|index/i);
  });
});

describe("jupyter_overwrite_cell_source", () => {
  it("overwrites by index (path that pre-dates cell_id closure)", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_overwrite_cell_source", {
      cell_index: 0,
      cell_source: "a = 42\n",
    });
    expect(String(result)).toContain("Overwrite cell 0");
    expect(String(result)).toMatch(/[+\-]\s*a\s*=\s*42/);
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it("overwrites by cell_id when the agent supplies it", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_overwrite_cell_source", {
      cell_id: "cell-B",
      cell_source: "# Replaced\n",
    });
    expect(String(result)).toContain("Overwrite cell 1");
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it("returns an error when neither cell_index nor cell_id is supplied", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_overwrite_cell_source", {
      cell_source: "x",
    });
    expect(String(result)).toMatch(/either.*cell_index.*cell_id|cell_id|cell_index/i);
  });

  it("returns an error when the supplied cell_id does not exist", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_overwrite_cell_source", {
      cell_id: "does-not-exist",
      cell_source: "x",
    });
    expect(String(result)).toMatch(/not found|ERROR/i);
  });
});

describe("jupyter_read_cell", () => {
  it("reads by cell_id and surfaces the cell's id + type", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_read_cell", {
      cell_id: "cell-A",
    });
    expect(String(result)).toContain("ID: cell-A");
    expect(String(result)).toContain("Type: code");
  });

  it("falls back to cell_index when cell_id is omitted", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_read_cell", {
      cell_index: 0,
    });
    expect(String(result)).toContain("Type: code");
  });

  it("hides outputs when include_outputs is false", async () => {
    stubMutateNotebook({
      notebook: {
        cells: [
          {
            cell_type: "code",
            id: "cell-A",
            source: "1+1\n",
            metadata: {},
            outputs: [
              {
                output_type: "execute_result",
                data: { "text/plain": "2" },
                metadata: {},
                execution_count: 1,
              },
            ],
            execution_count: 1,
          },
          {
            cell_type: "markdown",
            id: "cell-B",
            source: "# Hi\n",
            metadata: {},
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      },
    });
    const result = await harness.invoke("jupyter_read_cell", {
      cell_id: "cell-A",
      include_outputs: false,
    });
    expect(String(result)).not.toContain("2");
  });
});

describe("jupyter_clear_cell_output", () => {
  it("clears outputs on a code cell", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_clear_cell_output", {
      cell_id: "cell-A",
    });
    expect(String(result)).toMatch(/Cleared|cleared|outputs/i);
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to clear a non-code cell", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_clear_cell_output", {
      cell_id: "cell-B", // markdown in the fixture
    });
    expect(String(result)).toMatch(/markdown|not a code|ERROR/i);
  });
});

describe("jupyter_move_cell", () => {
  it("moves cell at index 0 to index 1", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_move_cell", {
      source_index: 0,
      target_index: 1,
    });
    expect(String(result)).toMatch(/Move|move/i);
    // PUT must happen with the cells reordered.
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it("moves by source+target cell_id, jmcp ordering (source first, then target)", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_move_cell", {
      source_cell_id: "cell-A",
      target_cell_id: "cell-B",
    });
    expect(String(result)).toMatch(/Move|move/i);
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it("errors when no source is given (only target)", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_move_cell", {
      target_cell_id: "cell-B",
    });
    expect(String(result)).toMatch(/source|ERROR/i);
  });

  it("errors when source_cell_id does not exist", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_move_cell", {
      source_cell_id: "no-such-cell",
      target_index: 0,
    });
    expect(String(result)).toMatch(/not found|ERROR/i);
  });
});

describe("jupyter_delete_cell", () => {
  it("deletes by cell_indices [1]", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_delete_cell", {
      cell_indices: [1],
    });
    expect(String(result)).toMatch(/Delete|Deleted 1|deleted/i);
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes by cell_ids_to_delete atomically", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_delete_cell", {
      cell_ids_to_delete: ["cell-A"],
    });
    expect(String(result)).toMatch(/Delete|Deleted 1|deleted/i);
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it("aborts when any cell_ids_to_delete is unknown", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_delete_cell", {
      cell_ids_to_delete: ["cell-A", "no-such-id"],
    });
    expect(String(result)).toMatch(/not found|atomic|aborted|ERROR/i);
  });

  it("merges + dedups cell_indices with cell_ids_to_delete", async () => {
    const { puts } = stubMutateNotebook();
    const result = await harness.invoke("jupyter_delete_cell", {
      cell_indices: [0, 1],
      cell_ids_to_delete: ["cell-A", "cell-A"],
    });
    // 2 unique targets -> one PUT, content has 0 cells.
    expect(String(result)).toMatch(/Delete|deleted/i);
    expect(puts).toHaveLength(1);
    const put = puts[0] as { cells: unknown[] };
    expect(put.cells).toHaveLength(0);
  });

  it("errors when no indices nor ids are supplied", async () => {
    stubMutateNotebook();
    const result = await harness.invoke("jupyter_delete_cell", {});
    expect(String(result)).toMatch(/provide|ERROR|cell_indices|cell_ids_to_delete/i);
  });
});
