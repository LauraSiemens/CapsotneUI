# Pre-build: SparkFun BMV080 needs Bosch SDK headers/libs copied into the library tree.
Import("env")  # noqa: N816 — SCons/PlatformIO convention

from pathlib import Path

from SCons.Script import Exit  # type: ignore[import-untyped]


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
