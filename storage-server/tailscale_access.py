"""Verify Lumin through public Funnel relays, avoiding the host's MagicDNS route.

Read-only by default. --setup configures this storage server's persistent Funnel;
--repair reconnects an existing session once if only public TLS/TCP access fails.
Uses Python's standard library, validates HTTPS certificates, reads no patient
files, and never logs or transmits secret keys from config.json.
"""

import argparse
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import urllib.request

BASE_DIR = Path(__file__).resolve().parent
APP_ORIGIN = "https://lumin.gazarxperia.workers.dev"
SERVICE = "Lumin Local Storage Server"


class AccessError(Exception):
    pass


def tailscale_binary():
    executable = shutil.which("tailscale")
    if not executable:
        candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Tailscale/tailscale.exe"
        executable = str(candidate) if candidate.is_file() else None
    if not executable:
        raise AccessError("Install Tailscale from tailscale.com and sign in on this storage computer.")
    return executable


def hidden_process_options():
    """Console children of a windowed EXE must also be explicitly hidden."""
    if os.name != "nt":
        return {}
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    return {"creationflags": subprocess.CREATE_NO_WINDOW, "startupinfo": startup}


def run_cli(executable, *arguments):
    try:
        result = subprocess.run([executable, *arguments], capture_output=True, text=True,
                                timeout=30, check=False, **hidden_process_options())
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AccessError("Tailscale did not respond. Open Tailscale and check its connection.") from error
    if result.returncode:
        # Do not print login links, preferences, credentials, or unrelated device data.
        raise AccessError("Tailscale command failed: " + " ".join(arguments)
                          + ". Check that Tailscale is signed in and you own its current profile.")
    return result.stdout


def cli_json(executable, *arguments):
    try:
        data = json.loads(run_cli(executable, *arguments))
        if not isinstance(data, dict):
            raise ValueError("Expected an object")
        return data
    except (ValueError, TypeError) as error:
        raise AccessError("Tailscale returned an unreadable status. Update Tailscale and try again.") from error


def load_port():
    path = Path(os.environ.get("LUMIN_STORAGE_CONFIG", str(BASE_DIR / "config.json")))
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if not isinstance(config, dict):
        raise AccessError("config.json must contain a configuration object.")
    port = int(config.get("port", 5000))
    if not 1 <= port <= 65535:
        raise AccessError("config.json port must be between 1 and 65535.")
    return port


