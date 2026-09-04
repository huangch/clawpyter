#!/bin/sh
# Host-side wrapper: start the ClawPyter JupyterLab container.
#
# (The in-container counterpart is docker-jupyter-start.sh, which is baked into
# the image and runs as its CMD — same naming rule as docker-entrypoint.sh.)

IMAGE_ID=clawpyter:latest

# The container's uid/gid is set at run time by the image entrypoint: by default
# it becomes the owner of the mounted /workspace (so notebooks you create are
# yours, not root's). Export HOST_UID / HOST_GID before running to force a
# specific id; the ``-e HOST_UID -e HOST_GID`` below forward them only when set.
#
# Unlike the pipeline images this one is a long-running SERVER: it publishes a
# port and stays in the foreground until Ctrl-C.

DATA_DIR=""
PORT=8888
TOKEN=""
PULL=1

while [ $# -gt 0 ]; do
    case "$1" in
        -p|--port)   PORT="$2";  shift 2 ;;
        --port=*)    PORT="${1#--port=}";  shift ;;
        -t|--token)  TOKEN="$2"; shift 2 ;;
        --token=*)   TOKEN="${1#--token=}"; shift ;;
        --no-pull)   PULL=0; shift ;;
        -h|--help)   DATA_DIR=""; break ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            if [ -z "${DATA_DIR}" ]; then
                DATA_DIR="$1"
                shift
            else
                break
            fi
            ;;
    esac
done

if [ -z "${DATA_DIR}" ]; then
    echo "Usage: clawpyter-docker-run.sh [-p <port>] [-t <token>] [--no-pull] /path/to/notebooks [COMMAND ...]"
    echo ""
    echo "Options:"
    echo "  -p, --port <port>   Host and container port (default: 8888)"
    echo "  -t, --token <tok>   Jupyter token. Omit to have one generated and printed;"
    echo "                      use 'none' to disable authentication entirely."
    echo "      --no-pull       Skip 'docker pull' (use the local image as-is)"
    echo ""
    echo "Examples:"
    echo "  clawpyter-docker-run.sh ~/notebooks                    # generated token"
    echo "  clawpyter-docker-run.sh -t secret ~/notebooks          # fixed token"
    echo "  clawpyter-docker-run.sh -p 8899 -t none ~/notebooks    # no auth, other port"
    echo "  clawpyter-docker-run.sh ~/notebooks bash               # shell instead of the server"
    exit 1
fi

if [ ! -d "${DATA_DIR}" ]; then
    echo "Error: notebook directory does not exist: ${DATA_DIR}" >&2
    exit 1
fi

if [ "${PULL}" -eq 1 ]; then
    docker pull ${IMAGE_ID} || echo "(pull failed; using local image)"
fi

# -e JUPYTER_TOKEN is forwarded only when set, so an unset token still means
# "generate one" inside the container rather than "disable authentication".
if [ -n "${TOKEN}" ]; then
    TOKEN_ENV="-e JUPYTER_TOKEN=${TOKEN}"
else
    TOKEN_ENV=""
fi

if [ $# -gt 0 ]; then
    # Direct command mode: run the provided command instead of the server.
    set -- bash -lc "$*"
else
    set --
fi

# shellcheck disable=SC2086
echo docker run --rm -it --init \
    -e HOST_UID -e HOST_GID ${TOKEN_ENV} -e JUPYTER_PORT="${PORT}" \
    -p "${PORT}":"${PORT}" \
    -v "${DATA_DIR}":/workspace \
    ${IMAGE_ID} "$@"

# shellcheck disable=SC2086
exec docker run --rm -it --init \
    -e HOST_UID -e HOST_GID ${TOKEN_ENV} -e JUPYTER_PORT="${PORT}" \
    -p "${PORT}":"${PORT}" \
    -v "${DATA_DIR}":/workspace \
    ${IMAGE_ID} "$@"
