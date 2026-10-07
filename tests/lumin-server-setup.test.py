"""Startup registration tests use temporary folders and a fake Windows registry."""
from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("lumin_setup", BASE / "lumin-server-setup/app.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class Registry:
    HKEY_CURRENT_USER = "current-user"
    KEY_SET_VALUE = 2
    REG_SZ = 1

    def __init__(self):
        self.values = {"Unrelated app": "keep this"}
        self.opened = []

    def CreateKeyEx(self, hive, path, reserved, access):
        self.opened.append((hive, path, access))
        return nullcontext("key")

    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[name] = value

    def DeleteValue(self, key, name):
        if name not in self.values:
            raise FileNotFoundError(name)
        del self.values[name]


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.registry = Registry()
        self.executable = self.root / "portable folder" / "Server setup.exe"
        self.executable.parent.mkdir()
        self.executable.write_bytes(b"disposable EXE fixture")
        self.state = self.root / "computer settings"

    def test_startup_copies_only_exe_to_stable_path_and_quotes_command(self):
        (self.executable.parent / "config.json").write_text('{"clinic_secret_key":"do-not-copy"}')
        (self.executable.parent / "sync.sqlite3").write_bytes(b"do-not-copy")
        command = setup.configure_startup(True, self.state, self.executable, self.registry)
        installed = next(self.state.glob("app/*/LuminStorageSetup.exe"))
        self.assertEqual(installed.read_bytes(), self.executable.read_bytes())
        self.assertEqual(command, subprocess.list2cmdline([str(installed), "--autostart"]))
        self.assertEqual(self.registry.values[setup.RUN_NAME], command)
        self.assertEqual(self.registry.opened, [("current-user", setup.RUN_KEY, 2)])
        self.assertNotIn("do-not-copy", command)
        self.assertEqual(list(self.state.rglob("config.json")), [])
        self.assertEqual(list(self.state.rglob("*.sqlite3")), [])
        self.executable.unlink()
        self.assertTrue(installed.is_file(), "Moving the portable folder must not break startup")

    def test_updated_exe_uses_new_path_and_keeps_running_version(self):
        first = setup.configure_startup(True, self.state, self.executable, self.registry)
        self.executable.write_bytes(b"updated disposable EXE fixture")
        second = setup.configure_startup(True, self.state, self.executable, self.registry)
        self.assertNotEqual(first, second)
        self.assertEqual(len(list(self.state.glob("app/*/LuminStorageSetup.exe"))), 2)
        self.assertEqual(self.registry.values[setup.RUN_NAME], second)

    def test_disabling_startup_is_idempotent_and_preserves_other_apps(self):
        setup.configure_startup(True, self.state, self.executable, self.registry)
        setup.configure_startup(False, self.state, registry=self.registry)
        setup.configure_startup(False, self.state, registry=self.registry)
        self.assertEqual(self.registry.values, {"Unrelated app": "keep this"})

    def test_single_instance_lock_releases_on_close(self):
        self.state.mkdir()
        first = setup.acquire_instance_lock(self.state)
        self.assertIsNotNone(first)
        try:
            self.assertIsNone(setup.acquire_instance_lock(self.state))
        finally:
            first.close()
        again = setup.acquire_instance_lock(self.state)
        self.assertIsNotNone(again)
        again.close()

    def test_startup_settings_keep_existing_patient_sync_identity_path(self):
        patient_root = self.root / "existing patients"
        before = setup.make_config(self.state, patient_root, "test-key")
        setup.configure_startup(True, self.state, self.executable, self.registry)
        after = setup.make_config(self.state, patient_root, "test-key")
        self.assertEqual(before, after)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_new_setup_matches_current_server_operational_settings_without_shipping_key(self):
        current = json.loads((BASE / "storage-server/config.json").read_text(encoding="utf-8"))
        config = setup.make_config(self.root, self.root / "patients", "user-entered-key")
        for name in ("port", "max_file_size_mb", "allowed_extensions"):
            self.assertEqual(config[name], current[name])
        self.assertNotIn("clinic_secret_key", setup.SERVER_DEFAULTS)
        self.assertNotIn("storage_path", setup.SERVER_DEFAULTS)
        self.assertNotIn("json", config["allowed_extensions"])

    def test_saved_settings_and_same_computer_identity_survive_restart(self):
        patient_root = self.root / "patients"
        original = setup.make_config(self.root, patient_root, "key", port=5055, max_file_size_mb=75)
        original["sync_state_path"] = str(self.root / "existing-sync")
        restored = setup.make_config(self.root, patient_root, "key", existing=original)
        self.assertEqual(restored, original)
        changed = setup.make_config(self.root, self.root / "other-patients", "key", existing=original)
        self.assertNotEqual(changed["sync_state_path"], original["sync_state_path"])

    def test_import_resolves_relative_patient_folder_and_excludes_other_computer_identity(self):
        path = self.root / "config.json"
        path.write_text(json.dumps({"storage_path": "patient files", "port": 5055,
                                    "max_file_size_mb": 75, "clinic_secret_key": "test-key",
                                    "sync_state_path": "do-not-copy", "peer_key": "do-not-copy"}))
        loaded = setup.read_existing_config(path)
        self.assertEqual(loaded["storage_path"], str((self.root / "patient files").resolve()))
        self.assertEqual(loaded["port"], 5055)
        self.assertEqual(loaded["max_file_size_mb"], 75)
        self.assertEqual(loaded["clinic_secret_key"], "test-key")
        self.assertNotIn("sync_state_path", loaded)
        self.assertNotIn("peer_key", loaded)

    def test_invalid_import_is_rejected(self):
        path = self.root / "config.json"
        for value in ([], {"storage_path": ""}, {"storage_path": "patients", "port": 0},
                      {"storage_path": "patients", "max_file_size_mb": -1},
                      {"storage_path": "patients", "allowed_extensions": ["../json"]}):
            with self.subTest(value=value):
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    setup.read_existing_config(path)


if __name__ == "__main__":
    unittest.main()
