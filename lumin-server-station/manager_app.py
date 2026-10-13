"""Lumin Dental Clinic - Dedicated Server Station & Manager UI.

Desktop application that manages:
1. Local Storage Server (Start / Stop / Restart / Uptime / Health)
2. Tailscale Remote Access (Tailscale Funnel with automated Supabase URL sync)
3. Two-Node File Synchronization (X-ray images and .zip 3D scans across folder hierarchy)
4. Background Automation (Windows Startup, System Tray, Scheduled Auto-Sync)
"""

import os
import sys
import json
import time
import socket
import shutil
import urllib.request
import urllib.error
import urllib.parse
import threading
import subprocess
import queue
import re
import logging
from datetime import datetime
from pathlib import Path
from PIL import Image, ImageDraw

import customtkinter as ctk
from werkzeug.serving import make_server

# Locate base directory
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    BASE_DIR = Path(__file__).resolve().parent

CONFIG_FILE = BASE_DIR / "config.json"
STATION_CONFIG_FILE = BASE_DIR / "station_config.json"
LOG_FILE = BASE_DIR / "manager.log"

# Supabase configuration for Tailscale URL sync
SUPABASE_URL = "https://pqbayjkypzfxvnksgwwf.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxYmF5amt5cHpmeHZua3Nnd3dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMjI4NzAsImV4cCI6MjEwNDY5ODg3MH0.e5tPe3PKUiFiS_ZnXcpDF9CRtGtp_B1oZsK37phOQ8Q"

DEFAULT_SERVER_CONFIG = {
    "port": 5000,
    "storage_path": "D:\\LuminStorage\\Patients",
    "fallback_storage_path": "./LuminStorage/Patients",
    "clinic_secret_key": "",
    "max_file_size_mb": 250,
    "allowed_extensions": [
        "jpg", "jpeg", "png", "webp", "bmp", "pdf", "dcm", "dicom", "tif", "tiff", "zip"
    ]
}

DEFAULT_STATION_CONFIG = {
    "auto_start_server": True,
    "auto_enable_tailscale": True,
    "minimize_to_tray": True,
    "start_on_boot": False,
    "auto_sync_enabled": False,
    "auto_sync_interval_minutes": 30,
    "peer_url": "",
    "peer_key": "",
    "server_role": "coordinator"
}


def load_json(path, default):
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return {**default, **json.load(f)}
        except Exception:
            pass
    return dict(default)


