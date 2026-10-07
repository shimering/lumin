"""Portable Windows launcher for the current Lumin storage server.

The executable contains code only. Configuration and sync identity belong to
this Windows computer, outside the directory users copy to another computer.
"""

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.parse
import urllib.error
import uuid
import webbrowser

APP_URL = "https://lumin.gazarxperia.workers.dev/#admin"
SERVICE = "Lumin Local Storage Server"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
SERVER_DEFAULTS = json.loads((RESOURCE_ROOT / "server-defaults.json").read_text(encoding="utf-8"))
EXTENSIONS = SERVER_DEFAULTS["allowed_extensions"]
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "LuminStorageSetup"


def machine_id():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography",
                            0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
            return winreg.QueryValueEx(key, "MachineGuid")[0]
    except (ImportError, OSError):
        return socket.gethostname() + ":" + str(uuid.getnode())


def state_directory():
    profile = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    computer = hashlib.sha256(machine_id().encode()).hexdigest()[:16]
    return profile / "LuminStorageSetup" / computer


def default_storage():
    if Path("D:/").is_dir():
        return Path("D:/LuminStorage/Patients")
    return state_directory() / "Patients"


def make_config(directory, storage, key, port=None, max_file_size_mb=None, existing=None):
    root = Path(storage).expanduser().resolve()
    dataset = hashlib.sha256(os.path.normcase(str(root)).encode()).hexdigest()[:16]
    config = {**SERVER_DEFAULTS, **(existing or {})}
    same_root = os.path.normcase(str(root)) == os.path.normcase(str(config.get("storage_path", "")))
    sync_state = config.get("sync_state_path") if same_root else None
    config.update(storage_path=str(root), fallback_storage_path=str(root), clinic_secret_key=key,
                  sync_state_path=sync_state or str(Path(directory) / "sync" / dataset))
    if port is not None:
        config["port"] = int(port)
    if max_file_size_mb is not None:
        config["max_file_size_mb"] = int(max_file_size_mb)
    if not 0 <= int(config["port"]) <= 65535 or int(config["max_file_size_mb"]) <= 0:
        raise ValueError("Invalid server port or upload limit.")
    return config


def read_existing_config(path):
    """Import server settings only; another computer's sync identity stays there."""
    path = Path(path).resolve()
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict) or not isinstance(value.get("storage_path"), str) or not value["storage_path"].strip():
        raise ValueError("Select a storage server config.json with a patient folder.")
    config = {name: value[name] for name in (*SERVER_DEFAULTS, "clinic_secret_key", "storage_path") if name in value}
    config = {**SERVER_DEFAULTS, **config}
    root = Path(os.path.expandvars(config["storage_path"])).expanduser()
    config["storage_path"] = str((path.parent / root).resolve())
    config["port"] = int(config["port"])
    config["max_file_size_mb"] = int(config["max_file_size_mb"])
    if not 1 <= config["port"] <= 65535 or config["max_file_size_mb"] <= 0:
        raise ValueError("Invalid server port or upload limit.")
    if not isinstance(config["allowed_extensions"], list) or not all(isinstance(ext, str) and ext.isalnum() for ext in config["allowed_extensions"]):
        raise ValueError("Invalid allowed extensions.")
    if not isinstance(config.get("clinic_secret_key", ""), str):
        raise ValueError("Invalid clinic key.")
    return config


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def launch_command(*arguments):
    if getattr(sys, "frozen", False):
        return [sys.executable, *arguments]
    return [sys.executable, str(Path(__file__).resolve()), *arguments]


def configure_startup(enabled, directory, executable=None, registry=None):
    """Register this user's app, keeping the portable EXE in a stable location.

    Versions have separate paths so an update never overwrites a running EXE.
    The Windows Run command contains only the executable path and --autostart.
    """
    if registry is None:
        import winreg as registry
    command = None
    if enabled:
        if executable is not None or getattr(sys, "frozen", False):
            source = Path(executable or sys.executable).resolve()
            version = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
            destination = Path(directory) / "app" / version / "LuminStorageSetup.exe"
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source != destination.resolve() and not destination.exists():
                temporary = destination.with_suffix(".tmp")
                shutil.copyfile(source, temporary)
                os.replace(temporary, destination)
            command = subprocess.list2cmdline([str(destination), "--autostart"])
        else:
            command = subprocess.list2cmdline(launch_command("--autostart"))
    with registry.CreateKeyEx(registry.HKEY_CURRENT_USER, RUN_KEY, 0, registry.KEY_SET_VALUE) as key:
        if enabled:
            registry.SetValueEx(key, RUN_NAME, 0, registry.REG_SZ, command)
        else:
            try:
                registry.DeleteValue(key, RUN_NAME)
            except FileNotFoundError:
                pass
    return command


def acquire_instance_lock(directory):
    """Hold a local file lock for this computer's GUI, without locking child servers."""
    handle = (Path(directory) / "app.lock").open("a+b")
    handle.seek(0, 2)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def load_server(config_path):
    os.environ["LUMIN_STORAGE_CONFIG"] = str(config_path)
    # Source development uses the same files as the main server. PyInstaller
    # includes these modules through --paths; no private config is packaged.
    if not getattr(sys, "frozen", False):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "storage-server"))
    import server
    return server


def serve(config_path, ready_path):
    config_path = Path(config_path).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if not config.get("clinic_secret_key"):
        raise ValueError("A clinic key is required.")
    logging.basicConfig(filename=config_path.parent / "server.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", force=True)
    module = load_server(config_path)
    from werkzeug.serving import make_server
    host = make_server("0.0.0.0", int(config.get("port", 5000)), module.app, threaded=True)
    stop_path = Path(ready_path).with_suffix(".stop")
    finished = threading.Event()

    def watch_stop():
        while not finished.wait(.2):
            if stop_path.exists():
                host.shutdown()
                return

    try:
        # Create a new identity on first launch, before accepting pairing.
        engine = module.get_sync_engine()
        write_json(ready_path, {"port": host.server_port, "nodeId": engine.node_id,
                               "storageRoot": str(module.STORAGE_ROOT)})
        threading.Thread(target=watch_stop, daemon=True).start()
        host.serve_forever()
    finally:
        finished.set()
        host.server_close()
        Path(ready_path).unlink(missing_ok=True)
        stop_path.unlink(missing_ok=True)
        logging.shutdown()


def terminate_process_tree(process):
    if process and process.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=10)
        else:
            process.kill()
        process.wait(timeout=6)


def stop_process(process, ready_path=None):
    if process and process.poll() is None:
        if ready_path:
            Path(ready_path).with_suffix(".stop").touch()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            # Windows venv and one-file EXE launchers can have a child PID.
            terminate_process_tree(process)


