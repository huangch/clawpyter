#!/usr/bin/env bash
# clawpyter - unified start/stop/restart/status/logs/list for the ClawPyter
# JupyterLab server.
#
# Manages BOTH backends (native + docker) without depending on the legacy
# start-jpy.sh / stop-jpy.sh / clawpyter-docker-run.sh scripts (those are
# kept in bak/ for reference only).
#
# State file: <data_dir>/.clawpyter/instances.json
#   - one JSON file per project directory tracks every instance by
#     "<backend>-<port>" key
#   - no /tmp/*.pid files (those leaked across users on shared machines)
#   - no ~/.hermes/ coupling: works for Hermes, OpenClaw, or human use
#
# Subcommands:
#   start   -d DIR -b {native,docker} [-p PORT] [-t TOKEN|--no-token]
#   stop    -d DIR -b {native,docker} [--force]
#   restart -d DIR -b {native,docker} [-p PORT] [-t TOKEN|--no-token]
#   status  [-d DIR] [-b BACKEND] [--all]
#   logs    -d DIR -b {native,docker} [-f]
#   list    [--all]
#
# Exit code 0 on success, 1 on user error, 2 on infrastructure failure.

set -euo pipefail

PROG="$(basename "$0")"
VERSION="1.0.0"

IMAGE_ID="${CLAWPYTER_IMAGE:-huangchtw/clawpyter:latest}"

# ---------------------------------------------------------------------------
# usage / help
# ---------------------------------------------------------------------------
print_usage() {
    cat <<EOF
$PROG $VERSION - manage ClawPyter JupyterLab instances

Usage:
  $PROG start    -d DIR -b {native,docker} [-p PORT] [-t TOKEN|--no-token]
  $PROG stop     -d DIR -b {native,docker} [--force]
  $PROG restart  -d DIR -b {native,docker} [-p PORT] [-t TOKEN|--no-token]
  $PROG status   [-d DIR] [-b BACKEND] [--all]
  $PROG logs     -d DIR -b {native,docker} [-f]
  $PROG list     [--all]
  $PROG -h | --help
  $PROG --version

Backends:
  native    jupyter lab on the host (requires conda env with jupyter + collaboration extension)
  docker    container from $IMAGE_ID

Options:
  -d, --data-dir  DIR      Project directory whose notebooks Jupyter serves (required for start/stop/restart/logs).
  -b, --backend   BACKEND  native | docker (required for most subcommands).
  -p, --port      PORT     Host port; default 8888. Native auto-finds a free port if taken; docker fails.
  -t, --token     TOKEN    Auth token. Omit for an auto-generated UUID; pass "none" or use --no-token to disable.
      --no-token           Disable authentication explicitly (JupyterServer empty token).
      --force              Skip confirmation prompts on stop.
  -f, --follow             Follow logs (tail -f equivalent).
      --all                For status/list: include stopped / stale entries (default: live only).
  -h, --help               Show this help and exit.
      --version            Show version and exit.

State file: <DIR>/.clawpyter/instances.json
EOF
}

# ---------------------------------------------------------------------------
# Tiny JSON helpers (no jq dependency). Each value must be one of:
#   string  - "value with \"\\n\" escapes"
#   number  - 123, 123.45
#   bool    - true | false
#   null    - null
# Anything else (arrays of mixed types, deep nesting) is out of scope; the file
# only contains flat string/number values today. If you need more, install jq.
# ---------------------------------------------------------------------------
_json_escape() {
    # Escape a string for embedding inside a JSON double-quoted value.
    local s="$1"
    # Order matters: backslash first.
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//	/\\t}"
    s="${s//
/\\n}"
    printf '%s' "$s"
}

_json_read_kv() {
    # Extract the value of a top-level key from a flat JSON object.
    # Usage: _json_read_kv <file> <key>
    local file="$1" key="$2"
    python3 - "$file" "$key" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except (OSError, ValueError) as e:
    sys.stderr.write(f"instances.json invalid: {e}\n")
    sys.exit(2)
val = data.get(sys.argv[2])
if val is None:
    sys.exit(0)
if isinstance(val, (dict, list)):
    print(json.dumps(val))
else:
    print(val)
PY
}
# Note: the heredoc above uses python3 — same Python resolver as build4hermes.sh
# (the user must have a Python env on PATH; for clawpyter start we already need
# `python3` for state-file IO, and the native backend needs `jupyter` anyway).

