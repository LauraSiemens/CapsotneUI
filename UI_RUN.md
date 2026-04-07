# How to run the air monitor dashboard (`ui/`)

The dashboard is static HTML/JS. You open it in a browser **over HTTP** (not `file://`), then connect **USB** or **WebSocket** for live data.

### Docker (UI + optional bridge)

From the **project root**:

```bash
docker compose up --build
```

Then open **http://localhost:8765**. Optional USB→WebSocket bridge: set **`SERIAL_PORT`** (Linux + device mapping). Details: **[DOCKER.md](DOCKER.md)**.

---

## 1. Start the web server

From a terminal, **project root**:

```bash
cd ui
python3 -m http.server 8765 --bind 0.0.0.0
```

- **`0.0.0.0`** — other devices on your Wi‑Fi (phones, tablets) can load the page using **this computer’s LAN IP**.
- **`127.0.0.1` only** — omit `--bind` or use `python3 -m http.server 8765` if you only browse on the same machine.

Leave this terminal open while you use the UI.

---

## 2. Open the page in a browser

| Where you browse | URL |
|------------------|-----|
| Same computer that runs the server | `http://127.0.0.1:8765` or `http://localhost:8765` |
| Phone / another PC on the same Wi‑Fi | `http://<SERVER_LAN_IP>:8765` (e.g. `http://192.168.1.42:8765`) |

Use **Chrome** or **Edge** if you need **USB (Web Serial)**; Safari/Firefox may not support Web Serial.

---

## 3. Connect live data

### Option A — USB (ESP32 plugged into this PC)

1. Choose **USB** (not WebSocket).
2. Click **Connect** and pick the ESP32 serial port.
3. Status should show **Live (USB)**.

### Option B — WebSocket (ESP32 on Wi‑Fi or hub + bridge)

1. Choose **WebSocket**.
2. Set the URL:
   - ESP32 Wi‑Fi firmware: **`ws://<ESP_IP>:8766`** (IP from serial monitor after boot).
   - PC running `scripts/serial_ws_bridge.py`: **`ws://127.0.0.1:8766`** on that PC, or **`ws://<HUB_LAN_IP>:8766`** from another device.
3. Click **Connect**. Status should show **Live (WebSocket)**.

Default field in the UI is an example IP — **replace it** with your real ESP or hub address.

---

## 4. If something fails

- **Blank page / blocked** — confirm the server is running and the URL uses **`http://`**, not `file://`.
- **USB won’t connect** — use Chrome/Edge; serve over `http://localhost:8765` (some browsers block Web Serial on non-localhost without HTTPS exceptions).
- **WebSocket stuck** — ESP must be on same network as the browser; hotspot often needs **2.4 GHz** / iPhone **Maximize Compatibility**; close **serial monitor** on the USB port if using the Python bridge on that machine.
- **Firewall** — allow inbound **TCP 8765** (HTTP) on the machine serving the UI; **8766** if that machine hosts the WebSocket bridge.

More detail (bridge install, ports, checklist): **[WIFI_CONNECTION.md](WIFI_CONNECTION.md)**.
