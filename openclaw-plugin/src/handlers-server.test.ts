// Tests for the server-level jupyter_* handlers.
//
// These handlers don't need an active notebook, so each test sets up a
// fresh `harness` (no `activateNotebook` call) and stubs ONE method on
// `JupyterDirectClient.prototype`. Mirrors hermes-plugin/tests/test_handlers_
// server.py for parity.

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  buildHarness,
  stubListFiles,
  stubListKernels,
  type Harness,
} from "./test-utils.js";

let harness: Harness;

beforeEach(async () => {
  // Plugin config drives the jupyter url / token seen on the client. Default
  // constructor url is http://127.0.0.1:8888 and an empty token — that's
  // what `jupyter_server_info` returns unless we override here.
  harness = await buildHarness();
});

afterEach(async () => {
  await harness.reset();
});

describe("jupyter_server_info", () => {
  it("returns the URL + token the client was constructed with", async () => {
    const result = await harness.invoke("jupyter_server_info", {});
    expect(result).toContain("Jupyter server info");
    expect(result).toContain("http://127.0.0.1:8888");
    // Default token is "" so the body shows `"jupyter_token": ""`.
    expect(result).toContain("jupyter_token");
  });

  it("honours a non-empty token from pluginConfig", async () => {
    await harness.reset();
    const h2 = await buildHarness({
      jupyterToken: "test-token",
      jupyterUrl: "http://test-jupyter.invalid:8888",
    });
    const result = await h2.invoke("jupyter_server_info", {});
    expect(result).toContain("http://test-jupyter.invalid:8888");
    expect(result).toContain("test-token");
  });
});

describe("jupyter_list_kernels", () => {
  it("renders a TSV listing of running kernels", async () => {
    stubListKernels(
      "Name\tDisplay_Name\tLanguage\tCodeMirror_Mode\tEnvironment\tHelp_Links\tIs_Default\tArgv_Sample\n" +
        "python3\tPython 3\tpython\tauto\t{}\t{}\ttrue\tpython",
    );
    const result = await harness.invoke("jupyter_list_kernels", {});
    expect(result).toContain("Jupyter kernels");
    expect(result).toContain("python3");
    expect(result).toContain("Python 3");
  });

  it("surfaces an empty listing cleanly when no kernels are running", async () => {
    stubListKernels(
      "Name\tDisplay_Name\tLanguage\tCodeMirror_Mode\tEnvironment\tHelp_Links\tIs_Default\tArgv_Sample\n",
    );
    const result = await harness.invoke("jupyter_list_kernels", {});
    expect(result).toContain("Jupyter kernels");
    // The TSV header should still be there.
    expect(result).toContain("Display_Name");
  });
});

describe("jupyter_list_kernelspecs", () => {
  it("returns the TSV listing produced by the client", async () => {
    const { vi } = await import("vitest");
    const { JupyterDirectClient } = await import("./jupyter-client.js");
    // The handler is a thin passthrough: `await client.listKernelspecs()` →
    // asToolText(title, tsv).
    vi.spyOn(JupyterDirectClient.prototype, "listKernelspecs").mockResolvedValue(
      "Name\tDisplay_Name\tLanguage\tCodeMirror_Mode\tEnv\n" +
        "python3\tPython 3 (IPython)\tpython\tauto\t{\"FOO\":\"bar\"}",
    );
    const result = await harness.invoke("jupyter_list_kernelspecs", {});
    expect(result).toContain("Jupyter kernelspecs");
    expect(result).toContain("python3");
    expect(result).toContain("Python 3 (IPython)");
  });
});

describe("jupyter_list_files", () => {
  it("returns the rendered TSV from the client", async () => {
    stubListFiles(
      "Showing 0-2 of 2 files\n\n" +
        "Path\tType\tSize\tLast_Modified\n" +
        "mydir\tdirectory\t-\trecent\n" +
        "nb.ipynb\tfile\t1.2KB\trecent\n",
    );
    const result = await harness.invoke("jupyter_list_files", {});
    expect(result).toContain("Jupyter files");
    expect(result).toContain("mydir");
    expect(result).toContain("nb.ipynb");
  });
});