def check_local_server(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as response:
            data = json.load(response)
            if response.status != 200 or data.get("status") != "online" or data.get("service") != SERVICE:
                raise ValueError("Wrong service")
    except Exception as error:
        raise AccessError(f"Start the Lumin storage server on port {port} first. Check server.log.") from error


def validate_funnel_target(config, host, port):
    handlers = config.get("Web", {}).get(host + ":443", {}).get("Handlers", {})
    expected = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    if handlers and (set(handlers) != {"/"}
                     or str(handlers["/"].get("Proxy", "")).rstrip("/") not in expected):
        raise AccessError("HTTPS port 443 serves another application. Its configuration was preserved."
                          " Use a separate Funnel port or storage computer.")
    return bool(handlers) and config.get("AllowFunnel", {}).get(host + ":443") is True


def public_relay_ips(host):
    # System DNS on the server resolves its own *.ts.net name to a private 100.x
    # address. Public DNS-over-HTTPS and direct relay connections prevent a false
    # success that only works on this computer or within its Tailscale network.
    for resolver in ("https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"):
        try:
            request = urllib.request.Request(resolver + "?name=" + host + "&type=A",
                                             headers={"Accept": "application/dns-json"})
            with urllib.request.urlopen(request, timeout=8) as response:
                answers = json.load(response).get("Answer", [])
            addresses = []
            for answer in answers:
                if answer.get("type") != 1:
                    continue
                address = str(ipaddress.IPv4Address(answer.get("data", "")))
                if ipaddress.ip_address(address).is_global and address not in addresses:
                    addresses.append(address)
            if addresses:
                return addresses[:3]
        except (OSError, ValueError, TypeError):
            continue
    raise AccessError("Public Funnel DNS could not be verified. Check this computer's internet/DNS"
                      " connection. No Tailscale settings were changed.")


class PublicHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, relay):
        super().__init__(host, port=443, timeout=6, context=ssl.create_default_context())
        self.relay = relay

    def connect(self):
        connection = socket.create_connection((self.relay, self.port), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(connection, server_hostname=self.host)
        except Exception:
            connection.close()
            raise


def probe_relay(host, relay):
    connection = PublicHTTPSConnection(host, relay)
    try:
        connection.request("GET", "/api/health", headers={"Origin": APP_ORIGIN})
        response = connection.getresponse()
        payload = response.read(65536)
        if response.status != 200:
            return "http", f"Public endpoint returned HTTP {response.status}. Check server.log."
        data = json.loads(payload)
        if data.get("status") != "online" or data.get("service") != SERVICE:
            return "health", "The public endpoint is not the Lumin storage server."
        if response.getheader("Access-Control-Allow-Origin") not in (APP_ORIGIN, "*"):
            return "cors", "The server does not allow the Lumin web app's origin. Update server.py."
        connection.request("OPTIONS", "/api/health", headers={
            "Origin": APP_ORIGIN, "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-lumin-key"})
        response = connection.getresponse()
        response.read(65536)
        allowed_headers = {part.strip().lower() for part in
                           (response.getheader("Access-Control-Allow-Headers") or "").split(",")}
        allowed_methods = {part.strip().upper() for part in
                           (response.getheader("Access-Control-Allow-Methods") or "").split(",")}
        if (response.status not in (200, 204)
                or response.getheader("Access-Control-Allow-Origin") not in (APP_ORIGIN, "*")
                or not allowed_headers.intersection({"x-lumin-key", "*"})
                or not allowed_methods.intersection({"GET", "*"})):
            return "cors", "Browser preflight failed. Update the storage server's CORS configuration."
        return "ok", "Public HTTPS and browser preflight both passed."
    except (OSError, http.client.HTTPException) as error:
        return "transport", "Public TLS/TCP connection failed (" + type(error).__name__ + ")."
    except (ValueError, TypeError, AttributeError):
        return "health", "The public health response is invalid. Check server.log."
    finally:
        connection.close()


def check_public_access(host, relays):
    failures = []
    for relay in relays:
        kind, detail = probe_relay(host, relay)
        if kind == "ok":
            return kind, detail
        failures.append((kind, detail))
    # Receiving HTTP proves the Funnel is publicly registered; do not reconnect
    # a healthy VPN to fix application, authentication, or CORS errors.
    return next((failure for failure in failures if failure[0] != "transport"), failures[0])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup", action="store_true", help="Enable this storage server's persistent Funnel.")
    parser.add_argument("--repair", action="store_true", help="Reconnect once if the public route alone is broken.")
    args = parser.parse_args(argv)
    try:
        port = load_port()
        check_local_server(port)
        print(f"[OK] Local Lumin server is healthy on port {port}.", flush=True)
        executable = tailscale_binary()
        state = cli_json(executable, "status", "--json")
        host = str(state.get("Self", {}).get("DNSName", "")).rstrip(".").lower()
        if state.get("BackendState") != "Running" or not re.fullmatch(r"(?:[a-z0-9-]+\.)+ts\.net", host):
            raise AccessError("Sign in and connect Tailscale on this storage computer first.")
        config = cli_json(executable, "funnel", "status", "--json")
        enabled = validate_funnel_target(config, host, port)
        if args.setup:
            run_cli(executable, "funnel", "--bg", "--https=443", f"http://127.0.0.1:{port}")
            enabled = validate_funnel_target(cli_json(executable, "funnel", "status", "--json"), host, port)
        if not enabled:
            raise AccessError("Public Funnel is not enabled for this storage server."
                              " Run setup-tailscale-access.bat on the storage computer.")
        relays = public_relay_ips(host)
        print("[*] Testing public HTTPS relays and Lumin browser access...", flush=True)
        kind, detail = check_public_access(host, relays)
        if kind == "transport" and args.repair:
            print("[!] Private storage works, but public Funnel is unreachable."
                  " Reconnecting Tailscale once; saved URLs and settings are retained.", flush=True)
            run_cli(executable, "down")
            run_cli(executable, "up", "--timeout=20s")
            kind, detail = check_public_access(host, relays)
        if kind != "ok":
            raise AccessError(detail + (" Run repair-tailscale-access.bat to repair registration."
                                       if kind == "transport" and not args.repair else ""))
        print("[OK] " + detail)
        print("[OK] Shared storage URL: https://" + host)
        print("[*] Save this HTTPS URL and your existing clinic key in Lumin Admin > Storage & X-Rays."
              " Refresh Lumin on the iPad/iPhone to confirm Connected.")
        return 0
    except (AccessError, OSError, ValueError, TypeError) as error:
        print("[ERROR] " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
