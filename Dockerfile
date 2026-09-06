# ClawPyter JupyterLab container
#
# Runs the JupyterLab server that ClawPyter's agent plugins drive. Live human +
# agent co-editing (Y.js CRDT) is a required feature, not an option, so
# jupyter-collaboration is baked in and the build fails if it is not loadable.
#
# The plugin itself is NOT installed here: it lives in the agent's environment
# (Hermes / OpenClaw), not on the notebook server.
#
# Build:  ./docker-build-push.sh          # or: docker build -t clawpyter:latest .
#
# Run (token printed in the log):
#   docker run --rm -p 8888:8888 -v "$PWD":/workspace clawpyter:latest
#
# Run with a fixed token (what the agent connects with):
#   docker run --rm -p 8888:8888 -e JUPYTER_TOKEN=secret \
#       -v "$PWD":/workspace clawpyter:latest
#
# No authentication (trusted networks only):
#   docker run --rm -p 8888:8888 -e JUPYTER_TOKEN=none \
#       -v "$PWD":/workspace clawpyter:latest
#
# Force a specific uid/gid instead of the mount owner:
#   docker run --rm -e HOST_UID=1000 -e HOST_GID=1000 \
#       -p 8888:8888 -v "$PWD":/workspace clawpyter:latest
#
# Interactive shell instead of the server:
#   docker run --rm -it -v "$PWD":/workspace clawpyter:latest bash

FROM python:3.11-slim

LABEL org.opencontainers.image.title="clawpyter" \
      org.opencontainers.image.description="JupyterLab server with real-time collaboration, for AI-agent notebook control" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

# bash (entrypoint + default shell), util-linux (setpriv, for the uid-remap
# entrypoint) and curl (health check) are absent from the slim base.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash util-linux curl \
 && rm -rf /var/lib/apt/lists/*

# JupyterLab + real-time collaboration. jupyter-collaboration is the SERVER
# half of co-editing and is mandatory: without it /api/collaboration/session/...
# 404s and every notebook silently becomes last-writer-wins.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir \
        "jupyterlab>=4.0" \
        "jupyter-collaboration>=4.0"

# Client half of the CRDT stack, so `docker exec` sessions and notebooks inside
# the container use the same API the agent plugin does.
RUN pip install --no-cache-dir \
        "jupyter-nbmodel-client>=1.5" \
        "pycrdt>=0.14"

# Build-time sanity: the server and the collaboration extension must both be
# present before the image is baked.
RUN jupyter lab --version >/dev/null \
 && python -c "import jupyter_nbmodel_client, pycrdt; print('collab client OK')" \
 && jupyter server extension list 2>&1 | grep -qi 'jupyter_server_ydoc' \
 && echo "jupyter-collaboration enabled"

# Non-root user. uid 1000 matches the siblings and is remapped at RUN time by
# the entrypoint to the owner of the mounted /workspace (or $HOST_UID/$HOST_GID).
COPY docker-entrypoint.sh ./
RUN groupadd -g 1000 user \
 && useradd -m -u 1000 -g 1000 user \
 && install -m 0755 ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Token handling: docker-entrypoint.sh translates JUPYTER_TOKEN into a
# --IdentityProvider.token=… flag on the jupyter command line.
#   unset -> random — but only matters when the operator calls the jupyter
#           command directly; under our CMD the entrypoint injects
#           `--IdentityProvider.token=` (empty) so the server is reachable.
#           To actually generate-or-print behaviour, override the CMD via
#           `docker run IMAGE ""`.
#   set   -> used verbatim on the jupyter CLI, overriding the random banner.
#   ""    -> authentication disabled (matches start-jpy.sh semantics).
# The container always listens on 8888; map it wherever you like with -p.
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:8888/api" >/dev/null || exit 1

WORKDIR /workspace
# NOTE: no `USER` here on purpose — the container starts as root so the
# entrypoint can remap `user` to the mount owner, then drops privileges via
# setpriv. `docker run --user ...` still works.
SHELL ["/bin/bash", "-lc"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["jupyter", "lab", \
     "--ip=0.0.0.0", \
     "--port=8888", \
     "--no-browser", \
     "--ServerApp.root_dir=/workspace"]