# ---------------------------------------------------------------------------
# path helpers
# ---------------------------------------------------------------------------
state_dir() {
    # Per-project: <data_dir>/.clawpyter
    printf '%s/.clawpyter\n' "$1"
}
state_file() {
    printf '%s/instances.json\n' "$(state_dir "$1")"
}
instance_key() {
    # "<backend>-<port>" — unique enough for one project; if you really need
    # multiple instances of the same backend on different ports in the same
    # project, the disambiguator is the port.
    printf '%s-%s\n' "$1" "$2"
}

# ---------------------------------------------------------------------------
# state-file IO
# ---------------------------------------------------------------------------
state_load() {
    # Print "{ "version": N, "instances": {...} }" or empty JSON.
    local f; f="$(state_file "$1")"
    if [[ -f "$f" ]]; then
        cat "$f"
    else
        printf '{"version":1,"instances":{}}\n'
    fi
}

state_get() {
    # Usage: state_get <data_dir> <key> <subkey>
    local data_dir="$1" key="$2" subkey="$3"
    local f; f="$(state_file "$data_dir")"
    [[ -f "$f" ]] || return 1
    python3 - "$f" "$key" "$subkey" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
except (OSError, ValueError):
    sys.exit(0)
inst = data.get("instances", {}).get(sys.argv[2])
if inst is None:
    sys.exit(0)
print(inst.get(sys.argv[3], ""))
PY
}

state_upsert() {
    # Usage: state_upsert <data_dir> <key> <json_blob_for_instance>
    local data_dir="$1" key="$2" blob="$3"
    local d f; d="$(state_dir "$data_dir")"; f="$d/instances.json"
    mkdir -p "$d"
    python3 - "$f" "$key" "$blob" <<'PY'
import json, os, sys, tempfile
path, key, blob = sys.argv[1], sys.argv[2], sys.argv[3]
new_inst = json.loads(blob)
try:
    with open(path) as fh:
        data = json.load(fh)
except (OSError, ValueError):
    data = {"version": 1, "instances": {}}
data.setdefault("version", 1)
data.setdefault("instances", {})
data["instances"][key] = new_inst
# Atomic write: write to temp file, then rename.
dir_ = os.path.dirname(path) or "."
with tempfile.NamedTemporaryFile("w", dir=dir_, delete=False, prefix=".instances-", suffix=".json.tmp") as tmp:
    json.dump(data, tmp, indent=2, sort_keys=True)
    tmp.write("\n")
    tmp.flush()
    os.fsync(tmp.fileno())
    tmp_path = tmp.name
os.replace(tmp_path, path)
PY
}

state_remove() {
    # Usage: state_remove <data_dir> <key>
    local data_dir="$1" key="$2"
    local f; f="$(state_file "$data_dir")"
    [[ -f "$f" ]] || return 0
    python3 - "$f" "$key" <<'PY'
import json, os, sys, tempfile
path, key = sys.argv[1], sys.argv[2]
try:
    with open(path) as fh:
        data = json.load(fh)
except (OSError, ValueError):
    sys.exit(0)
if key in data.get("instances", {}):
    del data["instances"][key]
    dir_ = os.path.dirname(path) or "."
    with tempfile.NamedTemporaryFile("w", dir=dir_, delete=False, prefix=".instances-", suffix=".json.tmp") as tmp:
        json.dump(data, tmp, indent=2, sort_keys=True)
        tmp.write("\n")
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = tmp.name
    os.replace(tmp_path, path)
PY
}

state_list_all() {
    # Usage: state_list_all [--include-stale]
    # Prints project state files found anywhere under known roots.
    # For now we only know about per-data-dir; scan the parent dir the user
    # is asking about. To get a true global list, pass --all + a known root.
    :
}

# ---------------------------------------------------------------------------
# port detection
# ---------------------------------------------------------------------------
port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | awk -v p="$port" '{n=split($4,a,":"); if (a[n]==p) found=1} END {exit !found}'
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tln 2>/dev/null | awk -v p="$port" '{n=split($4,a,":"); if (a[n]==p) found=1} END {exit !found}'
    else
        (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null
    fi
}

default_port() {
    # Find the lowest free port starting at 8888, up to 100 tries.
    local p
    for p in $(seq 8888 8987); do
        if ! port_in_use "$p"; then
            echo "$p"
            return 0
        fi
    done
    echo "Error: no free port 8888-8987" >&2
    return 1
}