def self_test(output):
    """Test the packaged child process using disposable files and port 0 only."""
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"ok": False}
    process = None
    ready = None
    workspace = None
    try:
        workspace = tempfile.TemporaryDirectory(prefix="lumin-setup-test-", dir=output.parent, ignore_cleanup_errors=True)
        with workspace as temporary:
            directory = Path(temporary)
            storage = directory / "patients"
            scan = storage / "مريض_اختبار" / "3D-Scans" / "original scan.zip"
            scan.parent.mkdir(parents=True)
            import io
            import zipfile
            from PIL import Image
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("scan.stl", "disposable scan fixture")
            scan.write_bytes(archive.getvalue())
            image = storage / "مريض_اختبار" / "X-Rays" / "image.png"
            image.parent.mkdir()
            Image.new("RGB", (8, 8), "white").save(image)
            metadata = storage / "مريض_اختبار" / "patient_media_details.json"
            metadata.write_text('{"test": true}', encoding="utf-8")
            config_path = directory / "config.json"
            config = make_config(directory, storage, "disposable-test-key", port=0)
            write_json(config_path, config)
            ready = directory / "ready.json"
            process = subprocess.Popen(launch_command("--serve", "--config", str(config_path),
                                                     "--ready-file", str(ready)),
                                       creationflags=CREATE_NO_WINDOW)
            deadline = time.monotonic() + 45
            while not ready.exists():
                if process.poll() is not None:
                    raise RuntimeError("Packaged server exited before starting.")
                if time.monotonic() > deadline:
                    raise TimeoutError("Packaged server did not start.")
                time.sleep(.1)
            status = json.loads(ready.read_text(encoding="utf-8"))
            url = "http://127.0.0.1:" + str(status["port"])
            with urllib.request.urlopen(url + "/api/health", timeout=8) as response:
                health = json.load(response)
            assert health["status"] == "online" and health["service"] == SERVICE
            assert Path(health["storageRoot"]) == storage.resolve()
            for path in (scan, image):
                request = urllib.request.Request(url + "/files/" + urllib.parse.quote(
                    path.relative_to(storage).as_posix()), headers={"x-lumin-key": "disposable-test-key"})
                with urllib.request.urlopen(request, timeout=8) as response:
                    assert response.read() == path.read_bytes(), "Original file bytes changed."
            # Auth remains required; setup does not introduce an admin bypass.
            try:
                urllib.request.urlopen(url + "/api/sync/info", timeout=8)
                raise AssertionError("Unprotected sync endpoint.")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            pid = '12345678-1234-4234-8234-123456789abc'
            rel = image.relative_to(storage).as_posix()
            request = urllib.request.Request(url + '/api/patient/' + pid + '/media-details', method='POST',
                headers={'x-lumin-key': 'disposable-test-key', 'Content-Type': 'application/json'},
                data=json.dumps(dict(relativePath=rel, patientName='مريض اختبار', patientNumber=1042,
                                     details=dict(tooth_ids=['3', 'A'], note='Local packaged annotation'))).encode())
            with urllib.request.urlopen(request, timeout=8) as response:
                saved = json.load(response)
            assert saved['metadataSource'] == 'local' and saved['details']['tooth_ids'] == ['3', 'A']
            request = urllib.request.Request(url + '/api/patient/' + pid + '/files',
                                             headers={'x-lumin-key': 'disposable-test-key'})
            with urllib.request.urlopen(request, timeout=8) as response:
                listing = json.load(response)
            assert listing['metadataSource'] == 'local'
            assert next(f for f in listing['files'] if f['relativePath'] == rel)['mediaDetails']['note'] == 'Local packaged annotation'
            stop_process(process, ready)
            process = None
            # Verify the same bundled engine includes files and excludes metadata.
            module = load_server(config_path)
            engine = module.get_sync_engine()
            records = engine.scan()
            assert scan.relative_to(storage).as_posix().casefold() in records
            assert image.relative_to(storage).as_posix().casefold() in records
            assert metadata.relative_to(storage).as_posix().casefold() not in records
            assert json.loads(metadata.read_text(encoding='utf-8'))['files']['X-Rays/image.png']['tooth_ids'] == ['3', 'A']
            # Verify clinical metadata is bundled and survives a restart without
            # changing original image bytes or replicating generated JSON files.
            pid = '12345678-1234-4234-8234-123456789abc'
            rel = image.relative_to(storage).as_posix()
            snapshot = dict(version=1, patients=[dict(id=pid, name='مريض اختبار', patient_number=1042)],
                            files=[dict(patient_id=pid, relative_path=rel, tooth_ids=['14', '15'],
                                        display_name='Test image', note='Packaged metadata test',
                                        scan_date='2026-10-07', scan_config={'rotation': 90})])
            engine.clinical.replace(snapshot)
            assert engine.clinical.details(rel)['patient_id'] == pid
            assert engine.clinical.details(rel)['tooth_ids'] == ['14', '15']
            module.update_storage_mapping_files()
            mapping = json.loads((storage / 'patients_mapping.json').read_text(encoding='utf-8'))
            mapped = next(f for f in mapping['files'] if f['relative_path'] == rel)
            assert mapped['tooth_ids'] == ['14', '15']
            assert mapped['scan_config'] == {'rotation': 90}
            from file_sync import SyncEngine, PROTOCOL
            other = SyncEngine(directory / "other-patients", directory / "other-sync", EXTENSIONS)
            assert other.node_id != status["nodeId"]
            assert engine.node_id == status["nodeId"], "Restart must preserve this computer's identity."
            result = {"ok": True, "health": True, "originalImageAndZipBytes": True,
                      "metadataExcluded": True, "clinicalMetadata": True, "localMediaMetadata": True, "authRequired": True,
                      "independentIdentity": True, "stableIdentity": True, "syncProtocol": PROTOCOL,
                      "patient3dScans": health["capabilities"]["patient3dScans"],
                      "scanOriginalFilenames": health["capabilities"]["scanOriginalFilenames"],
                      "syncConflictChoices": health["capabilities"]["syncConflictChoices"],
                      "syncDeletionReview": health["capabilities"]["syncDeletionReview"],
                      "maxFileSizeMB": health["maxFileSizeMB"]}
    except Exception as error:
        result["error"] = type(error).__name__ + ": " + str(error)
    finally:
        stop_process(process, ready)
        logging.shutdown()
        if workspace:
            workspace.cleanup()
        write_json(output, result)
    return 0 if result["ok"] else 1


