#!/usr/bin/env python3
"""
Append battery % from ESP32 USB serial CSV to a CSV file (timestamp + BatteryPct).

Uses the same 8-column format as bmv.ino (last column = BatteryPct).
Does not start WebSocket — use serial_ws_bridge.py --battery-log if you need both.

  pip install -r scripts/requirements-bridge.txt
  python3 scripts/log_battery_serial.py --port /dev/cu.usbserial-XXXX

Close other serial monitors (including Web Serial) before starting.
"""

from __future__ import annotations

import argparse
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import serial

from battery_log_util import append_battery_row
from bmv_csv import extract_battery_percent


def main() -> None:
    p = argparse.ArgumentParser(description="Log BatteryPct from BMV serial CSV to a file")
    p.add_argument("--port", "-p", required=True, help="Serial device, e.g. /dev/cu.usbserial-1410")
    p.add_argument("--baud", "-b", type=int, default=115200)
    p.add_argument(
        "--out",
        "-o",
        default="battery_log.csv",
        help="Output CSV path (default: battery_log.csv in cwd)",
    )
    args = p.parse_args()

    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.2)
    except serial.SerialException as e:
        print(f"Serial open failed ({args.port}): {e}", file=sys.stderr)
        raise SystemExit(1) from e

    print(f"Logging battery to {os.path.abspath(args.out)}  (Ctrl+C to stop)")
    try:
        while True:
            line = ser.readline()
            if not line:
                continue
            try:
                text = line.decode("utf-8", errors="replace").strip()
            except Exception:
                continue
            if not text:
                continue
            pct = extract_battery_percent(text)
            if pct is not None:
                append_battery_row(args.out, pct)
                print(pct, flush=True)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        ser.close()


if __name__ == "__main__":
    main()