# ---------------------------------------------------------------------------
# token helpers (mirror start-jpy.sh behaviour: -t none => empty token)
# ---------------------------------------------------------------------------
generate_uuid() {
    if command -v uuid >/dev/null 2>&1; then uuid
    elif command -v uuidgen >/dev/null 2>&1; then uuidgen
    elif [[ -f /proc/sys/kernel/random/uuid ]]; then cat /proc/sys/kernel/random/uuid
    elif command -v openssl >/dev/null 2>&1; then openssl rand -hex 16
    else
        echo "Error: cannot generate UUID (no uuid/uuidgen/openssl/kernel-random). Use -t <token>." >&2
        return 1
    fi
}

normalize_token() {
    # $1 is the raw token string from -t, "" if --no-token.
    # stdout: "auto" | "none" | "<literal>".
    local raw="$1"
    if [[ "$raw" == "__none__" ]]; then
        echo "none"
    elif [[ -z "$raw" ]]; then
        echo "auto"
    else
        echo "$raw"
    fi
}

# ---------------------------------------------------------------------------
# native backend
# ---------------------------------------------------------------------------
native_start() {
    # native_start <data_dir> <port> <token_kind>
    local data_dir="$1" port="$2" kind="$3"
    local log; log="$(state_dir "$data_dir")/${port}.log"

    # Preflights (fatal)
    local jupyter_bin
    if ! jupyter_bin="$(command -v jupyter)"; then
        echo "Error: 'jupyter' is not on PATH. Activate a ClawPyter environment first:" >&2
        echo "       conda activate <env>     (or: ./conda-setup.sh <env>)" >&2
        return 2
    fi
    if ! jupyter server extension list 2>&1 | grep -qi 'jupyter_server_ydoc'; then
        echo "Error: jupyter-collaboration is not installed in this environment." >&2
        echo "       Live human+agent co-editing requires it; without it every notebook" >&2
        echo "       falls back to whole-file PUTs (last writer wins)." >&2
        echo "       Install it with:  pip install 'jupyter-collaboration>=4.0'" >&2
        echo "       or re-run:        ./conda-setup.sh <env>" >&2
        return 2
    fi

    # Resolve token
    local token token_flag
    case "$kind" in
        auto) token="$(generate_uuid)"; token_flag="--IdentityProvider.token=$token" ;;
        none) token=""; token_flag="--IdentityProvider.token=" ;;
        *)    token="$kind";  token_flag="--IdentityProvider.token=$token" ;;
    esac

    # If the port is already taken AND it's not our own previously-managed
    # instance, refuse. (We don't auto-find here for native: caller chose the
    # port deliberately.)
    if port_in_use "$port"; then
        # Is it a previous clawpyter instance in this dir?
        local key; key="$(instance_key native "$port")"
        local prior_pid; prior_pid="$(state_get "$data_dir" "$key" "pid" 2>/dev/null || true)"
        if [[ -n "$prior_pid" ]] && kill -0 "$prior_pid" 2>/dev/null; then
            echo "Error: an existing clawpyter native instance is running on port $port (PID $prior_pid)." >&2
            echo "       Use '$PROG stop -d $data_dir -b native' first, or pick -p <other>." >&2
            return 1
        fi
        echo "Error: port $port is already in use by another process." >&2
        echo "       Free the port or pass -p <other>; native backend does not auto-find." >&2
        return 1
    fi

    # Launch.
    "$jupyter_bin" lab \
        --no-browser \
        --ServerApp.root_dir="$data_dir" \
        "$token_flag" \
        --ip=0.0.0.0 \
        --port "$port" \
        --ServerApp.port_retries=0 \
        > "$log" 2>&1 &

    local pid=$!
    sleep 2
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "Error: jupyter lab exited during startup." >&2
        sed 's/^/    /' "$log" >&2
        return 2
    fi

    # Wait for it to answer (up to 60 s).
    local ready=0
    for _ in $(seq 1 60); do
        if curl -s "http://127.0.0.1:$port" >/dev/null 2>&1; then
            ready=1
            break
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "Error: jupyter lab process (PID $pid) died during startup." >&2
            sed 's/^/    /' "$log" >&2
            return 2
        fi
        sleep 1
    done
    if [[ $ready -ne 1 ]]; then
        echo "Error: jupyter lab did not respond on port $port within 60s." >&2
        sed 's/^/    /' "$log" >&2
        return 2
    fi

    # Detect actual port (in case Jupyter retried despite port_retries=0 — safe belt).
    local actual_port="$port"
    if grep -q "is running at:" "$log"; then
        local detected
        detected="$(grep -oP 'http://[^:]+:\K[0-9]+' "$log" | head -1 || true)"
        [[ -n "$detected" ]] && actual_port="$detected"
    fi

    # Determine our public IP (LAN), like start-jpy.sh did.
    local ip="127.0.0.1"
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)"
    [[ -z "$ip" ]] && ip="127.0.0.1"

    # Persist state.
    local key; key="$(instance_key native "$actual_port")"
    local blob
    blob=$(cat <<JSON
{
  "backend": "native",
  "port": ${actual_port},
  "pid": ${pid},
  "token": $(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$token"),
  "auth_disabled": $([[ "$kind" == "none" ]] && echo true || echo false),
  "requested_port": ${port},
  "jupyter_bin": "$(_json_escape "$jupyter_bin")",
  "data_dir": "$(_json_escape "$data_dir")",
  "log": "$(_json_escape "$log")",
  "ip": "$(_json_escape "$ip")",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
)
    state_upsert "$data_dir" "$key" "$blob"

    # Friendly output.
    echo
    echo "ClawPyter (native) running on port $actual_port (PID $pid)"
    if [[ "$kind" != "none" ]]; then
        echo "  URL:   http://$ip:$actual_port/?token=$token"
        echo "  AI:    Connect to Jupyter at http://$ip:$actual_port with token $token"
    else
        echo "  URL:   http://$ip:$actual_port/  (no token)"
        echo "  AI:    Connect to Jupyter at http://$ip:$actual_port (no token)"
    fi
    echo "  Log:   $log"
}

native_stop() {
    # native_stop <data_dir> <port> [--force]
    local data_dir="$1" port="$2" force="${3:-}"
    local key; key="$(instance_key native "$port")"
    local pid
    pid="$(state_get "$data_dir" "$key" "pid" 2>/dev/null || true)"

    if [[ -z "$pid" ]]; then
        echo "No clawpyter native instance recorded for port $port in $data_dir." >&2
        return 1
    fi

    if kill -0 "$pid" 2>/dev/null; then
        if [[ "$force" != "--force" ]]; then
            echo "Stopping jupyter lab (PID $pid) on port $port..."
        fi
        kill "$pid"
        # Wait up to 10 s for graceful shutdown.
        local i
        for i in $(seq 1 10); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$pid" 2>/dev/null; then
            echo "Process did not exit; sending SIGKILL." >&2
            kill -9 "$pid" 2>/dev/null || true
        fi
    else
        echo "PID $pid is no longer running; cleaning stale state." >&2
    fi
    state_remove "$data_dir" "$key"
    echo "Stopped native instance on port $port."
}

# ---------------------------------------------------------------------------
# docker backend
# ---------------------------------------------------------------------------
docker_require() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "Error: 'docker' is not on PATH; require docker CLI." >&2
        return 2
    fi
    if ! docker info >/dev/null 2>&1; then
        echo "Error: docker daemon is unreachable (run '$PROG status -b docker' or start Docker)." >&2
        return 2
    fi
}

