#! /bin/sh

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