def save_json(path, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return True
    except Exception as e:
        print(f"Error saving {path}: {e}")
        return False


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(('10.254.254.254', 1))
        ip = s.getsockname()[0]
        s.close()
        if ip and ip != '127.0.0.1':
            return ip
    except Exception:
        pass
    return "127.0.0.1"


def get_tailscale_binary():
    executable = shutil.which("tailscale")
    if not executable:
        candidates = [
            Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Tailscale/tailscale.exe",
            Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Tailscale/tailscale.exe"
        ]
        for c in candidates:
            if c.is_file():
                executable = str(c)
                break
    return executable


def run_silent_cmd(cmd, timeout=10, **kwargs):
    """Run a subprocess command completely hidden with zero console window popping up on Windows."""
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    if sys.platform == "win32":
        # CREATE_NO_WINDOW prevents creation of a console window
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        # STARTF_USESHOWWINDOW with SW_HIDE forces any window to remain hidden
        si = kwargs.get("startupinfo")
        if si is None:
            si = subprocess.STARTUPINFO()
        si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
        si.wShowWindow = 0  # SW_HIDE
        kwargs["startupinfo"] = si
    return subprocess.run(cmd, timeout=timeout, **kwargs)


def get_tailscale_info():
    """Returns dict with Tailscale connection, DNS host, Funnel state, and IPs."""
    exe = get_tailscale_binary()
    if not exe:
        return {"installed": False, "running": False, "host": "", "url": "", "ip": "", "funnel": False}

    try:
        res = run_silent_cmd([exe, "status", "--json"], timeout=5)
        if res.returncode != 0:
            return {"installed": True, "running": False, "host": "", "url": "", "ip": "", "funnel": False}
        data = json.loads(res.stdout) if res.stdout else {}
        backend = data.get("BackendState", "")
        self_info = data.get("Self", {})
        dns_name = str(self_info.get("DNSName", "")).rstrip(".").lower()
        ips = self_info.get("TailscaleIPs", [])
        ts_ip = ips[0] if ips else ""

        # Check Funnel status
        funnel_active = False
        try:
            f_res = run_silent_cmd([exe, "funnel", "status", "--json"], timeout=5)
            if f_res.returncode == 0 and f_res.stdout:
                f_data = json.loads(f_res.stdout)
                funnel_active = bool(f_data.get("AllowFunnel", {}).get(f"{dns_name}:443"))
        except Exception:
            pass

        return {
            "installed": True,
            "running": backend == "Running",
            "host": dns_name,
            "url": f"https://{dns_name}" if dns_name else "",
            "ip": ts_ip,
            "funnel": funnel_active
        }
    except Exception:
        return {"installed": True, "running": False, "host": "", "url": "", "ip": "", "funnel": False}


def create_tray_icon_image():
    """Create a stylized dental tooth icon for the system tray."""
    img = Image.new('RGBA', (64, 64), color=(0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([4, 4, 60, 60], fill=(37, 99, 235, 255))
    draw.rounded_rectangle([18, 14, 46, 38], radius=8, fill=(255, 255, 255, 255))
    draw.rounded_rectangle([20, 32, 28, 50], radius=4, fill=(255, 255, 255, 255))
    draw.rounded_rectangle([36, 32, 44, 50], radius=4, fill=(255, 255, 255, 255))
    return img


def set_windows_startup(enable: bool) -> bool:
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE
        )
        app_name = "LuminServerStation"
        if enable:
            if getattr(sys, 'frozen', False):
                target = f'"{sys.executable}"'
            else:
                target = f'"{sys.executable}" "{BASE_DIR / "manager_app.py"}"'
            winreg.SetValueEx(key, app_name, 0, winreg.REG_SZ, target)
        else:
            try:
                winreg.DeleteValue(key, app_name)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
        return True
    except Exception as e:
        print(f"Windows startup error: {e}")
        return False


def is_windows_startup_enabled() -> bool:
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_READ
        )
        try:
            val, _ = winreg.QueryValueEx(key, "LuminServerStation")
            return bool(val)
        except FileNotFoundError:
            return False
        finally:
            winreg.CloseKey(key)
    except Exception:
        return False


def sync_url_to_supabase(url: str, clinic_key: str) -> bool:
    """Register live storage URL with Supabase so all clinic devices connect automatically."""
    rpc_endpoint = f"{SUPABASE_URL}/rest/v1/rpc/update_clinic_storage_url"
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Content-Type": "application/json"
    }
    payload = json.dumps({
        "new_url": url,
        "clinic_key": clinic_key
    }).encode("utf-8")
    try:
        req = urllib.request.Request(rpc_endpoint, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8").strip()
            return body in ("true", "True", "1")
    except Exception as e:
        print(f"Failed to sync URL to Supabase: {e}")
        return False


class QueueLogHandler(logging.Handler):
    def __init__(self, log_queue):
        super().__init__()
        self.log_queue = log_queue

    def emit(self, record):
        try:
            msg = self.format(record)
            self.log_queue.put(f"[{record.levelname}] {msg}")
        except Exception:
            pass


class ServerStationApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        # Aesthetic configuration
        ctk.set_appearance_mode("Dark")
        ctk.set_default_color_theme("blue")

        self.title("Lumin Dental — Server Station & Sync Hub")
        self.geometry("980x750")
        self.minsize(880, 650)

        # Configs
        self.server_config = load_json(CONFIG_FILE, DEFAULT_SERVER_CONFIG)
        self.station_config = load_json(STATION_CONFIG_FILE, DEFAULT_STATION_CONFIG)

        # In-process HTTP Server
        self.http_server = None
        self.server_thread = None
        self.server_start_time = None

        # Tailscale state
        self.ts_info = {"installed": False, "running": False, "host": "", "url": "", "ip": "", "funnel": False}
        self.tailscale_supabase_synced = False

        # Sync state
        self.active_sync_job = None
        self.is_syncing = False
        self.last_sync_time = None

        # Logging queue
        self.log_queue = queue.Queue()
        self.setup_logging()

        # System Tray
        self.tray_icon = None
        self.init_tray_icon()

        # UI build
        self.setup_ui()

        # Background monitor thread
        self.running = True
        self.monitor_thread = threading.Thread(target=self.background_monitor_loop, daemon=True)
        self.monitor_thread.start()

        # Log drain loop
        self.after(200, self.drain_log_queue)

        # Auto actions on launch
        if self.station_config.get("auto_start_server", True):
            self.after(500, self.start_server)

        if self.station_config.get("auto_enable_tailscale", True):
            self.after(1200, self.enable_tailscale_funnel)

        self.protocol("WM_DELETE_WINDOW", self.on_close_window)

    def setup_logging(self):
        root_logger = logging.getLogger()
        handler = QueueLogHandler(self.log_queue)
        formatter = logging.Formatter('[%(asctime)s] %(name)s: %(message)s', '%H:%M:%S')
        handler.setFormatter(formatter)
        root_logger.addHandler(handler)
        root_logger.setLevel(logging.INFO)

    def log(self, message: str, level: str = "INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        entry = f"[{timestamp}] [{level}] {message}"
        self.log_queue.put(entry)
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(entry + "\n")
        except Exception:
            pass

    def drain_log_queue(self):
        try:
            while True:
                entry = self.log_queue.get_nowait()
                if hasattr(self, "log_textbox"):
                    self.log_textbox.configure(state="normal")
                    self.log_textbox.insert("end", entry + "\n")
                    self.log_textbox.see("end")
                    self.log_textbox.configure(state="disabled")
        except queue.Empty:
            pass
        if self.running:
            self.after(200, self.drain_log_queue)

    def init_tray_icon(self):
        try:
            import pystray
            image = create_tray_icon_image()
            menu = pystray.Menu(
                pystray.MenuItem("Open Lumin Station", self.show_window_from_tray, default=True),
                pystray.MenuItem("Start Server", lambda: self.after(0, self.start_server)),
                pystray.MenuItem("Stop Server", lambda: self.after(0, self.stop_server)),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Sync Files Now", lambda: self.after(0, self.start_manual_sync)),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Exit Completely", self.exit_application)
            )
            self.tray_icon = pystray.Icon("lumin_station", image, "Lumin Server Station", menu)
            threading.Thread(target=self.tray_icon.run, daemon=True).start()
        except Exception as e:
            print(f"Tray initialization notice: {e}")

    def show_window_from_tray(self):
        self.after(0, self._restore_window)

    def _restore_window(self):
        self.deiconify()
        self.lift()
        self.focus_force()

    def on_close_window(self):
        if self.station_config.get("minimize_to_tray", True) and self.tray_icon:
            self.withdraw()
            self.log("Minimized to system tray. Server & sync automation remain active.", "INFO")
        else:
            self.exit_application()

    def exit_application(self):
        self.running = False
        self.log("Stopping services and exiting...", "INFO")
        self.stop_server()
        if self.tray_icon:
            try:
                self.tray_icon.stop()
            except Exception:
                pass
        self.destroy()
        sys.exit(0)

    # ---------------- UI BUILDER ----------------
    def setup_ui(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        # 1. Header Bar
        header = ctk.CTkFrame(self, corner_radius=0, fg_color=("#1e293b", "#0f172a"), height=64)
        header.grid(row=0, column=0, sticky="ew")
        header.grid_columnconfigure(1, weight=1)

        logo_frame = ctk.CTkFrame(header, fg_color="transparent")
        logo_frame.grid(row=0, column=0, padx=20, pady=12, sticky="w")

        title_lbl = ctk.CTkLabel(
            logo_frame,
            text="LUMIN SERVER STATION",
            font=ctk.CTkFont(family="Segoe UI", size=16, weight="bold"),
            text_color="#38bdf8"
        )
        title_lbl.pack(anchor="w")

        sub_lbl = ctk.CTkLabel(
            logo_frame,
            text="Clinical Storage, Tailscale Remote Funnel & Two-Node File Sync Hub",
            font=ctk.CTkFont(family="Segoe UI", size=11),
            text_color="#94a3b8"
        )
        sub_lbl.pack(anchor="w")

        top_btn_frame = ctk.CTkFrame(header, fg_color="transparent")
        top_btn_frame.grid(row=0, column=2, padx=20, pady=12, sticky="e")

        open_web_btn = ctk.CTkButton(
            top_btn_frame,
            text="Open Web Dashboard",
            width=150,
            height=32,
            fg_color="#2563eb",
            hover_color="#1d4ed8",
            command=self.open_web_dashboard
        )
        open_web_btn.pack(side="left", padx=6)

        hide_btn = ctk.CTkButton(
            top_btn_frame,
            text="Hide to Tray",
            width=100,
            height=32,
            fg_color="#334155",
            hover_color="#475569",
            command=self.withdraw
        )
        hide_btn.pack(side="left", padx=6)

        # 2. Main Tabview
        self.tabview = ctk.CTkTabview(self, corner_radius=12, fg_color=("#0f172a", "#1e293b"))
        self.tabview.grid(row=1, column=0, padx=16, pady=12, sticky="nsew")

        self.tab_services = self.tabview.add("🖥️  Services & Health")
        self.tab_sync = self.tabview.add("🔄  File Synchronization")
        self.tab_settings = self.tabview.add("⚙️  Settings & Storage")
        self.tab_logs = self.tabview.add("📋  Live Logs")

        self.build_services_tab()
        self.build_sync_tab()
        self.build_settings_tab()
        self.build_logs_tab()

        # 3. Status Bar
        status_bar = ctk.CTkFrame(self, corner_radius=0, fg_color=("#0f172a", "#090d16"), height=28)
        status_bar.grid(row=2, column=0, sticky="ew")
        status_bar.grid_columnconfigure(0, weight=1)

        self.status_left_lbl = ctk.CTkLabel(
            status_bar,
            text=f"LAN IP: {get_local_ip()} | Port: {self.server_config.get('port', 5000)}",
            font=ctk.CTkFont(family="Segoe UI", size=11),
            text_color="#64748b"
        )
        self.status_left_lbl.grid(row=0, column=0, padx=16, pady=4, sticky="w")

        self.status_right_lbl = ctk.CTkLabel(
            status_bar,
            text="Tailscale Funnel Active · Supabase Cloud Synced",
            font=ctk.CTkFont(family="Segoe UI", size=11),
            text_color="#64748b"
        )
        self.status_right_lbl.grid(row=0, column=1, padx=16, pady=4, sticky="e")

    # ---------- TAB 1: SERVICES & HEALTH ----------
    def build_services_tab(self):
        tab = self.tab_services
        tab.grid_columnconfigure((0, 1), weight=1)

        # Server Card
        server_card = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        server_card.grid(row=0, column=0, padx=10, pady=10, sticky="nsew")

        ctk.CTkLabel(server_card, text="Local Storage Server", font=ctk.CTkFont(size=15, weight="bold"), text_color="#f8fafc").pack(anchor="w", padx=16, pady=(14, 4))
        ctk.CTkLabel(server_card, text="Serves X-rays, photos, and 3D scans across local clinic Wi-Fi.", font=ctk.CTkFont(size=12), text_color="#94a3b8").pack(anchor="w", padx=16, pady=(0, 12))

        b_row = ctk.CTkFrame(server_card, fg_color="transparent")
        b_row.pack(fill="x", padx=16, pady=4)

        self.server_badge = ctk.CTkLabel(
            b_row,
            text="● OFFLINE",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#ef4444",
            fg_color="#451a1a",
            corner_radius=6,
            padx=10,
            pady=4
        )
        self.server_badge.pack(side="left")

        self.server_uptime_lbl = ctk.CTkLabel(b_row, text="Uptime: --:--:--", font=ctk.CTkFont(size=12), text_color="#64748b")
        self.server_uptime_lbl.pack(side="right")

        self.server_details_lbl = ctk.CTkLabel(
            server_card,
            text=f"Address: http://localhost:{self.server_config.get('port', 5000)}\nStatus: Idle",
            justify="left",
            font=ctk.CTkFont(family="Consolas", size=12),
            text_color="#cbd5e1"
        )
        self.server_details_lbl.pack(anchor="w", padx=16, pady=12)

        btn_row = ctk.CTkFrame(server_card, fg_color="transparent")
        btn_row.pack(fill="x", padx=16, pady=(4, 16))

        self.btn_start_server = ctk.CTkButton(btn_row, text="Start Server", fg_color="#10b981", hover_color="#059669", width=120, command=self.start_server)
        self.btn_start_server.pack(side="left", padx=(0, 8))

        self.btn_stop_server = ctk.CTkButton(btn_row, text="Stop Server", fg_color="#ef4444", hover_color="#dc2626", width=120, command=self.stop_server, state="disabled")
        self.btn_stop_server.pack(side="left", padx=8)

        self.btn_restart_server = ctk.CTkButton(btn_row, text="Restart", fg_color="#334155", hover_color="#475569", width=80, command=self.restart_server, state="disabled")
        self.btn_restart_server.pack(side="left", padx=8)

        # Tailscale Remote Access Card
        ts_card = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        ts_card.grid(row=0, column=1, padx=10, pady=10, sticky="nsew")

        ctk.CTkLabel(ts_card, text="Tailscale Remote Access & Funnel", font=ctk.CTkFont(size=15, weight="bold"), text_color="#f8fafc").pack(anchor="w", padx=16, pady=(14, 4))
        ctk.CTkLabel(ts_card, text="Permanent, secure HTTPS domain for iPads, phones & laptops (no port forwarding).", font=ctk.CTkFont(size=12), text_color="#94a3b8").pack(anchor="w", padx=16, pady=(0, 12))

        t_row = ctk.CTkFrame(ts_card, fg_color="transparent")
        t_row.pack(fill="x", padx=16, pady=4)

        self.ts_badge = ctk.CTkLabel(
            t_row,
            text="● CHECKING...",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#94a3b8",
            fg_color="#1e293b",
            corner_radius=6,
            padx=10,
            pady=4
        )
        self.ts_badge.pack(side="left")

        self.ts_supabase_lbl = ctk.CTkLabel(t_row, text="Supabase: Checking...", font=ctk.CTkFont(size=12), text_color="#64748b")
        self.ts_supabase_lbl.pack(side="right")

        self.ts_url_entry = ctk.CTkEntry(ts_card, placeholder_text="Tailscale URL...", state="readonly", font=ctk.CTkFont(family="Consolas", size=11))
        self.ts_url_entry.pack(fill="x", padx=16, pady=(10, 4))

        self.ts_ip_lbl = ctk.CTkLabel(ts_card, text="Tailscale IP: --", font=ctk.CTkFont(family="Consolas", size=11), text_color="#64748b")
        self.ts_ip_lbl.pack(anchor="w", padx=16, pady=(0, 8))

        t_btn_row = ctk.CTkFrame(ts_card, fg_color="transparent")
        t_btn_row.pack(fill="x", padx=16, pady=(4, 16))

        self.btn_enable_funnel = ctk.CTkButton(t_btn_row, text="Enable Funnel", fg_color="#0284c7", hover_color="#0369a1", width=120, command=self.enable_tailscale_funnel)
        self.btn_enable_funnel.pack(side="left", padx=(0, 6))

        self.btn_disable_funnel = ctk.CTkButton(t_btn_row, text="Disable Funnel", fg_color="#334155", hover_color="#475569", width=110, command=self.disable_tailscale_funnel)
        self.btn_disable_funnel.pack(side="left", padx=6)

        copy_btn = ctk.CTkButton(t_btn_row, text="Copy URL", fg_color="#334155", hover_color="#475569", width=80, command=self.copy_ts_url)
        copy_btn.pack(side="left", padx=6)

        sync_sb_btn = ctk.CTkButton(t_btn_row, text="Sync Supabase", fg_color="#10b981", hover_color="#059669", width=110, command=self.sync_tailscale_to_supabase)
        sync_sb_btn.pack(side="left", padx=6)

        # Storage Disk Capacity Card
        disk_card = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        disk_card.grid(row=1, column=0, columnspan=2, padx=10, pady=10, sticky="ew")

        ctk.CTkLabel(disk_card, text="Storage Drive & Free Capacity", font=ctk.CTkFont(size=14, weight="bold"), text_color="#f8fafc").pack(anchor="w", padx=16, pady=(12, 4))

        self.disk_info_lbl = ctk.CTkLabel(disk_card, text="Drive: -- | Free: -- GB | Total: -- GB", font=ctk.CTkFont(size=12), text_color="#cbd5e1")
        self.disk_info_lbl.pack(anchor="w", padx=16, pady=2)

        self.disk_bar = ctk.CTkProgressBar(disk_card, fg_color="#1e293b", progress_color="#10b981", height=10)
        self.disk_bar.pack(fill="x", padx=16, pady=(6, 12))
        self.disk_bar.set(0.1)

    # ---------- TAB 2: FILE SYNCHRONIZATION ----------
    def build_sync_tab(self):
        tab = self.tab_sync
        tab.grid_columnconfigure(0, weight=1)

        banner = ctk.CTkFrame(tab, corner_radius=8, fg_color="#172554", border_width=1, border_color="#1d4ed8")
        banner.pack(fill="x", padx=10, pady=(10, 14))

        b_text = (
            "📌 Remade Synchronization Protocol:\n"
            "• Synchronizes X-ray & clinical photo images across the folder hierarchy.\n"
            "• Synchronizes 3D intraoral scans strictly as original .zip archives.\n"
            "• Clinical notes and tooth assignments are shared seamlessly via Supabase Cloud."
        )
        ctk.CTkLabel(banner, text=b_text, justify="left", font=ctk.CTkFont(size=12), text_color="#bfdbfe").pack(padx=14, pady=10, anchor="w")

        # Peer Configuration Box
        peer_box = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        peer_box.pack(fill="x", padx=10, pady=6)

        ctk.CTkLabel(peer_box, text="Peer Server Configuration (Coordinator ↔ Replica)", font=ctk.CTkFont(size=14, weight="bold")).pack(anchor="w", padx=16, pady=(12, 6))

        cfg_grid = ctk.CTkFrame(peer_box, fg_color="transparent")
        cfg_grid.pack(fill="x", padx=16, pady=6)
        cfg_grid.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(cfg_grid, text="This Computer Role:").grid(row=0, column=0, sticky="w", pady=6)
        self.role_var = ctk.StringVar(value=self.station_config.get("server_role", "coordinator"))
        role_menu = ctk.CTkSegmentedButton(
            cfg_grid,
            values=["coordinator", "replica"],
            variable=self.role_var,
            command=self.on_role_change
        )
        role_menu.grid(row=0, column=1, sticky="w", padx=10, pady=6)

        ctk.CTkLabel(cfg_grid, text="Remote Server URL:").grid(row=1, column=0, sticky="w", pady=6)
        self.peer_url_entry = ctk.CTkEntry(cfg_grid, placeholder_text="e.g. https://other-laptop.ts.net or http://192.168.1.55:5000")
        self.peer_url_entry.insert(0, self.station_config.get("peer_url", ""))
        self.peer_url_entry.grid(row=1, column=1, sticky="ew", padx=10, pady=6)

        ctk.CTkLabel(cfg_grid, text="Remote Clinic Key:").grid(row=2, column=0, sticky="w", pady=6)
        self.peer_key_entry = ctk.CTkEntry(cfg_grid, show="*", placeholder_text="Clinic secret key")
        self.peer_key_entry.insert(0, self.station_config.get("peer_key", self.server_config.get("clinic_secret_key", "")))
        self.peer_key_entry.grid(row=2, column=1, sticky="ew", padx=10, pady=6)

        p_act_frame = ctk.CTkFrame(peer_box, fg_color="transparent")
        p_act_frame.pack(fill="x", padx=16, pady=(8, 14))

        self.btn_pair = ctk.CTkButton(p_act_frame, text="Pair Servers", fg_color="#2563eb", hover_color="#1d4ed8", width=140, command=self.pair_servers)
        self.btn_pair.pack(side="left", padx=(0, 10))

        self.btn_unpair = ctk.CTkButton(p_act_frame, text="Unpair", fg_color="#334155", hover_color="#475569", width=90, command=self.unpair_servers)
        self.btn_unpair.pack(side="left", padx=10)

        self.pair_status_lbl = ctk.CTkLabel(p_act_frame, text="Status: Checking pairing...", font=ctk.CTkFont(size=12), text_color="#94a3b8")
        self.pair_status_lbl.pack(side="left", padx=16)

        # Sync Action Box
        sync_act_box = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        sync_act_box.pack(fill="x", padx=10, pady=10)

        ctk.CTkLabel(sync_act_box, text="Two-Way File Synchronization", font=ctk.CTkFont(size=14, weight="bold")).pack(anchor="w", padx=16, pady=(12, 4))

        act_top = ctk.CTkFrame(sync_act_box, fg_color="transparent")
        act_top.pack(fill="x", padx=16, pady=6)

        self.btn_sync_now = ctk.CTkButton(
            act_top,
            text="⚡ Sync Files Now",
            font=ctk.CTkFont(size=14, weight="bold"),
            fg_color="#10b981",
            hover_color="#059669",
            height=40,
            width=200,
            command=self.start_manual_sync
        )
        self.btn_sync_now.pack(side="left")

        self.sync_phase_lbl = ctk.CTkLabel(act_top, text="Phase: Idle", font=ctk.CTkFont(size=13, weight="bold"), text_color="#38bdf8")
        self.sync_phase_lbl.pack(side="left", padx=20)

        self.sync_progress_bar = ctk.CTkProgressBar(sync_act_box, height=12, fg_color="#1e293b", progress_color="#38bdf8")
        self.sync_progress_bar.pack(fill="x", padx=16, pady=(10, 6))
        self.sync_progress_bar.set(0)

        self.sync_stats_lbl = ctk.CTkLabel(
            sync_act_box,
            text="Completed: 0 / 0 files · 0.0 / 0.0 MB transferred · No conflicts",
            font=ctk.CTkFont(size=12),
            text_color="#94a3b8"
        )
        self.sync_stats_lbl.pack(anchor="w", padx=16, pady=(2, 14))

        # Auto-Sync Schedule Box
        sched_box = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        sched_box.pack(fill="x", padx=10, pady=6)

        s_grid = ctk.CTkFrame(sched_box, fg_color="transparent")
        s_grid.pack(fill="x", padx=16, pady=12)

        self.auto_sync_switch = ctk.CTkSwitch(
            s_grid,
            text="Enable Background Scheduled Auto-Sync",
            command=self.on_auto_sync_toggle
        )
        if self.station_config.get("auto_sync_enabled", False):
            self.auto_sync_switch.select()
        self.auto_sync_switch.pack(side="left")

        self.sync_interval_menu = ctk.CTkOptionMenu(
            s_grid,
            values=["Every 15 minutes", "Every 30 minutes", "Every 1 hour", "Every 4 hours"],
            command=self.on_sync_interval_change
        )
        interval_m = self.station_config.get("auto_sync_interval_minutes", 30)
        mapping = {15: "Every 15 minutes", 30: "Every 30 minutes", 60: "Every 1 hour", 240: "Every 4 hours"}
        self.sync_interval_menu.set(mapping.get(interval_m, "Every 30 minutes"))
        self.sync_interval_menu.pack(side="left", padx=20)

        self.last_sync_lbl = ctk.CTkLabel(s_grid, text="Last sync: Never", font=ctk.CTkFont(size=12), text_color="#64748b")
        self.last_sync_lbl.pack(side="right")

    # ---------- TAB 3: SETTINGS & STORAGE ----------
    def build_settings_tab(self):
        tab = self.tab_settings
        tab.grid_columnconfigure(0, weight=1)

        auto_box = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        auto_box.pack(fill="x", padx=10, pady=10)

        ctk.CTkLabel(auto_box, text="Background & System Automation", font=ctk.CTkFont(size=14, weight="bold")).pack(anchor="w", padx=16, pady=(12, 6))

        self.chk_boot = ctk.CTkCheckBox(auto_box, text="Launch Lumin Server Station on Windows Boot", command=self.on_boot_toggle)
        if is_windows_startup_enabled():
            self.chk_boot.select()
        self.chk_boot.pack(anchor="w", padx=16, pady=6)

        self.chk_auto_server = ctk.CTkCheckBox(auto_box, text="Automatically start Storage Server when application opens", command=self.save_station_settings)
        if self.station_config.get("auto_start_server", True):
            self.chk_auto_server.select()
        self.chk_auto_server.pack(anchor="w", padx=16, pady=6)

        self.chk_auto_tailscale = ctk.CTkCheckBox(auto_box, text="Automatically enable Tailscale Funnel and sync URL to Supabase on launch", command=self.save_station_settings)
        if self.station_config.get("auto_enable_tailscale", True):
            self.chk_auto_tailscale.select()
        self.chk_auto_tailscale.pack(anchor="w", padx=16, pady=6)

        self.chk_tray = ctk.CTkCheckBox(auto_box, text="Closing window minimizes to System Tray (keeps server & sync active)", command=self.save_station_settings)
        if self.station_config.get("minimize_to_tray", True):
            self.chk_tray.select()
        self.chk_tray.pack(anchor="w", padx=16, pady=(6, 14))

        store_box = ctk.CTkFrame(tab, corner_radius=10, fg_color="#0f172a", border_width=1, border_color="#334155")
        store_box.pack(fill="x", padx=10, pady=10)

        ctk.CTkLabel(store_box, text="Storage Folder & Server Parameters", font=ctk.CTkFont(size=14, weight="bold")).pack(anchor="w", padx=16, pady=(12, 6))

        s_grid = ctk.CTkFrame(store_box, fg_color="transparent")
        s_grid.pack(fill="x", padx=16, pady=6)
        s_grid.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(s_grid, text="Storage Root Directory:").grid(row=0, column=0, sticky="w", pady=6)
        path_row = ctk.CTkFrame(s_grid, fg_color="transparent")
        path_row.grid(row=0, column=1, sticky="ew", padx=10, pady=6)
        path_row.grid_columnconfigure(0, weight=1)

        self.storage_path_entry = ctk.CTkEntry(path_row)
        self.storage_path_entry.insert(0, self.server_config.get("storage_path", "D:\\LuminStorage\\Patients"))
        self.storage_path_entry.grid(row=0, column=0, sticky="ew")

        btn_browse = ctk.CTkButton(path_row, text="Browse...", width=90, fg_color="#334155", hover_color="#475569", command=self.browse_storage_path)
        btn_browse.grid(row=0, column=1, padx=(8, 0))

        ctk.CTkLabel(s_grid, text="Server Port:").grid(row=1, column=0, sticky="w", pady=6)
        self.port_entry = ctk.CTkEntry(s_grid, width=120)
        self.port_entry.insert(0, str(self.server_config.get("port", 5000)))
        self.port_entry.grid(row=1, column=1, sticky="w", padx=10, pady=6)

        ctk.CTkLabel(s_grid, text="Clinic Secret Key:").grid(row=2, column=0, sticky="w", pady=6)
        self.clinic_key_entry = ctk.CTkEntry(s_grid)
        self.clinic_key_entry.insert(0, str(self.server_config.get("clinic_secret_key", "")))
        self.clinic_key_entry.grid(row=2, column=1, sticky="ew", padx=10, pady=6)

        btn_save = ctk.CTkButton(store_box, text="💾 Save Configuration", fg_color="#2563eb", hover_color="#1d4ed8", width=180, command=self.save_server_settings)
        btn_save.pack(anchor="w", padx=16, pady=(10, 16))

    # ---------- TAB 4: LIVE LOGS ----------
    def build_logs_tab(self):
        tab = self.tab_logs
        tab.grid_columnconfigure(0, weight=1)
        tab.grid_rowconfigure(1, weight=1)

        top_row = ctk.CTkFrame(tab, fg_color="transparent")
        top_row.grid(row=0, column=0, sticky="ew", padx=10, pady=6)

        btn_clear = ctk.CTkButton(top_row, text="Clear Logs", width=100, fg_color="#334155", hover_color="#475569", command=self.clear_logs)
        btn_clear.pack(side="left")

        btn_open = ctk.CTkButton(top_row, text="Open Log File", width=120, fg_color="#334155", hover_color="#475569", command=self.open_log_file)
        btn_open.pack(side="left", padx=10)

        self.log_textbox = ctk.CTkTextbox(
            tab,
            corner_radius=8,
            fg_color="#090d16",
            text_color="#94a3b8",
            font=ctk.CTkFont(family="Consolas", size=11),
            wrap="none"
        )
        self.log_textbox.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
        self.log_textbox.configure(state="disabled")

    # ---------------- CONTROLLER LOGIC ----------------
    def open_web_dashboard(self):
        port = self.server_config.get("port", 5000)
        url = f"http://localhost:{port}"
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass

    def browse_storage_path(self):
        from tkinter import filedialog
        folder = filedialog.askdirectory(initialdir=self.storage_path_entry.get(), title="Select Patient Storage Root Folder")
        if folder:
            self.storage_path_entry.delete(0, "end")
            self.storage_path_entry.insert(0, os.path.normpath(folder))

    def save_server_settings(self):
        try:
            port = int(self.port_entry.get().strip())
            path_val = self.storage_path_entry.get().strip()
            key_val = self.clinic_key_entry.get().strip()

            self.server_config["port"] = port
            self.server_config["storage_path"] = path_val
            self.server_config["clinic_secret_key"] = key_val

            if save_json(CONFIG_FILE, self.server_config):
                self.log("Server configuration saved. Restart server to apply changes.", "SUCCESS")
                self.update_disk_usage()
        except Exception as e:
            self.log(f"Failed to save settings: {e}", "ERROR")

    def save_station_settings(self):
        self.station_config["auto_start_server"] = bool(self.chk_auto_server.get())
        self.station_config["auto_enable_tailscale"] = bool(self.chk_auto_tailscale.get())
        self.station_config["minimize_to_tray"] = bool(self.chk_tray.get())
        save_json(STATION_CONFIG_FILE, self.station_config)

    def on_boot_toggle(self):
        enabled = bool(self.chk_boot.get())
        set_windows_startup(enabled)
        self.station_config["start_on_boot"] = enabled
        save_json(STATION_CONFIG_FILE, self.station_config)
        self.log(f"Windows startup {'enabled' if enabled else 'disabled'}.", "INFO")

    def on_role_change(self, role):
        self.station_config["server_role"] = role
        save_json(STATION_CONFIG_FILE, self.station_config)
        self.log(f"Node role set to {role}.", "INFO")

    def on_auto_sync_toggle(self):
        enabled = bool(self.auto_sync_switch.get())
        self.station_config["auto_sync_enabled"] = enabled
        save_json(STATION_CONFIG_FILE, self.station_config)
        self.log(f"Scheduled auto-sync {'activated' if enabled else 'deactivated'}.", "INFO")

    def on_sync_interval_change(self, choice):
        mapping = {"Every 15 minutes": 15, "Every 30 minutes": 30, "Every 1 hour": 60, "Every 4 hours": 240}
        self.station_config["auto_sync_interval_minutes"] = mapping.get(choice, 30)
        save_json(STATION_CONFIG_FILE, self.station_config)
        self.log(f"Auto-sync interval set to {choice}.", "INFO")

    def clear_logs(self):
        self.log_textbox.configure(state="normal")
        self.log_textbox.delete("1.0", "end")
        self.log_textbox.configure(state="disabled")

    def open_log_file(self):
        if LOG_FILE.exists():
            os.startfile(str(LOG_FILE))

    def copy_ts_url(self):
        url = self.ts_url_entry.get().strip()
        if url:
            self.clipboard_clear()
            self.clipboard_append(url)
            self.log(f"Copied Tailscale URL: {url}", "INFO")

    # ---------- SERVER MANAGEMENT (IN-PROCESS WERKZEUG) ----------
    def start_server(self):
        if self.http_server:
            return

        port = self.server_config.get("port", 5000)
        self.log(f"Starting storage server on port {port}...", "INFO")

        def run_srv():
            try:
                if str(BASE_DIR) not in sys.path:
                    sys.path.insert(0, str(BASE_DIR))
                import server
                self.http_server = make_server('0.0.0.0', port, server.app, threaded=True)
                self.server_start_time = time.time()
                self.after(0, self._on_server_started)
                self.http_server.serve_forever()
            except Exception as e:
                self.log(f"Server error: {e}", "ERROR")
                self.after(0, self._on_server_stopped)

        self.server_thread = threading.Thread(target=run_srv, daemon=True, name="LuminHttpServer")
        self.server_thread.start()

    def _on_server_started(self):
        self.btn_start_server.configure(state="disabled")
        self.btn_stop_server.configure(state="normal")
        self.btn_restart_server.configure(state="normal")
        self.server_badge.configure(text="● ONLINE", text_color="#10b981", fg_color="#064e3b")
        port = self.server_config.get("port", 5000)
        self.log(f"Storage server is ONLINE at http://localhost:{port} (LAN IP: {get_local_ip()})", "SUCCESS")

    def stop_server(self):
        if self.http_server:
            self.log("Stopping storage server...", "INFO")
            try:
                self.http_server.shutdown()
            except Exception:
                pass
            self.http_server = None
            self.server_thread = None
            self.server_start_time = None
        self._on_server_stopped()

    def _on_server_stopped(self):
        self.btn_start_server.configure(state="normal")
        self.btn_stop_server.configure(state="disabled")
        self.btn_restart_server.configure(state="disabled")
        self.server_badge.configure(text="● OFFLINE", text_color="#ef4444", fg_color="#451a1a")
        self.server_uptime_lbl.configure(text="Uptime: --:--:--")
        self.server_details_lbl.configure(text=f"Address: http://localhost:{self.server_config.get('port', 5000)}\nStatus: Idle")
        self.log("Storage server stopped.", "INFO")

    def restart_server(self):
        self.stop_server()
        self.after(800, self.start_server)

    # ---------- TAILSCALE MANAGEMENT ----------
    def refresh_tailscale_status(self):
        info = get_tailscale_info()
        self.ts_info = info
        self.after(0, lambda: self._update_ts_ui(info))

    def _update_ts_ui(self, info):
        if not info["installed"]:
            self.ts_badge.configure(text="● NOT INSTALLED", text_color="#94a3b8", fg_color="#1e293b")
            self.ts_url_entry.configure(state="normal")
            self.ts_url_entry.delete(0, "end")
            self.ts_url_entry.insert(0, "Install Tailscale from tailscale.com")
            self.ts_url_entry.configure(state="readonly")
            self.ts_ip_lbl.configure(text="Tailscale IP: Not Installed")
            self.ts_supabase_lbl.configure(text="Supabase: Offline")
            return

        if not info["running"]:
            self.ts_badge.configure(text="● TAILSCALE STOPPED", text_color="#ef4444", fg_color="#451a1a")
            self.ts_url_entry.configure(state="normal")
            self.ts_url_entry.delete(0, "end")
            self.ts_url_entry.insert(0, "Sign in and connect Tailscale")
            self.ts_url_entry.configure(state="readonly")
            self.ts_ip_lbl.configure(text="Tailscale IP: Stopped")
            self.ts_supabase_lbl.configure(text="Supabase: Offline")
            return

        # Running
        url = info["url"]
        self.ts_url_entry.configure(state="normal")
        self.ts_url_entry.delete(0, "end")
        self.ts_url_entry.insert(0, url or "No domain name")
        self.ts_url_entry.configure(state="readonly")
        self.ts_ip_lbl.configure(text=f"Tailnet IP: {info['ip'] or '--'} | Host: {info['host']}")

        if info["funnel"]:
            self.ts_badge.configure(text="● FUNNEL ACTIVE (HTTPS)", text_color="#10b981", fg_color="#064e3b")
            self.btn_enable_funnel.configure(state="disabled")
            self.btn_disable_funnel.configure(state="normal")
        else:
            self.ts_badge.configure(text="● TAILNET ONLY", text_color="#0284c7", fg_color="#082f49")
            self.btn_enable_funnel.configure(state="normal")
            self.btn_disable_funnel.configure(state="disabled")

        if self.tailscale_supabase_synced:
            self.ts_supabase_lbl.configure(text="✓ Supabase: Synced", text_color="#10b981")
        else:
            self.ts_supabase_lbl.configure(text="Supabase: Not Synced", text_color="#64748b")

    def enable_tailscale_funnel(self):
        exe = get_tailscale_binary()
        if not exe:
            self.log("Tailscale is not installed on this computer.", "ERROR")
            return

        port = self.server_config.get("port", 5000)
        self.log(f"Configuring Tailscale Funnel for port {port}...", "INFO")

        def worker():
            try:
                cmd = [exe, "funnel", "--bg", "--https=443", f"http://127.0.0.1:{port}"]
                res = run_silent_cmd(cmd, timeout=25)
                if res.returncode == 0:
                    self.log("Tailscale Funnel enabled successfully on port 443.", "SUCCESS")
                else:
                    self.log(f"Tailscale funnel output: {res.stderr or res.stdout}", "INFO")

                # Refresh and auto-sync to Supabase
                info = get_tailscale_info()
                self.ts_info = info
                self.after(0, lambda: self._update_ts_ui(info))

                if info["url"]:
                    key = self.server_config.get("clinic_secret_key", "")
                    synced = sync_url_to_supabase(info["url"], key)
                    if synced:
                        self.tailscale_supabase_synced = True
                        self.log(f"Registered Tailscale URL with Supabase: {info['url']}", "SUCCESS")
                        self.after(0, lambda: self.ts_supabase_lbl.configure(text="✓ Supabase: Synced", text_color="#10b981"))
            except Exception as e:
                self.log(f"Error enabling Tailscale Funnel: {e}", "ERROR")

        threading.Thread(target=worker, daemon=True).start()

    def disable_tailscale_funnel(self):
        exe = get_tailscale_binary()
        if not exe:
            return

        self.log("Disabling Tailscale Funnel...", "INFO")
        def worker():
            try:
                run_silent_cmd([exe, "funnel", "--https=443", "off"], timeout=15)
                self.log("Tailscale Funnel turned off.", "INFO")
                self.tailscale_supabase_synced = False
                self.refresh_tailscale_status()
            except Exception as e:
                self.log(f"Error turning off Tailscale Funnel: {e}", "ERROR")

        threading.Thread(target=worker, daemon=True).start()

    def sync_tailscale_to_supabase(self):
        info = get_tailscale_info()
        url = info.get("url")
        if not url:
            self.log("No Tailscale URL detected to sync.", "WARNING")
            return

        key = self.server_config.get("clinic_secret_key", "")
        self.log(f"Syncing Tailscale URL ({url}) to Supabase...", "INFO")

        def worker():
            synced = sync_url_to_supabase(url, key)
            if synced:
                self.tailscale_supabase_synced = True
                self.log("Tailscale storage URL registered in Supabase.", "SUCCESS")
                self.after(0, lambda: self.ts_supabase_lbl.configure(text="✓ Supabase: Synced", text_color="#10b981"))
            else:
                self.log("Could not update Supabase. Verify internet connection.", "ERROR")

        threading.Thread(target=worker, daemon=True).start()

    # ---------- SYNC ACTIONS ----------
    def pair_servers(self):
        remote_url = self.peer_url_entry.get().strip().rstrip("/")
        remote_key = self.peer_key_entry.get().strip()

        if not remote_url:
            self.log("Enter the Remote Server URL first.", "WARNING")
            return

        self.station_config["peer_url"] = remote_url
        self.station_config["peer_key"] = remote_key
        save_json(STATION_CONFIG_FILE, self.station_config)

        port = self.server_config.get("port", 5000)
        local_key = self.server_config.get("clinic_secret_key", "")

        self.log(f"Pairing coordinator with remote peer at {remote_url}...", "INFO")
        threading.Thread(target=self._pair_worker, args=(port, local_key, remote_url, remote_key), daemon=True).start()

    def _pair_worker(self, port, local_key, remote_url, remote_key):
        req_url = f"http://127.0.0.1:{port}/api/sync/pair"
        payload = json.dumps({"url": remote_url, "key": remote_key}).encode("utf-8")
        headers = {"Content-Type": "application/json", "x-lumin-key": local_key}

        try:
            req = urllib.request.Request(req_url, data=payload, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.load(resp)
                if data.get("paired"):
                    peer_id = data.get("peerId", "")
                    self.log(f"Successfully paired with remote peer ({peer_id[:8]}...)!", "SUCCESS")
                    self.after(0, lambda: self.pair_status_lbl.configure(text=f"✓ Paired ({peer_id[:8]}...)", text_color="#10b981"))
        except urllib.error.HTTPError as he:
            try:
                raw = he.read().decode('utf-8', errors='replace')
                body = json.loads(raw)
                detail = body.get('error') or raw
            except Exception:
                detail = f"HTTP {he.code}"
            if he.code == 401:
                self.log(f"Pairing failed (401 Unauthorized): {detail}. Ensure the Remote Clinic Key matches, and verify the remote computer is running the updated Lumin Server Station.", "ERROR")
            elif he.code == 409:
                self.log(f"Pairing conflict (409): {detail}", "ERROR")
            else:
                self.log(f"Pairing failed ({he.code}): {detail}", "ERROR")
            self.after(0, lambda: self.pair_status_lbl.configure(text=f"✗ Pairing failed ({he.code})", text_color="#ef4444"))
        except Exception as e:
            self.log(f"Pairing error: {e}", "ERROR")
            self.after(0, lambda: self.pair_status_lbl.configure(text="✗ Pairing error", text_color="#ef4444"))

    def unpair_servers(self):
        port = self.server_config.get("port", 5000)
        local_key = self.server_config.get("clinic_secret_key", "")
        req_url = f"http://127.0.0.1:{port}/api/sync/unpair"
        headers = {"x-lumin-key": local_key}

        try:
            req = urllib.request.Request(req_url, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                self.log("Unpaired successfully.", "INFO")
                self.pair_status_lbl.configure(text="Not Paired", text_color="#94a3b8")
        except Exception as e:
            self.log(f"Unpair error: {e}", "ERROR")

    def start_manual_sync(self):
        if self.is_syncing:
            self.log("Sync already in progress.", "WARNING")
            return

        port = self.server_config.get("port", 5000)
        local_key = self.server_config.get("clinic_secret_key", "")
        self.is_syncing = True
        self.btn_sync_now.configure(state="disabled", text="Syncing in Progress...")
        self.sync_phase_lbl.configure(text="Phase: Starting...", text_color="#f59e0b")

        threading.Thread(target=self._start_sync_job_worker, args=(port, local_key), daemon=True).start()

    def _start_sync_job_worker(self, port, local_key):
        req_url = f"http://127.0.0.1:{port}/api/sync/jobs"
        headers = {"x-lumin-key": local_key}

        try:
            req = urllib.request.Request(req_url, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                job = json.load(resp)
                self.log(f"Sync job started (ID: {job.get('id')})", "INFO")
                self.active_sync_job = job
        except urllib.error.HTTPError as he:
            err_msg = he.read().decode('utf-8', errors='replace')
            self.log(f"Sync failed: {err_msg}", "ERROR")
            self.is_syncing = False
            self.after(0, lambda: self.btn_sync_now.configure(state="normal", text="⚡ Sync Files Now"))
            self.after(0, lambda: self.sync_phase_lbl.configure(text="Phase: Failed", text_color="#ef4444"))
        except Exception as e:
            self.log(f"Sync failed: {e}", "ERROR")
            self.is_syncing = False
            self.after(0, lambda: self.btn_sync_now.configure(state="normal", text="⚡ Sync Files Now"))
            self.after(0, lambda: self.sync_phase_lbl.configure(text="Phase: Failed", text_color="#ef4444"))

    # ---------- MONITOR LOOP ----------
    def background_monitor_loop(self):
        last_auto_sync = 0
        last_ts_poll = 0

        while self.running:
            try:
                port = self.server_config.get("port", 5000)
                is_running = False

                if self.http_server:
                    is_running = True
                    uptime_str = "--:--:--"
                    if self.server_start_time:
                        sec = int(time.time() - self.server_start_time)
                        h, rem = divmod(sec, 3600)
                        m, s = divmod(rem, 60)
                        uptime_str = f"{h:02d}:{m:02d}:{s:02d}"
                    self.after(0, lambda u=uptime_str, p=port: self._update_server_live_ui(u, p))
                else:
                    self.after(0, self._update_server_dead_ui)

                # Tailscale Status Refresh (every 15 seconds)
                now = time.time()
                if now - last_ts_poll >= 15:
                    last_ts_poll = now
                    self.refresh_tailscale_status()

                # Poll active sync job
                if is_running:
                    self.poll_active_sync_job(port)

                # Scheduled auto-sync
                if (is_running and self.station_config.get("auto_sync_enabled", False)
                        and self.station_config.get("server_role") == "coordinator" and not self.is_syncing):
                    interval = self.station_config.get("auto_sync_interval_minutes", 30) * 60
                    if now - last_auto_sync >= interval:
                        last_auto_sync = now
                        self.log("Triggering scheduled background synchronization...", "INFO")
                        self.after(0, self.start_manual_sync)

                # Disk Usage
                self.after(0, self.update_disk_usage)

            except Exception:
                pass

            time.sleep(2)

    def _update_server_live_ui(self, uptime, port):
        self.server_uptime_lbl.configure(text=f"Uptime: {uptime}")
        self.server_details_lbl.configure(text=f"Address: http://localhost:{port}\nStatus: Listening · LAN: http://{get_local_ip()}:{port}")

    def _update_server_dead_ui(self):
        self.server_uptime_lbl.configure(text="Uptime: --:--:--")
        self.server_details_lbl.configure(text=f"Address: http://localhost:{self.server_config.get('port', 5000)}\nStatus: Idle")

    def poll_active_sync_job(self, port):
        local_key = self.server_config.get("clinic_secret_key", "")
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/api/sync/jobs/latest", headers={"x-lumin-key": local_key})
            with urllib.request.urlopen(req, timeout=2) as resp:
                data = json.load(resp)
                job = data.get("job")
                if job:
                    self.after(0, lambda j=job: self._update_sync_ui_with_job(j))
        except Exception:
            pass

    def _update_sync_ui_with_job(self, job):
        status = job.get("status")
        phase = job.get("phase", "idle")
        total_files = job.get("totalFiles", 0)
        completed_files = job.get("completedFiles", 0)
        total_bytes = job.get("totalBytes", 0)
        transferred_bytes = job.get("transferredBytes", 0)
        conflicts = job.get("conflicts", [])

        if status == "running":
            self.is_syncing = True
            self.btn_sync_now.configure(state="disabled", text="Syncing in Progress...")
            self.sync_phase_lbl.configure(text=f"Phase: {phase.capitalize()}", text_color="#38bdf8")

            pct = 0.0
            if total_bytes > 0:
                pct = transferred_bytes / total_bytes
            elif total_files > 0:
                pct = completed_files / total_files
            self.sync_progress_bar.set(min(1.0, max(0.0, pct)))

        elif status in ("completed", "completed_with_conflicts"):
            self.is_syncing = False
            self.btn_sync_now.configure(state="normal", text="⚡ Sync Files Now")
            self.sync_progress_bar.set(1.0)
            self.last_sync_time = datetime.now().strftime("%Y-%m-%d %H:%M")
            self.last_sync_lbl.configure(text=f"Last sync: {self.last_sync_time}")

            if status == "completed_with_conflicts":
                self.sync_phase_lbl.configure(text="Finished (Preserved Conflicts)", text_color="#f59e0b")
            else:
                self.sync_phase_lbl.configure(text="Phase: Completed Successfully", text_color="#10b981")

        elif status == "failed":
            self.is_syncing = False
            self.btn_sync_now.configure(state="normal", text="⚡ Retry Sync")
            self.sync_phase_lbl.configure(text="Phase: Failed (Check Logs)", text_color="#ef4444")

        mb_transferred = transferred_bytes / (1024 * 1024)
        mb_total = total_bytes / (1024 * 1024)
        conflict_msg = f"{len(conflicts)} conflicts preserved" if conflicts else "No conflicts"
        self.sync_stats_lbl.configure(
            text=f"Completed: {completed_files} / {total_files} files · {mb_transferred:.1f} / {mb_total:.1f} MB · {conflict_msg}"
        )

    def update_disk_usage(self):
        try:
            path_str = self.server_config.get("storage_path", "D:\\LuminStorage\\Patients")
            path = Path(path_str)
            check_path = path
            while not check_path.exists() and check_path.parent != check_path:
                check_path = check_path.parent

            if check_path.exists():
                usage = shutil.disk_usage(str(check_path))
                free_gb = usage.free / (1024 ** 3)
                total_gb = usage.total / (1024 ** 3)
                used_ratio = (usage.total - usage.free) / usage.total

                drive = Path(check_path).drive or str(check_path)
                self.disk_info_lbl.configure(
                    text=f"Drive {drive} | Free: {free_gb:.1f} GB / {total_gb:.1f} GB ({int((1-used_ratio)*100)}% available) | Target: {path_str}"
                )
                self.disk_bar.set(used_ratio)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        app = ServerStationApp()
        app.mainloop()
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(f"[{datetime.now().strftime('%H:%M:%S')}] [CRITICAL] {e}\n{tb}\n")
        except Exception:
            pass
        raise