docker_start() {
    # docker_start <data_dir> <port> <token_kind>
    local data_dir="$1" port="$2" kind="$3"
    docker_require || return $?

    # Refuse to clobber an existing instance on this port.
    if port_in_use "$port"; then
        local key; key="$(instance_key docker "$port")"
        local prior; prior="$(state_get "$data_dir" "$key" "container" 2>/dev/null || true)"
        if [[ -n "$prior" ]] && docker ps -q --filter "id=$prior" 2>/dev/null | grep -q .; then
            echo "Error: clawpyter docker instance already running on port $port (container $prior)." >&2
            echo "       Use '$PROG stop -d $data_dir -b docker' first." >&2
            return 1
        fi
        echo "Error: port $port is already in use on the host; pick -p <other>." >&2
        return 1
    fi

    if [[ ! -d "$data_dir" ]]; then
        echo "Error: --data-dir $data_dir does not exist." >&2
        return 1
    fi

    # Compose the -e JUPYTER_TOKEN argument.
    #
    # The published clawpyter image's CMD is `jupyter lab ...` (not
    # start-notebook.sh), so it doesn't honour JUPYTER_TOKEN natively.
    # docker-entrypoint.sh translates JUPYTER_TOKEN into a
    # `--IdentityProvider.token=…` flag on the jupyter command line so
    # the env var actually takes effect (empty string = no auth).
    local token_env
    case "$kind" in
        auto) token_env="" ;;                    # jupyter will generate and print
        none) token_env="-e JUPYTER_TOKEN=" ;;   # empty string = "no token"
        *)    token_env="-e JUPYTER_TOKEN=$kind" ;;
    esac

    # Pull (best-effort, like clawpyter-docker-run.sh).
    if [[ "${CLAWPYTER_NO_PULL:-0}" -ne 1 ]]; then
        docker pull "$IMAGE_ID" >/dev/null 2>&1 || echo "(pull failed; using local image)"
    fi

    local container_name="clawpyter_${port}_$$"
    local log; log="$(state_dir "$data_dir")/${port}.log"
    mkdir -p "$(state_dir "$data_dir")"

    # Host IP (used only for the printed URL; the container listens on 0.0.0.0).
    local ip="127.0.0.1"
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)"
    [[ -z "$ip" ]] && ip="127.0.0.1"

    # Detached launch. Pass HOST_UID/HOST_GID only if the user exported them.
    local extra_env="-e HOST_UID -e HOST_GID"
    [[ -z "${HOST_UID:-}" ]] && extra_env="${extra_env//-e HOST_UID/}"
    [[ -z "${HOST_GID:-}" ]] && extra_env="${extra_env//-e HOST_GID/}"

    # `set +e` so we can capture the container ID.
    set +e
    # shellcheck disable=SC2086
    local cid
    cid="$(docker run -d --init \
        --label clawpyter.managed=1 \
        --name "$container_name" \
        $extra_env \
        $token_env \
        -p "${port}:8888" \
        -v "${data_dir}:/workspace" \
        "$IMAGE_ID" 2>"$log")"
    local rc=$?
    set -e
    if [[ $rc -ne 0 || -z "$cid" ]]; then
        echo "Error: docker run failed. See $log" >&2
        sed 's/^/    /' "$log" >&2
        return 2
    fi

    # Wait for the container's jupyter to answer on $port (≤ 60 s).
    local ready=0
    for _ in $(seq 1 60); do
        if curl -s "http://127.0.0.1:$port" >/dev/null 2>&1; then
            ready=1; break
        fi
        docker ps -q --filter "id=$cid" 2>/dev/null | grep -q . || {
            echo "Error: container $cid exited during startup." >&2
            docker logs "$cid" >&2 || true
            return 2
        }
        sleep 1
    done
    if [[ $ready -ne 1 ]]; then
        echo "Error: container did not respond on port $port within 60s." >&2
        docker logs "$cid" >&2 || true
        return 2
    fi

    # Extract the auto-generated token from the container's banner if needed.
    local token=""
    if [[ "$kind" == "auto" || "$kind" == "none" ]]; then
        token="$(docker logs "$cid" 2>&1 | grep -oP 'token=\K[a-f0-9]+' | head -1 || true)"
    else
        token="$kind"
    fi

    local key; key="$(instance_key docker "$port")"
    local blob
    blob=$(cat <<JSON
{
  "backend": "docker",
  "port": ${port},
  "container": "$(_json_escape "$cid")",
  "container_name": "$(_json_escape "$container_name")",
  "token": $(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$token"),
  "auth_disabled": $([[ "$kind" == "none" ]] && echo true || echo false),
  "image": "$(_json_escape "$IMAGE_ID")",
  "data_dir": "$(_json_escape "$data_dir")",
  "log": "$(_json_escape "$log")",
  "ip": "$(_json_escape "$ip")",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
)
    state_upsert "$data_dir" "$key" "$blob"

    echo
    echo "ClawPyter (docker) running on port $port (container $cid)"
    if [[ -n "$token" ]]; then
        echo "  URL:   http://$ip:$port/?token=$token"
        echo "  AI:    Connect to Jupyter at http://$ip:$port with token $token"
    else
        echo "  URL:   http://$ip:$port/  (no token)"
        echo "  AI:    Connect to Jupyter at http://$ip:$port (no token)"
    fi
    echo "  Log:   docker logs $cid    (or: $PROG logs -d $data_dir -b docker -f)"
}

docker_stop() {
    # docker_stop <data_dir> <port> [--force]
    local data_dir="$1" port="$2" force="${3:-}"
    local key; key="$(instance_key docker "$port")"
    local cid
    cid="$(state_get "$data_dir" "$key" "container" 2>/dev/null || true)"
    docker_require || return $?

    if [[ -z "$cid" ]]; then
        echo "No clawpyter docker instance recorded for port $port in $data_dir." >&2
        return 1
    fi

    # Find the container even if state was lost (label fallback).
    if ! docker ps -q --filter "id=$cid" 2>/dev/null | grep -q .; then
        local recovered
        recovered="$(docker ps -q --filter "label=clawpyter.managed=1" --filter "publish=$port" 2>/dev/null | head -1 || true)"
        if [[ -n "$recovered" ]]; then
            cid="$recovered"
        fi
    fi

    if ! docker ps -q --filter "id=$cid" 2>/dev/null | grep -q .; then
        echo "No running container with id $cid; cleaning stale state." >&2
        state_remove "$data_dir" "$key"
        return 0
    fi

    if [[ "$force" != "--force" ]]; then
        echo "Stopping container $cid on port $port..."
    fi
    docker stop --time 10 "$cid" >/dev/null
    # Best-effort remove (-rm was specified at run, but state may have been lost).
    docker rm -f "$cid" >/dev/null 2>&1 || true
    state_remove "$data_dir" "$key"
    echo "Stopped docker instance on port $port."
}

# ---------------------------------------------------------------------------
# status / logs / list (shared logic; backend filtering where applicable)
# ---------------------------------------------------------------------------
status_for() {
    # status_for <data_dir> [backend] [show_all]
    local data_dir="$1" backend_filter="${2:-}" show_all="${3:-1}"
    local f; f="$(state_file "$data_dir")"
    if [[ ! -f "$f" ]]; then
        if [[ "$show_all" == "1" ]]; then echo "(no instances)"; fi
        return 0
    fi
    python3 - "$f" "$backend_filter" "$show_all" <<'PY'
import json, os, subprocess, sys
path, backend_filter, show_all = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as fh:
        data = json.load(fh)
except (OSError, ValueError):
    print(f"(state file invalid: {path})")
    sys.exit(0)
insts = data.get("instances", {})
if not insts:
    print("(no instances)")
    sys.exit(0)

def alive(inst):
    b = inst.get("backend")
    if b == "native":
        pid = inst.get("pid")
        if not pid: return False, "no pid"
        try:
            os.kill(pid, 0); return True, "running"
        except (OSError, ProcessLookupError):
            return False, f"stale (pid {pid} gone)"
    if b == "docker":
        cid = inst.get("container")
        if not cid: return False, "no container id"
        out = subprocess.run(["docker", "ps", "-q", "--filter", f"id={cid}"],
                             capture_output=True, text=True)
        if out.stdout.strip():
            return True, "running"
        return False, f"stale (container {cid[:12]} gone)"
    return False, "unknown backend"

rows = []
for k, inst in sorted(insts.items()):
    b = inst.get("backend", "?")
    if backend_filter and b != backend_filter: continue
    ok, status = alive(inst)
    if not ok and show_all != "1": continue
    rows.append((k, b, inst.get("port", "?"), status,
                 inst.get("started_at", ""), inst.get("log", "")))

if not rows:
    sys.exit(0)

w = [max(len(str(r[i])) for r in rows + [("KEY","BACKEND","PORT","STATUS","STARTED","LOG")]) for i in range(6)]
hdr = ("KEY", "BACKEND", "PORT", "STATUS", "STARTED", "LOG")
print("  ".join(c.ljust(w[i]) for i, c in enumerate(hdr)))
for r in rows:
    print("  ".join(str(c).ljust(w[i]) for i, c in enumerate(r)))
PY
}

logs_for() {
    local data_dir="$1" backend="$2" follow="$3"
    local f; f="$(state_file "$data_dir")"
    [[ -f "$f" ]] || { echo "No state file at $f." >&2; return 1; }
    # Most recently started instance of the given backend.
    local picked
    picked="$(python3 - "$f" "$backend" <<'PY'
import json, sys
path, backend = sys.argv[1], sys.argv[2]
with open(path) as fh:
    data = json.load(fh)
candidates = [(k, v) for k, v in data.get("instances", {}).items()
              if v.get("backend") == backend]
if not candidates:
    sys.exit(1)
candidates.sort(key=lambda kv: kv[1].get("started_at", ""))
print(candidates[-1][0])
PY
)"
    [[ -z "$picked" ]] && { echo "No $backend instance found." >&2; return 1; }
    local target
    target="$(python3 - "$f" "$picked" <<'PY'
import json, sys
path, k = sys.argv[1], sys.argv[2]
with open(path) as fh:
    d = json.load(fh)
print(d["instances"][k].get("log", ""))
PY
)"
    if [[ "$backend" == "docker" ]]; then
        local cid
        cid="$(state_get "$data_dir" "$picked" "container" 2>/dev/null || true)"
        if [[ -n "$cid" ]] && docker ps -q --filter "id=$cid" 2>/dev/null | grep -q .; then
            [[ "$follow" == "1" ]] && exec docker logs -f "$cid"
            docker logs "$cid"
            return
        fi
        echo "(container $cid not running; falling back to log file $target)" >&2
    fi
    [[ -z "$target" ]] && { echo "No log target." >&2; return 1; }
    [[ -f "$target" ]] || { echo "Log file missing: $target" >&2; return 1; }
    if [[ "$follow" == "1" ]]; then
        tail -n 50 -f "$target"
    else
        tail -n 100 "$target"
    fi
}

