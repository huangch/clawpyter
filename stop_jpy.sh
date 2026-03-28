#! /bin/sh

# Stop any existing Jupyter Lab process.
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