#!/usr/bin/env bash
# Copy Bosch BMV080 SDK artifacts into the SparkFun BMV080 Arduino library.
# Download the SDK from: https://www.bosch-sensortec.com/products/environmental-sensors/particulate-matter-sensor/bmv080/#documents
#
# Usage:
#   ./scripts/install_bmv080_sdk.sh /path/to/extracted/bmv080_sdk
#
# Optional: set SPARKFUN_BMV080_LIB to the library folder if it is not auto-detected.

set -euo pipefail

SDK_ROOT="${1:-}"
if [[ -z "$SDK_ROOT" || ! -d "$SDK_ROOT" ]]; then
  echo "Usage: $0 /path/to/bmv080_sdk" >&2
  exit 1
fi

detect_lib_dir() {
  if [[ -n "${SPARKFUN_BMV080_LIB:-}" ]]; then
    echo "$SPARKFUN_BMV080_LIB"
    return
  fi
  local here
  here="$(cd "$(dirname "$0")/.." && pwd)"
  local pio_lib
  pio_lib=$(find "$here/.pio/libdeps" -maxdepth 6 -type d -name "SparkFun BMV080 Arduino Library" 2>/dev/null | head -1)
  if [[ -n "$pio_lib" ]]; then
    echo "$pio_lib"
    return
  fi
  local arduino_lib="${HOME}/Documents/Arduino/libraries/SparkFun_BMV080_Arduino_Library"
  if [[ -d "$arduino_lib" ]]; then
    echo "$arduino_lib"
    return
  fi
  echo "" 
}

LIB_DIR="$(detect_lib_dir)"
if [[ -z "$LIB_DIR" ]]; then
  echo "Could not find SparkFun BMV080 Arduino Library." >&2
  echo "Install it (Arduino Library Manager or PlatformIO), or set SPARKFUN_BMV080_LIB." >&2
  exit 1
fi

HDR_SRC="$SDK_ROOT/api/inc"
# Bosch SDK v11.x uses api/lib/...; older packages used api/api/lib/...
ESP32_SRC=""
for candidate in \
  "$SDK_ROOT/api/lib/xtensa_esp32/xtensa_esp32_elf_gcc/release" \
  "$SDK_ROOT/api/api/lib/xtensa_esp32/xtensa_esp32_elf_gcc/release"; do
  if [[ -f "$candidate/lib_bmv080.a" && -f "$candidate/lib_postProcessor.a" ]]; then
    ESP32_SRC="$candidate"
    break
  fi
done
DEST_HDR="$LIB_DIR/src/sfTk"
DEST_ESP32="$LIB_DIR/src/esp32"

if [[ ! -f "$HDR_SRC/bmv080.h" ]]; then
  echo "SDK layout unexpected: missing $HDR_SRC/bmv080.h" >&2
  exit 1
fi
if [[ -z "$ESP32_SRC" ]]; then
  echo "SDK layout unexpected: could not find ESP32 release libs (lib_bmv080.a + lib_postProcessor.a)." >&2
  echo "Looked under:" >&2
  echo "  $SDK_ROOT/api/lib/xtensa_esp32/..." >&2
  echo "  $SDK_ROOT/api/api/lib/xtensa_esp32/..." >&2
  exit 1
fi

mkdir -p "$DEST_HDR" "$DEST_ESP32"
cp -v "$HDR_SRC/bmv080.h" "$DEST_HDR/"
cp -v "$HDR_SRC/bmv080_defs.h" "$DEST_HDR/"
cp -v "$ESP32_SRC/lib_bmv080.a" "$ESP32_SRC/lib_postProcessor.a" "$DEST_ESP32/"

echo "Installed Bosch BMV080 SDK files into: $LIB_DIR"
