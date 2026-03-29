#!/bin/bash

# ---------------------------------------------------------------
# Argument handling
#   -h          Show usage and exit
#   -p <port>   Port of the Jupyter Lab instance to stop.
#               If omitted, lists all running instances for selection.
# ---------------------------------------------------------------

PORT=""

while getopts ":hp:" opt; do
	case $opt in
		p) PORT="$OPTARG" ;;
		h) echo "Usage: $0 [-p <port>]"
		   echo ""
		   echo "Options:"
		   echo "  -p <port>   Port of the Jupyter Lab instance to stop."
		   echo "              If omitted, lists all running instances for selection."
		   echo ""
		   echo "Examples:"
		   echo "  $0"
		   echo "  $0 -p 8889"
		   exit 0 ;;
		\?) echo "Invalid option: -$OPTARG" >&2; exit 1 ;;
		:) echo "Option -$OPTARG requires an argument." >&2; exit 1 ;;
	esac
done

stop_instance() {
	local pid_file=$1
	local port=$2
	local pid
	pid=$(cat "$pid_file")
	if kill -0 "$pid" 2>/dev/null; then
		echo "Stopping Jupyter Lab on port $port (PID $pid)"
		kill "$pid"
	else
		echo "Stale PID file for port $port — process $pid is not running."
	fi
	rm -f "$pid_file"
}

if [ -n "$PORT" ]; then
	# --------------- explicit port mode ---------------
	PID_FILE="/tmp/jupyterlab-${PORT}.pid"
	if [ -f "$PID_FILE" ]; then
		stop_instance "$PID_FILE" "$PORT"
	else
		echo "Error: no Jupyter Lab PID file found for port $PORT (expected $PID_FILE)." >&2
		exit 1
	fi
else
	# --------------- interactive selection mode ---------------
	shopt -s nullglob
	PID_FILES=(/tmp/jupyterlab-*.pid)
	shopt -u nullglob

	if [ ${#PID_FILES[@]} -eq 0 ]; then
		echo "No Jupyter Lab instances found."
		exit 0
	fi

	# Build list of live instances; silently clean up stale PID files.
	RUNNING_PORTS=()
	RUNNING_PIDS=()
	RUNNING_FILES=()
	for pf in "${PID_FILES[@]}"; do
		pid=$(cat "$pf")
		port=$(basename "$pf" | grep -oP '(?<=jupyterlab-)\d+(?=\.pid)')
		if kill -0 "$pid" 2>/dev/null; then
			RUNNING_PORTS+=("$port")
			RUNNING_PIDS+=("$pid")
			RUNNING_FILES+=("$pf")
		else
			rm -f "$pf"
		fi
	done

	if [ ${#RUNNING_PORTS[@]} -eq 0 ]; then
		echo "No running Jupyter Lab instances found (cleaned up stale PID files)."
		exit 0
	fi

	if [ ${#RUNNING_PORTS[@]} -eq 1 ]; then
		# Only one instance — stop it without prompting.
		stop_instance "${RUNNING_FILES[0]}" "${RUNNING_PORTS[0]}"
		exit 0
	fi

	# Multiple instances — show a menu.
	echo "Running Jupyter Lab instances:"
	for i in "${!RUNNING_PORTS[@]}"; do
		echo "  $((i+1))) port ${RUNNING_PORTS[$i]}  (PID ${RUNNING_PIDS[$i]})"
	done
	echo "  a) Stop all"
	echo "  q) Quit"
	echo ""
	read -rp "Select instance to stop [1-${#RUNNING_PORTS[@]}/a/q]: " choice

	case "$choice" in
		q|Q)
			echo "Aborted."
			exit 0
			;;
		a|A)
			for i in "${!RUNNING_PORTS[@]}"; do
				stop_instance "${RUNNING_FILES[$i]}" "${RUNNING_PORTS[$i]}"
			done
			;;
		''|*[!0-9]*)
			echo "Invalid selection." >&2
			exit 1
			;;
		*)
			idx=$((choice - 1))
			if [ "$idx" -lt 0 ] || [ "$idx" -ge "${#RUNNING_PORTS[@]}" ]; then
				echo "Invalid selection." >&2
				exit 1
			fi
			stop_instance "${RUNNING_FILES[$idx]}" "${RUNNING_PORTS[$idx]}"
			;;
	esac
fi