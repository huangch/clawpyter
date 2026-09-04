#!/bin/bash

# ---------------------------------------------------------------
# Argument handling using flags (compatible with conda environments)
#   -h                   Show usage and exit
#   -b                   Open browser when Jupyter server starts (default: no browser)
#   -n <notebook_dir>    Required, directory where notebooks are stored
#   -p <port>            Optional, desired port (default: 8888). If specified and
#                        occupied, the script will exit with an error instead of
#                        trying another port.
#   -t <jupyter_token>   Optional, defaults to a freshly generated UUID.
#                        Pass -t none (or -t "") to disable token
#                        authentication entirely.
# ---------------------------------------------------------------

NOTEBOOK_DIR=""
JUPYTER_TOKEN=""
TOKEN_PROVIDED=false
DESIRED_PORT=""
OPEN_BROWSER=false

while getopts ":hbn:p:t:" opt; do
	case $opt in
		b) OPEN_BROWSER=true ;;
		n) NOTEBOOK_DIR="$OPTARG" ;;
		p) DESIRED_PORT="$OPTARG" ;;
		t) if [[ "$OPTARG" == -* ]]; then
				# getopts would otherwise swallow the next flag (e.g. -p) as
				# the token value.
				echo "Error: -t looks like it was given another flag ('$OPTARG') as its token." >&2
				echo "Use -t none for no token, or -t <token> for an explicit token." >&2
				exit 1
			fi
		   JUPYTER_TOKEN="$OPTARG"
		   TOKEN_PROVIDED=true ;;
		h) echo "Usage: $0 -n <notebook_directory> [-b] [-p <port>] [-t <jupyter_token>]"
		   echo "";
		   echo "Options:";
		   echo "  -b          Open browser when Jupyter server starts";
		   echo "  -p <port>   Desired port (default: 8888). Fails if port is already in use.";
		   echo "  -t <token>  Jupyter token (default: freshly generated UUID).";
		   echo "              Special values that disable token authentication:";
		   echo "                -t none    (recommended)";
		   echo "                -t \"\"     (empty string also works)";
		   echo "              When authentication is disabled, anyone who can";
		   echo "              reach the server URL can use Jupyter — only do";
		   echo "              this on trusted networks.";
		   echo "";
		   echo "Examples:";
		   echo "  $0 -n ~/.openclaw/jupyter_home";
		   echo "  $0 -n ~/.openclaw/jupyter_home -p 8889";
		   echo "  $0 -n ~/.openclaw/jupyter_home -b -p 9000 -t abcdef123456";
		   echo "  $0 -n ~/.openclaw/jupyter_home -t none    # no token / no authentication";
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

# Special token values: "none" (or an empty string) means no authentication.
if [ "$JUPYTER_TOKEN" = "none" ]; then
	JUPYTER_TOKEN=""
fi
# If -t was not supplied at all, generate a UUID using the helper above.
if [ "$TOKEN_PROVIDED" = false ] && [ -z "$JUPYTER_TOKEN" ]; then
	JUPYTER_TOKEN=$(generate_uuid)
fi
# Best-effort: detect the IP other machines would use to reach this host.
# Falls back to localhost when the machine has no default route (containers,
# some VPN setups) — `ip` would otherwise leave the variable empty.
JUPYTER_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+')
JUPYTER_IP="${JUPYTER_IP:-127.0.0.1}"

# export BROWSER=/usr/bin/microsoft-edge

