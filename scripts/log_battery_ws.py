#!/usr/bin/env python3
"""
Connect to the air monitor WebSocket (ESP32 Wi‑Fi or serial_ws_bridge) and append
BatteryPct to a CSV file.

  pip install -r scripts/requirements-bridge.txt
  python3 scripts/log_battery_ws.py --url ws://192.168.1.100:8766

Reconnects automatically if the link drops.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException

from battery_log_util import append_battery_row
from bmv_csv import extract_battery_percent


def _decode_message(message: str | bytes) -> str:
    if isinstance(message, str):
        return message
    return message.decode("utf-8", errors="replace")


def _try_log_line(raw: str, out_path: str) -> None:
    text = raw.replace("\r", "").strip()
    if not text:
        return
    pct = extract_battery_percent(text)
    if pct is not None:
        append_battery_row(out_path, pct)
        print(pct, flush=True)


def _process_chunk(remainder: str, chunk: str, out_path: str) -> str:
    """
    ESP32 sends one CSV row per WebSocket text frame with no trailing newline.
    The serial bridge may send \\n-terminated lines. Handle both.
    """
    data = remainder + chunk
    while "\n" in data:
        line, data = data.split("\n", 1)
        _try_log_line(line, out_path)

    tail = data.replace("\r", "").strip()
    if not tail:
        return ""

    pct = extract_battery_percent(tail)
    if pct is not None:
        append_battery_row(out_path, pct)
        print(pct, flush=True)
        return ""

    # Header row, garbage, or a line split across frames (rare)
    if tail.count(",") < 7:
        return data
    return ""


async def run_client(url: str, out_path: str, reconnect_sec: float) -> None:
    remainder = ""
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                print(f"Connected {url} → logging to {os.path.abspath(out_path)}")
                async for message in ws:
                    remainder = _process_chunk(remainder, _decode_message(message), out_path)
        except (ConnectionClosed, WebSocketException, OSError) as e:
            print(f"Disconnected ({e!s}); retrying in {reconnect_sec:.0f}s…", flush=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Error: {e!s}; retrying in {reconnect_sec:.0f}s…", flush=True)
        await asyncio.sleep(reconnect_sec)


def main() -> None:
    p = argparse.ArgumentParser(description="Log BatteryPct from BMV WebSocket stream to CSV")
    p.add_argument(
        "--url",
        "-u",
        default="ws://127.0.0.1:8766",
        help="WebSocket URL (ESP32 or bridge), e.g. ws://192.168.1.100:8766",
    )
    p.add_argument(
        "--out",
        "-o",
        default="battery_log.csv",
        help="Output CSV path (default: battery_log.csv in cwd)",
    )
    p.add_argument(
        "--reconnect",
        type=float,
        default=3.0,
        help="Seconds to wait before reconnecting after disconnect (default: 3)",
    )
    args = p.parse_args()

    try:
        asyncio.run(run_client(args.url, args.out, args.reconnect))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
