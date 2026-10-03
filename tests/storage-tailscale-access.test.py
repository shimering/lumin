import contextlib
import importlib.util
import io
import json
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import Mock, patch

PATH = Path(__file__).resolve().parents[1] / "storage-server" / "tailscale_access.py"
spec = importlib.util.spec_from_file_location("tailscale_access", PATH)
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
HOST = "clinic.tail123.ts.net"
RELAY = "176.58.90.46"
FUNNEL = {"Web": {HOST + ":443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:5000"}}}},
          "AllowFunnel": {HOST + ":443": True}}


def response(payload=None, status=200, headers=None):
    result = Mock(status=status)
    result.read.return_value = json.dumps(payload).encode() if payload is not None else b""
    header_values = {"Access-Control-Allow-Origin": access.APP_ORIGIN,
                     "Access-Control-Allow-Headers": "x-lumin-key",
                     "Access-Control-Allow-Methods": "GET, OPTIONS"}
    header_values.update(headers or {})
    result.getheader.side_effect = header_values.get
    return result


class TailscaleAccessTests(unittest.TestCase):
    def test_public_dns_ignores_magicdns_and_private_addresses(self):
        payload = {"Answer": [{"type": 1, "data": "100.91.9.40"},
                              {"type": 1, "data": "127.0.0.1"},
                              {"type": 1, "data": "192.168.1.4"},
                              {"type": 1, "data": RELAY},
                              {"type": 1, "data": RELAY}]}
        with patch.object(access.urllib.request, "urlopen") as fetch:
            fetch.return_value.__enter__.return_value = io.BytesIO(json.dumps(payload).encode())
            self.assertEqual(access.public_relay_ips(HOST), [RELAY])
            self.assertIn("dns.google", fetch.call_args.args[0].full_url)
        with patch.object(access.urllib.request, "urlopen", side_effect=OSError("DNS offline")):
            with self.assertRaisesRegex(access.AccessError, "No Tailscale settings were changed"):
                access.public_relay_ips(HOST)

    def test_public_tls_connects_to_relay_but_validates_original_hostname(self):
        transport = Mock()
        tls = Mock()
        with patch.object(access.ssl, "create_default_context", return_value=tls), \
                patch.object(access.socket, "create_connection", return_value=transport) as connect:
            connection = access.PublicHTTPSConnection(HOST, RELAY)
            connection.connect()
            connect.assert_called_once_with((RELAY, 443), timeout=6)
            tls.wrap_socket.assert_called_once_with(transport, server_hostname=HOST)
            connection.close()

    def test_valid_health_and_browser_preflight_are_required_without_sending_keys(self):
        connection = Mock()
        connection.getresponse.side_effect = [response({"status": "online", "service": access.SERVICE}), response()]
        with patch.object(access, "PublicHTTPSConnection", return_value=connection):
            self.assertEqual(access.probe_relay(HOST, RELAY)[0], "ok")
        requests = connection.request.call_args_list
        self.assertEqual(requests[0].args, ("GET", "/api/health"))
        self.assertNotIn("x-lumin-key", requests[0].kwargs["headers"])
        self.assertEqual(requests[1].args, ("OPTIONS", "/api/health"))
        self.assertEqual(requests[1].kwargs["headers"]["Access-Control-Request-Headers"], "x-lumin-key")
        connection.close.assert_called_once()

    def test_certificate_http_and_cors_errors_are_distinguished(self):
        for expected, first, second in [
            ("http", response(status=503), None),
            ("health", response({"status": "online", "service": "Different server"}), None),
            ("cors", response({"status": "online", "service": access.SERVICE}, headers={"Access-Control-Allow-Origin": None}), None),
            ("cors", response({"status": "online", "service": access.SERVICE}), response(headers={"Access-Control-Allow-Headers": "authorization"})),
        ]:
            connection = Mock()
            connection.getresponse.side_effect = [first, second]
            with patch.object(access, "PublicHTTPSConnection", return_value=connection):
                self.assertEqual(access.probe_relay(HOST, RELAY)[0], expected)
        connection = Mock()
        connection.request.side_effect = ssl.SSLError("Handshake failed")
        with patch.object(access, "PublicHTTPSConnection", return_value=connection):
            self.assertEqual(access.probe_relay(HOST, RELAY)[0], "transport")
        connection.close.assert_called_once()

    def test_an_unreachable_relay_does_not_mask_another_working_relay(self):
        with patch.object(access, "probe_relay", side_effect=[("transport", "TLS failed"), ("ok", "Public access works")]):
            self.assertEqual(access.check_public_access(HOST, [RELAY, "176.58.90.145"])[0], "ok")
        with patch.object(access, "probe_relay", side_effect=[("http", "HTTP 401"), ("transport", "TLS failed")]):
            self.assertEqual(access.check_public_access(HOST, [RELAY, "176.58.90.145"])[0], "http")

    def test_another_applications_proxy_and_private_serve_are_preserved(self):
        self.assertTrue(access.validate_funnel_target(FUNNEL, HOST, 5000))
        with self.assertRaisesRegex(access.AccessError, "another application"):
            access.validate_funnel_target(FUNNEL, HOST, 6000)
        extra = json.loads(json.dumps(FUNNEL))
        extra["Web"][HOST + ":443"]["Handlers"]["/other"] = {"Proxy": "http://127.0.0.1:3000"}
        with self.assertRaises(access.AccessError):
            access.validate_funnel_target(extra, HOST, 5000)
        private = {**FUNNEL, "AllowFunnel": {}}
        self.assertFalse(access.validate_funnel_target(private, HOST, 5000))

    def workflow(self, args, outcomes, funnel=FUNNEL):
        output = io.StringIO()
        with patch.object(access, "load_port", return_value=5000), \
                patch.object(access, "check_local_server"), \
                patch.object(access, "tailscale_binary", return_value="tailscale.exe"), \
                patch.object(access, "cli_json", side_effect=[{"BackendState": "Running", "Self": {"DNSName": HOST + "."}}, funnel]), \
                patch.object(access, "public_relay_ips", return_value=[RELAY]), \
                patch.object(access, "check_public_access", side_effect=outcomes) as check, \
                patch.object(access, "run_cli") as run, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = access.main(args)
        return code, check, run, output.getvalue()

    def test_read_only_check_never_reconnects_or_enables_funnel(self):
        code, _, run, _ = self.workflow([], [("transport", "Public TLS failed")])
        self.assertEqual(code, 1)
        run.assert_not_called()
        code, _, run, _ = self.workflow(["--repair"], [("ok", "Verified")])
        self.assertEqual(code, 0)
        run.assert_not_called()

    def test_laptop_only_connection_reconnects_once_and_requires_public_success(self):
        code, check, run, output = self.workflow(["--repair"], [("transport", "TLS failed"), ("ok", "Verified")])
        self.assertEqual(code, 0)
        self.assertEqual([call.args[1:] for call in run.call_args_list], [("down",), ("up", "--timeout=20s")])
        self.assertEqual(check.call_count, 2)
        self.assertIn("https://" + HOST, output)
        code, check, run, output = self.workflow(["--repair"], [("transport", "TLS failed"), ("transport", "Still failing")])
        self.assertEqual(code, 1)
        self.assertEqual(run.call_count, 2)
        self.assertNotIn("Shared storage URL", output)

    def test_application_errors_and_disabled_funnel_do_not_reconnect(self):
        code, _, run, _ = self.workflow(["--repair"], [("cors", "CORS failed")])
        self.assertEqual(code, 1)
        run.assert_not_called()
        code, check, run, _ = self.workflow(["--repair"], [], {**FUNNEL, "AllowFunnel": {}})
        self.assertEqual(code, 1)
        check.assert_not_called()
        run.assert_not_called()

    def test_unhealthy_local_server_never_changes_the_vpn(self):
        with patch.object(access, "load_port", return_value=5000), \
                patch.object(access, "check_local_server", side_effect=access.AccessError("Server stopped")), \
                patch.object(access, "run_cli") as run, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(access.main(["--setup", "--repair"]), 1)
        run.assert_not_called()

    def test_dedicated_pc_setup_uses_its_own_hostname_and_configured_port(self):
        dedicated_host = "dedicated-pc.tail789.ts.net"
        dedicated = {"Web": {dedicated_host + ":443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:6500"}}}},
                     "AllowFunnel": {dedicated_host + ":443": True}}
        with patch.object(access, "load_port", return_value=6500), \
                patch.object(access, "check_local_server") as local, \
                patch.object(access, "tailscale_binary", return_value="tailscale.exe"), \
                patch.object(access, "cli_json", side_effect=[{"BackendState": "Running", "Self": {"DNSName": dedicated_host + "."}}, {}, dedicated]), \
                patch.object(access, "public_relay_ips", return_value=[RELAY]) as resolve, \
                patch.object(access, "check_public_access", return_value=("ok", "Verified")), \
                patch.object(access, "run_cli") as run, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(access.main(["--setup", "--repair"]), 0)
        local.assert_called_once_with(6500)
        resolve.assert_called_once_with(dedicated_host)
        run.assert_called_once_with("tailscale.exe", "funnel", "--bg", "--https=443", "http://127.0.0.1:6500")

    def test_a_failed_reconnection_reports_failure_instead_of_a_false_success(self):
        def reconnect(executable, command, *args):
            if command == "up":
                raise access.AccessError("Finish signing in to Tailscale.")
        with patch.object(access, "load_port", return_value=5000), \
                patch.object(access, "check_local_server"), \
                patch.object(access, "tailscale_binary", return_value="tailscale.exe"), \
                patch.object(access, "cli_json", side_effect=[{"BackendState": "Running", "Self": {"DNSName": HOST}}, FUNNEL]), \
                patch.object(access, "public_relay_ips", return_value=[RELAY]), \
                patch.object(access, "check_public_access", return_value=("transport", "TLS failed")) as check, \
                patch.object(access, "run_cli", side_effect=reconnect) as run, \
                contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(output):
            self.assertEqual(access.main(["--repair"]), 1)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(check.call_count, 1)
        self.assertNotIn("Shared storage URL", output.getvalue())
        self.assertIn("Finish signing in", output.getvalue())

    def test_custom_config_port_and_invalid_config(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text('{"port": 6500, "clinic_secret_key": "never-print-this"}')
            with patch.dict(access.os.environ, {"LUMIN_STORAGE_CONFIG": str(config)}):
                self.assertEqual(access.load_port(), 6500)
                config.write_text('{"port": 70000}')
                with self.assertRaises(access.AccessError):
                    access.load_port()
                config.write_text('[]')
                with self.assertRaises(access.AccessError):
                    access.load_port()


if __name__ == "__main__":
    unittest.main()
