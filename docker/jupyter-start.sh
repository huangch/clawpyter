#!/usr/bin/env bash
# Runs INSIDE the container as its CMD — this does not start a container.
# To start one from the host, use ./clawpyter-docker-run.sh.
#
# (Naming rule, same as docker-entrypoint.sh: a `docker-` prefix marks scripts
# baked into the image; host-side wrappers are named <package>-docker-run.sh.)
#
# Token semantics mirror start-jpy.sh so the container and the host script
# behave identically:
#   JUPYTER_TOKEN unset   -> generate a UUID and print it
#   JUPYTER_TOKEN=none    -> authentication disabled (trusted networks only)
#   JUPYTER_TOKEN=<value> -> use it verbatim
set -euo pipefail

PORT="${JUPYTER_PORT:-8888}"
TOKEN="${JUPYTER_TOKEN:-}"

if [ "$TOKEN" = "none" ]; then
    TOKEN=""
    echo "# jupyter token: DISABLED (JUPYTER_TOKEN=none)"
elif [ -z "$TOKEN" ]; then
    # Generated rather than left open, so an unset variable is never insecure.
    TOKEN="$(python -c 'import uuid; print(uuid.uuid4())')"
    echo "# jupyter token: ${TOKEN}"
else
    echo "# jupyter token: (from JUPYTER_TOKEN)"
fi

echo "# connect to: http://127.0.0.1:${PORT}"
echo "# root_dir  : /workspace"

exec jupyter lab \
    --ip=0.0.0.0 \
    --port="${PORT}" \
    --no-browser \
    --ServerApp.root_dir=/workspace \
    --IdentityProvider.token="${TOKEN}"
