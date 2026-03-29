#!/bin/bash

# ---------------------------------------------------------------
# Argument handling using flags (compatible with conda environments)
#   -h                   Show usage and exit
#   -b                   Open browser when Jupyter server starts (default: no browser)
#   -n <notebook_dir>    Required, directory where notebooks are stored
#   -p <port>            Optional, desired port (default: 8888). If specified and
#                        occupied, the script will exit with an error instead of
#                        trying another port.
#   -t <jupyter_token>   Optional, defaults to a freshly generated UUID
# ---------------------------------------------------------------

NOTEBOOK_DIR=""
JUPYTER_TOKEN=""
DESIRED_PORT=""
OPEN_BROWSER=false

while getopts ":hbn:p:t:" opt; do
	case $opt in
		b) OPEN_BROWSER=true ;;
		n) NOTEBOOK_DIR="$OPTARG" ;;
		p) DESIRED_PORT="$OPTARG" ;;
		t) JUPYTER_TOKEN="$OPTARG" ;;
		h) echo "Usage: $0 -n <notebook_directory> [-b] [-p <port>] [-t <jupyter_token>]"
		   echo "";
		   echo "Options:";
		   echo "  -b          Open browser when Jupyter server starts";
		   echo "  -p <port>   Desired port (default: 8888). Fails if port is already in use.";
		   echo "";
		   echo "Examples:";
		   echo "  $0 -n ~/.openclaw/jupyter_home";
		   echo "  $0 -n ~/.openclaw/jupyter_home -p 8889";
		   echo "  $0 -n ~/.openclaw/jupyter_home -b -p 9000 -t abcdef123456";
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

# ---------------------------------------------------------------------
# Port resolution:
#   -p given  → check availability; fail immediately if occupied.
#   -p absent → let Jupyter auto-find a free port starting from 8888.
# ---------------------------------------------------------------------
is_port_in_use() {
	local port=$1
	if command -v ss >/dev/null 2>&1; then
		ss -tln 2>/dev/null | grep -q ":${port} "
	elif command -v netstat >/dev/null 2>&1; then
		netstat -tln 2>/dev/null | grep -q ":${port} "
	else
		# Fallback: try opening a TCP connection
		(echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null
	fi
}

if [ -n "$DESIRED_PORT" ]; then
	if is_port_in_use "$DESIRED_PORT"; then
		echo "Error: port $DESIRED_PORT is already in use. Free the port or omit -p to auto-select." >&2
		exit 1
	fi
	JUPYTER_PORT="$DESIRED_PORT"
	PORT_RETRIES=0   # hard-require the specified port; fail if Jupyter can't bind it
else
	JUPYTER_PORT=8888
	PORT_RETRIES=50  # Jupyter default: auto-find next free port
fi

# PID and log files are keyed on port to support multiple simultaneous instances.
PID_FILE="/tmp/jupyterlab-${JUPYTER_PORT}.pid"
LOG_FILE="/tmp/jupyterlab-${JUPYTER_PORT}.log"

# Stop any existing Jupyter Lab process on this port.
if [ -f "$PID_FILE" ]; then
	JLAB_PID=$(cat "$PID_FILE")
	if kill -0 "$JLAB_PID" 2>/dev/null; then
		echo "Stopping existing Jupyter Lab on port $JUPYTER_PORT (PID $JLAB_PID)"
		kill "$JLAB_PID"
	else
		echo "Stale PID file found for port $JUPYTER_PORT, but process $JLAB_PID is not running."
	fi
	rm -f "$PID_FILE"
else
	echo "No existing Jupyter Lab process found for port $JUPYTER_PORT; proceeding."
fi

# Remove any stale PID/log files before starting a new instance.
rm -f "$PID_FILE" "$LOG_FILE"

# Start Jupyter Lab inside the conda environment in the background. The PID of
# the wrapper process returned by `conda run` is not the actual Jupyter server
# PID, so we later locate the real process with `pgrep`.

NO_BROWSER_FLAG=""
if [ "$OPEN_BROWSER" = false ]; then
	NO_BROWSER_FLAG="--no-browser"
fi

echo jupyter lab \
	${NO_BROWSER_FLAG:+"$NO_BROWSER_FLAG"} \
	--ServerApp.root_dir="$NOTEBOOK_DIR" \
	--IdentityProvider.token=${JUPYTER_TOKEN} \
	--ip=0.0.0.0 \
	--port $JUPYTER_PORT \
	--ServerApp.port_retries=$PORT_RETRIES
	
# shellcheck disable=SC2086
jupyter lab \
	$NO_BROWSER_FLAG \
	--ServerApp.root_dir="$NOTEBOOK_DIR" \
	--IdentityProvider.token=${JUPYTER_TOKEN} \
	--ip=0.0.0.0 \
	--port $JUPYTER_PORT \
	--ServerApp.port_retries=$PORT_RETRIES \
	> "$LOG_FILE" 2>&1 &

# Give Jupyter a moment to start before searching for its PID.
sleep 2
# Use the PID of the background process we just started
JLAB_PID=$!
# Verify the process is actually running
if ! kill -0 "$JLAB_PID" 2>/dev/null; then
	echo "Error: Failed to start Jupyter Lab (PID $JLAB_PID not running)"
	cat "$LOG_FILE"
	exit 1
fi
echo "$JLAB_PID" > "$PID_FILE"

# Parse the actual port Jupyter bound to (may differ from JUPYTER_PORT if a
# retry happened in the no-p case). Poll the log for up to 30 s.
ACTUAL_PORT=""
for i in $(seq 1 30); do
	ACTUAL_PORT=$(grep -oP 'http://[^:]+:\K[0-9]+' "$LOG_FILE" 2>/dev/null | head -1)
	if [ -n "$ACTUAL_PORT" ]; then
		break
	fi
	sleep 1
done
if [ -z "$ACTUAL_PORT" ]; then
	ACTUAL_PORT="$JUPYTER_PORT"
	echo "Warning: could not detect actual port from log; assuming $JUPYTER_PORT"
fi

# If Jupyter bound to a different port (auto-find case), rename the PID file
# so that stop-jpy.sh -p <actual_port> can find it.
if [ "$ACTUAL_PORT" != "$JUPYTER_PORT" ]; then
	ACTUAL_PID_FILE="/tmp/jupyterlab-${ACTUAL_PORT}.pid"
	mv "$PID_FILE" "$ACTUAL_PID_FILE"
	PID_FILE="$ACTUAL_PID_FILE"
	echo "Note: Jupyter bound to port $ACTUAL_PORT (requested $JUPYTER_PORT)"
fi

# Wait for Jupyter to respond on the actual port.
until curl -s http://127.0.0.1:$ACTUAL_PORT >/dev/null; do
	sleep 1
done



echo
echo \# ---------------------------------------------------------------------------
echo \# URL to access Jupyter Lab \(with token for authentication\)
echo \# ---------------------------------------------------------------------------
echo http://$JUPYTER_IP:$ACTUAL_PORT/?token=$JUPYTER_TOKEN
echo
echo \# ---------------------------------------------------------------------------
echo \# Tell the AI to connect with:
echo \# ---------------------------------------------------------------------------
echo "Connect to Jupyter at http://$JUPYTER_IP:$ACTUAL_PORT with token $JUPYTER_TOKEN"
echo