# ---------------------------------------------------------------------------
# arg parsing helpers
# ---------------------------------------------------------------------------
require_arg() {
    # require_arg <flag> <value>
    [[ -n "${2:-}" ]] || { echo "Error: $1 requires a value." >&2; exit 1; }
}

parse_backend() {
    case "$1" in
        native|docker) echo "$1" ;;
        *) echo "Error: --backend must be 'native' or 'docker' (got: $1)." >&2; exit 1 ;;
    esac
}

# ---------------------------------------------------------------------------
# command dispatch
# ---------------------------------------------------------------------------
cmd_start() {
    local data_dir="" backend="" port="" token="" no_token=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -d|--data-dir) require_arg "$1" "$2"; data_dir="$2"; shift 2 ;;
            -b|--backend)  require_arg "$1" "$2"; backend="$(parse_backend "$2")"; shift 2 ;;
            -p|--port)     require_arg "$1" "$2"; port="$2"; shift 2 ;;
            -t|--token)    require_arg "$1" "$2"; token="$2"; shift 2 ;;
            --no-token)    no_token=1; shift ;;
            -h|--help)     print_usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done
    [[ -n "$data_dir" ]] || { echo "Error: --data-dir is required." >&2; exit 1; }
    [[ -n "$backend"  ]] || { echo "Error: --backend is required." >&2; exit 1; }
    [[ -d "$data_dir" || "$backend" == "native" ]] || {
        echo "Error: $data_dir does not exist." >&2; exit 1; }

    # If --port not given, default to 8888; if 8888 busy, auto-pick the next free.
    if [[ -z "$port" ]]; then
        port="$(default_port)" || exit 2
    fi

    local kind
    if [[ $no_token -eq 1 ]]; then kind="none"
    elif [[ -z "$token" ]]; then kind="auto"
    else kind="$token"
    fi
    case "$backend" in
        native) native_start "$data_dir" "$port" "$kind" ;;
        docker) docker_start "$data_dir" "$port" "$kind" ;;
    esac
}

