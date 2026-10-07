"""Build a portable EXE using the current storage-server sources, without config."""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

BASE = Path(__file__).resolve().parent
SERVER = BASE.parent / "storage-server"
OUTPUT = BASE / "release"


def current_defaults():
    """Copy operational defaults, never the clinic key or runtime paths."""
    tree = ast.parse((SERVER / "server.py").read_text(encoding="utf-8"))
    defaults = next(ast.literal_eval(node.value) for node in tree.body
                    if isinstance(node, ast.Assign) and any(
                        isinstance(target, ast.Name) and target.id == "DEFAULT_CONFIG" for target in node.targets))
    path = SERVER / "config.json"
    if path.exists():
        defaults.update(json.loads(path.read_text(encoding="utf-8-sig")))
    return {name: defaults[name] for name in ("port", "max_file_size_mb", "allowed_extensions")}


def main():
    defaults_path = BASE / "server-defaults.json"
    defaults_path.write_text(json.dumps(current_defaults(), indent=2) + "\n", encoding="utf-8")
    sources = (BASE / "app.py", defaults_path, SERVER / "server.py", SERVER / "file_sync.py",
               SERVER / "tailscale_access.py", SERVER / "clinical_metadata.py",
               BASE.parent / "icons/dental-icon-v1-32.png")
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=BASE, text=True).strip()
    command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
               "--name", "LuminStorageSetup", "--distpath", str(OUTPUT),
               "--workpath", str(BASE / "build"), "--specpath", str(BASE / "build"),
               "--paths", str(SERVER), "--collect-data", "customtkinter",
               "--hidden-import", "pystray._win32",
               "--add-data", str(BASE.parent / "icons/dental-icon-v1-32.png") + os.pathsep + ".",
               "--add-data", str(defaults_path) + os.pathsep + ".", str(BASE / "app.py")]
    subprocess.run(command, cwd=BASE, check=True)
    if hashes != {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}:
        raise RuntimeError("Server sources changed during the build. Rebuild before distributing.")
    shutil.copyfile(BASE / "README.md", OUTPUT / "READ-ME.md")
    manifest = {"serverRevision": revision, "syncProtocol": 1, "clinicalMetadataVersion": 2,
                "defaults": current_defaults(), "sources": hashes}
    executable = OUTPUT / "LuminStorageSetup.exe"
    for flag, name in (("--self-test-output", "server-verification.json"), ("--ui-test-output", "ui-verification.json")):
        report = OUTPUT / name
        report.unlink(missing_ok=True)
        subprocess.run([str(executable), flag, str(report)], check=True, timeout=120)
        if not json.loads(report.read_text(encoding="utf-8"))["ok"]:
            raise RuntimeError("Packaged verification failed: " + name)
    manifest["executableSHA256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    manifest["verified"] = {"server": True, "englishArabicUI": True, "clinicalMetadata": True, "localMediaMetadata": True,
                            "trayToggle": True, "trayReopenAndQuit": True}
    (OUTPUT / "build-info.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    with zipfile.ZipFile(BASE / "LuminStorageSetup.zip", "w", zipfile.ZIP_DEFLATED) as package:
        for name in ("LuminStorageSetup.exe", "READ-ME.md", "build-info.json"):
            package.write(OUTPUT / name, "LuminStorageSetup/" + name)
    # Existing Python installations keep their own config and identity. Never
    # distribute the current clinic config, .venv, patient data or runtime state.
    with zipfile.ZipFile(BASE / "LuminStorageServerUpdate.zip", "w", zipfile.ZIP_DEFLATED) as package:
        for name in ("server.py", "file_sync.py", "clinical_metadata.py", "tailscale_access.py", "README.md"):
            package.write(SERVER / name, "storage-server/" + name)
        package.write(OUTPUT / "build-info.json", "build-info.json")
    # Keep the existing README download link current, with its original flat
    # layout for extraction directly into an existing server installation.
    with zipfile.ZipFile(SERVER / "lumin-storage-sync-update.zip", "w", zipfile.ZIP_DEFLATED) as package:
        for name in ("server.py", "file_sync.py", "clinical_metadata.py", "tailscale_access.py", "README.md"):
            package.write(SERVER / name, name)
    with zipfile.ZipFile(BASE / "LuminStorageWebUpdate.zip", "w", zipfile.ZIP_DEFLATED) as package:
        for name in ("index.html", "lumin-storage-sync.js", "lumin-storage-sync.css", "lumin-chart-media.js", "lumin-patient-scans.js", "sw.js", "app-version.json"):
            package.write(BASE.parent / name, name)
    print("Built " + str(OUTPUT / "LuminStorageSetup.exe"))


if __name__ == "__main__":
    main()
