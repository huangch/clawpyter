# AGENTS.md — ClawPyter

Standing instructions for AI agents (Hermes, Claude Code, Codex, …) working **in this repository**.
This file is for *developing* ClawPyter; it is not part of the plugin/skill packaging shipped to end users.

## What this repo is

ClawPyter gives AI agents JupyterLab control via a shared set of 36 `jupyter_*` tools,
packaged twice:

- `hermes-plugin/` — Python plugin for Hermes Agent. Implements **live co-editing**
  (Y.js CRDT via `jupyter-collaboration`, see `collab_client.py`); falls back to REST when
  the collaboration deps are missing.
- `openclaw-plugin/` — TypeScript plugin for OpenClaw. Implements **the same live
  co-editing** via `yjs` and Node's built-in WebSocket (see `src/collab-client.ts`).
  `yjs` is a **peer-optional** dependency: the plugin loads and runs without it and
  silently falls back to the Contents-API path. Tri-state mode mirrors the Hermes side:
  `JUPYTER_COLLAB_MODE` env var (Hermes) / `collabMode` config (OpenClaw), default `"auto"`.
- Root shell scripts: `conda-setup.sh` builds an environment; `start-jpy.sh` / `stop-jpy.sh`
  manage a local JupyterLab instance.
- `Dockerfile` + `docker-build-push.sh` build `huangchtw/clawpyter`, a JupyterLab server
  image with collaboration enabled. The image deliberately does **not** contain the
  plugins — those belong in the agent's environment.

## Product boundary

ClawPyter is the **native Jupyter integration for Hermes Agent and OpenClaw** —
nothing more, nothing less. The plugins in `hermes-plugin/` and `openclaw-plugin/`
are loaded **inside** the agent's process via the runtime's plugin contract; no
external MCP server is involved.

**Deliberately out of scope:**