cmd_stop() {
    local data_dir="" backend="" force=0
    local tolerate_missing=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -d|--data-dir) require_arg "$1" "$2"; data_dir="$2"; shift 2 ;;
            -b|--backend)  require_arg "$1" "$2"; backend="$(parse_backend "$2")"; shift 2 ;;
            --force) force=1; shift ;;
            --tolerate-missing) tolerate_missing=1; shift ;;
            -h|--help) print_usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done
    [[ -n "$data_dir" ]] || { echo "Error: --data-dir is required." >&2; exit 1; }
    [[ -n "$backend"  ]] || { echo "Error: --backend is required." >&2; exit 1; }
    local f; f="$(state_file "$data_dir")"
    if [[ ! -f "$f" ]]; then
        if [[ $tolerate_missing -eq 1 ]]; then return 0; fi
        echo "No instances tracked for $data_dir." >&2; exit 1
    fi
    # Find ports for this backend (there could be more than one historically).
    local ports
    ports="$(python3 - "$f" "$backend" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    d = json.load(fh)
print("\n".join(str(v.get("port")) for k, v in d.get("instances", {}).items()
                if v.get("backend") == sys.argv[2] and v.get("port") is not None))
PY
)"
    if [[ -z "$ports" ]]; then
        if [[ $tolerate_missing -eq 1 ]]; then return 0; fi
        echo "No $backend instances in $data_dir." >&2; exit 1
    fi
    local force_flag=""
    [[ $force -eq 1 ]] && force_flag="--force"
    while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        case "$backend" in
            native) native_stop "$data_dir" "$p" "$force_flag" ;;
            docker) docker_stop  "$data_dir" "$p" "$force_flag" ;;
        esac
    done <<< "$ports"
}

