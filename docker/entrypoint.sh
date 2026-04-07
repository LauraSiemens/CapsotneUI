#!/bin/sh
# Dashboard on 8765; optional USB→WebSocket bridge on 8766 when SERIAL_PORT is set.
cd /app || exit 1

HTTP_PID=""
BRIDGE_PID=""

cleanup() {
  kill "$BRIDGE_PID" "$HTTP_PID" 2>/dev/null || true
}
trap cleanup INT TERM

echo "BMV: serving UI on 0.0.0.0:8765"
python3 -m http.server 8765 --bind 0.0.0.0 --directory ui &
HTTP_PID=$!

if [ -n "$SERIAL_PORT" ]; then
  echo "BMV: serial bridge $SERIAL_PORT -> ws://0.0.0.0:8766"
  if [ -n "$BATTERY_LOG" ]; then
    python3 scripts/serial_ws_bridge.py \
      --port "$SERIAL_PORT" \
      --ws-host 0.0.0.0 \
      --battery-log "$BATTERY_LOG" &
  else
    python3 scripts/serial_ws_bridge.py \
      --port "$SERIAL_PORT" \
      --ws-host 0.0.0.0 &
  fi
  BRIDGE_PID=$!
else
  echo "BMV: no SERIAL_PORT — UI only. Use ESP32 Wi‑Fi or run the bridge on the host."
fi

wait
cleanup
