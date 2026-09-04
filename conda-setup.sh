#!/usr/bin/env bash
# conda-setup.sh — create and populate a conda environment for ClawPyter.
#
# <<<USAGE_START>>>
# Usage:  sh ./conda-setup.sh ENV_NAME [-r|--reset] [-j|--jupyter] [-d|--dev]
#                                      [--no-collab] [-h|--help]
#
#   ENV_NAME                (positional, REQUIRED) Conda environment to use/create.
#                           There is NO fallback to the currently-activated conda
#                           env: the name is mandatory so `-r` can never
#                           accidentally destroy a different active environment.
#   -r | --reset            Deactivate, remove, recreate, and activate ENV_NAME.
#                           Without this flag the script skips env creation and
#                           only (re-)installs packages into the existing env.
#   -j | --jupyter          Also install the JupyterLab SERVER side (jupyterlab
#                           + jupyter-collaboration) so `./start-jpy.sh` can run
#                           in this env. Skip it when Jupyter runs elsewhere —
#                           in Docker, on another host, or in its own env.
#   -d | --dev              Also install dev tooling (pytest, ruff, pre_commit).
#   --no-collab             Skip the co-editing CLIENT libraries
#                           (jupyter_nbmodel_client, pycrdt). ClawPyter then
#                           runs in REST-only mode: no live co-editing.
#   -h | --help             Print this help message and exit.
# <<<USAGE_END>>>
#
# ClawPyter is an agent PLUGIN, not an installable package — there is no
# pyproject.toml. This script therefore installs the plugin's runtime
# dependencies rather than the plugin itself; `./build4hermes.sh` copies the
# plugin into ~/.hermes/plugins/.
#
# Co-editing needs BOTH halves, in possibly different environments:
#   * client (here, with the agent) : jupyter_nbmodel_client + pycrdt
#   * server (with JupyterLab)      : jupyter-collaboration      [-j]
# Missing either one is not fatal — ClawPyter falls back to REST.

set -e   # abort on first error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Argument parsing ─────────────────────────────────────────────────────────
DO_RESET=0
DO_JUPYTER=0
DO_DEV=0
DO_COLLAB=1

print_usage() {
    awk '
        /<<<USAGE_START>>>/ {capture=1; next}
        /<<<USAGE_END>>>/   {capture=0}
        capture            {sub(/^# ?/, ""); print}
    ' "$0"
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)     print_usage; exit 0 ;;
        -r|--reset)    DO_RESET=1;   shift ;;
        -j|--jupyter)  DO_JUPYTER=1; shift ;;
        -d|--dev)      DO_DEV=1;     shift ;;
        --no-collab)   DO_COLLAB=0;  shift ;;
        -*)
            echo "Unknown option: $1" >&2
            echo "Run '${0##*/} --help' for usage." >&2
            exit 1
            ;;
        *)
            if [ -n "${ENV_NAME:-}" ]; then
                echo "Error: only one positional argument (ENV_NAME) is accepted; got '$ENV_NAME' and '$1'." >&2
                echo "Run '${0##*/} --help' for usage." >&2
                exit 1
            fi
            ENV_NAME="$1"
            shift
            ;;
    esac
done

if [ -z "${ENV_NAME:-}" ]; then
    echo "Error: ENV_NAME is required." >&2
    echo "       Run '${0##*/} --help' for usage." >&2
    exit 1
fi

echo "Target conda environment: ${ENV_NAME}  (reset=${DO_RESET}, jupyter=${DO_JUPYTER}, dev=${DO_DEV}, collab=${DO_COLLAB})"

# ── (Re-)create environment ──────────────────────────────────────────────────
CONDA_BASE="$(conda info --base 2>/dev/null || true)"
if [ -z "${CONDA_BASE}" ]; then
    for _base in /opt/conda /opt/anaconda3; do
        if [ -f "${_base}/etc/profile.d/conda.sh" ]; then
            CONDA_BASE="${_base}"
            break
        fi
    done
fi
if [ -z "${CONDA_BASE}" ] || [ ! -f "${CONDA_BASE}/etc/profile.d/conda.sh" ]; then
    echo "Error: cannot locate conda.sh. Activate conda first or set CONDA_BASE." >&2
    exit 1
fi
. "${CONDA_BASE}/etc/profile.d/conda.sh"

if [ "$DO_RESET" -eq 1 ]; then
    conda deactivate
    conda env remove -n "${ENV_NAME}" -y 2>/dev/null || true
    # Pure-Python client stack — no CUDA/GPU packages.
    conda create -n "${ENV_NAME}" python=3.11 -c conda-forge -y
fi

