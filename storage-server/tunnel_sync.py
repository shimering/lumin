"""
Lumin Dental Clinic - Automated Storage Server & Tunnel Synchronizer
Runs both the local storage server and Cloudflare Tunnel, automatically
detects the live trycloudflare.com URL, and syncs it directly to Supabase
so all iPads, phones, and PCs connect seamlessly with ZERO manual configuration.
"""

import os
import re
import sys
import time
import json
import urllib.request
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).parent.resolve()
CONFIG_FILE = BASE_DIR / "config.json"
CLOUDFLARED_EXE = BASE_DIR / "cloudflared.exe"
PYTHON_EXE = BASE_DIR / ".venv" / "Scripts" / "python.exe"

# Supabase configuration
SUPABASE_URL = "https://pqbayjkypzfxvnksgwwf.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxYmF5amt5cHpmeHZua3Nnd3dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMjI4NzAsImV4cCI6MjEwNDY5ODg3MH0.e5tPe3PKUiFiS_ZnXcpDF9CRtGtp_B1oZsK37phOQ8Q"
CLINIC_KEY = "LuminClinicKey_2026"

if not PYTHON_EXE.exists():
    PYTHON_EXE = Path(sys.executable)

def load_clinic_key():
    global CLINIC_KEY
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                c = json.load(f)
                CLINIC_KEY = c.get("clinic_secret_key", CLINIC_KEY)
        except Exception:
            pass
    return CLINIC_KEY

def sync_url_to_supabase(tunnel_url: str) -> bool:
    """Send the newly generated Cloudflare Tunnel URL to Supabase."""
    rpc_endpoint = f"{SUPABASE_URL}/rest/v1/rpc/update_clinic_storage_url"
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Content-Type": "application/json"
    }
    payload = json.dumps({
        "new_url": tunnel_url,
        "clinic_key": CLINIC_KEY
    }).encode("utf-8")

    try:
        req = urllib.request.Request(rpc_endpoint, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8").strip()
            return body in ("true", "True", "1")
    except Exception as e:
        print(f"[!] Failed to sync URL to Supabase: {e}")
        return False

def check_server_running() -> bool:
    try:
        with urllib.request.urlopen("http://localhost:5000/api/health", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False

def main():
    print("=" * 60)
    print("   LUMIN DENTAL CLINIC - AUTOMATED STORAGE & TUNNEL")
    print("=" * 60)
    print()

    load_clinic_key()

    # 1. Ensure local storage server is running
    server_proc = None
    if not check_server_running():
        print("[*] Starting local storage server on port 5000...")
        server_py = BASE_DIR / "server.py"
        server_proc = subprocess.Popen(
            [str(PYTHON_EXE), str(server_py)],
            cwd=str(BASE_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        time.sleep(2)
        if check_server_running():
            print("[OK] Local storage server is ONLINE!")
        else:
            print("[!] Waiting for server to initialize...")
            time.sleep(3)
    else:
        print("[OK] Local storage server is already running on port 5000.")

    # 2. Check cloudflared binary
    if not CLOUDFLARED_EXE.exists():
        print(f"[!] cloudflared.exe not found in {BASE_DIR}. Please run start-tunnel.bat once to download it.")
        sys.exit(1)

    # 3. Start Cloudflare Tunnel and capture output
    print("[*] Starting Cloudflare Tunnel...")
    tunnel_cmd = [str(CLOUDFLARED_EXE), "tunnel", "--url", "http://localhost:5000"]

    tunnel_proc = subprocess.Popen(
        tunnel_cmd,
        cwd=str(BASE_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace"
    )

    tunnel_url = None
    url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")

    print("[*] Negotiating connection with Cloudflare...")
    while True:
        line = tunnel_proc.stdout.readline()
        if not line and tunnel_proc.poll() is not None:
            print("[!] Cloudflare Tunnel process exited prematurely.")
            break

        if not line:
            continue

        match = url_pattern.search(line)
        if match:
            tunnel_url = match.group(0)
            print()
            print("+" + "-" * 58 + "+")
            print(f"| LIVE CLOUDFLARE TUNNEL URL:                              |")
            print(f"| {tunnel_url.ljust(56)} |")
            print("+" + "-" * 58 + "+")
            print()

            # 4. Automatically sync to Supabase!
            print("[*] Synchronizing URL with Lumin cloud database...")
            if sync_url_to_supabase(tunnel_url):
                print("[SUCCESS] Live URL automatically synced to Supabase!")
                print("[OK] All iPads, mobile phones, and clinic computers are connected!")
                print("[INFO] You DO NOT need to copy or paste anything into the app.")
                print()
            else:
                print("[!] Could not auto-sync to database. Please paste the URL into Admin -> Storage & X-Rays manually.")

            print("=" * 60)
            print("Storage server & tunnel are ACTIVE. Keep this window minimized.")
            print("Press Ctrl+C to stop.")
            print("=" * 60)
            break

    # Keep running and stream output
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[*] Stopping tunnel and server...")
        if tunnel_proc:
            tunnel_proc.terminate()
        if server_proc:
            server_proc.terminate()
        print("[OK] Stopped successfully.")

if __name__ == "__main__":
    main()
