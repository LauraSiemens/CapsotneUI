# Optional battery test sketch

Self-contained PlatformIO project: **CSV over USB + Bluetooth** with an extra **battery %** column (ESP32 ADC on `VBAT_PIN`).

**Not** the main `bmv.ino` dashboard firmware. Delete this folder when you are done.

## Build and upload

```bash
cd battery_test
pio run -t upload
pio device monitor
```

## Bosch BMV080 SDK

The first `pio run` downloads the SparkFun library into `battery_test/.pio/libdeps/...` but not the Bosch blobs.

If you **already** ran `./scripts/install_bmv080_sdk.sh` for the **root** project (`bmv/.pio/libdeps/...`), the pre-build script **`scripts/check_bmv080_sdk.py`** will **copy** `bmv080.h`, `bmv080_defs.h`, and the ESP32 `.a` libs from the parent repo into `battery_test`’s SparkFun folder automatically.

If the parent repo does not have the SDK yet, from repo root:

```bash
./scripts/install_bmv080_sdk.sh "/path/to/your/bmv080_sdk"
```

Then build again from `battery_test/`.

## Serial output

115200 baud. Each line:

`timestamp, PM1, PM2.5, PM10, Temp, Humidity, Gas, Pressure, BatteryPct`

Tune **`VBAT_PIN`**, **`VOLTAGE_DIVIDER`**, and the voltage→% curve in `battery_test.ino` for your board.
