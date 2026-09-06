#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# OpenClaw plugin installer for ClawPyter.
#
# Compatible with OpenClaw 2026.9.2 design:
#   * Uses the canonical positional-path form:
#         openclaw plugins install <path> --force --accept-capabilities
#     The short-flag form `install -l <path>` (where -l is the old alias for
#     --link) still works but is not preferred as of 2026.9.x.
#   * Sends the absolute path of the inner git repo via a `git:file://` URL.
#     This routes through the git-source resolver, which gives OpenClaw full
#     provenance (HEAD SHA, ref, source) and goes through the same capability
#     + audit-log path as remote installs. The local-path resolver (no git:
#     prefix) is the alternative, but it skips provenance tracking.
#   * `--accept-capabilities` is mandatory in 2026.9.x because our
#     openclaw.plugin.json declares `contracts.tools` (the new tool-contracts
#     contract introduced in 2026.9.2).
#   * `--force` overwrites any prior clawpyter install record. Required when
#     iterating because we don't track a version bump in the manifest yet.
# -----------------------------------------------------------------------------

PLUGIN_SRC="$(cd "$(dirname "$0")/openclaw-plugin" && pwd)"

# Required tools.
for cmd in npm node git openclaw; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' not found on PATH." >&2
    case "$cmd" in
      npm|node) echo "       Install Node.js (>= 20) and npm first." >&2 ;;
      git)      echo "       Install git first; the install path uses 'git:' resolution." >&2 ;;
      openclaw) echo "       Install the OpenClaw runtime first; this script only registers the plugin." >&2 ;;
    esac
    exit 1
  fi
done

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "ERROR: Node.js >= 20 required (found: $(node -v))." >&2
  echo "       OpenClaw 2026.9.x no longer builds against Node 18." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Install Node deps + compile. dist/ stays outside the inner repo's tracked
# tree (see openclaw-plugin/.gitignore), so the git:file:// source stays slim
# and the build outputs are regenerated on the user's side during install.
# -----------------------------------------------------------------------------
echo "==> Installing OpenClaw-plugin runtime deps (peer/optional yjs NOT auto-installed; the plugin loads without it)..."
(cd "$PLUGIN_SRC" && npm install --omit=optional --no-audit --no-fund)

echo "==> Compiling TypeScript..."
(cd "$PLUGIN_SRC" && npm run build)

# -----------------------------------------------------------------------------
# Verify the inner repo exists and has a HEAD commit.
# -----------------------------------------------------------------------------
if [[ ! -d "$PLUGIN_SRC/.git" ]]; then
  echo "ERROR: $PLUGIN_SRC is not a git repository." >&2
  echo "       OpenClaw 2026.9.x 'git:' install expects a real git source." >&2
  echo "       Initialise it with:" >&2
  echo "           cd $PLUGIN_SRC && git init -b main" >&2
  echo "           cd $PLUGIN_SRC && git add .gitignore openclaw.plugin.json package.json package-lock.json src skills tsconfig.json" >&2
  echo "           cd $PLUGIN_SRC && git -c user.email=you@example.com -c user.name=You commit -m 'initial source for OpenClaw install'" >&2
  exit 1
fi

if ! (cd "$PLUGIN_SRC" && git rev-parse --verify HEAD >/dev/null 2>&1); then
  echo "ERROR: $PLUGIN_SRC has no commits yet (HEAD missing)." >&2
  echo "       OpenClaw's git-source resolver needs a HEAD commit to clone." >&2
  echo "       Make an initial commit (see instructions above)." >&2
  exit 1
fi

# Use the inner repo's absolute file:// path. file:// requires no relative
# segments, no shell expansion — pass it as-is.
GIT_FILE_URL="git:file://${PLUGIN_SRC}"

# -----------------------------------------------------------------------------
# Install via the canonical positional-path command (now also accepts the
# git:file:// URL through the git-source resolver).
# -----------------------------------------------------------------------------
echo "==> Registering clawpyter with OpenClaw via git:file:// URL..."
if ! openclaw plugins install "$GIT_FILE_URL" --force --accept-capabilities; then
  echo "ERROR: 'openclaw plugins install $GIT_FILE_URL --force --accept-capabilities' failed." >&2
  echo "       If the security scan blocked this trusted local install, re-run" >&2
  echo "       with  openclaw plugins install $GIT_FILE_URL --force --accept-capabilities ' --acknowledge-install-policy-warning  " >&2
  echo "       or set plugins.installPolicy.allow_local_path_plugin_files: true in config.yaml." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Verify registration + tell the operator about the daemon restart they need.
# -----------------------------------------------------------------------------
echo "==> Verifying clawpyter is registered..."
if openclaw plugins list 2>/dev/null | grep -q clawpyter; then
  echo "    ✓ clawpyter is registered."
else
  echo "    (clawpyter did not appear in 'openclaw plugins list' — check the install output above.)" >&2
  exit 1
fi

echo ""
echo "Done. Restart any running OpenClaw daemon so the new plugin is picked up:"
echo "    openclaw daemon restart"
echo ""
echo "If you previously enabled clawpyter, the existing enable record is preserved."
echo "If this is a fresh install, enable it now:"
echo "    openclaw plugins enable clawpyter"
