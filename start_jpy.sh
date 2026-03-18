#!/bin/bash

# ---------------------------------------------------------------
# Argument handling using flags (compatible with conda environments)
#   -o <manifest_path>   Optional, defaults to $HOME/.openclaw/openclaw.json
#   -n <notebook_dir>    Required, directory where notebooks are stored
#   -t <jupyter_token>   Optional, defaults to a freshly generated UUID
# ---------------------------------------------------------------

DEFAULT_MANIFEST="$HOME/.openclaw/openclaw.json"
MANIFEST="$DEFAULT_MANIFEST"
NOTEBOOK_DIR=""
JUPYTER_TOKEN=""

while getopts ":ho:n:t:" opt; do
	case $opt in
		o) MANIFEST="$OPTARG" ;;
		n) NOTEBOOK_DIR="$OPTARG" ;;
		t) JUPYTER_TOKEN="$OPTARG" ;;
		h) echo "Usage: $0 -n <notebook_directory> [-o <manifest_path>] [-t <jupyter_token>]"
		   echo "";
		   echo "Examples:";
		   echo "  $0 -n ~/.openclaw/jupyter_home                # uses default manifest";
		   echo "  $0 -o ~/.openclaw/openclaw.json -n ~/.openclaw/jupyter_home";
		   echo "  $0 -o ~/.openclaw/openclaw.json -n ~/.openclaw/jupyter_home -t abcdef123456";
		   exit 0 ;;
		\?) echo "Invalid option: -$OPTARG" >&2; exit 1 ;;
		:) echo "Option -$OPTARG requires an argument." >&2; exit 1 ;;
	esac
done
shift $((OPTIND -1))

# Validate required notebook directory
if [ -z "$NOTEBOOK_DIR" ]; then
	echo "Error: notebook_directory is required. Use -n <path>."
	echo "Run $0 -h for usage." >&2
	exit 1
fi

