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
