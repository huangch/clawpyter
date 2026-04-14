#!/usr/bin/env bash
set -euo pipefail

PLUGIN_SRC="$(cd "$(dirname "$0")/hermes-plugin" && pwd)"
PLUGIN_DEST="$HOME/.hermes/plugins/clawpyter"

echo "==> Installing Python dependencies (httpx, websockets)..."
pip install --quiet httpx websockets

echo "==> Copying plugin to $PLUGIN_DEST..."
rm -rf "$PLUGIN_DEST"
cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"

echo "==> Verifying plugin files..."
python3 -m py_compile "$PLUGIN_DEST/__init__.py"
python3 -m py_compile "$PLUGIN_DEST/schemas.py"
python3 -m py_compile "$PLUGIN_DEST/tools.py"

echo "==> Plugin installed. Reloading Hermes plugin registry..."
hermes plugins list 2>/dev/null | grep -q clawpyter \
  && echo "    clawpyter is registered." \
  || echo "    (Start hermes to pick up the plugin — it is discovered at startup.)"

echo ""
echo "Done. Set JUPYTER_URL and JUPYTER_TOKEN in your environment or .env, then run: hermes"
