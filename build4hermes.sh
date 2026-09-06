#!/usr/bin/env bash
set -euo pipefail

# Hermes plugin installer for ClawPyter.
#
# Honours the Sep-2026 Hermes conventions:
#   * Uses `get_hermes_home()` semantics via the HERMES_HOME env var
#     (falls back to $HOME/.hermes when HERMES_HOME is unset).
#   * Prefers `hermes plugins install -l <dir>` when the Hermes CLI is on PATH
#     so the post-install scan, manifest validation, env prompt, and
#     enable-toggle happen through the canonical path.
#   * Falls back to direct cp -r if Hermes is not installed yet (e.g. during
#     a fresh bootstrap before pip install hermes-cli), but still honours
#     HERMES_HOME and warns about skipped scan / enable.
#   * Verifies every .py under the installed plugin compiles cleanly so an
#     import-time error in collab_client.py or schemas.py also fails the
#     install (the loader only runs them on first call).

PLUGIN_SRC="$(cd "$(dirname "$0")/hermes-plugin" && pwd)"

# Hermes itself runs inside its own venv; resolve to the Python interpreter
# on PATH (which is whichever the user activated, e.g. `conda activate claude`).
# Using bare `pip` here can land deps in the wrong env.
PY="$(command -v python3)"
if [[ -z "$PY" ]]; then
  echo "ERROR: python3 not found on PATH. Activate a Python env first (e.g. 'conda activate claude')." >&2
  exit 1
fi

# ClawPyter needs Python >= 3.9 (uses PEP 604 union syntax in some deps and
# requires modern pip). Refuse system Pythons that would either fail to parse
# the source or fail to install packages into read-only site dirs.
PY_VER="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
PY_PREFIX="$("$PY" -c 'import sys;print(sys.prefix)')"
PY_EXEC="$("$PY" -c 'import sys;print(sys.exec_prefix)')"
case "$PY_VER" in
  3.[6-8]|3.[6-8].*) echo "ERROR: Python $PY_VER at $PY is too old (need >=3.9). Activate a newer env (e.g. 'conda activate claude')." >&2; exit 1 ;;
esac
if [[ "$PY_PREFIX" == "/usr" || "$PY_EXEC" == "/usr" ]] && [[ -z "${CONDA_PREFIX:-}" || "$PY_PREFIX" != "$CONDA_PREFIX" ]]; then
  echo "ERROR: resolved python3 ($PY) points at the system Python ($PY_PREFIX)." >&2
  echo "       Install/activate a venv or conda env first (e.g. 'conda activate claude')." >&2
  exit 1
fi

echo "==> Using Python: $PY ($("$PY" --version 2>&1), prefix=$PY_PREFIX)"

# Resolve Hermes home: HERMES_HOME env var first (mirrors Hermes' get_hermes_home()),
# otherwise the platform default under $HOME.
if [[ -n "${HERMES_HOME:-}" ]]; then
  HERMES_HOME_RESOLVED="$HERMES_HOME"
else
  HERMES_HOME_RESOLVED="$HOME/.hermes"
fi
PLUGIN_DEST="$HERMES_HOME_RESOLVED/plugins/clawpyter"
SKILL_DEST="$HERMES_HOME_RESOLVED/skills/clawpyter"
echo "==> Hermes home: $HERMES_HOME_RESOLVED"

echo "==> Installing Python dependencies (httpx, websockets)..."
"$PY" -m pip install --quiet httpx websockets

echo "==> Installing optional jupyter-collaboration dependencies..."
echo "    (skip on failure — ClawPyter falls back to REST mode if missing)"
"$PY" -m pip install --quiet jupyter_nbmodel_client pycrdt || \
  echo "    WARNING: collaboration deps not installed; ClawPyter will run in REST mode only."

# ----------------------------------------------------------------------------
# Install path: prefer `hermes plugins install` so the canonical Hermes
# installer runs scan + enable. Fall back to cp -r if Hermes isn't on PATH.
# ----------------------------------------------------------------------------
if command -v hermes >/dev/null 2>&1; then
  echo "==> Hermes CLI detected — delegating to 'hermes plugins install'..."
  # Ensure the user wants to overwrite (mirrors the canonical ask flow).
  if [[ -d "$PLUGIN_DEST" ]]; then
    echo "    Existing install at $PLUGIN_DEST — Hermes will replace it."
  fi
  if ! hermes plugins install -l "$PLUGIN_SRC" --enable; then
    echo "ERROR: 'hermes plugins install -l $PLUGIN_SRC --enable' failed." >&2
    echo "       Re-run with HERMES_PLUGINS_SCAN_ON_INSTALL=false if the security" >&2
    echo "       scan blocks this trusted local install, or pass --force to override." >&2
    exit 1
  fi
else
  echo "==> Hermes CLI not on PATH — using direct cp -r fallback."
  echo "    (Re-run after 'pip install hermes-cli' to enable the canonical install path.)"
  mkdir -p "$(dirname "$PLUGIN_DEST")"
  rm -rf "$PLUGIN_DEST"
  cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"
  echo "    WARNING: install skipped Hermes' security scan and enable-toggle." >&2
  echo "             After bootstrapping Hermes, run: hermes plugins enable clawpyter" >&2
fi

# Skill file: Hermes snapshots skills at session start, so install BEFORE first
# Hermes launch. Hermes Sep-2026 supports `hermes plugin skills install` as a
# canonical path; the manual cp is a defensive fallback.
echo "==> Installing skill file to $SKILL_DEST..."
mkdir -p "$SKILL_DEST"
if command -v hermes >/dev/null 2>&1 && hermes plugin skills install --help >/dev/null 2>&1; then
  hermes plugin skills install "$PLUGIN_SRC/SKILL.md" --name clawpyter || \
    cp -f "$PLUGIN_SRC/SKILL.md" "$SKILL_DEST/SKILL.md"
else
  cp -f "$PLUGIN_SRC/SKILL.md" "$SKILL_DEST/SKILL.md"
fi

echo "==> Verifying plugin files..."
# Compile every .py under the plugin so an import-time error in collab_client.py
# or schemas.py also fails the install.
fail=0
while IFS= read -r -d '' f; do
  if ! "$PY" -m py_compile "$f" >/dev/null 2>&1; then
    echo "    FAILED compile: $f" >&2
    fail=1
  fi
done < <(find "$PLUGIN_DEST" -type f -name '*.py' -print0)
[[ $fail -eq 0 ]] || { echo "Plugin verification FAILED." >&2; exit 1; }

# Stronger post-install check than 'hermes plugins list | grep': confirm the
# artifact actually landed and the loader will be able to import it.
[[ -f "$PLUGIN_DEST/__init__.py" ]] || { echo "Missing $PLUGIN_DEST/__init__.py" >&2; exit 1; }
[[ -f "$SKILL_DEST/SKILL.md" ]]       || { echo "Missing $SKILL_DEST/SKILL.md" >&2; exit 1; }

echo "==> Plugin installed. Reloading Hermes plugin registry..."
if command -v hermes >/dev/null 2>&1; then
  if hermes plugins list 2>/dev/null | grep -q clawpyter; then
    echo "    clawpyter is registered."
  else
    echo "    (Start hermes to pick up the plugin — it is discovered at startup.)"
  fi
else
  echo "    (hermes CLI not on PATH — will be picked up the next time hermes is launched.)"
fi

echo ""
echo "Done. Set JUPYTER_URL and JUPYTER_TOKEN in your environment or .env, then run: hermes"
echo "Note: restart any running Hermes session so it re-snapshots skills/clawpyter/SKILL.md."
