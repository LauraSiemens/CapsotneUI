# Docker: dashboard + optional serial bridge

## Quick start (UI only)

ESP32 sends data over **Wi‑Fi WebSocket** (no USB to this machine):

```bash
docker compose up --build
```

- **Dashboard:** http://localhost:8765  
- In the UI choose **WebSocket** and set **`ws://<ESP_IP>:8766`** (IP from the ESP serial monitor).

## UI + USB serial bridge

Use this when the ESP32 is **plugged into the same machine** that runs Docker and you want **`ws://localhost:8766`** in the browser.

1. **Linux:** find the device (e.g. `/dev/ttyUSB0`, `/dev/ttyACM0`), then either:
   - Edit `docker-compose.yml`: uncomment `devices:` and map host → same path in container, **or**
   - Run:  
     `docker run --rm -it -p 8765:8765 -p 8766:8766 --device=/dev/ttyUSB0 -e SERIAL_PORT=/dev/ttyUSB0 $(docker build -q .)`

2. Start with serial port set:

   ```bash
   SERIAL_PORT=/dev/ttyUSB0 docker compose up --build
   ```

   The device path in **`SERIAL_PORT`** must be the path **inside the container** (usually the same as on the host if you mapped it 1:1).

3. Open http://localhost:8765 and use **WebSocket** `ws://localhost:8766`.

**macOS / Windows Docker Desktop:** passing USB serial into containers is **awkward or unsupported**. Options: run **`python3 scripts/serial_ws_bridge.py`** on the host instead, or use **ESP32 Wi‑Fi** with UI-only Docker.

## Optional battery log (with bridge)

Mount a host folder and set `BATTERY_LOG` to a path **inside** the container:

```bash
docker compose run --rm -p 8765:8765 -p 8766:8766 \
  -e SERIAL_PORT=/dev/ttyUSB0 \
  -e BATTERY_LOG=/data/battery_log.csv \
  -v "$(pwd)/docker-data:/data" \
  --device=/dev/ttyUSB0 \
  bmv
```

(Adjust for your compose service name; with `docker compose up`, add a `volumes:` entry in `docker-compose.yml` for production use.)

## Plain `docker build` / `docker run`

```bash
docker build -t bmv-air-monitor .
docker run --rm -p 8765:8765 -p 8766:8766 bmv-air-monitor
```

Add `-e SERIAL_PORT=...` and `--device` when using the bridge on Linux.
