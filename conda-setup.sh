#!/usr/bin/env bash
# conda-setup.sh — create and populate a conda environment for ClawPyter.
#
# <<<USAGE_START>>>
# Usage:  sh ./conda-setup.sh ENV_NAME [-r|--reset] [-d|--dev] [-h|--help]
#
#   ENV_NAME                (positional, REQUIRED) Conda environment to use/create.
#                           There is NO fallback to the currently-activated conda
#                           env: the name is mandatory so `-r` can never
#                           accidentally destroy a different active environment.
#   -r | --reset            Deactivate, remove, recreate, and activate ENV_NAME.
#                           Without this flag the script skips env creation and
#                           only (re-)installs packages into the existing env.
#   -d | --dev              Also install dev tooling (pytest, pytest-cov, ruff,
#                           pre_commit).
#   -h | --help             Print this help message and exit.
# <<<USAGE_END>>>
#
# ClawPyter is an agent PLUGIN, not an installable package — there is no
# pyproject.toml. This script installs the plugin's runtime dependencies plus
# the JupyterLab server it drives; `./build4hermes.sh` copies the plugin into
# ~/.hermes/plugins/.
#
# Everything below is MANDATORY — there are no opt-out flags. Live co-editing
# needs all of it, and a partial install produces an environment that looks
# fine but silently degrades to REST (last-writer-wins, no shared editing):
#
#   client half (agent side)  : httpx, websockets, jupyter_nbmodel_client, pycrdt
#   server half (JupyterLab)  : jupyterlab, jupyter-collaboration
#
# Run the JupyterLab server elsewhere (Docker, another host) if you prefer —
# but this env still gets the server packages so `./start-jpy.sh` works and the
# smoke test can prove the collaboration extension actually loads.

set -e   # abort on first error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Argument parsing ─────────────────────────────────────────────────────────
DO_RESET=0
DO_DEV=0

print_usage() {
    awk '
        /<<<USAGE_START>>>/ {capture=1; next}
        /<<<USAGE_END>>>/   {capture=0}
        capture            {sub(/^# ?/, ""); print}
    ' "$0"
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)  print_usage; exit 0 ;;
        -r|--reset) DO_RESET=1; shift ;;
        -d|--dev)   DO_DEV=1;   shift ;;
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

echo "Target conda environment: ${ENV_NAME}  (reset=${DO_RESET}, dev=${DO_DEV})"

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
    # --override-channels keeps pkgs/main and pkgs/r (and their Terms-of-Service
    # prompts) out of the solve. Pure-Python stack — no CUDA/GPU packages.
    conda create -y --override-channels -n "${ENV_NAME}" -c conda-forge python=3.11
fi

conda activate "${ENV_NAME}"
pip install --upgrade pip

# Redirect pip's wheel cache to /tmp to bypass NAS inode quotas. Exported before
# any purge: `pip cache purge` obeys this variable.
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-/tmp/pip-cache-clawpyter}"

# ── Plugin runtime + co-editing client ───────────────────────────────────────
# Mirrors build4hermes.sh; keep the two in sync.
echo "---- installing plugin runtime + co-editing client ----"
pip install httpx websockets jupyter_nbmodel_client pycrdt

# ── JupyterLab server + collaboration ────────────────────────────────────────
# jupyter-collaboration is the SERVER half: without it
# /api/collaboration/session/... 404s and ClawPyter degrades to REST.
echo "---- installing JupyterLab server + collaboration ----"
pip install "jupyterlab>=4.0" "jupyter-collaboration>=4.0"

if [ "${DO_DEV}" -eq 1 ]; then
    echo "---- installing dev tooling ----"
    pip install pytest pytest-cov ruff pre_commit
fi

# ── Smoke test ───────────────────────────────────────────────────────────────
# Hard checks are fatal: a half-installed env must not look like a success.
# Every check below is mandatory — co-editing needs all of them.
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

python -c 'import importlib.metadata as m; print("  httpx", m.version("httpx"), "| websockets", m.version("websockets"), "| pycrdt", m.version("pycrdt"))' || true

smoke "import httpx"                  python -c 'import httpx'
smoke "import websockets"             python -c 'import websockets'
smoke "import jupyter_nbmodel_client" python -c 'import jupyter_nbmodel_client'
smoke "import pycrdt"                 python -c 'import pycrdt'

smoke "plugin modules compile"  python -m py_compile \
        "${SCRIPT_DIR}/hermes-plugin/__init__.py" \
        "${SCRIPT_DIR}/hermes-plugin/schemas.py" \
        "${SCRIPT_DIR}/hermes-plugin/tools.py" \
        "${SCRIPT_DIR}/hermes-plugin/collab_client.py"

# HAS_COLLAB is what tools.py branches on; assert the client half is really live
# rather than trusting that the imports merely resolved.
smoke "collab client enabled"   python -c "
import importlib.util, sys, types
here = '${SCRIPT_DIR}/hermes-plugin'
pkg = types.ModuleType('_cp'); pkg.__path__ = [here]; sys.modules['_cp'] = pkg
spec = importlib.util.spec_from_file_location('_cp.collab_client', here + '/collab_client.py')
m = importlib.util.module_from_spec(spec); sys.modules['_cp.collab_client'] = m
spec.loader.exec_module(m)
sys.exit(0 if getattr(m, 'HAS_COLLAB', False) else 1)
"

smoke "jupyter on PATH"         command -v jupyter
smoke "jupyter lab --version"   jupyter lab --version
# Without the SERVER extension /api/collaboration 404s and co-editing is off.
smoke "jupyter-collaboration enabled" \
        bash -c "jupyter server extension list 2>&1 | grep -qi jupyter_collaboration"

if [ "${DO_DEV}" -eq 1 ]; then
    smoke "pytest importable (dev)" python -c 'import pytest'
fi

if [ "${SMOKE_FAIL}" -ne 0 ]; then
    echo "smoke test: ${SMOKE_FAIL} check(s) FAILED" >&2
    exit 1
fi
echo "smoke test: all checks passed"

echo
echo "Next:"
echo "  ./build4hermes.sh                 # install the plugin into ~/.hermes/plugins/"
echo "  ./start-jpy.sh -n <notebook_dir>  # start JupyterLab in this env"
echo "  # or run the server in Docker:"
echo "  #   docker run --rm -p 8888:8888 -v \"\$PWD\":/workspace clawpyter:latest"
