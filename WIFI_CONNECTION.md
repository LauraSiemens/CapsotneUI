# Connecting the air monitor over Wi‑Fi (local network)

**Serving the dashboard and picking USB vs WebSocket in the browser:** see **[UI_RUN.md](UI_RUN.md)**.

Firmware (`bmv.ino`) sends the same CSV stream over:

- **USB serial** (always)
- **Wi‑Fi station + WebSocket** (optional, with `wifi_secrets.h`): ESP32 joins your router and broadcasts CSV on port **8766** — use **`ws://<ESP_IP>:8766`** in the dashboard.

**Bluetooth Classic is disabled** in this build to free RAM for reliable Wi‑Fi.

You can also use a **hub PC + USB** and the Python bridge. Both paths use the same UI WebSocket URL pattern; only the **host IP** changes (hub vs ESP32).

---

## Overview

| Piece | Role |
|--------|------|
| ESP32 (Wi‑Fi mode) | Joins your Wi‑Fi; serves **WebSocket** on **8766** with live CSV. |
| ESP32 + USB hub | Powered / data via USB; **no** ESP32 Wi‑Fi required. |
| **Serial → WebSocket bridge** | Reads CSV from USB and broadcasts on LAN (`ws://…:8766`). |
| **HTTP server** | Serves the `ui/` folder (`http://…:8765`). |
| Other devices | Same Wi‑Fi → open dashboard, **WebSocket** URL = **`ws://<ESP_IP>:8766`** or **`ws://<HUB_IP>:8766`**. |

---

## 1. ESP32 Wi‑Fi (battery / no USB hub)

1. Copy `wifi_secrets.example.h` → `wifi_secrets.h` (same folder as `bmv.ino`). Edit **SSID** and **password**. `wifi_secrets.h` is gitignored.
2. Build and upload `bmv.ino`. Open **serial monitor** (115200): note **WiFi OK IP** and the printed **`ws://…:8766`** URL.
3. Serve the UI from any machine on the LAN (see §2.4), or open the UI locally.
4. Choose **WebSocket**, set URL to **`ws://<ESP_IP>:8766`**, **Connect**.

If `wifi_secrets.h` is missing or **WIFI_SSID** is empty, Wi‑Fi is skipped (USB-only CSV).

---

## 2. On the hub computer (Mac / Linux / Windows) — USB bridge

### 2.1 Install bridge dependencies

From the project root (with your Python venv if you use one):

```bash
pip install -r scripts/requirements-bridge.txt
```

### 2.2 Find the USB serial port

- **Mac / Linux:** e.g. `pio device list` or `ls /dev/cu.*` / `/dev/ttyUSB*`
- **Windows:** Device Manager → COM port (e.g. `COM3`)

### 2.3 Start the WebSocket bridge

Close **Web Serial** in the browser and any **serial monitor** on that port first.

```bash
python3 scripts/serial_ws_bridge.py --port /dev/cu.YOUR_PORT
```

Append **battery %** to a CSV while bridging: add **`--battery-log battery_log.csv`** (see [BATTERY_AND_WIFI_UI.md](BATTERY_AND_WIFI_UI.md)).  
To log from **WebSocket only** (e.g. ESP32 Wi‑Fi): **`python3 scripts/log_battery_ws.py --url ws://<host>:8766`**.

Default WebSocket listen: **`0.0.0.0:8766`** (all interfaces).  
On the hub itself you can use `ws://127.0.0.1:8766`.

### 2.4 Serve the UI so other devices can open it

From the **`ui`** folder, bind to all interfaces:

```bash
cd ui
python3 -m http.server 8765 --bind 0.0.0.0
```

### 2.5 Find the hub’s LAN IP

Other devices need this address (not `localhost`).

- **macOS:** System Settings → Network → Wi‑Fi → Details → IP, or `ipconfig getifaddr en0` (interface name may vary).
- **Linux:** `ip -4 addr` or `hostname -I`
- **Windows:** `ipconfig` → IPv4 under your Wi‑Fi adapter

Example hub IP: `192.168.1.42`.

---

## 3. On another phone or laptop (same Wi‑Fi)

1. Open a browser (Chrome, Edge, Safari, etc.).
2. Go to: **`http://<HUB_IP>:8765`**  
   Example: `http://192.168.1.42:8765`
3. Under connection type, choose **WebSocket** (not USB).
4. Set the URL to **`ws://<HUB_IP>:8766`** if you use the USB bridge, or **`ws://<ESP_IP>:8766`** if the ESP32 is on Wi‑Fi.  
   Example: `ws://192.168.1.42:8766`
5. Click **Connect**.

You should see **Live (WebSocket)** and updating gauges. If the link drops, the UI will try **Reconnecting…** with backoff; you can **Disconnect** and **Connect** again.

---

## 4. Firewall

If nothing loads from other devices:

- Allow **inbound TCP 8765** (HTTP) and **8766** (WebSocket) on the hub’s OS firewall.
- Guest Wi‑Fi or “AP isolation” on some routers blocks device-to-device traffic; use the main LAN or disable isolation for testing.

---

## 5. Optional: custom bridge ports

```bash
python3 scripts/serial_ws_bridge.py --port /dev/cu.YOUR_PORT --ws-port 9000
```

Then use **`ws://<HUB_IP>:9000`** in the dashboard.

---

## 6. Custom WebSocket port on the ESP32

In `wifi_secrets.h` you can add `#define WIFI_WEBSOCKET_PORT 9000` and use **`ws://<ESP_IP>:9000`** in the UI (must match Python bridge port if you use that instead).

---

## Quick checklist

**ESP32 Wi‑Fi path**

- [ ] `wifi_secrets.h` with real SSID/password; upload firmware; note ESP IP from serial
- [ ] UI served (any host on LAN); client: `ws://<ESP_IP>:8766`

**USB hub path**

- [ ] Hub: bridge running with correct `--port`
- [ ] Hub: `python3 -m http.server 8765 --bind 0.0.0.0` from `ui/`
- [ ] Client: same Wi‑Fi as hub
- [ ] Client: `http://<HUB_IP>:8765` and `ws://<HUB_IP>:8766`

**Both**

- [ ] Firewall / router isolation not blocking 8765 and 8766 when using those ports