cmd_restart() {
    # Rebuild clean arg arrays. `stop` only needs -d / -b (it looks up everything
    # else from state). `start` gets all the original args minus --force.
    local stop_args=() start_args=()
    local force=0 data_dir="" backend=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --force) force=1; shift ;;
            -d|--data-dir) data_dir="$2"; stop_args+=(-d "$2"); start_args+=(-d "$2"); shift 2 ;;
            -b|--backend)  backend="$(parse_backend "$2")"; stop_args+=(-b "$2"); start_args+=(-b "$2"); shift 2 ;;
            *) start_args+=("$1"); shift ;;
        esac
    done
    [[ -n "$data_dir" ]] || { echo "Error: --data-dir is required." >&2; exit 1; }
    [[ -n "$backend"  ]] || { echo "Error: --backend is required." >&2; exit 1; }
    [[ $force -eq 1 ]] && stop_args=(--force "${stop_args[@]}")
    # Always tolerate stop failing — restart is meaningful even if there was
    # nothing to stop (it then collapses to a plain start).
    stop_args+=(--tolerate-missing)
    cmd_stop    "${stop_args[@]}" || true
    cmd_start   "${start_args[@]}"
}

cmd_status() {
    local data_dir="" backend="" all=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -d|--data-dir) require_arg "$1" "$2"; data_dir="$2"; shift 2 ;;
            -b|--backend)  require_arg "$1" "$2"; backend="$(parse_backend "$2")"; shift 2 ;;
            --all) all=1; shift ;;
            -h|--help) print_usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done
    if [[ -n "$data_dir" ]]; then
        echo "Project: $data_dir"
        status_for "$data_dir" "$backend" "$all"
    else
        # Scan under CWD and a few common roots? Simpler: show a hint.
        echo "No --data-dir given. Pass -d <DIR> (the same one used with start)."
        echo "Tip: '$PROG list' is not yet implemented; for now look up $PROG status under each project root."
    fi
}