TEXT = {
    "title": ("Lumin Storage Setup", "إعداد خادم التخزين — Lumin"),
    "subtitle": ("Connect this computer to your clinic's patient files.", "اربط هذا الكمبيوتر بملفات المرضى في العيادة."),
    "folder": ("Patient files folder", "مجلد ملفات المرضى"),
    "browse": ("Choose folder", "اختر المجلد"),
    "folder_hint": ("Select the existing Patients folder on this computer.", "اختر مجلد المرضى الموجود على هذا الكمبيوتر."),
    "import_config": ("Load existing server settings", "تحميل إعدادات الخادم الموجود"),
    "import_ok": ("Settings loaded. Check the patient folder, then start the server.", "تم تحميل الإعدادات. تحقق من مجلد المرضى ثم شغّل الخادم."),
    "import_error": ("Could not load these settings. Select the old storage server's config.json.", "تعذّر تحميل الإعدادات. اختر ملف config.json الخاص بخادم التخزين القديم."),
    "port": ("Server port", "منفذ الخادم"),
    "upload_limit": ("Upload limit (MB)", "الحد الأقصى للرفع (ميجابايت)"),
    "settings_error": ("Enter a port from 1 to 65535 and a positive upload limit.", "أدخل منفذًا من 1 إلى 65535 وحدًا موجبًا لحجم الرفع."),
    "key": ("Clinic key", "مفتاح العيادة"),
    "key_hint": ("Use the same key saved for this server in Lumin Admin.", "استخدم المفتاح المحفوظ لهذا الخادم في لوحة إدارة Lumin."),
    "show": ("Show", "إظهار"), "hide": ("Hide", "إخفاء"),
    "start": ("Start server", "تشغيل الخادم"), "stop": ("Stop server", "إيقاف الخادم"),
    "starting": ("Starting server…", "جارٍ تشغيل الخادم…"),
    "stopping": ("Stopping server…", "جارٍ إيقاف الخادم…"),
    "offline": ("Server stopped", "الخادم متوقف"), "online": ("Server running", "الخادم يعمل"),
    "copy": ("Copy address", "نسخ العنوان"), "copied": ("Address copied", "تم نسخ العنوان"),
    "remote": ("Enable remote access", "تفعيل الوصول عن بُعد"),
    "remote_wait": ("Checking remote access…", "جارٍ فحص الوصول عن بُعد…"),
    "remote_ok": ("Remote access verified. Save this HTTPS address in Lumin.", "تم التحقق من الوصول عن بُعد. احفظ عنوان HTTPS في Lumin."),
    "remote_missing": ("Install Tailscale and sign in on this computer, then try again.", "ثبّت Tailscale وسجّل الدخول على هذا الكمبيوتر، ثم حاول مرة أخرى."),
    "remote_failed": ("Remote setup failed. Check Tailscale and view the setup log.", "تعذّر إعداد الوصول عن بُعد. تحقق من Tailscale وافتح سجل الإعداد."),
    "web": ("Open Lumin Admin", "فتح إدارة Lumin"), "log": ("View log", "عرض السجل"),
    "help": ("Keep this app open while using the server. In Lumin Admin, save this computer's HTTPS address and clinic key, then pair the two servers.", "اترك التطبيق مفتوحًا أثناء استخدام الخادم. في إدارة Lumin، احفظ عنوان HTTPS لهذا الكمبيوتر ومفتاح العيادة، ثم اربط الخادمين."),
    "scope": ("Sync includes images, documents and original 3D scan ZIP files. Each computer creates its own sync identity.", "تشمل المزامنة الصور والمستندات وملفات ZIP الأصلية للمسح ثلاثي الأبعاد. لكل كمبيوتر هوية مزامنة مستقلة."),
    "key_required": ("Enter the clinic key before starting.", "أدخل مفتاح العيادة قبل التشغيل."),
    "folder_required": ("Choose the patient files folder before starting.", "اختر مجلد ملفات المرضى قبل التشغيل."),
    "folder_error": ("This folder cannot be used. Choose a writable patient folder.", "لا يمكن استخدام هذا المجلد. اختر مجلد مرضى يسمح بالكتابة."),
    "port_busy": ("The selected port is already in use. Stop the old storage server, then start this app.", "المنفذ المحدد مستخدم بالفعل. أوقف خادم التخزين القديم، ثم شغّل هذا التطبيق."),
    "failed": ("The server could not start. View the log for details.", "تعذّر تشغيل الخادم. افتح السجل للاطلاع على التفاصيل."),
    "unexpected_stop": ("The server stopped unexpectedly. View the log and start it again.", "توقف الخادم بشكل غير متوقع. افتح السجل ثم شغّله مرة أخرى."),
    "startup": ("Start with Windows and connect automatically", "التشغيل مع Windows والاتصال تلقائيًا"),
    "startup_hint": ("After Windows sign-in, starts the server minimized and enables remote access using your saved settings.", "بعد تسجيل الدخول إلى Windows، يشغّل الخادم مصغّرًا ويفعّل الوصول عن بُعد باستخدام الإعدادات المحفوظة."),
    "startup_failed": ("Could not save the startup setting. View the log and try again.", "تعذّر حفظ إعداد التشغيل التلقائي. افتح السجل وحاول مرة أخرى."),
    "tray": ("Minimize to tray", "التصغير إلى منطقة الإعلام"),
    "tray_hint": ("Keep the server running quietly when minimized or closed. Use the tray icon to reopen the app or quit.", "يستمر الخادم بالعمل بصمت عند تصغير النافذة أو إغلاقها. استخدم أيقونة منطقة الإعلام لإعادة فتح التطبيق أو إنهائه."),
    "tray_open": ("Open Lumin Storage Setup", "فتح إعداد خادم Lumin"),
    "tray_quit": ("Quit and stop server", "إنهاء التطبيق وإيقاف الخادم"),
    "tray_failed": ("Could not enable the tray icon. The app will stay visible. View the setup log and try again.", "تعذر تفعيل أيقونة منطقة الإعلام. سيبقى التطبيق ظاهرًا. افتح سجل الإعداد وحاول مرة أخرى."),
    "remote_retry": ("Waiting for internet or Tailscale. Remote access will retry automatically.", "في انتظار الإنترنت أو Tailscale. ستتم إعادة محاولة الاتصال تلقائيًا."),
    "already_running": ("Lumin Storage Setup is already running. Open it from the taskbar or tray icon. Quit it before opening an updated version.", "تطبيق إعداد خادم Lumin يعمل بالفعل. افتحه من شريط المهام أو أيقونة منطقة الإعلام، وأنهِ التطبيق قبل فتح إصدار جديد."),
}


