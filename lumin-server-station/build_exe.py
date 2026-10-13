"""Build script to compile Lumin Server Station into a standalone Windows executable."""

import sys
import shutil
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

def build():
    print("=" * 60)
    print("  BUILDING LUMIN SERVER STATION STANDALONE EXECUTABLE")
    print("=" * 60)

    pyinstaller_cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name", "LuminServerStation",
        "--distpath", str(BASE_DIR),
        "--workpath", str(BASE_DIR / "build"),
        "--specpath", str(BASE_DIR),
        "--collect-all", "customtkinter",
        "--collect-all", "PIL",
        "--collect-all", "flask",
        "--collect-all", "flask_cors",
        "--collect-all", "werkzeug",
        "--collect-all", "jinja2",
        "--collect-all", "pystray",
        "--add-data", f"{BASE_DIR / 'config.json'};.",
        "--add-data", f"{BASE_DIR / 'station_config.json'};.",
        "--add-data", f"{BASE_DIR / 'cloudflared.exe'};.",
        "--add-data", f"{BASE_DIR / 'file_sync.py'};.",
        "--add-data", f"{BASE_DIR / 'server.py'};.",
        "--add-data", f"{BASE_DIR / 'tunnel_sync.py'};.",
        "--add-data", f"{BASE_DIR / 'tailscale_access.py'};.",
        str(BASE_DIR / "manager_app.py")
    ]

    print(f"Running PyInstaller in: {BASE_DIR}")
    result = subprocess.run(pyinstaller_cmd, cwd=str(BASE_DIR))
    if result.returncode == 0:
        dist_dir = BASE_DIR / "LuminServerStation"
        for fname in ["config.json", "station_config.json"]:
            src = BASE_DIR / fname
            dst = dist_dir / fname
            if src.exists() and not dst.exists():
                shutil.copy2(str(src), str(dst))
        print("\n[SUCCESS] LuminServerStation built successfully!")
    else:
        print(f"\n[ERROR] Build failed with exit code {result.returncode}")
    return result.returncode

if __name__ == "__main__":
    sys.exit(build())
