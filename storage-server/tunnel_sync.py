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
import argparse
import queue
import threading
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

def check_server_running(url: str = "http://127.0.0.1:5000") -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=3) as resp:
            health = json.load(resp)
            return (resp.status == 200 and health.get("status") == "online"
                    and health.get("service") == "Lumin Local Storage Server")
    except Exception:
        return False


def load_origin_url() -> str:
    config = {}
    if CONFIG_FILE.exists():
        with CONFIG_FILE.open(encoding="utf-8") as config_file:
            config = json.load(config_file)
    port = int(config.get("port", 5000))
    if not 1 <= port <= 65535:
        raise ValueError("config.json port must be between 1 and 65535")
    return f"http://127.0.0.1:{port}"


def get_local_ip() -> str:
    """Detect the local machine IP on the clinic LAN."""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(('10.254.254.254', 1))
        ip = s.getsockname()[0]
        s.close()
        if ip and ip != '127.0.0.1':
            return ip
    except Exception:
        pass
    return ""


def stop_process(process):
    """Only stop child processes created by this launcher."""
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def wait_for_server(process, origin_url, timeout=30) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            print(f"[ERROR] Storage server exited with code {process.returncode}. See server.log.")
            return False
        if check_server_running(origin_url):
            return True
        time.sleep(0.5)
    print("[ERROR] Storage server did not become ready. See server.log.")
    return False


def read_tunnel_output(process, output):
    # Drain the pipe for the entire lifetime of the tunnel, including after startup.
    try:
        for line in process.stdout:
            output.put(line)
    finally:
        output.put(None)