conda activate "${ENV_NAME}"
pip install --upgrade pip

# Redirect pip's wheel cache to /tmp to bypass NAS inode quotas. Exported before
# any purge: `pip cache purge` obeys this variable.
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-/tmp/pip-cache-clawpyter}"

# ── Required plugin dependencies ─────────────────────────────────────────────
# Mirrors build4hermes.sh; keep the two in sync.
echo "---- installing required dependencies ----"
pip install httpx websockets

# ── Optional: co-editing client (Y.js CRDT) ──────────────────────────────────
if [ "${DO_COLLAB}" -eq 1 ]; then
    echo "---- installing co-editing client (jupyter_nbmodel_client, pycrdt) ----"
    pip install jupyter_nbmodel_client pycrdt
fi

# ── Optional: JupyterLab server side ─────────────────────────────────────────
if [ "${DO_JUPYTER}" -eq 1 ]; then
    echo "---- installing JupyterLab server + collaboration ----"
    pip install "jupyterlab>=4.0" "jupyter-collaboration>=4.0"
fi

# ── Optional: dev tooling ────────────────────────────────────────────────────
if [ "${DO_DEV}" -eq 1 ]; then
    echo "---- installing dev tooling ----"
    pip install pytest pytest-cov ruff pre_commit
fi

# ── Smoke test ───────────────────────────────────────────────────────────────
# Hard checks are fatal: a half-installed env must not look like a success.
echo "---- smoke test ----"
SMOKE_FAIL=0
smoke() {                       # smoke <label> <command...>
    label="$1"; shift
    if "$@" >/dev/null 2>&1; then
        printf '  PASS  %s\n' "$label"
    else
        printf '  FAIL  %s\n' "$label"
        SMOKE_FAIL=$((SMOKE_FAIL + 1))
    fi
}

python -c 'import importlib.metadata as m; print("  httpx", m.version("httpx"), "| websockets", m.version("websockets"))' || true

smoke "import httpx"            python -c 'import httpx'
smoke "import websockets"       python -c 'import websockets'

# The plugin must import with only its runtime deps present. It is a plain
# directory (no package metadata), so load it under a synthetic package name.
smoke "plugin modules compile"  python -m py_compile \
        "${SCRIPT_DIR}/hermes-plugin/__init__.py" \
        "${SCRIPT_DIR}/hermes-plugin/schemas.py" \
        "${SCRIPT_DIR}/hermes-plugin/tools.py" \
        "${SCRIPT_DIR}/hermes-plugin/collab_client.py"

if [ "${DO_COLLAB}" -eq 1 ]; then
    smoke "import jupyter_nbmodel_client" python -c 'import jupyter_nbmodel_client'
    smoke "import pycrdt"                 python -c 'import pycrdt'
    # HAS_COLLAB is what tools.py branches on; assert the client half is live.
    smoke "collab client enabled"         python -c "
import importlib.util, sys, types
here = '${SCRIPT_DIR}/hermes-plugin'
pkg = types.ModuleType('_cp'); pkg.__path__ = [here]; sys.modules['_cp'] = pkg
spec = importlib.util.spec_from_file_location('_cp.collab_client', here + '/collab_client.py')
m = importlib.util.module_from_spec(spec); sys.modules['_cp.collab_client'] = m
spec.loader.exec_module(m)
sys.exit(0 if getattr(m, 'HAS_COLLAB', False) else 1)
"
else
    echo "  SKIP  co-editing client (--no-collab); ClawPyter will run REST-only"
fi

if [ "${DO_JUPYTER}" -eq 1 ]; then
    smoke "jupyter on PATH"     command -v jupyter
    smoke "jupyter lab --version" jupyter lab --version
    # Without the SERVER extension /api/collaboration 404s and co-editing is off.
    smoke "jupyter-collaboration enabled" \
        bash -c "jupyter server extension list 2>&1 | grep -qi jupyter_collaboration"
else
    echo "  SKIP  JupyterLab server (rerun with -j/--jupyter, or run it in Docker)"
fi

if [ "${SMOKE_FAIL}" -ne 0 ]; then
    echo "smoke test: ${SMOKE_FAIL} check(s) FAILED" >&2
    exit 1
fi
echo "smoke test: all checks passed"

echo
echo "Next:"
echo "  ./build4hermes.sh                 # install the plugin into ~/.hermes/plugins/"
if [ "${DO_JUPYTER}" -eq 1 ]; then
    echo "  ./start-jpy.sh -n <notebook_dir>  # start JupyterLab in this env"
else
    echo "  docker run --rm -p 8888:8888 -v \"\$PWD\":/workspace clawpyter:latest"
fi
