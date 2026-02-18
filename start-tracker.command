#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
SERVER_PID_FILE="$ROOT_DIR/.wt-server.pid"
TUNNEL_PID_FILE="$ROOT_DIR/.wt-tunnel.pid"
CLOUDFLARE_CONFIG="${HOME}/.cloudflared/config.yml"

mkdir -p "$LOG_DIR"
cd "$ROOT_DIR"

drop_pid_if_dead() {
  local pid_file="$1"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
  fi
}

kill_pid_file_process() {
  local pid_file="$1"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

kill_port_listener() {
  local port="$1"
  local pids
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ ! -f "$ROOT_DIR/server.js" ]; then
  echo "server.js not found in: $ROOT_DIR"
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo "Install it first (macOS): brew install cloudflared"
  exit 1
fi

# Clean stale state/processes so one-click start is reliable.
drop_pid_if_dead "$SERVER_PID_FILE"
drop_pid_if_dead "$TUNNEL_PID_FILE"
kill_pid_file_process "$SERVER_PID_FILE"
kill_pid_file_process "$TUNNEL_PID_FILE"
pkill -f "cloudflared tunnel run" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
kill_port_listener 3000
kill_port_listener 3443

start_process() {
  local pid_file="$1"
  local cmd="$2"
  local log_file="$3"

  echo "Starting: $cmd"
  nohup bash -lc "$cmd" >"$log_file" 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$pid_file"
  sleep 1

  if ! kill -0 "$new_pid" 2>/dev/null; then
    echo "Failed to start: $cmd"
    echo "Check log: $log_file"
    exit 1
  fi
}

start_process "$SERVER_PID_FILE" "npm start" "$LOG_DIR/server.log"

TUNNEL_CMD="npm run tunnel:cf"
if [ -f "$CLOUDFLARE_CONFIG" ]; then
  TUNNEL_CMD="npm run tunnel:fixed"
fi
start_process "$TUNNEL_PID_FILE" "$TUNNEL_CMD" "$LOG_DIR/tunnel.log"

echo ""
echo "Warehouse Tracker started."
echo "Local URL: https://localhost:3443"
echo "Server log: $LOG_DIR/server.log"
echo "Tunnel log: $LOG_DIR/tunnel.log"
echo ""

fixed_host=""
if [ -f "$CLOUDFLARE_CONFIG" ]; then
  fixed_host="$(grep -E '^[[:space:]]*-?[[:space:]]*hostname:' "$CLOUDFLARE_CONFIG" | head -n 1 | sed -E 's/.*hostname:[[:space:]]*//' | tr -d '"' | tr -d "'" || true)"
fi
if [ -n "$fixed_host" ]; then
  echo "Mobile URL (fixed): https://${fixed_host}"
else
  tunnel_url=""
  for _ in $(seq 1 15); do
    tunnel_url="$(grep -aEo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$LOG_DIR/tunnel.log" | tail -n 1 || true)"
    if [ -n "$tunnel_url" ]; then
      break
    fi
    sleep 1
  done

  if [ -n "$tunnel_url" ]; then
    echo "Mobile URL: $tunnel_url"
  else
    echo "Tunnel started, but URL not detected yet."
    echo "Check: tail -n 80 $LOG_DIR/tunnel.log"
  fi
fi
