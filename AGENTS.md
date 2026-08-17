# AGENTS.md — ClawPyter

Standing instructions for AI agents (Hermes, Claude Code, Codex, …) working **in this repository**.
This file is for *developing* ClawPyter; it is not part of the plugin/skill packaging shipped to end users.

## What this repo is

ClawPyter gives AI agents JupyterLab control via a shared set of 20 `jupyter_*` tools,
packaged twice:

- `hermes-plugin/` — Python plugin for Hermes Agent. Also implements **live co-editing**
  (Y.js CRDT via `jupyter-collaboration`, see `collab_client.py`); falls back to REST when
  the collaboration deps are missing.
- `openclaw-plugin/` — TypeScript plugin for OpenClaw. Uses the Contents-API path only
  (no co-editing yet).
- Root shell scripts: `start-jpy.sh` / `stop-jpy.sh` manage a local JupyterLab instance.

## Environment

- **Always run `conda activate claude` before any Python / pip command.**
- Python plugin deps: `httpx`, `websockets` (required); `jupyter_nbmodel_client`, `pycrdt`
  (optional, co-editing only).
- OpenClaw plugin deps are managed by `npm` inside `openclaw-plugin/` (TypeScript, built to `dist/`).

## Build / deploy

```sh
./build4hermes.sh    # pip deps + copy hermes-plugin/ -> ~/.hermes/plugins/clawpyter/
./build4openclaw.sh  # npm install + build, then `openclaw plugins install -l`
```

- `build4hermes.sh` does `rm -rf` of the destination before copying — re-run it after **every**
  change to `hermes-plugin/` (the deployed copy otherwise goes stale).
- `build4openclaw.sh` uninstalls before installing; a running OpenClaw daemon may need
  `openclaw daemon restart` afterwards.

## SKILL.md sync rule (important)

`hermes-plugin/SKILL.md` and `openclaw-plugin/skills/clawpyter/SKILL.md` must stay **in sync**
with one exception: the Hermes copy additionally contains the **"Co-editing with a human"**
section. That section is Hermes-only (co-editing is not implemented in the OpenClaw plugin) and
must NOT be copied into the OpenClaw SKILL.md. When editing one copy, mirror the change in the
other, keeping that difference intact.

## Conventions

- `start-jpy.sh` token design: no `-t` → auto-generated UUID token; `-t none` or `-t ""` →
  no authentication (trusted networks only); `-t <token>` → explicit token. Keep the help
  text and README consistent with this if you touch token handling.
- Never commit secrets: tokens, `.jupyter_ystore.db`, `node_modules/`, `dist/`, `__pycache__/`
  are gitignored — if a path is still tracked, use `git rm --cached`.
- The README's "Project Structure" section mirrors the real tree; update it when files move.