cmd_logs() {
    local data_dir="" backend="" follow=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -d|--data-dir) require_arg "$1" "$2"; data_dir="$2"; shift 2 ;;
            -b|--backend)  require_arg "$1" "$2"; backend="$(parse_backend "$2")"; shift 2 ;;
            -f|--follow) follow=1; shift ;;
            -h|--help) print_usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done
    [[ -n "$data_dir" ]] || { echo "Error: --data-dir is required." >&2; exit 1; }
    [[ -n "$backend"  ]] || { echo "Error: --backend is required." >&2; exit 1; }
    logs_for "$data_dir" "$backend" "$follow"
}

cmd_list() {
    local all=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --all) all=1; shift ;;
            -h|--help) print_usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done
    # 'list' without --data-dir walks known clawpyter state files? For now,
    # we surface a clear message; user passes -d.
    echo "'$PROG list' requires --data-dir in this version. Use: $PROG status -d <DIR> [--all]"
    exit 1
}

# ---------------------------------------------------------------------------
# entry
# ---------------------------------------------------------------------------
main() {
    if [[ $# -eq 0 ]]; then print_usage; exit 0; fi
    case "${1:-}" in
        -h|--help) print_usage; exit 0 ;;
        --version) echo "$PROG $VERSION"; exit 0 ;;
    esac
    local sub="${1:-}"; shift || true
    case "$sub" in
        start)    cmd_start    "$@" ;;
        stop)     cmd_stop     "$@" ;;
        restart)  cmd_restart  "$@" ;;
        status)   cmd_status   "$@" ;;
        logs)     cmd_logs     "$@" ;;
        list)     cmd_list     "$@" ;;
        *) echo "Unknown subcommand: $sub" >&2; print_usage; exit 1 ;;
    esac
}

main "$@"
