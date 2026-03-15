#! /bin/sh
kill "$(cat /tmp/jupyterlab.pid)"
kill "$(cat /tmp/jupytermcp.pid)"