# ---------------------------------------------------------------
# Ensure NOTEBOOK_DIR is an absolute path. Jupyter Lab requires an
# absolute directory, but the user may provide a relative one (e.g.
# "./my_notebooks"). If the path does not start with '/', we resolve it
# against the current working directory.
# ---------------------------------------------------------------
if [[ "$NOTEBOOK_DIR" != /* ]]; then
	# `cd` will fail if the directory does not exist; in that case we keep
	# the original value and let Jupyter report the error.
	if cd "$NOTEBOOK_DIR" 2>/dev/null; then
		NOTEBOOK_DIR="$(pwd)"
	else
		echo "Warning: provided notebook directory '$NOTEBOOK_DIR' does not exist; proceeding with original value."
	fi
fi

# If a previous instance of jupyter-mcp-serveris still running, terminate it.
# First verify that the PID file exists and that the PID inside corresponds to
# a running process. This avoids errors when the file is missing or stale.
if [ -f /tmp/jupytermcp.pid ]; then
	MCP_PID=$(cat /tmp/jupytermcp.pid)
	if kill -0 "$MCP_PID" 2>/dev/null; then
		echo "Stopping existing jupyter-mcp-server (PID $MCP_PID)"
		kill "$MCP_PID"
	else
		echo "Stale jupyter-mcp-server PID file found, but process $MCP_PID is not running."
	fi
	# Remove the PID file regardless of whether the process was running.
	rm -f /tmp/jupytermcp.pid
else
	echo "No existing jupyter-mcp-server PID file found; proceeding."
fi

# Likewise, stop any existing Jupyter Lab process.
if [ -f /tmp/jupyterlab.pid ]; then
	JLAB_PID=$(cat /tmp/jupyterlab.pid)
	if kill -0 "$JLAB_PID" 2>/dev/null; then
		echo "Stopping existing Jupyter Lab (PID $JLAB_PID)"
		kill "$JLAB_PID"
	else
		echo "Stale Jupyter Lab PID file found, but process $JLAB_PID is not running."
	fi
	# Remove the PID file regardless of whether the process was running.
	rm -f /tmp/jupyterlab.pid
else
	echo "No existing Jupyter Lab PID file found; proceeding."
fi

# ---------------------------------------------------------------------
# Generate a UUID/token – many Linux systems provide `uuid` or `uuidgen`.
# If neither is available we fall back to reading /proc/sys/kernel/random/uuid
# (present on most kernels) or finally using `openssl rand` to produce a
# 32‑character hexadecimal string.
# ---------------------------------------------------------------------
generate_uuid() {
	if command -v uuid >/dev/null 2>&1; then
		uuid
	elif command -v uuidgen >/dev/null 2>&1; then
		uuidgen
	elif [ -f /proc/sys/kernel/random/uuid ]; then
		cat /proc/sys/kernel/random/uuid
	else
		# openssl may not be installed, but it is a common fallback.
		openssl rand -hex 16
	fi
}

# If token not supplied, generate a UUID using the helper above
if [ -z "$JUPYTER_TOKEN" ]; then
	JUPYTER_TOKEN=$(generate_uuid)
fi
JUPYTER_IP=$(ip -4 route get 1.1.1.1 | grep -oP 'src \K\S+')

# export BROWSER=/usr/bin/microsoft-edge
# Remove any stale PID file before starting a new Jupyter Lab instance.
rm -f /tmp/jupyterlab.pid

# Start Jupyter Lab inside the conda environment in the background. The PID of
# the wrapper process returned by `conda run` is not the actual Jupyter server
# PID, so we later locate the real process with `pgrep`.
conda run -n openclaw-jpy jupyter lab \
	--no-browser \
	--notebook-dir "$NOTEBOOK_DIR" \
	--IdentityProvider.token=${JUPYTER_TOKEN} \
	--ip=0.0.0.0 \
	--port 8888 \
	> /tmp/jupyterlab.log 2>&1 &

# Give Jupyter a moment to start before searching for its PID.
sleep 2
# Find the PID of the Jupyter Lab process that matches the notebook directory.
JLAB_PID=$(pgrep -f "jupyter-lab.*--notebook-dir $NOTEBOOK_DIR")
echo "$JLAB_PID" > /tmp/jupyterlab.pid

# wait for Jupyter to come up
until curl -s http://127.0.0.1:8888 >/dev/null; do
	sleep 1
done

conda run -n openclaw-jpy uvx jupyter-mcp-server start \
	    --transport streamable-http \
	    --jupyter-url http://127.0.0.1:8888 \
	    --jupyter-token ${JUPYTER_TOKEN} \
		--port 4040 \
		> /tmp/jupytermcp.log 2>&1 &

echo $! > /tmp/jupytermcp.pid

echo
echo \# ---------------------------------------------------------------------------
echo \# The \`config\` object to be injected into the openclaw configuration
echo \# ---------------------------------------------------------------------------
echo "        \"config\": {"
echo "          \"jupyterUrl\": \"http://$JUPYTER_IP:8888\","
echo "          \"jupyterToken\": \"$JUPYTER_TOKEN\","
echo "          \"notebookDir\": \"$NOTEBOOK_DIR\""
echo "        }"   
echo
echo \# ---------------------------------------------------------------------------
echo \# URL to access Jupyter Lab \(with token for authentication\)
echo \# ---------------------------------------------------------------------------
echo http://$JUPYTER_IP:8888/?token=$JUPYTER_TOKEN
echo

# ---------------------------------------------------------------------------
# Automatically inject the generated configuration into the plugin manifest
# (the manifest path is supplied as the first argument). This updates the
# `plugins.entries.clawpyter.config` object with the current Jupyter URL,
# token, and notebook directory.
# ---------------------------------------------------------------------------

# Resolve manifest path to an absolute path if it is relative
if [[ "$MANIFEST" != /* ]]; then
	MANIFEST="$(cd "$(dirname "$0")" && pwd)/$MANIFEST"
fi

# Use jq to set the config object. If jq is not installed, fall back to a
# simple Python one‑liner. The temporary file approach ensures atomic update.
if command -v jq >/dev/null 2>&1; then
	jq ".plugins.entries.clawpyter.config = {\
		jupyterUrl: \"http://$JUPYTER_IP:8888\",\
		jupyterToken: \"$JUPYTER_TOKEN\",\
		notebookDir: \"$NOTEBOOK_DIR\"\
	}" "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
else
	python3 - <<PY
import json, pathlib, os
manifest_path = pathlib.Path(os.path.abspath("$MANIFEST"))
data = json.loads(manifest_path.read_text())
data.setdefault('plugins', {}).setdefault('entries', {}).setdefault('clawpyter', {})['config'] = {
	"jupyterUrl": f"http://{os.getenv('JUPYTER_IP')}:8888",
	"jupyterToken": os.getenv('JUPYTER_TOKEN'),
	"notebookDir": os.getenv('NOTEBOOK_DIR')
}
manifest_path.write_text(json.dumps(data, indent=2))
PY
fi