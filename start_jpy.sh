#!/bin/bash

# Check if at least the notebook directory argument is provided
if [ $# -lt 1 ]; then
	echo "Usage: $0 <notebook_directory> [jupyter_token]"
	echo ""
	echo "Examples:"
	echo "  $0 ~/.openclaw/jupyter_home"
	echo "  $0 ~/.openclaw/jupyter_home abcdef123456"
	echo "  $0 ~/notebooks"
	echo "  $0 /tmp/jupyter_workspace"
	exit 1
fi

NOTEBOOK_DIR="$1"
# Use provided token as second argument, otherwise generate a new UUID
if [ -n "$2" ]; then
	JUPYTER_TOKEN="$2"
else
	JUPYTER_TOKEN=$(uuid)
fi
JUPYTER_IP=$(ip -4 route get 1.1.1.1 | grep -oP 'src \K\S+')

export BROWSER=/usr/bin/microsoft-edge
jupyter lab \
	--notebook-dir "$NOTEBOOK_DIR" \
	--IdentityProvider.token=${JUPYTER_TOKEN} \
	--ip=0.0.0.0 \
	--port 8888 \
	> /tmp/jupyterlab.log 2>&1 &
	# --no-browser \

echo $! > /tmp/jupyterlab.pid

# wait for Jupyter to come up
until curl -s http://127.0.0.1:8888 >/dev/null; do
	sleep 1
done

uvx jupyter-mcp-server start \
	    --transport streamable-http \
	    --jupyter-url http://127.0.0.1:8888 \
	    --jupyter-token ${JUPYTER_TOKEN} \
		--port 4040 \
		> /tmp/jupytermcp.log 2>&1 &

echo $! > /tmp/jupytermcp.pid

echo "        \"config\": {"
echo "          \"jupyterUrl\": \"http://$JUPYTER_IP:8888\","
echo "          \"jupyterToken\": \"$JUPYTER_TOKEN\","
echo "          \"notebookDir\": \"$NOTEBOOK_DIR\""
echo "        }"   