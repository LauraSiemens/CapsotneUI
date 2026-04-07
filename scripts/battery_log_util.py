"""Append timestamp + battery_pct rows to a CSV file (shared by serial / bridge / WS loggers)."""

from __future__ import annotations

import os
from datetime import datetime, timezone


def append_battery_row(path: str, pct: int) -> None:
    new_file = not os.path.exists(path) or os.path.getsize(path) == 0
    with open(path, "a", encoding="utf-8") as f:
        if new_file:
            f.write("timestamp_utc,battery_pct\n")
        f.write(f"{datetime.now(timezone.utc).isoformat()},{pct}\n")