# ---------------------------------------------------------------------
# Port resolution:
#   -p given  → check availability; fail immediately if occupied.
#   -p absent → let Jupyter auto-find a free port starting from 8888.
# ---------------------------------------------------------------------
is_port_in_use() {
	local port=$1
	if command -v ss >/dev/null 2>&1; then
		# Match the port at the end of the local-address field (column 4).
		# A naive `grep ":$port "` misses because ss output has no trailing
		# space after the port. `-v p=...` passes the port into awk.
		ss -tln 2>/dev/null | awk -v p="$port" '{n=split($4, a, ":"); if (a[n] == p) found=1} END {exit !found}'
	elif command -v netstat >/dev/null 2>&1; then
		netstat -tln 2>/dev/null | awk -v p="$port" '{n=split($4, a, ":"); if (a[n] == p) found=1} END {exit !found}'
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

# ---------------------------------------------------------------
# Preflight. Both checks are fatal: a server that starts without
# jupyter-collaboration silently degrades every notebook to REST
# (last-writer-wins), which is exactly the failure ClawPyter must not have.
# ---------------------------------------------------------------
if ! command -v jupyter >/dev/null 2>&1; then
        echo "Error: 'jupyter' is not on PATH." >&2
        echo "       Activate the ClawPyter environment first:  conda activate <env>" >&2
        echo "       Create one with:                          ./conda-setup.sh <env>" >&2
        exit 1
fi

if ! jupyter server extension list 2>&1 | grep -qi 'jupyter_collaboration'; then
        echo "Error: jupyter-collaboration is not installed in this environment." >&2
        echo "       Live human + agent co-editing requires it; without it every" >&2
        echo "       notebook falls back to whole-file PUTs (last writer wins)." >&2
        echo "       Install it with:  pip install 'jupyter-collaboration>=4.0'" >&2
        echo "       or re-run:        ./conda-setup.sh <env>" >&2
        exit 1
fi

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

# Start Jupyter Lab in the background, using whichever `jupyter` is on PATH —
# i.e. the currently activated conda environment. $! is therefore the real
# server PID (no `conda run` wrapper sits in between).

NO_BROWSER_FLAG=""
if [ "$OPEN_BROWSER" = false ]; then
	NO_BROWSER_FLAG="--no-browser"
fi

# An empty token (i.e. -t "") disables token authentication in Jupyter.
TOKEN_FLAG="--IdentityProvider.token=${JUPYTER_TOKEN}"

echo jupyter lab \
	${NO_BROWSER_FLAG:+"$NO_BROWSER_FLAG"} \
	--ServerApp.root_dir="$NOTEBOOK_DIR" \
	"$TOKEN_FLAG" \
	--ip=0.0.0.0 \
	--port $JUPYTER_PORT \
	--ServerApp.port_retries=$PORT_RETRIES
	
# shellcheck disable=SC2086
jupyter lab \
	$NO_BROWSER_FLAG \
	--ServerApp.root_dir="$NOTEBOOK_DIR" \
	"$TOKEN_FLAG" \
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

# Wait for Jupyter to respond on the actual port (bounded — fail with log
# contents if the process dies or never comes up within 60 s).
READY=false
for i in $(seq 1 60); do
	if curl -s http://127.0.0.1:$ACTUAL_PORT >/dev/null 2>&1; then
		READY=true
		break
	fi
	if ! kill -0 "$JLAB_PID" 2>/dev/null; then
		echo "Error: Jupyter Lab process (PID $JLAB_PID) exited during startup." >&2
		cat "$LOG_FILE" >&2
		exit 1
	fi
	sleep 1
done
if [ "$READY" = false ]; then
	echo "Error: Jupyter Lab did not respond on port $ACTUAL_PORT within 60 s." >&2
	cat "$LOG_FILE" >&2
	exit 1
fi

# ---------------------------------------------------------------------
# Detect whether jupyter-collaboration (Y.js RTC) is enabled. ClawPyter's
# Hermes plugin auto-detects this at runtime, but printing it here lets the
# user know up-front whether human + agent co-editing will work.
# ---------------------------------------------------------------------
COLLAB_PROBE_URL="http://127.0.0.1:$ACTUAL_PORT/api/collaboration/session/Untitled.ipynb"
COLLAB_AUTH=()
if [ -n "$JUPYTER_TOKEN" ]; then
	COLLAB_AUTH=(-H "Authorization: token $JUPYTER_TOKEN")
fi
COLLAB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
	"${COLLAB_AUTH[@]}" \
	-H "Content-Type: application/json" \
	-d '{"format":"json","type":"notebook"}' \
	"$COLLAB_PROBE_URL" 2>/dev/null || echo "000")
if [ "$COLLAB_STATUS" = "200" ] || [ "$COLLAB_STATUS" = "201" ]; then
	COLLAB_MODE="ENABLED (live human + agent co-editing supported)"
else
	# The extension was present at preflight, so a failure here means the API
	# itself is not answering — a broken server, not a missing package.
	COLLAB_MODE="ERROR — extension is installed but /api/collaboration returned HTTP $COLLAB_STATUS"
fi


echo
if [ -n "$JUPYTER_TOKEN" ]; then
	echo \# ---------------------------------------------------------------------------
	echo \# URL to access Jupyter Lab \(with token for authentication\)
	echo \# ---------------------------------------------------------------------------
	echo http://$JUPYTER_IP:$ACTUAL_PORT/?token=$JUPYTER_TOKEN
	echo
	echo \# ---------------------------------------------------------------------------
	echo \# Tell the AI to connect with:
	echo \# ---------------------------------------------------------------------------
	echo "Connect to Jupyter at http://$JUPYTER_IP:$ACTUAL_PORT with token $JUPYTER_TOKEN"
else
	echo \# ---------------------------------------------------------------------------
	echo \# URL to access Jupyter Lab \(no token required\)
	echo \# ---------------------------------------------------------------------------
	echo http://$JUPYTER_IP:$ACTUAL_PORT/
	echo
	echo \# ---------------------------------------------------------------------------
	echo \# Tell the AI to connect with:
	echo \# ---------------------------------------------------------------------------
	echo "Connect to Jupyter at http://$JUPYTER_IP:$ACTUAL_PORT (no token)"
fi
echo
echo \# ---------------------------------------------------------------------------
echo \# jupyter-collaboration: $COLLAB_MODE
echo \# ---------------------------------------------------------------------------
echo
