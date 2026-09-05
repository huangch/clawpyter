#!/usr/bin/env bash
set -euo pipefail

PLUGIN_SRC="$(cd "$(dirname "$0")/hermes-plugin" && pwd)"
PLUGIN_DEST="$HOME/.hermes/plugins/clawpyter"
SKILL_DEST="$HOME/.hermes/skills/clawpyter"

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

echo "==> Installing Python dependencies (httpx, websockets)..."
"$PY" -m pip install --quiet httpx websockets

echo "==> Installing optional jupyter-collaboration dependencies..."
echo "    (skip on failure — ClawPyter falls back to REST mode if missing)"
"$PY" -m pip install --quiet jupyter_nbmodel_client pycrdt || \
  echo "    WARNING: collaboration deps not installed; ClawPyter will run in REST mode only."

echo "==> Copying plugin to $PLUGIN_DEST..."
mkdir -p "$(dirname "$PLUGIN_DEST")"
rm -rf "$PLUGIN_DEST"
cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"

echo "==> Installing skill file to $SKILL_DEST..."
# Install the skill directly so it exists *before* Hermes ever starts — Hermes
# snapshots skills at session start, so a lazy copy from _install_skill() at
# plugin load time can be missed on the first launch after install.
mkdir -p "$SKILL_DEST"
cp -f "$PLUGIN_SRC/SKILL.md" "$SKILL_DEST/SKILL.md"

echo "==> Verifying plugin files..."
# Compile every .py under the plugin so an import-time error in collab_client.py
# or schemas.py also fails the install (the old script only checked 3 files).
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
[[ -f "$SKILL_DEST/SKILL.md" ]]       || { echo "Missing $SKILL_DEST/SKILL.md"   >&2; exit 1; }

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
