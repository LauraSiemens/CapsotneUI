# Battery percentage on the dashboard (USB & Wi‑Fi)

Main firmware (`bmv.ino`) still appends an **8th CSV field**, `BatteryPct` (0–100), on every line over **USB** and **WebSocket**. The **dashboard does not show a battery tile** (removed); use the **PC loggers** below if you want battery history.

If you run **older firmware** with only seven CSV columns, parsers that expect battery use padding or skip; `log_battery_*` scripts need the **8-column** row.

## How data reaches Wi‑Fi viewers

**Option A — Wi‑Fi on the ESP32:** With `wifi_secrets.h` configured, `bmv.ino` joins your router and runs a **WebSocket server on port 8766**, broadcasting the same CSV lines. Point the dashboard at **`ws://<ESP_IP>:8766`** (see serial monitor for the IP).

**Option B — USB hub:** The **hub computer** runs `scripts/serial_ws_bridge.py` and rebroadcasts serial to **`ws://<HUB_IP>:8766`**.

Any device on the same LAN that loads the UI with the matching WebSocket URL sees the stream, including `BatteryPct`.

## Log battery % on a PC (CSV file)

Firmware must send the **8-column** CSV (last field = `BatteryPct`). Nothing is logged on the ESP32 itself.

**USB only — standalone logger** (no WebSocket bridge):

```bash
pip install -r scripts/requirements-bridge.txt
python3 scripts/log_battery_serial.py --port /dev/cu.YOUR_PORT --out battery_log.csv
```

Writes **`timestamp_utc,battery_pct`** rows. Default output file is **`battery_log.csv`** in the current working directory.

**USB + bridge** — log while forwarding to the dashboard:

```bash
python3 scripts/serial_ws_bridge.py --port /dev/cu.YOUR_PORT --battery-log battery_log.csv
```

**WebSocket** (ESP32 on Wi‑Fi or any machine reaching `ws://…:8766`):

```bash
pip install -r scripts/requirements-bridge.txt
python3 scripts/log_battery_ws.py --url ws://192.168.1.100:8766 --out battery_log.csv
```

Use the **same URL** as in the dashboard (ESP IP or hub). Reconnects automatically if the socket drops (`--reconnect` seconds).

## Hardware / tuning

- Default ADC pin is **`VBAT_PIN` 33** with a **2×** divider constant (`VOLTAGE_DIVIDER`). Change these in `bmv.ino` if your board wires battery sense differently.
- The percent curve is a **rough Li‑ion estimate** from voltage; for accurate fuel gauging you would need a coulomb-counting chip or calibration against your pack.
