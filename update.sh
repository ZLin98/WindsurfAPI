#!/usr/bin/env bash
# One-click update: pull latest code, verify/install LS, restart service.
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-3003}"
NAME="${PM2_NAME:-windsurf-api}"
SERVICE_MANAGER="${SERVICE_MANAGER:-auto}"
PID_FILE="${PID_FILE:-.windsurf-api.pid}"
LOG_FILE="${LOG_FILE:-logs/server.log}"
MIN_LS_BYTES="${MIN_LS_BYTES:-1000000}"

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

resolve_ls_path() {
  local path="${LS_BINARY_PATH:-/opt/windsurf/language_server_linux_x64}"
  if [ -f .env ]; then
    local env_path
    env_path="$(grep -E '^LS_BINARY_PATH=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
    env_path="${env_path%\"}"
    env_path="${env_path#\"}"
    env_path="${env_path%\'}"
    env_path="${env_path#\'}"
    [ -n "$env_path" ] && path="$env_path"
  fi
  printf '%s\n' "$path"
}

file_size() {
  stat --format=%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0
}

select_manager() {
  case "$SERVICE_MANAGER" in
    pm2|nohup) printf '%s\n' "$SERVICE_MANAGER" ;;
    auto)
      if has_cmd pm2; then printf 'pm2\n'; else printf 'nohup\n'; fi
      ;;
    *)
      echo "Unsupported SERVICE_MANAGER=$SERVICE_MANAGER (use auto, pm2, or nohup)" >&2
      exit 1
      ;;
  esac
}

echo "=== [1/5] Pull latest ==="
git fetch --quiet origin
BEFORE="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/master)"

if ! git pull --ff-only --quiet 2>/dev/null; then
  echo "    ! remote history changed; hard-resetting to origin/master"
  git reset --hard "$REMOTE"
fi

AFTER="$(git rev-parse HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "    Already up to date"
else
  echo "    $BEFORE -> $AFTER"
  git log --oneline "$BEFORE..$AFTER" 2>/dev/null | head -10 || true
fi

echo ""
echo "=== [2/5] Verify LS binary ==="
LS_PATH="$(resolve_ls_path)"
if [ -f "$LS_PATH" ]; then
  LOCAL_SIZE="$(file_size "$LS_PATH")"
  if [ "${LOCAL_SIZE:-0}" -lt "$MIN_LS_BYTES" ]; then
    echo "    ! LS binary at $LS_PATH is too small (${LOCAL_SIZE} bytes)"
    echo "    Reinstalling instead of using a likely broken download..."
    if [ "${SKIP_LS_INSTALL:-0}" = "1" ]; then
      echo "    SKIP_LS_INSTALL=1, please install LS manually and rerun"
      exit 1
    fi
    LS_INSTALL_PATH="$LS_PATH" bash ./install-ls.sh
  else
    chmod +x "$LS_PATH"
    echo "    LS binary OK: $LS_PATH (${LOCAL_SIZE} bytes)"
    if [ "${UPDATE_LS:-0}" = "1" ]; then
      echo "    UPDATE_LS=1, reinstalling LS via install-ls.sh..."
      LS_INSTALL_PATH="$LS_PATH" bash ./install-ls.sh
    fi
  fi
else
  echo "    LS binary not found at $LS_PATH"
  if [ "${SKIP_LS_INSTALL:-0}" = "1" ]; then
    echo "    SKIP_LS_INSTALL=1, please install LS manually and rerun"
    exit 1
  fi
  LS_INSTALL_PATH="$LS_PATH" bash ./install-ls.sh
fi

MANAGER="$(select_manager)"
echo "    Service manager: $MANAGER"

echo ""
echo "=== [3/5] Stop service ==="
if [ "$MANAGER" = "pm2" ]; then
  pm2 stop "$NAME" >/dev/null 2>&1 || true
  pm2 delete "$NAME" >/dev/null 2>&1 || true
else
  if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
      kill "$OLD_PID" >/dev/null 2>&1 || true
    fi
    rm -f "$PID_FILE"
  fi
fi
fuser -k "$PORT"/tcp >/dev/null 2>&1 || true
pkill -f "node.*WindsurfAPI/src/index.js" >/dev/null 2>&1 || true
pkill -f "node.*src/index.js" >/dev/null 2>&1 || true

for _ in $(seq 1 30); do
  if ! ss -ltn 2>/dev/null | grep -q ":$PORT "; then break; fi
  sleep 1
done

echo ""
echo "=== [4/5] Start service ==="
if [ "$MANAGER" = "pm2" ]; then
  pm2 start src/index.js --name "$NAME" --cwd "$(pwd)"
  pm2 save >/dev/null 2>&1 || true
else
  mkdir -p "$(dirname "$LOG_FILE")"
  nohup env PORT="$PORT" node src/index.js >> "$LOG_FILE" 2>&1 &
  NEW_PID="$!"
  echo "$NEW_PID" > "$PID_FILE"
  echo "    Started with nohup pid=$NEW_PID log=$LOG_FILE"
fi

echo ""
echo "=== [5/5] Health check ==="
sleep 3
if curl -sf "http://localhost:$PORT/health" | head -200; then
  echo ""
  echo ""
  echo "Update complete. Dashboard: http://\$YOUR_IP:$PORT/dashboard"
else
  echo ""
  echo "Health check failed."
  if [ "$MANAGER" = "pm2" ]; then
    echo "Check: pm2 logs $NAME"
  else
    echo "Check: tail -200 $LOG_FILE"
  fi
  exit 1
fi