def gui(test_output=None, autostart=False):
    import customtkinter as ctk
    from tkinter import filedialog, messagebox
    ctk.set_appearance_mode("light")
    ctk.set_default_color_theme("blue")
    workspace = tempfile.TemporaryDirectory(prefix="lumin-setup-ui-") if test_output else None
    directory = Path(workspace.name) if workspace else state_directory()
    directory.mkdir(parents=True, exist_ok=True)
    instance_lock = acquire_instance_lock(directory)
    if instance_lock is None:
        if not autostart:
            messagebox.showinfo(TEXT["title"][0], TEXT["already_running"][0])
        if workspace:
            workspace.cleanup()
        return

    class Setup(ctk.CTk):
        def __init__(self):
            super().__init__()
            if test_output:
                self.withdraw()
            self.directory = directory
            self.config_path = self.directory / "config.json"
            self.settings_path = self.directory / "settings.json"
            self.settings = {}
            try:
                self.settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, AttributeError):
                pass
            if not isinstance(self.settings, dict):
                self.settings = {}
            self.startup_enabled = self.settings.get("startupConnect") is True
            self.tray_enabled = self.settings.get("minimizeToTray") is True
            self.tray_icon = None
            self.tray_ready = False
            self.tray_hide_pending = False
            self.auto_remote_active = self.startup_enabled
            self.remote_retry = None
            self.remote_attempts = 0
            self.language = "en"
            self.process = None
            self.ready = None
            self.events = queue.Queue()
            self.busy = False
            self.remote_busy = False
            self.remote_process = None
            self.message_key = "offline"
            self.address = ""
            self.key_visible = False
            self.closing = threading.Event()
            self.lifecycle_lock = threading.Lock()
            saved = {}
            try:
                saved = json.loads(self.config_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            if not isinstance(saved, dict):
                saved = {}
            self.saved_config = saved
            self.port = int(saved.get("port", SERVER_DEFAULTS["port"]))
            available_height = int(self.winfo_screenheight() / self._get_window_scaling()) - 100
            self.geometry("760x" + str(max(660, min(820, available_height))))
            self.minsize(660, 660)
            self.configure(fg_color="#f1f5f9")
            self.protocol("WM_DELETE_WINDOW", self.close)
            self.grid_columnconfigure(0, weight=1)
            self.grid_rowconfigure(1, weight=1)
            header = ctk.CTkFrame(self, fg_color="transparent")
            header.grid(row=0, column=0, sticky="ew", padx=28, pady=(24, 12))
            header.grid_columnconfigure(0, weight=1)
            self.heading = ctk.CTkLabel(header, font=("Segoe UI", 24, "bold"), text_color="#0f172a", anchor="w")
            self.heading.grid(row=0, column=0, sticky="ew")
            self.toggle = self.button(header, "العربية", self.toggle_language, secondary=True, width=92)
            self.toggle.grid(row=0, column=1, padx=(12, 0))
            self.subtitle = ctk.CTkLabel(header, text_color="#64748b", font=("Segoe UI", 14), anchor="w")
            self.subtitle.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(8, 0))
            card = ctk.CTkScrollableFrame(self, fg_color="#ffffff", corner_radius=20)
            card.grid(row=1, column=0, sticky="nsew", padx=28, pady=(4, 16))
            card.grid_columnconfigure(0, weight=1)
            self.folder_label = self.label(card, "folder", row=0, bold=True, pady=(18, 8))
            folder_row = ctk.CTkFrame(card, fg_color="transparent")
            folder_row.grid(row=1, column=0, sticky="ew", padx=22)
            folder_row.grid_columnconfigure(0, weight=1)
            self.folder = self.entry(folder_row)
            self.folder.grid(row=0, column=0, sticky="ew")
            self.folder.insert(0, saved.get("storage_path", str(default_storage())))
            self.browse = self.button(folder_row, "", self.choose_folder, secondary=True, width=140)
            self.browse.grid(row=0, column=1, padx=(12, 0))
            self.folder_hint = self.label(card, "folder_hint", row=2, muted=True, pady=(8, 18))
            settings_card = ctk.CTkFrame(card, fg_color="#f8fafc", corner_radius=14)
            settings_card.grid(row=6, column=0, sticky="ew", padx=22, pady=(0, 20))
            settings_card.grid_columnconfigure((0, 1), weight=1)
            self.import_button = self.button(settings_card, "", self.import_config, secondary=True)
            self.import_button.grid(row=0, column=0, columnspan=2, sticky="ew", padx=16, pady=(16, 8))
            self.port_label = ctk.CTkLabel(settings_card, text="", anchor="w", text_color="#334155")
            self.port_label.grid(row=1, column=0, sticky="ew", padx=16, pady=(8, 4))
            self.limit_label = ctk.CTkLabel(settings_card, text="", anchor="w", text_color="#334155")
            self.limit_label.grid(row=1, column=1, sticky="ew", padx=16, pady=(8, 4))
            self.port_entry = self.entry(settings_card)
            self.port_entry.grid(row=2, column=0, sticky="ew", padx=16, pady=(0, 16))
            self.port_entry.insert(0, str(self.port))
            self.limit_entry = self.entry(settings_card)
            self.limit_entry.grid(row=2, column=1, sticky="ew", padx=16, pady=(0, 16))
            self.limit_entry.insert(0, str(saved.get("max_file_size_mb", SERVER_DEFAULTS["max_file_size_mb"])))
            self.key_label = self.label(card, "key", row=3, bold=True, pady=(0, 8))
            key_row = ctk.CTkFrame(card, fg_color="transparent")
            key_row.grid(row=4, column=0, sticky="ew", padx=22)
            key_row.grid_columnconfigure(0, weight=1)
            self.key = self.entry(key_row, show="•")
            self.key.grid(row=0, column=0, sticky="ew")
            self.key.insert(0, saved.get("clinic_secret_key", ""))
            self.show_key = self.button(key_row, "", self.toggle_key, secondary=True, width=140)
            self.show_key.grid(row=0, column=1, padx=(12, 0))
            self.key_hint = self.label(card, "key_hint", row=5, muted=True, pady=(8, 22))
            startup_card = ctk.CTkFrame(card, fg_color="#f8fafc", corner_radius=14)
            startup_card.grid(row=7, column=0, sticky="ew", padx=22, pady=(0, 20))
            startup_card.grid_columnconfigure(0, weight=1)
            self.startup_switch = ctk.CTkSwitch(startup_card, text="", command=self.on_startup_change,
                                              height=44, switch_width=44, switch_height=24,
                                              font=("Segoe UI", 13, "bold"), text_color="#334155",
                                              progress_color="#2563eb", button_color="#ffffff",
                                              button_hover_color="#dbeafe", fg_color="#cbd5e1")
            self.startup_switch.grid(row=0, column=0, sticky="ew", padx=16, pady=(8, 0))
            if self.startup_enabled:
                self.startup_switch.select()
            self.startup_hint = ctk.CTkLabel(startup_card, text="", anchor="w", justify="left",
                                            wraplength=530, font=("Segoe UI", 13), text_color="#64748b")
            self.startup_hint.grid(row=1, column=0, sticky="ew", padx=16, pady=(0, 16))
            self.tray_switch = ctk.CTkSwitch(startup_card, text="", command=self.on_tray_change,
                                            height=44, switch_width=44, switch_height=24,
                                            font=("Segoe UI", 13, "bold"), text_color="#334155",
                                            progress_color="#2563eb", button_color="#ffffff",
                                            button_hover_color="#dbeafe", fg_color="#cbd5e1")
            self.tray_switch.grid(row=2, column=0, sticky="ew", padx=16, pady=(0, 0))
            if self.tray_enabled:
                self.tray_switch.select()
            self.tray_hint = ctk.CTkLabel(startup_card, text="", anchor="w", justify="left",
                                        wraplength=530, font=("Segoe UI", 13), text_color="#64748b")
            self.tray_hint.grid(row=3, column=0, sticky="ew", padx=16, pady=(0, 16))
            self.start_button = self.button(card, "", self.start_or_stop)
            self.start_button.grid(row=8, column=0, sticky="ew", padx=22)
            status_card = ctk.CTkFrame(card, fg_color="#f8fafc", corner_radius=14)
            status_card.grid(row=9, column=0, sticky="ew", padx=22, pady=(20, 16))
            status_card.grid_columnconfigure(0, weight=1)
            self.status = ctk.CTkLabel(status_card, font=("Segoe UI", 14, "bold"), text_color="#64748b",
                                       anchor="w", justify="left", wraplength=565)
            self.status.grid(row=0, column=0, sticky="ew", padx=16, pady=(14, 8))
            self.address_label = ctk.CTkLabel(status_card, text="", font=("Consolas", 13), text_color="#334155",
                                              anchor="w", wraplength=565)
            self.address_label.grid(row=1, column=0, sticky="ew", padx=16)
            self.copy_button = self.button(status_card, "", self.copy_address, secondary=True)
            self.copy_button.grid(row=2, column=0, sticky="ew", padx=16, pady=(10, 14))
            self.remote_button = self.button(card, "", self.enable_remote, secondary=True)
            self.remote_button.grid(row=10, column=0, sticky="ew", padx=22)
            self.help_label = self.label(card, "help", row=11, muted=True, pady=(14, 18))
            self.scope_label = self.label(card, "scope", row=12, muted=True, pady=(0, 18))
            footer = ctk.CTkFrame(self, fg_color="transparent")
            footer.grid(row=2, column=0, sticky="ew", padx=28, pady=(0, 24))
            footer.grid_columnconfigure(0, weight=1)
            self.web_button = self.button(footer, "", lambda: webbrowser.open(APP_URL), secondary=True)
            self.web_button.grid(row=0, column=0, sticky="ew")
            self.log_button = self.button(footer, "", self.view_log, secondary=True, width=120)
            self.log_button.grid(row=0, column=1, padx=(12, 0))
            self.bind("<Configure>", self.fit_labels)
            self.bind("<Unmap>", self.on_minimize)
            self.translate()
            self.after(150, self.poll)
            if self.startup_enabled and not test_output:
                # Refresh the installed version when an updated portable EXE is
                # opened. A failed refresh still allows the current server to run.
                try:
                    configure_startup(True, self.directory)
                except OSError:
                    self.log_setup_error("Startup registration refresh failed")
                self.after(350, self.resume_startup)
                if autostart:
                    self.after(500, self.hide_to_tray if self.tray_enabled else self.iconify)

        def fit_labels(self, event):
            if event.widget is not self:
                return
            width = max(280, event.width - 128)
            for label in (self.folder_hint, self.key_hint, self.help_label, self.scope_label):
                label.configure(wraplength=width)
            self.status.configure(wraplength=max(250, width - 32))
            self.address_label.configure(wraplength=max(250, width - 32))
            self.startup_hint.configure(wraplength=max(250, width - 32))
            self.tray_hint.configure(wraplength=max(250, width - 32))
            self.subtitle.configure(wraplength=max(280, event.width - 56))

        def text(self, key):
            return TEXT[key][self.language == "ar"]

        def button(self, parent, text, command, secondary=False, width=180):
            return ctk.CTkButton(parent, text=text, command=command, height=44, width=width,
                                corner_radius=12, border_width=0, font=("Segoe UI", 14, "bold"),
                                fg_color="#eff6ff" if secondary else "#2563eb",
                                hover_color="#dbeafe" if secondary else "#1d4ed8",
                                text_color="#1d4ed8" if secondary else "#ffffff")

        def entry(self, parent, **kwargs):
            return ctk.CTkEntry(parent, height=44, corner_radius=12, fg_color="#f8fafc",
                                border_color="#e2e8f0", border_width=1, text_color="#334155",
                                font=("Segoe UI", 14), **kwargs)

        def label(self, parent, key, row, bold=False, muted=False, pady=0):
            widget = ctk.CTkLabel(parent, text="", anchor="w", justify="left", wraplength=565,
                                 font=("Segoe UI", 13 if muted else 14, "bold" if bold else "normal"),
                                 text_color="#64748b" if muted else "#334155")
            widget.grid(row=row, column=0, sticky="ew", padx=22, pady=pady)
            return widget

        def translate(self):
            self.title(self.text("title"))
            rtl = self.language == "ar"
            self.toggle.configure(text="English" if rtl else "العربية")
            self.heading.configure(text=self.text("title"), anchor="e" if rtl else "w")
            self.subtitle.configure(text=self.text("subtitle"), anchor="e" if rtl else "w")
            self.startup_switch.configure(text=self.text("startup"))
            self.startup_hint.configure(text=self.text("startup_hint"), anchor="e" if rtl else "w",
                                        justify="right" if rtl else "left")
            self.tray_switch.configure(text=self.text("tray"))
            self.tray_hint.configure(text=self.text("tray_hint"), anchor="e" if rtl else "w",
                                     justify="right" if rtl else "left")
            if self.tray_icon:
                self.tray_icon.menu = self.tray_menu()
                self.tray_icon.update_menu()
            for widget, key in ((self.folder_label, "folder"), (self.folder_hint, "folder_hint"),
                                (self.key_label, "key"), (self.key_hint, "key_hint"),
                                (self.port_label, "port"), (self.limit_label, "upload_limit"),
                                (self.help_label, "help"), (self.scope_label, "scope")):
                widget.configure(text=self.text(key), anchor="e" if rtl else "w", justify="right" if rtl else "left")
            for widget, key in ((self.browse, "browse"), (self.copy_button, "copy"),
                                (self.remote_button, "remote_wait" if self.remote_busy else "remote"),
                                (self.web_button, "web"), (self.log_button, "log"),
                                (self.show_key, "hide" if self.key_visible else "show")):
                widget.configure(text=self.text(key))
            self.import_button.configure(text=self.text("import_config"))
            self.start_button.configure(text=self.text("starting" if self.busy else "stop" if self.process else "start"))
            self.status.configure(text=self.text(self.message_key), anchor="e" if rtl else "w", justify="right" if rtl else "left")
            self.address_label.configure(text=self.address)
            self.copy_button.configure(state="normal" if self.address else "disabled")
            self.remote_button.configure(state="normal" if self.process and not self.busy and not self.remote_busy else "disabled")

        def log_setup_error(self, message):
            with (self.directory / "setup.log").open("a", encoding="utf-8") as log:
                log.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")

        def resume_startup(self):
            if self.startup_enabled and not self.closing.is_set() and not self.process and not self.busy:
                self.auto_remote_active = True
                self.start_or_stop()

        def save_server_config(self):
            if not self.folder.get().strip():
                self.set_message("folder_required", True)
                return False
            if not self.key.get().strip():
                self.set_message("key_required", True)
                return False
            try:
                port = int(self.port_entry.get())
                limit = int(self.limit_entry.get())
                if not 1 <= port <= 65535 or limit <= 0:
                    raise ValueError("Invalid port or limit")
            except ValueError:
                self.set_message("settings_error", True)
                return False
            try:
                root = Path(self.folder.get()).expanduser().resolve()
                root.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryFile(dir=root):
                    pass
                self.saved_config = make_config(self.directory, root, self.key.get().strip(), port, limit,
                                               existing=self.saved_config)
                write_json(self.config_path, self.saved_config)
                self.port = port
                return True
            except (OSError, ValueError):
                self.set_message("folder_error", True)
                return False

        def import_config(self):
            path = filedialog.askopenfilename(title=self.text("import_config"),
                                             filetypes=[("JSON", "*.json")])
            if not path:
                return
            try:
                settings = read_existing_config(path)
                # Keep this computer's state when importing its own settings.
                # Imported sync paths and pairing credentials are never used.
                if os.path.normcase(settings["storage_path"]) != os.path.normcase(str(self.saved_config.get("storage_path", ""))):
                    self.saved_config.pop("sync_state_path", None)
                self.saved_config.update(settings)
                for widget, name in ((self.folder, "storage_path"), (self.key, "clinic_secret_key"),
                                     (self.port_entry, "port"), (self.limit_entry, "max_file_size_mb")):
                    widget.delete(0, "end")
                    widget.insert(0, str(settings.get(name, "")))
                self.set_message("import_ok")
            except (OSError, ValueError, TypeError):
                self.set_message("import_error", True)

        def cancel_remote_retry(self):
            if self.remote_retry is not None:
                self.after_cancel(self.remote_retry)
                self.remote_retry = None

        def on_startup_change(self):
            enabled = bool(self.startup_switch.get())
            previous = self.startup_enabled
            if enabled and not self.process and not self.save_server_config():
                self.startup_switch.deselect()
                return
            try:
                configure_startup(enabled, self.directory)
                settings = {**self.settings, "startupConnect": enabled}
                write_json(self.settings_path, settings)
            except (OSError, ValueError):
                # Keep the registration consistent with the previous saved state.
                try:
                    configure_startup(previous, self.directory)
                except OSError:
                    pass
                self.startup_switch.select() if previous else self.startup_switch.deselect()
                self.log_setup_error("Could not save startup setting")
                self.set_message("startup_failed", True)
                return
            self.startup_enabled = enabled
            self.settings = settings
            self.auto_remote_active = enabled
            self.cancel_remote_retry()
            self.remote_attempts = 0
            if enabled:
                if self.process and not self.busy:
                    self.enable_remote()
                elif not self.process and not self.busy:
                    self.start_or_stop()
            elif self.message_key == "remote_retry":
                self.set_message("online" if self.process else "offline")

        def tray_menu(self):
            import pystray
            # Callbacks run on the tray thread. Only the Tk event loop touches UI.
            return pystray.Menu(
                pystray.MenuItem(self.text("tray_open"), lambda *_: self.events.put(("tray_open", None)), default=True),
                pystray.MenuItem(self.text("tray_quit"), lambda *_: self.events.put(("tray_quit", None))))

        def ensure_tray(self):
            if self.tray_icon:
                return True
            try:
                import pystray
                from PIL import Image
                resource = RESOURCE_ROOT / "dental-icon-v1-32.png"
                if not resource.is_file() and not getattr(sys, "frozen", False):
                    resource = Path(__file__).resolve().parents[1] / "icons/dental-icon-v1-32.png"
                with Image.open(resource) as source:
                    image = source.convert("RGBA")
                self.tray_icon = pystray.Icon("LuminStorageSetup", image, self.text("title"), self.tray_menu())

                def ready(icon):
                    try:
                        if self.closing.is_set() or self.tray_icon is not icon:
                            # A quick toggle-off can precede the native message
                            # loop. Stop it now that its setup callback is ready.
                            icon.stop()
                            return
                        icon.visible = True
                        self.events.put(("tray_ready", icon))
                    except Exception:
                        self.events.put(("tray_error", icon))

                self.tray_icon.run_detached(setup=ready)
                return True
            except Exception:
                self.stop_tray()
                self.log_setup_error("Tray icon could not start")
                return False

        def stop_tray(self):
            icon, self.tray_icon = self.tray_icon, None
            self.tray_ready = False
            self.tray_hide_pending = False
            if icon:
                try:
                    icon.stop()
                except Exception:
                    self.log_setup_error("Tray icon could not stop")

        def on_tray_change(self):
            enabled = bool(self.tray_switch.get())
            if enabled and not self.ensure_tray():
                self.tray_switch.deselect()
                self.set_message("tray_failed", True)
                return
            try:
                settings = {**self.settings, "minimizeToTray": enabled}
                write_json(self.settings_path, settings)
            except OSError:
                self.tray_switch.select() if self.tray_enabled else self.tray_switch.deselect()
                if not self.tray_enabled:
                    self.stop_tray()
                self.set_message("tray_failed", True)
                return
            self.settings = settings
            self.tray_enabled = enabled
            if enabled:
                self.hide_to_tray()
            else:
                self.restore_window()
                self.stop_tray()

        def on_minimize(self, event):
            if event.widget is self and self.tray_enabled and self.state() == "iconic":
                self.hide_to_tray()

        def hide_to_tray(self):
            if self.closing.is_set():
                return
            if not self.ensure_tray():
                self.restore_window()
                self.set_message("tray_failed", True)
                return
            self.tray_hide_pending = True
            # Never hide the only way to reopen the app before its icon exists.
            if self.tray_ready:
                self.tray_hide_pending = False
                self.withdraw()

        def restore_window(self):
            self.tray_hide_pending = False
            self.deiconify()
            self.lift()

        def retry_remote(self):
            self.remote_retry = None
            if self.auto_remote_active and self.startup_enabled and self.process and not self.closing.is_set():
                self.enable_remote()

        def schedule_remote_retry(self):
            self.cancel_remote_retry()
            if self.auto_remote_active and self.startup_enabled and self.process and not self.closing.is_set():
                self.remote_attempts += 1
                delay = min(300, 30 * 2 ** min(self.remote_attempts - 1, 4))
                self.remote_retry = self.after(delay * 1000, self.retry_remote)
                self.set_message("remote_retry")

        def toggle_language(self):
            self.language = "ar" if self.language == "en" else "en"
            self.translate()

        def toggle_key(self):
            self.key_visible = not self.key_visible
            self.key.configure(show="" if self.key_visible else "•")
            self.translate()

        def choose_folder(self):
            folder = filedialog.askdirectory(title=self.text("folder"), initialdir=self.folder.get() or str(Path.home()))
            if folder:
                self.folder.delete(0, "end")
                self.folder.insert(0, folder)

        def controls(self, enabled):
            for widget in (self.folder, self.key, self.browse, self.show_key, self.import_button,
                           self.port_entry, self.limit_entry):
                widget.configure(state="normal" if enabled else "disabled")

        def refresh_saved_config(self):
            # The running server can change its drive/folder through Lumin Admin.
            # Read those persisted settings before the next launch.
            try:
                saved = json.loads(self.config_path.read_text(encoding="utf-8"))
                if not isinstance(saved, dict):
                    return
                self.saved_config = saved
                for widget, name in ((self.folder, "storage_path"), (self.port_entry, "port"),
                                     (self.limit_entry, "max_file_size_mb")):
                    widget.delete(0, "end")
                    widget.insert(0, str(saved[name]))
            except (OSError, ValueError, KeyError):
                self.log_setup_error("Could not refresh saved server settings")

        def set_message(self, key, error=False):
            self.message_key = key
            self.status.configure(text_color="#be123c" if error else "#047857" if self.process else "#64748b")
            self.translate()

        def start_or_stop(self):
            if self.busy:
                return
            if self.process:
                self.auto_remote_active = False
                self.cancel_remote_retry()
                self.busy = True
                self.start_button.configure(state="disabled", text=self.text("stopping"))
                threading.Thread(target=self.stop_worker, daemon=True).start()
                return
            if self.remote_busy:
                return
            if not self.save_server_config():
                return
            try:
                # Only inspect the port. Never stop a server started by another app.
                with socket.socket() as probe:
                    probe.settimeout(.5)
                    if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                        self.set_message("port_busy", True)
                        return
            except (OSError, ValueError):
                self.set_message("folder_error", True)
                return
            self.busy = True
            self.auto_remote_active = self.startup_enabled
            self.controls(False)
            self.start_button.configure(state="disabled")
            self.set_message("starting")
            threading.Thread(target=self.start_worker, daemon=True).start()

        def start_worker(self):
            process = None
            try:
                with self.lifecycle_lock:
                    if self.closing.is_set():
                        return
                    self.ready = self.directory / ("ready-" + uuid.uuid4().hex + ".json")
                    with (self.directory / "launcher.log").open("a", encoding="utf-8") as log:
                        process = subprocess.Popen(launch_command("--serve", "--config", str(self.config_path),
                                                                  "--ready-file", str(self.ready)),
                                                   stdout=log, stderr=log, creationflags=CREATE_NO_WINDOW)
                    self.process = process
                deadline = time.monotonic() + 45
                while not self.ready.exists():
                    if self.closing.is_set() or process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Server did not start.")
                    time.sleep(.1)
                data = json.loads(self.ready.read_text(encoding="utf-8"))
                with urllib.request.urlopen("http://127.0.0.1:%s/api/health" % data["port"], timeout=5) as response:
                    health = json.load(response)
                if health.get("service") != SERVICE or health.get("storageRoot") != data["storageRoot"]:
                    raise RuntimeError("Unexpected storage service.")
                if self.closing.is_set():
                    stop_process(process, self.ready)
                else:
                    self.events.put(("started", process))
            except Exception:
                stop_process(process, self.ready)
                self.events.put(("error", "failed"))

        def stop_worker(self):
            with self.lifecycle_lock:
                remote_process = self.remote_process
            terminate_process_tree(remote_process)
            stop_process(self.process, self.ready)
            self.events.put(("stopped", None))

        def poll(self):
            try:
                while True:
                    event, value = self.events.get_nowait()
                    if event == "tray_ready":
                        if self.tray_icon is value and self.tray_enabled:
                            self.tray_ready = True
                            if self.tray_hide_pending:
                                self.hide_to_tray()
                    elif event == "tray_open":
                        self.restore_window()
                    elif event == "tray_quit":
                        self.shutdown()
                        return
                    elif event == "tray_error":
                        if self.tray_icon is not value:
                            continue
                        self.stop_tray()
                        self.restore_window()
                        self.set_message("tray_failed", True)
                    elif event == "started":
                        self.process = value
                        self.busy = False
                        self.address = "http://localhost:%s" % self.port
                        self.start_button.configure(state="normal")
                        self.set_message("online")
                        if self.startup_enabled and self.auto_remote_active:
                            self.enable_remote()
                    elif event in ("stopped", "error"):
                        self.process = None
                        self.busy = False
                        self.address = ""
                        self.cancel_remote_retry()
                        if self.ready:
                            self.ready.unlink(missing_ok=True)
                        self.controls(True)
                        if event == "stopped":
                            self.refresh_saved_config()
                        self.start_button.configure(state="normal")
                        self.set_message("offline" if event == "stopped" else value, event == "error")
                    elif event == "remote":
                        self.remote_busy = False
                        if not self.process or self.closing.is_set():
                            continue
                        if value:
                            self.cancel_remote_retry()
                            self.remote_attempts = 0
                            self.address = value
                            self.set_message("remote_ok")
                        else:
                            self.set_message("remote_failed", True)
                            self.schedule_remote_retry()
                    elif event == "missing_tailscale":
                        self.remote_busy = False
                        if not self.process or self.closing.is_set():
                            continue
                        self.set_message("remote_missing", True)
                        self.schedule_remote_retry()
            except queue.Empty:
                pass
            if self.process and not self.busy and self.process.poll() is not None:
                self.process = None
                self.address = ""
                self.cancel_remote_retry()
                self.controls(True)
                self.set_message("unexpected_stop", True)
            self.after(150, self.poll)

        def copy_address(self):
            if self.address:
                self.clipboard_clear()
                self.clipboard_append(self.address)
                self.copy_button.configure(text=self.text("copied"))

        def enable_remote(self):
            if not self.process or self.remote_busy:
                return
            self.remote_busy = True
            self.cancel_remote_retry()
            self.translate()
            threading.Thread(target=self.remote_worker, daemon=True).start()

        def remote_worker(self):
            process = None
            try:
                executable = shutil.which("tailscale") or str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Tailscale/tailscale.exe")
                if not Path(executable).is_file():
                    self.events.put(("missing_tailscale", None))
                    return
                with self.lifecycle_lock:
                    if self.closing.is_set():
                        return
                    with (self.directory / "remote.log").open("w", encoding="utf-8") as log:
                        process = subprocess.Popen(launch_command("--remote", "--config", str(self.config_path)),
                                                   stdout=log, stderr=log, creationflags=CREATE_NO_WINDOW)
                    self.remote_process = process
                if process.wait(timeout=100):
                    self.events.put(("remote", None))
                    return
                state = subprocess.run([executable, "status", "--json"], capture_output=True, text=True,
                                       timeout=10, creationflags=CREATE_NO_WINDOW, check=True)
                host = str(json.loads(state.stdout).get("Self", {}).get("DNSName", "")).rstrip(".")
                self.events.put(("remote", "https://" + host if host.endswith(".ts.net") else None))
            except Exception:
                self.events.put(("remote", None))
            finally:
                terminate_process_tree(process)
                with self.lifecycle_lock:
                    if self.remote_process is process:
                        self.remote_process = None

        def view_log(self):
            logs = [self.directory / name for name in ("launcher.log", "server.log", "remote.log", "setup.log")]
            existing = [path for path in logs if path.is_file()]
            path = max(existing, key=lambda p: p.stat().st_mtime) if existing else self.directory / "launcher.log"
            path.touch(exist_ok=True)
            os.startfile(path)

        def close(self):
            if self.tray_enabled:
                self.hide_to_tray()
            else:
                self.shutdown()

        def shutdown(self):
            # The app owns only this subprocess. Other server installations and
            # patient files are never stopped, moved or overwritten here.
            self.closing.set()
            self.stop_tray()
            self.cancel_remote_retry()
            with self.lifecycle_lock:
                process, ready, remote = self.process, self.ready, self.remote_process
            terminate_process_tree(remote)
            stop_process(process, ready)
            self.destroy()

    window = Setup()
    if test_output:
        try:
            for language in ("en", "ar"):
                window.language = language
                window.translate()
                window.update_idletasks()
                assert window.heading.cget("text") == window.text("title")
                assert window.key.cget("show") == "•"
                for button in (window.start_button, window.browse, window.show_key, window.copy_button,
                               window.remote_button, window.web_button, window.log_button, window.toggle,
                               window.import_button):
                    assert button.cget("height") >= 44
                assert window.start_button.cget("text") == window.text("start")
                assert window.startup_switch.cget("height") >= 44
                assert window.tray_switch.cget("height") >= 44
                assert window.tray_switch.cget("text") == window.text("tray")
                assert window.remote_button.cget("state") == "disabled"
                window.start_or_stop()
                assert window.message_key == "key_required"
                window.toggle_key()
                assert window.key.cget("show") == ""
                window.toggle_key()
            assert int(window.port_entry.get()) == SERVER_DEFAULTS["port"]
            assert int(window.limit_entry.get()) == SERVER_DEFAULTS["max_file_size_mb"]
            # Exercise the real toggle and retry callbacks, while substituting
            # registration and networking so no startup setting or Funnel on
            # the user's computer is changed by this hidden test.
            from unittest.mock import patch
            calls = []
            with patch(__name__ + ".configure_startup", side_effect=lambda enabled, directory: calls.append(enabled)):
                window.startup_switch.select()
                window.on_startup_change()
                assert not window.startup_switch.get() and not calls
                window.folder.delete(0, "end")
                window.folder.insert(0, str(directory / "test-patients"))
                window.key.insert(0, "disposable-test-key")
                window.port_entry.delete(0, "end")
                window.port_entry.insert(0, "invalid")
                assert not window.save_server_config() and window.message_key == "settings_error"
                window.port_entry.delete(0, "end")
                window.port_entry.insert(0, "5055")
                window.start_or_stop = lambda: calls.append("start")
                window.startup_switch.select()
                window.on_startup_change()
                assert calls == [True, "start"]
                assert json.loads(window.settings_path.read_text(encoding="utf-8"))["startupConnect"] is True
                window.resume_startup()
                assert calls[-1] == "start"
                class FakeProcess:
                    def poll(self):
                        return None
                window.enable_remote = lambda: calls.append("remote")
                window.events.put(("started", FakeProcess()))
                window.poll()
                assert calls[-1] == "remote"
                window.events.put(("remote", None))
                window.poll()
                assert window.remote_retry is not None
                assert window.message_key == "remote_retry"
                window.retry_remote()
                assert calls[-1] == "remote"
                window.schedule_remote_retry()
                retry_id = window.remote_retry
                window.startup_switch.deselect()
                window.on_startup_change()
                assert calls[-1] is False and window.remote_retry is None
                assert retry_id not in window.tk.call("after", "info")
                assert json.loads(window.settings_path.read_text(encoding="utf-8"))["startupConnect"] is False
                # Enabling startup while running must not overwrite folder changes
                # persisted by Lumin Admin with stale values from the setup form.
                with patch.object(window, "save_server_config", side_effect=AssertionError("Running config overwritten")):
                    window.startup_switch.select()
                    window.on_startup_change()
                    assert window.startup_enabled and calls[-1] == "remote"
                    window.startup_switch.deselect()
                    window.on_startup_change()
            class FakeTray:
                def __init__(self, name, image, title, menu):
                    self.menu = menu
                    self.visible = False
                    self.stopped = False
                def run_detached(self, setup):
                    setup(self)
                def update_menu(self):
                    pass
                def stop(self):
                    self.stopped = True
            with patch("pystray.Icon", FakeTray), patch.object(window, "withdraw") as hide, \
                    patch.object(window, "deiconify") as show, patch.object(window, "lift"), \
                    patch(__name__ + ".configure_startup"):
                process = window.process
                window.tray_switch.select()
                window.on_tray_change()
                icon = window.tray_icon
                assert window.tray_enabled and icon.visible
                assert json.loads(window.settings_path.read_text(encoding="utf-8"))["minimizeToTray"]
                assert hide.call_count == 0, "Do not hide until the tray ready event is processed"
                window.poll()
                assert hide.call_count == 1
                window.close()
                assert not window.closing.is_set() and window.process is process
                assert hide.call_count == 2
                for language in ("en", "ar"):
                    window.language = language
                    window.translate()
                    assert list(icon.menu)[0].text == window.text("tray_open")
                list(icon.menu)[0](icon)
                window.poll()
                assert show.call_count == 1 and window.process is process
                window.startup_switch.select()
                window.on_startup_change()
                assert json.loads(window.settings_path.read_text(encoding="utf-8"))["minimizeToTray"]
                window.startup_switch.deselect()
                window.on_startup_change()
                window.tray_switch.deselect()
                window.on_tray_change()
                assert icon.stopped and not window.tray_enabled
                settings = json.loads(window.settings_path.read_text(encoding="utf-8"))
                assert settings == {"startupConnect":False, "minimizeToTray":False}
                with patch("pystray.Icon", side_effect=RuntimeError("tray unavailable")):
                    window.tray_switch.select()
                    window.on_tray_change()
                    assert not window.tray_switch.get() and not window.tray_enabled
                    assert window.message_key == "tray_failed" and not window.closing.is_set()
                class DeferredTray(FakeTray):
                    def run_detached(self, setup):
                        self.setup_callback = setup
                        self.stops = 0
                    def stop(self):
                        self.stops += 1
                with patch("pystray.Icon", DeferredTray):
                    window.tray_switch.select()
                    window.on_tray_change()
                    deferred = window.tray_icon
                    window.tray_switch.deselect()
                    window.on_tray_change()
                    deferred.setup_callback(deferred)
                    assert deferred.stops == 2 and not deferred.visible
                    assert window.tray_icon is None and not window.tray_enabled
                window.tray_switch.select()
                window.on_tray_change()
                window.poll()
                with patch.object(window, "shutdown") as quit_app:
                    list(window.tray_icon.menu)[1](window.tray_icon)
                    window.poll()
                    quit_app.assert_called_once()
            write_json(test_output, {"ok": True, "languages": ["en", "ar"], "touchTargets": True,
                                     "clinicKeyRequired": True, "keyMasked": True,
                                     "startupToggle": True, "automaticRemoteAccess": True,
                                     "remoteRetry": True, "disableCancelsRetry": True,
                                     "currentDefaults": True, "customPortValidation": True,
                                     "runningConfigPreserved": True, "trayToggle":True,
                                     "trayReopenAndQuit":True, "trayKeepsServerRunning":True,
                                     "trayFailureStaysVisible":True, "preferencesPreserved":True,
                                     "cancelledTrayStartupStopped":True})
        except Exception as error:
            write_json(test_output, {"ok": False, "error": str(error)})
        finally:
            window.stop_tray()
            window.destroy()
            instance_lock.close()
            workspace.cleanup()
    else:
        try:
            window.mainloop()
        finally:
            window.stop_tray()
            instance_lock.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--remote", action="store_true")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--ready-file", type=Path)
    parser.add_argument("--self-test-output", type=Path)
    parser.add_argument("--ui-test-output", type=Path)
    parser.add_argument("--autostart", action="store_true")
    args = parser.parse_args()
    # Windowed executables have no console; libraries can still safely write.
    if getattr(sys, "frozen", False) and args.config and (args.serve or args.remote):
        destination = args.config.resolve().parent / ("remote.log" if args.remote else "launcher.log")
        destination.parent.mkdir(parents=True, exist_ok=True)
        stream = destination.open("a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = stream
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    if args.self_test_output:
        return self_test(args.self_test_output)
    if args.ui_test_output:
        gui(args.ui_test_output)
        return 0 if json.loads(args.ui_test_output.read_text(encoding="utf-8"))["ok"] else 1
    if args.serve:
        if not args.config or not args.ready_file:
            parser.error("--serve requires --config and --ready-file")
        try:
            serve(args.config, args.ready_file)
        except (Exception, SystemExit):
            logging.exception("Storage server could not start.")
            return 1
    elif args.remote:
        if not args.config:
            parser.error("--remote requires --config")
        os.environ["LUMIN_STORAGE_CONFIG"] = str(args.config.resolve())
        if not getattr(sys, "frozen", False):
            sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "storage-server"))
        import tailscale_access
        return tailscale_access.main(["--setup"])
    else:
        gui(autostart=args.autostart)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
