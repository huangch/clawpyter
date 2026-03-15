#!/bin/bash
export BROWSER=/usr/bin/microsoft-edge
JUPYTER_TOKEN=$(uuid)
jupyter lab \
	--notebook-dir ~/.openclaw/jupyter_home \
	--no-browser \
	--IdentityProvider.token=${JUPYTER_TOKEN} \
	--ip=0.0.0.0 \
	--port 8888 \
	> /tmp/jupyterlab.log 2>&1 &

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