def run_tunnel(origin_url, protocol, server_proc=None, sync_url=True, timeout=90):
    command = [str(CLOUDFLARED_EXE), "tunnel", "--no-autoupdate",
               "--protocol", protocol, "--url", origin_url]
    print(f"[*] Starting Cloudflare Tunnel ({protocol}) -> {origin_url}")
    process = subprocess.Popen(command, cwd=str(BASE_DIR), stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, bufsize=1,
                               encoding="utf-8", errors="replace")
    output = queue.Queue()
    reader = threading.Thread(target=read_tunnel_output, args=(process, output), daemon=True)
    reader.start()
    tunnel_url = None
    ready = False
    registered = False
    deadline = time.monotonic() + timeout
    next_health_check = 0
    dns_error = False
    url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
    try:
        with (BASE_DIR / "tunnel.log").open("a", encoding="utf-8") as log:
            log.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} protocol={protocol} ---\n")
            log.flush()
            while True:
                if server_proc is not None and server_proc.poll() is not None:
                    print("[ERROR] Storage server stopped. See server.log.")
                    return 1
                try:
                    line = output.get(timeout=0.5)
                except queue.Empty:
                    line = ""
                if line is None:
                    code = process.wait(timeout=5)
                    print(f"[ERROR] Cloudflare Tunnel stopped (exit code {code}). See tunnel.log.")
                    if dns_error:
                        print("\n" + "=" * 65)
                        print("  [!] DIAGNOSIS: DNS / INTERNET CONNECTION ERROR")
                        print("=" * 65)
                        print("  cloudflared could not resolve 'api.trycloudflare.com'.")
                        print("  Likely causes:")
                        print("   1. The Mini PC is not connected to the internet (check Wi-Fi/cable).")
                        print("   2. The DNS server cannot resolve Cloudflare. In Windows network")
                        print("      settings, set IPv4 DNS to 1.1.1.1 or 8.8.8.8.")
                        print("   3. Your ISP or router is blocking trycloudflare.com.")
                        print("\n  CLINIC LOCAL LAN ALTERNATIVE (No Internet Required):")
                        print("   If your iPads & computers are connected to the same clinic Wi-Fi,")
                        print("   you can run 'start-server.bat' instead and access storage via")
                        print("   your local IP address (e.g. http://192.168.1.xxx:5000).")
                        print("=" * 65 + "\n")
                    return code or 1
                if line:
                    print(line.rstrip(), flush=True)
                    log.write(line)
                    log.flush()
                    if "no such host" in line.lower() or "lookup api.trycloudflare.com" in line.lower():
                        dns_error = True
                    match = url_pattern.search(line)
                    if match:
                        tunnel_url = match.group(0)
                    if "Registered tunnel connection" in line:
                        registered = True
                    # Avoid waiting through repeated QUIC timeouts on restrictive networks.
                    lower_line = line.lower()
                    if (protocol == "auto" and not ready and "quic" in lower_line
                            and ("failed to dial" in lower_line or "handshake did not complete" in lower_line)):
                        print("[!] QUIC connection failed. Retrying over HTTP/2 (TCP port 7844).")
                        return "http2"
                now = time.monotonic()
                if not ready and now >= deadline:
                    print(f"[ERROR] Tunnel did not become reachable within {timeout} seconds. See tunnel.log.")
                    print("[*] Check outbound Cloudflare connectivity on port 7844 and api.trycloudflare.com on port 443.")
                    return 1
                if not ready and registered and tunnel_url and now >= next_health_check:
                    next_health_check = now + 5
                    if check_server_running(tunnel_url):
                        ready = True
                        print(f"[OK] Storage server is reachable through {tunnel_url}")
                        if sync_url:
                            print("[*] Synchronizing the verified URL with Lumin...")
                            if sync_url_to_supabase(tunnel_url):
                                print("[SUCCESS] Storage URL synced to Lumin.")
                            else:
                                print("[!] Auto-sync failed. Paste the verified URL into Admin -> Storage & X-Rays.")
                        print("[OK] Keep this window open. Press Ctrl+C to stop.")
    finally:
        stop_process(process)
        reader.join(timeout=5)
        process.stdout.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run Lumin storage and monitor its Cloudflare tunnel.")
    parser.add_argument("--http2", action="store_true", help="Use TCP instead of QUIC for restricted networks.")
    parser.add_argument("--tunnel-only", action="store_true", help="Connect an already running storage server without auto-sync.")
    args = parser.parse_args(argv)
    print("=" * 60)
    print("   LUMIN DENTAL CLINIC - AUTOMATED STORAGE & TUNNEL")
    print("=" * 60)
    print()
    server_proc = None
    server_log = None
    try:
        origin_url = load_origin_url()
        load_clinic_key()
        if not CLOUDFLARED_EXE.exists():
            print("[ERROR] cloudflared.exe is missing. Run start-tunnel.bat --check-only first.")
            return 1
        if not check_server_running(origin_url):
            if args.tunnel_only:
                print(f"[ERROR] Storage server is not ready at {origin_url}. Run start-server.bat first.")
                return 1
            print(f"[*] Starting local storage server at {origin_url}...")
            server_log = (BASE_DIR / "server.log").open("a", encoding="utf-8")
            # Startup tracebacks go to server.log; stdout can contain the clinic key.
            server_proc = subprocess.Popen([str(PYTHON_EXE), "-u", str(BASE_DIR / "server.py")],
                                           cwd=str(BASE_DIR), stdout=subprocess.DEVNULL, stderr=server_log)
            if not wait_for_server(server_proc, origin_url):
                return 1
        print(f"[OK] Local storage server is ONLINE at {origin_url}.")
        local_ip = get_local_ip()
        if local_ip:
            port = origin_url.split(":")[-1]
            print(f"[*] Clinic LAN Access: http://{local_ip}:{port}")
        result = run_tunnel(origin_url, "http2" if args.http2 else "auto", server_proc,
                            sync_url=not args.tunnel_only)
        if result == "http2":
            result = run_tunnel(origin_url, "http2", server_proc, sync_url=not args.tunnel_only)
        return result if result > 0 else 1
    except KeyboardInterrupt:
        print("\n[*] Stopping tunnel and server...")
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"[ERROR] {error}")
        return 1
    finally:
        stop_process(server_proc)
        if server_log is not None:
            server_log.close()


if __name__ == "__main__":
    sys.exit(main())
