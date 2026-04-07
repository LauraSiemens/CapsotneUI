# Pre-build: SparkFun BMV080 needs Bosch SDK headers/libs copied into the library tree.
Import("env")  # noqa: N816 — SCons/PlatformIO convention

import shutil
from pathlib import Path

from SCons.Script import Exit  # type: ignore[import-untyped]


def _try_sync_from_parent_repo(child_sparkfun: Path, pioenv: str) -> bool:
    """
    If this env is a subfolder (e.g. battery_test/) and the repo root already has
    the Bosch SDK in .pio/libdeps, copy headers + esp32 .a into this project's copy.
    """
    project_dir = child_sparkfun.parent.parent.parent.parent  # .../libdeps/esp32dev -> project
    parent_sparkfun = (
        project_dir.parent
        / ".pio"
        / "libdeps"
        / pioenv
        / "SparkFun BMV080 Arduino Library"
    )
    parent_hdr = parent_sparkfun / "src" / "sfTk" / "bmv080.h"
    if not parent_hdr.is_file():
        return False

    dst_sf = child_sparkfun / "src" / "sfTk"
    dst_sf.mkdir(parents=True, exist_ok=True)
    for name in ("bmv080.h", "bmv080_defs.h"):
        src = parent_sparkfun / "src" / "sfTk" / name
        if src.is_file():
            shutil.copy2(src, dst_sf / name)

    src_esp = parent_sparkfun / "src" / "esp32"
    dst_esp = child_sparkfun / "src" / "esp32"
    if src_esp.is_dir():
        dst_esp.mkdir(parents=True, exist_ok=True)
        for lib in ("lib_bmv080.a", "lib_postProcessor.a"):
            p = src_esp / lib
            if p.is_file():
                shutil.copy2(p, dst_esp / lib)

    return (child_sparkfun / "src" / "sfTk" / "bmv080.h").is_file()


def main() -> None:
    project_dir = Path(env["PROJECT_DIR"])
    pioenv = env.subst("$PIOENV")
    sparkfun = (
        project_dir
        / ".pio"
        / "libdeps"
        / pioenv
        / "SparkFun BMV080 Arduino Library"
    )
    header = sparkfun / "src" / "sfTk" / "bmv080.h"

    if not sparkfun.is_dir():
        return

    if header.is_file():
        return

    if _try_sync_from_parent_repo(sparkfun, pioenv) and header.is_file():
        print()
        print(
            "BMV080 SDK: copied from parent repo .pio/libdeps into this project's library."
        )
        print()
        return

    print()
    print("=" * 72)
    print("BUILD STOPPED: Bosch BMV080 SDK is not installed in the SparkFun library.")
    print()
    print("  1) Download the BMV080 SDK from Bosch Sensortec (BMV080 product page).")
    print("  2) From the project folder, run:")
    print(
        '       ./scripts/install_bmv080_sdk.sh "/path/to/extracted/bmv080_sdk"',
    )
    print("     Or set SPARKFUN_BMV080_LIB to your library path if it lives elsewhere.")
    print()
    print("  Expected after install:", header)
    print("=" * 72)
    print()
    Exit(1)


main()
