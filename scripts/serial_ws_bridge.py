#!/usr/bin/env python3
"""
Forward ESP32 CSV lines from USB serial to all WebSocket clients (dashboard WebSocket mode).

Usage:
  pip install -r scripts/requirements-bridge.txt
  python3 scripts/serial_ws_bridge.py --port /dev/cu.usbserial-XXXX

Then open the UI, choose WebSocket, URL ws://localhost:8766 (or this machine's LAN IP).

Close other serial monitors (including Web Serial in the browser) before starting.

Optional: --battery-log battery_log.csv  (same folder or path) to append BatteryPct while bridging.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Any, Optional, Set

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import serial
import websockets
from websockets.exceptions import ConnectionClosed

from battery_log_util import append_battery_row
from bmv_csv import extract_battery_percent

clients: Set[Any] = set()


async def broadcast(text: str) -> None:
    if not clients or not text:
        return
    dead: list[Any] = []
    for ws in list(clients):
        try:
            await ws.send(text)
        except ConnectionClosed:
            dead.append(ws)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def ws_handler(websocket: Any) -> None:
    clients.add(websocket)
    try:
        async for _ in websocket:
            pass
    finally:
        clients.discard(websocket)


async def serial_reader(port: str, baud: int, battery_log: Optional[str]) -> None:
    loop = asyncio.get_event_loop()
    try:
        ser = serial.Serial(port, baud, timeout=0.1)
    except serial.SerialException as e:
        print(f"Serial open failed ({port}): {e}", file=sys.stderr)
        raise SystemExit(1) from e

    print(f"Serial OK {port} @ {baud}")
    try:
        while True:
            line = await loop.run_in_executor(None, ser.readline)
            if not line:
                await asyncio.sleep(0)
                continue
            try:
                text = line.decode("utf-8", errors="replace").strip()
            except Exception:
                continue
            if text:
                if battery_log:
                    pct = extract_battery_percent(text)
                    if pct is not None:
                        await loop.run_in_executor(
                            None, append_battery_row, battery_log, pct
                        )
                await broadcast(text)
    finally:
        ser.close()


async def run_server(
    serial_port: str,
    baud: int,
    ws_host: str,
    ws_port: int,
    battery_log: Optional[str],
) -> None:
    async with websockets.serve(ws_handler, ws_host, ws_port):
        print(f"WebSocket ws://{ws_host}:{ws_port}  (share LAN IP with phones on same Wi-Fi)")
        if battery_log:
            print(f"Battery log: {os.path.abspath(battery_log)}")
        await serial_reader(serial_port, baud, battery_log)


def main() -> None:
    p = argparse.ArgumentParser(description="Serial CSV → WebSocket broadcast for air monitor UI")
    p.add_argument(
        "--port",
        "-p",
        required=True,
        help="Serial device, e.g. /dev/cu.usbserial-1410 or COM3",
    )
    p.add_argument("--baud", "-b", type=int, default=115200)
    p.add_argument("--ws-host", default="0.0.0.0", help="Listen address (default all interfaces)")
    p.add_argument("--ws-port", type=int, default=8766)
    p.add_argument(
        "--battery-log",
        metavar="FILE",
        default=None,
        help="Append timestamp,battery_pct rows from 8-column CSV (e.g. battery_log.csv)",
    )
    args = p.parse_args()

    try:
        asyncio.run(
            run_server(
                args.port,
                args.baud,
                args.ws_host,
                args.ws_port,
                args.battery_log,
            )
        )
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