- **MCP server entry point.** Don't add one. Users on GitHub Copilot / Continue
  / Cline / Cursor / Aider should install
  [`jupyter-mcp-server`](https://github.com/datalayer/jupyter-mcp-server) instead
  — it's their first-party tool, ships through ClawHub, and that's its job.
- **JupyterLab extension mode.** jmcp can run as a JupyterLab embedded extension
  (`JUPYTER_SERVER` mode). ClawPyter cannot, and shouldn't try: the value here
  is the native agent-runtime integration, not the embedded Jupyter integration.
- **Cloud sandbox backends.** jmcp ships integration with Colab / Kaggle /
  Modal / Daytona / E2B / Coreweave / Cloudflare / Datalayer through the
  `code-sandboxes` package. ClawPyter is local-Jupyter only; reach for jmcp when
  agents need remote GPU.

If a future contributor proposes an MCP-server or extension-mode entry point,
redirect them to `jupyter-mcp-server` instead of expanding scope here. The
README's "When to use / when not to use" section is the canonical statement.

## Environment

- **Always run `conda activate claude` before any Python / pip command.**
- `./conda-setup.sh ENV_NAME [-r|--reset] [-d|--dev]` creates/populates an env.
  There are **no** opt-out flags: co-editing is mandatory, so it always installs
  both halves of the stack.
- Hermes plugin deps, all required: `httpx`, `websockets`, `jupyter_nbmodel_client`, `pycrdt`
  (agent side) and `jupyterlab`, `jupyter-collaboration` (server side).
  A missing server extension is the dangerous case — it degrades silently to
  whole-file PUTs, so `start-jpy.sh` refuses to launch without it.
- OpenClaw plugin deps are managed by `npm` inside `openclaw-plugin/` (TypeScript, built to `dist/`).
  Production runtime: `@sinclair/typebox` (required for tool schema). Optional: `yjs` >= 13.5.22
  (no `>=X.Y.Z` upper bound — peer dep) enables Y.js CRDT co-editing; Node ≥ 22 supplies
  the WebSocket client.
- The two SKILL.md files (`hermes-plugin/SKILL.md` and `openclaw-plugin/skills/clawpyter/SKILL.md`)
  must stay in sync on tool surface, lifecycle, and the **Co-editing with a human** section.
  Both runtimes now ship co-editing; the difference is purely which optional CRDT libs to install.

## Build / deploy

```sh
./conda-setup.sh <env>   # env + all deps (agent side AND JupyterLab server)
./build4hermes.sh        # pip deps + copy hermes-plugin/ -> ~/.hermes/plugins/clawpyter/
./build4openclaw.sh      # npm install + build, then `openclaw plugins install -l`
./docker-build-push.sh   # build clawpyter:latest -> push huangchtw/clawpyter:latest
```

### Tests (Hermes plugin Python suite)

The Hermes handler surface is exercised by a sync pytest suite under
`hermes-plugin/tests/` (35 tests covering `jupyter_*` server-, notebook-, and
cell-level handlers). Tests use the canonical Python module name `hermes_plugin`
via a dev-only symlink so Python's import system can resolve the directory —
the source-of-truth path `hermes-plugin/` has a dash, which Python identifiers
cannot use.

```sh
# One-time: create the dev-only import alias (gitignored).
ln -sf hermes-plugin hermes_plugin

# Run:
python3 -m pytest               # uses pytest.ini testpaths = hermes_plugin/tests
python3 -m pytest -v            # verbose
python3 -m pytest -k move_cell  # narrow via pytest -k filter
```

The suite does NOT need pytest-asyncio (`hermes-plugin/tests/_bootstrap.py`
provides a `run()` helper that wraps handlers under `asyncio.run`). CI is
local today; add `-m pytest tests/` to the conda-setup `-d` dev workflow if
you wire CI later.

### Tests (OpenClaw plugin TypeScript suite)

The OpenClaw plugin (`openclaw-plugin/`) ships a parallel TypeScript suite
run by **vitest** (51 tests as of Sep-2026). It mirrors the python suite:
- `image-outputs.test.ts` covers `preferredImageMime`, `renderImagePayload`,
  `formatIopubForAgent`, `outputsToCellOutputs` (image MIME handling).
- `handlers-cell.test.ts` exercises the cell-level handlers
  (`insert_cell`, `overwrite_cell_source`, `read_cell`, `clear_cell_output`,
  `move_cell`, `delete_cell`) with a per-cell-id closure path that mirrors
  `hermes_plugin/tests/test_handlers_cell.py`.
- `handlers-server.test.ts` exercises the server-info / kernels /
  kernelspecs / files handlers via prototype `vi.spyOn` mocking on
  `JupyterDirectClient` (no network).

Run:

```sh
cd openclaw-plugin
ln -sf ../hermes-plugin hermes_plugin   # only if you'll run pytest too
npm install                              # installs vitest + yjs from package.json
npx vitest run                           # 51 tests in ~1s
npx vitest run src/handlers-cell.test.ts # narrow by path
```

`vitest.config.ts` resolves the bare specifier `openclaw/plugin-sdk/
plugin-entry` (the OpenClaw host's plugin SDK, not installed here) to a
test-only stub at `src/test-stub-openclaw-sdk.ts`. The stub returns the
`definePluginEntry({...})` argument unchanged so handler tests can drive
`pluginEntry.register(api)` without standing up the host at runtime.
The stub is excluded from the production `tsc -p tsconfig.json` build
(via the `test-stub-*.ts` glob in the `exclude` list).

CI is local today; the conda-setup `-d` dev workflow installs vitest
automatically and exposes the result via `npx vitest run` after
`./conda-setup.sh clawpyter -d`.

### Running JupyterLab — use the unified `clawpyter` script

The legacy `start-jpy.sh` / `stop-jpy.sh` / `clawpyter-docker-run.sh` scripts
have moved to `bak_old_scripts/` (kept for reference; they still work). The
single, replacement entry point is **`./clawpyter.sh`**:

```sh
./clawpyter.sh start    -d <notebook_dir> -b {native,docker} [-p <port>] [-t <token>|--no-token]
./clawpyter.sh stop     -d <notebook_dir> -b {native,docker}
./clawpyter.sh status   -d <notebook_dir> [-b {native,docker}] [--all]
./clawpyter.sh logs     -d <notebook_dir> -b {native,docker} [-f]
```

State lives in `<data_dir>/.clawpyter/instances.json` (no `/tmp/*.pid`, no
global `~/.hermes/` coupling — the agent or any launcher can read it). The
wrapper uses `CLAWPYTER_IMAGE` if set (default `huangchtw/clawpyter:latest`)
and `CLAWPYTER_NO_PULL=1` to skip the image pull.

- Script naming rule: a `docker-` PREFIX means the script is baked into the
  image and runs inside it (`docker-entrypoint.sh`);
  host-side wrappers are `<package>-docker-run.sh`, matching wsinsight,
  sptxinsight and hplot. `docker-build-push.sh` is the one host-side exception,
  and is named identically across all the sibling repos.

- `build4hermes.sh` does `rm -rf` of the destination before copying — re-run it after **every**
  change to `hermes-plugin/` (the deployed copy otherwise goes stale).
- `build4openclaw.sh` uninstalls before installing; a running OpenClaw daemon may need
  `openclaw daemon restart` afterwards.
- The image needs no launch wrapper: `jupyter-server` reads `JUPYTER_TOKEN`
  itself (unset -> random token in the banner, `""` -> auth disabled), so `CMD`
  is a plain `jupyter lab ...` array. The container always listens on 8888;
  `clawpyter` maps the host port and translates `--no-token` to the empty string.
- `docker-entrypoint.sh` is kept **byte-for-byte identical** across wsinsight, sptxinsight,
  hplot, wsinsight-train and clawpyter. Copy it, don't edit one copy.

## SKILL.md sync rule (important)

`hermes-plugin/SKILL.md` and `openclaw-plugin/skills/clawpyter/SKILL.md` must stay **in sync**.
Both runtimes now ship co-editing (Hermes via `jupyter_nbmodel_client` + `pycrdt`, OpenClaw via
`yjs` + Node's built-in WebSocket), so the **"Co-editing with a human"** section is present
in BOTH copies — it is no longer Hermes-only. When editing one copy, mirror the change in
the other, including the runtime-dependency sentence that names each runtime's CRDT deps
(`jupyter_nbmodel_client` + `pycrdt` for Hermes, `yjs` for OpenClaw).

## Conventions

- `start-jpy.sh` token design: no `-t` → auto-generated UUID token; `-t none` or `-t ""` →
  no authentication (trusted networks only); `-t <token>` → explicit token. Keep the help
  text, the README and `clawpyter-docker-run.sh` consistent with this if you touch token
  handling — the container mirrors the same three cases via `JUPYTER_TOKEN`.
- `start-jpy.sh` runs whichever `jupyter` is on PATH (no `conda run` wrapper), so `$!` is
  the real server PID. Its two preflight checks — `jupyter` present, `jupyter_collaboration`
  loaded — are fatal by design.
- Never commit secrets: tokens, `.jupyter_ystore.db`, `node_modules/`, `dist/`, `__pycache__/`
  are gitignored — if a path is still tracked, use `git rm --cached`.
- The README's "Project Structure" section mirrors the real tree; update it when files move.
