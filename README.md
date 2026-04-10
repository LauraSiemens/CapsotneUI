# Air monitor project — how to run everything

This repo is an **ESP32 air-quality setup** (particulate matter, temperature, humidity, and more) plus a **web dashboard** in the `ui` folder. Data can reach the dashboard over a **USB cable** or over **Wi‑Fi**.

Use the steps below in order. You do not need to do all of them — pick the path that matches how your hardware is connected.

---

## What runs where (simple picture)

- **The ESP32** runs firmware from `bmv.ino`. It sends **comma-separated numbers** (CSV) once per second.
- **The dashboard** is just files in `ui/` (HTML and JavaScript). Your **browser** needs to load them with **`http://`**, not by double-clicking the file.
- **Port 8765** is for the **web page** (the dashboard).
- **Port 8766** is for **live data over Wi‑Fi** (WebSocket), when you use that mode.

---

## 1. Run the dashboard (always start here)

Open a terminal, go to this project’s **`ui`** folder, and start a small built-in web server:

```bash
cd ui
python3 -m http.server 8765 --bind 0.0.0.0
```

Leave that window open. On the **same computer**, open a browser and go to:

**http://localhost:8765**

(`http://127.0.0.1:8765` is the same thing.)

**Why `--bind 0.0.0.0`?** So a **phone or another laptop on the same Wi‑Fi** can open the page using **your computer’s IP address**, like `http://192.168.1.42:8765`. If you only ever use one machine, you can leave off `--bind` and use the default.

**Browsers:** For **USB** connection to the ESP32, use **Chrome** or **Edge** (they support Web Serial). Safari and Firefox often do not.

---

## 2. Put live data on the dashboard

The page starts empty until you connect a data source.

### Option A — USB (ESP32 plugged into this computer)

1. In the page, choose **USB** (not WebSocket).
2. Click **Connect** and select the ESP32’s serial port.
3. You should see live numbers when the firmware is running.

### Option B — WebSocket (ESP32 on Wi‑Fi, or a helper PC)

The dashboard expects a WebSocket address like **`ws://SOME_IP:8766`**.

- If the **ESP32 is on your Wi‑Fi** with Wi‑Fi enabled in the firmware, use the ESP’s IP from the serial monitor, for example **`ws://192.168.1.100:8766`**.
- If another **PC** reads USB and forwards data, use **that PC’s IP** on port **8766** instead.

**Wi‑Fi on the ESP32:** Copy `wifi_secrets.example.h` to `wifi_secrets.h`, add your network name and password, then build and upload `bmv.ino`. The serial monitor shows something like **WiFi OK** and an IP. If `wifi_secrets.h` is missing or empty, Wi‑Fi is skipped and you can still use USB.

**USB on a Mac/PC but browser on another device:** Run the Python bridge on the machine that has the USB cable (see “Helper scripts” below), then point the dashboard’s WebSocket at **`ws://THAT_MACHINE_IP:8766`**.

---

## 3. Same thing with Docker (optional)

From the **project root** (not inside `ui`):

```bash
docker compose up --build
```

Then open **http://localhost:8765**. Use **WebSocket** in the UI and set the URL to your ESP or bridge, e.g. **`ws://192.168.x.x:8766`**.

On **Linux**, you can pass a USB serial device into the container with **`SERIAL_PORT`** and device mapping; see comments in `docker-compose.yml` and `Dockerfile`. On **macOS/Windows**, USB inside Docker is often painful — use **ESP32 Wi‑Fi** or run **`scripts/serial_ws_bridge.py`** on the host instead.

---

## 4. Helper scripts (Python)

From the project root, with dependencies installed if needed (`pip install -r scripts/requirements-bridge.txt`):

- **`scripts/serial_ws_bridge.py`** — reads CSV from a **USB serial port** and rebroadcasts it on the network so browsers can use **WebSocket**. Example:  
  `python3 scripts/serial_ws_bridge.py --port /dev/cu.YOUR_PORT`  
  Close any serial monitor on that port first.

- **`scripts/log_battery_serial.py`** and **`scripts/log_battery_ws.py`** — optional **CSV logs** of battery percentage. Firmware sends battery as the last CSV field; the main dashboard may not show a battery tile, but logging still works.

---

## 5. Build and upload the ESP32 firmware

Use **PlatformIO** from the project root (activate your virtual environment if you use one):

```bash
pio run -t upload
```

Serial monitor: **`pio device monitor`** (115200 baud).

The **BMV080** particulate sensor needs Bosch SDK files copied into the SparkFun library. If the build complains, run **`./scripts/install_bmv080_sdk.sh`** with the path to your downloaded SDK (see Bosch’s BMV080 documentation).

---

## 6. Optional: `battery_test` folder

That folder is a **separate test sketch** (battery + Bluetooth), not the main `bmv.ino` app. Build it with PlatformIO from inside **`battery_test/`**. It needs the same BMV080 SDK setup as the main project.

---

## 7. If something goes wrong

- **Blank or broken page** — Make sure the **`ui` server** is running and the URL starts with **`http://`**, not `file://`.
- **USB will not connect** — Use Chrome or Edge; serve the UI from **localhost** as above.
- **WebSocket never connects** — Same Wi‑Fi as the ESP or bridge; many hotspots need **2.4 GHz**; turn off **AP isolation** on the router if devices cannot see each other; allow firewall ports **8765** (page) and **8766** (data) on the machine that hosts them.
- **Serial busy** — Only one program can use the USB port at a time (bridge, monitor, or upload — not all at once on the same port).

---

That’s everything you need to run the UI, connect data, and work with the firmware in plain terms.
