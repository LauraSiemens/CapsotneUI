"""
Parse BMV monitor CSV lines (8 columns; last field = BatteryPct).
Matches UI logic: skip header rows (PM label in column index 1).
"""

from __future__ import annotations

import math
import re
from typing import Optional

_PM_COL1 = re.compile(r"pm", re.I)


def extract_battery_percent(line: str) -> Optional[int]:
    """
    Return 0–100 battery % from a data row, or None if not parseable / header / short row.
    """
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 8:
        return None
    if _PM_COL1.search(parts[1]):
        return None
    raw = parts[7].lower()
    if raw in ("nan", "inf", "-inf", ""):
        return None
    try:
        v = float(parts[7])
    except ValueError:
        return None
    if not math.isfinite(v):
        return None
    return int(round(v))
