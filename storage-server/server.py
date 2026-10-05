"""
Lumin Dental Clinic - Local Storage Server
Stores patient X-rays, clinical photos, and documents in human-readable Windows folders.
Exposes a secure REST API for universal access across Lumin users via Cloudflare Tunnel or local LAN.
"""

import os
import re
import sys
import json
import logging
from datetime import datetime
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import urllib.parse
import threading
from file_sync import SyncEngine, SyncError, install_sync_routes, safe_path, json_request
from PIL import Image, ImageOps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

SUPABASE_URL = "https://pqbayjkypzfxvnksgwwf.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxYmF5amt5cHpmeHZua3Nnd3dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMjI4NzAsImV4cCI6MjEwNDY5ODg3MH0.e5tPe3PKUiFiS_ZnXcpDF9CRtGtp_B1oZsK37phOQ8Q"
PATIENT_NAME_CACHE = {}

def sanitize_name(name: str) -> str:
    """Sanitize names for safe Windows folder/file naming."""
    raw = str(name or '').strip()
    if not raw or raw.lower() in ('none', 'null', 'undefined'):
        return ""
    # Replace illegal Windows filesystem chars: <>:"/\|?*
    cleaned = re.sub(r'[<>:"/\\|?*]+', '_', raw)
    # Collapse multiple spaces or underscores
    cleaned = re.sub(r'[\s_]+', '_', cleaned).strip(' ._')
    return cleaned

def resolve_patient_name(patient_id: str, supplied_name: str = "") -> str:
    """Resolve clean patient name from argument, local cache, or Supabase RPC."""
    clean_supplied = sanitize_name(supplied_name) if supplied_name else ""
    if clean_supplied and clean_supplied != "Patient" and clean_supplied != "Unnamed":
        PATIENT_NAME_CACHE[patient_id] = clean_supplied
        return clean_supplied

    if patient_id in PATIENT_NAME_CACHE:
        return PATIENT_NAME_CACHE[patient_id]

    try:
        url = f"{SUPABASE_URL}/rest/v1/rpc/get_patient_name"
        headers = {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Content-Type": "application/json"
        }
        payload = json.dumps({
            "patient_uuid": patient_id,
            "clinic_key": config.get("clinic_secret_key", "LuminClinicKey_2026")
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=3) as resp:
            raw = resp.read().decode("utf-8").strip()
            name = json.loads(raw)
            if name:
                cleaned = sanitize_name(name)
                PATIENT_NAME_CACHE[patient_id] = cleaned
                return cleaned
    except Exception as e:
        logger.debug(f"Could not resolve patient name via Supabase for {patient_id}: {e}")

    return ""

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("LuminStorage")

# Load configuration
CONFIG_FILE = Path(os.environ.get("LUMIN_STORAGE_CONFIG", str(Path(__file__).parent / "config.json")))
DEFAULT_CONFIG = {
    "port": 5000,
    "storage_path": "D:\\LuminStorage\\Patients",
    "fallback_storage_path": "./LuminStorage/Patients",
    "clinic_secret_key": "LuminClinicKey_2026",
    "max_file_size_mb": 50,
    "allowed_extensions": ["jpg", "jpeg", "png", "webp", "gif", "bmp", "pdf", "dcm", "tif", "tiff"]
}

config = DEFAULT_CONFIG.copy()
if CONFIG_FILE.exists():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            user_config = json.load(f)
            config.update(user_config)
            logger.info("Loaded configuration from config.json")
    except Exception as e:
        logger.warning(f"Failed to read config.json, using defaults: {e}")

# Determine storage root directory
storage_root_candidate = Path(config["storage_path"])
# If D:\ does not exist (e.g. system has only C: drive), use fallback or C:
try:
    storage_root_candidate.mkdir(parents=True, exist_ok=True)
    STORAGE_ROOT = storage_root_candidate.resolve()
except Exception as e:
    logger.warning(f"Could not initialize primary path {config['storage_path']} ({e}), using fallback.")
    fallback = Path(__file__).parent / config["fallback_storage_path"]
    fallback.mkdir(parents=True, exist_ok=True)
    STORAGE_ROOT = fallback.resolve()

logger.info(f"Root patient storage directory: {STORAGE_ROOT}")

THUMBNAIL_ROOT = STORAGE_ROOT / ".thumbnails"
try:
    THUMBNAIL_ROOT.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

def generate_thumbnail(original_file_path: Path):
    """Generate a lightweight WebP thumbnail (max 480x480) for instant preview loading."""
    try:
        rel = original_file_path.relative_to(STORAGE_ROOT)
        thumb_path = (THUMBNAIL_ROOT / rel).with_suffix(".webp")
        thumb_path.parent.mkdir(parents=True, exist_ok=True)

        if thumb_path.exists() and thumb_path.stat().st_mtime >= original_file_path.stat().st_mtime:
            return thumb_path

        ext = original_file_path.suffix.lower().lstrip(".")
        if ext not in ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff"]:
            return None

        with Image.open(original_file_path) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                pass
            elif im.mode != "RGB":
                im = im.convert("RGB")
            im.thumbnail((480, 480), Image.Resampling.LANCZOS)
            im.save(thumb_path, "WEBP", quality=80)

        logger.info(f"Generated thumbnail for {rel}: {thumb_path.stat().st_size / 1024:.1f} KB")
        return thumb_path
    except Exception as e:
        logger.warning(f"Failed to generate thumbnail for {original_file_path}: {e}")
        return None

def get_folder_patient_id(folder_path: Path) -> str:
    """Read patient_id from .patient_id metadata file in folder."""
    try:
        meta_file = folder_path / ".patient_id"
        if meta_file.is_file():
            content = meta_file.read_text(encoding="utf-8").strip()
            if content.startswith("{"):
                data = json.loads(content)
                return str(data.get("patient_id") or "").strip()
            return content.strip()
    except Exception:
        pass
    return ""


def set_folder_patient_id(folder_path: Path, patient_id: str, patient_name: str = "", patient_number: str = "", phone: str = ""):
    """Write .patient_id metadata file into patient folder."""
    if not patient_id or patient_id == "General" or not folder_path.is_dir():
        return
    try:
        meta_file = folder_path / ".patient_id"
        existing = {}
        if meta_file.is_file():
            try:
                txt = meta_file.read_text(encoding="utf-8").strip()
                if txt.startswith("{"):
                    existing = json.loads(txt)
            except Exception:
                pass
        data = {
            "patient_id": patient_id,
            "patient_number": str(patient_number or existing.get("patient_number") or ""),
            "patient_name": patient_name or existing.get("patient_name") or folder_path.name.replace("_", " "),
            "phone": str(phone or existing.get("phone") or ""),
            "updated_at": datetime.now().isoformat()
        }
        meta_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning(f"Could not write .patient_id in {folder_path}: {e}")


def get_patient_folder_from_supabase(patient_id: str) -> str:
    """Query Supabase RPC to find the recorded folder prefix for this patient's media."""
    try:
        url = f"{SUPABASE_URL}/rest/v1/rpc/get_patient_media_folder"
        headers = {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Content-Type": "application/json"
        }
        payload = json.dumps({
            "p_patient_uuid": patient_id,
            "clinic_key": config.get("clinic_secret_key", "LuminClinicKey_2026")
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=4) as resp:
            raw = resp.read().decode("utf-8").strip()
            folder = json.loads(raw)
            if folder:
                return sanitize_name(folder)
    except Exception as e:
        logger.debug(f"Could not get patient media folder via Supabase RPC for {patient_id}: {e}")
    return ""


def update_supabase_media_paths(patient_id: str, old_folder: str, new_folder: str) -> int:
    """Update relative_path in Supabase patient_media_details using secure RPC."""
    try:
        url = f"{SUPABASE_URL}/rest/v1/rpc/update_patient_media_folder"
        headers = {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Content-Type": "application/json"
        }
        payload = json.dumps({
            "p_patient_uuid": patient_id,
            "p_old_prefix": f"{old_folder}/",
            "p_new_prefix": f"{new_folder}/",
            "clinic_key": config.get("clinic_secret_key", "LuminClinicKey_2026")
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=4) as resp:
            updated_count = json.loads(resp.read().decode("utf-8").strip())
            logger.info(f"Updated {updated_count} media detail rows in Supabase for patient {patient_id}")
            return updated_count or 0
    except Exception as e:
        logger.warning(f"Could not update Supabase media folder for {patient_id}: {e}")
        return 0


def rename_patient_storage_folder(patient_id: str, old_folder_name: str, new_folder_name: str) -> bool:
    """Safely rename a patient's directory on disk, thumbnails, sync records, and Supabase."""
    clean_old = sanitize_name(old_folder_name)
    clean_new = sanitize_name(new_folder_name)
    if not clean_old or not clean_new or clean_old == clean_new:
        return False

    old_dir = STORAGE_ROOT / clean_old
    new_dir = STORAGE_ROOT / clean_new

    if not old_dir.is_dir():
        return False

    try:
        if not new_dir.exists():
            old_dir.rename(new_dir)
        else:
            for root, dirs, files in os.walk(old_dir):
                rel_dir = Path(root).relative_to(old_dir)
                target_sub = new_dir / rel_dir
                target_sub.mkdir(parents=True, exist_ok=True)
                for f in files:
                    src_file = Path(root) / f
                    dst_file = target_sub / f
                    if not dst_file.exists():
                        shutil.move(str(src_file), str(dst_file))
            shutil.rmtree(str(old_dir), ignore_errors=True)

        # Rename thumbnails
        old_thumb = THUMBNAIL_ROOT / clean_old
        new_thumb = THUMBNAIL_ROOT / clean_new
        if old_thumb.is_dir():
            if not new_thumb.exists():
                old_thumb.rename(new_thumb)
            else:
                for root, dirs, files in os.walk(old_thumb):
                    rel_dir = Path(root).relative_to(old_thumb)
                    target_sub = new_thumb / rel_dir
                    target_sub.mkdir(parents=True, exist_ok=True)
                    for f in files:
                        src_file = Path(root) / f
                        dst_file = target_sub / f
                        if not dst_file.exists():
                            shutil.move(str(src_file), str(dst_file))
                shutil.rmtree(str(old_thumb), ignore_errors=True)

        # Write .patient_id metadata in target folder
        set_folder_patient_id(new_dir, patient_id, clean_new)

        # Update sync records in SQLite if sync database exists
        try:
            sync_db_path = config.get('sync_state_path') or (Path(__file__).parent / '.lumin-sync' / 'sync.sqlite3')
            if Path(sync_db_path).is_file():
                import sqlite3
                with sqlite3.connect(str(sync_db_path)) as con:
                    cur = con.cursor()
                    rows = cur.execute("SELECT path, value FROM records WHERE path LIKE ?", (f"{clean_old}/%",)).fetchall()
                    for p, val_str in rows:
                        new_p = f"{clean_new}/{p[len(clean_old) + 1:]}"
                        val = json.loads(val_str)
                        val["path"] = new_p
                        cur.execute("DELETE FROM records WHERE path = ?", (p,))
                        cur.execute("INSERT OR REPLACE INTO records (path, value) VALUES (?, ?)", (new_p, json.dumps(val)))
                    con.commit()
        except Exception as sync_e:
            logger.warning(f"Could not update local sync records during rename: {sync_e}")

        # Update Supabase records
        update_supabase_media_paths(patient_id, clean_old, clean_new)

        # Update PATIENT_NAME_CACHE
        PATIENT_NAME_CACHE[patient_id] = clean_new

        logger.info(f"Successfully migrated patient folder {clean_old} -> {clean_new} for patient {patient_id}")
        try:
            threading.Thread(target=update_storage_mapping_files, daemon=True, name="lumin-update-mappings").start()
        except Exception:
            pass
        return True
    except Exception as e:
        logger.error(f"Failed to rename patient folder {clean_old} -> {clean_new}: {e}")
        return False


_mapping_lock = threading.Lock()
_last_mapping_result = {
    "status": "idle",
    "updated_at": None,
    "total_patients": 0,
    "total_files": 0
}

def sql_quote(val) -> str:
    """Safely quote and escape values for MySQL / MariaDB statements."""
    if val is None:
        return "NULL"
    val_str = str(val)
    escaped = val_str.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "\\r")
    return f"'{escaped}'"

def fetch_all_patients_metadata_from_supabase() -> list:
    """Fetch complete patient metadata (id, patient_number, name, phone) from Supabase RPC."""
    try:
        url = f"{SUPABASE_URL}/rest/v1/rpc/get_all_patients_storage_metadata"
        headers = {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Content-Type": "application/json"
        }
        payload = json.dumps({
            "clinic_key": config.get("clinic_secret_key", "LuminClinicKey_2026")
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, list):
                return data
    except Exception as e:
        logger.warning(f"Could not fetch patients metadata via Supabase RPC: {e}")
    return []

def update_storage_mapping_files() -> dict:
    """
    Generate and synchronize:
    1. Root MySQL dump: STORAGE_ROOT / patients_mapping.sql
    2. Root SQLite database: STORAGE_ROOT / patients_mapping.sqlite
    3. Root Master JSON: STORAGE_ROOT / patients_mapping.json
    4. Per-patient MySQL dump: STORAGE_ROOT / <patient_folder> / patient_mapping.sql
    5. Per-patient JSON: STORAGE_ROOT / <patient_folder> / patient_mapping.json
    """
    global _last_mapping_result
    with _mapping_lock:
        if not STORAGE_ROOT.is_dir():
            return {"error": "STORAGE_ROOT not accessible"}

        now_dt = datetime.now()
        now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")

        all_metadata = fetch_all_patients_metadata_from_supabase()
        patients_by_id = {p["id"]: p for p in all_metadata if p.get("id")}
        patients_by_name = {p["name"].strip(): p for p in all_metadata if p.get("name")}

        patient_records = []
        file_records = []

        for d in sorted(STORAGE_ROOT.iterdir()):
            if not d.is_dir() or d.name.startswith('.'):
                continue

            meta_file = d / ".patient_id"
            pid = ""
            existing_meta = {}
            if meta_file.is_file():
                try:
                    content = meta_file.read_text(encoding="utf-8").strip()
                    if content.startswith("{"):
                        existing_meta = json.loads(content)
                        pid = existing_meta.get("patient_id") or ""
                    else:
                        pid = content
                except Exception:
                    pass

            clean_folder_name = d.name.replace("_", " ")
            pdata = patients_by_id.get(pid) or patients_by_name.get(clean_folder_name) or {}

            resolved_id = pdata.get("id") or pid or d.name
            resolved_num = str(pdata.get("patient_number") or existing_meta.get("patient_number") or "")
            resolved_name = pdata.get("name") or existing_meta.get("patient_name") or clean_folder_name
            resolved_phone = pdata.get("phone") or existing_meta.get("phone") or ""

            if resolved_id:
                PATIENT_NAME_CACHE[resolved_id] = d.name

            try:
                set_folder_patient_id(d, resolved_id, resolved_name, resolved_num, resolved_phone)
            except Exception:
                pass

            patient_files = []
            folder_size = 0

            for r, dirs, files in os.walk(d):
                dirs[:] = [x for x in dirs if not x.startswith('.')]
                for f in files:
                    if f.startswith('.') or f.endswith(('.sql', '.json', '.sqlite', '.db')):
                        continue
                    fp = Path(r) / f
                    stat = fp.stat()
                    rel = fp.relative_to(STORAGE_ROOT).as_posix()
                    cat = fp.parent.name
                    folder_size += stat.st_size
                    mod_dt = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                    ext = fp.suffix.lower().lstrip(".")

                    f_rec = {
                        "id": rel,
                        "patient_id": resolved_id,
                        "patient_name": resolved_name,
                        "folder_name": d.name,
                        "category": cat,
                        "filename": f,
                        "relative_path": rel,
                        "file_size_bytes": stat.st_size,
                        "file_extension": ext,
                        "modified_at": mod_dt,
                        "updated_at": now_str
                    }
                    patient_files.append(f_rec)
                    file_records.append(f_rec)

            p_rec = {
                "patient_id": resolved_id,
                "patient_number": resolved_num,
                "patient_name": resolved_name,
                "folder_name": d.name,
                "folder_path": str(d.resolve()),
                "phone": resolved_phone,
                "total_files": len(patient_files),
                "total_size_bytes": folder_size,
                "updated_at": now_str
            }
            patient_records.append(p_rec)

            # 1. Per-patient JSON
            try:
                (d / "patient_mapping.json").write_text(json.dumps({
                    "patient": p_rec,
                    "files": patient_files
                }, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception as e:
                logger.warning(f"Could not write patient_mapping.json in {d.name}: {e}")

            # 2. Per-patient SQL
            try:
                p_sql_lines = [
                    "-- =====================================================================",
                    f"-- Lumin Dental Clinic - Patient Storage Mapping (MySQL / MariaDB Dump)",
                    f"-- Patient: {resolved_name} (Patient #: {resolved_num or 'N/A'})",
                    f"-- Patient UUID: {resolved_id}",
                    f"-- Folder Name:  {d.name}",
                    f"-- Export Date:  {now_str}",
                    "-- =====================================================================",
                    "",
                    "SET NAMES utf8mb4;",
                    "SET FOREIGN_KEY_CHECKS = 0;",
                    "",
                    "CREATE TABLE IF NOT EXISTS `patient_folders_mapping` (",
                    "  `patient_id` varchar(64) NOT NULL,",
                    "  `patient_number` varchar(32) DEFAULT NULL,",
                    "  `patient_name` varchar(255) NOT NULL,",
                    "  `folder_name` varchar(255) NOT NULL,",
                    "  `folder_path` text NOT NULL,",
                    "  `phone` varchar(64) DEFAULT NULL,",
                    "  `total_files` int NOT NULL DEFAULT '0',",
                    "  `total_size_bytes` bigint NOT NULL DEFAULT '0',",
                    "  `updated_at` datetime NOT NULL,",
                    "  PRIMARY KEY (`patient_id`),",
                    "  KEY `idx_pfm_folder` (`folder_name`),",
                    "  KEY `idx_pfm_number` (`patient_number`)",
                    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
                    "",
                    "CREATE TABLE IF NOT EXISTS `patient_files_mapping` (",
                    "  `id` varchar(255) NOT NULL,",
                    "  `patient_id` varchar(64) NOT NULL,",
                    "  `patient_name` varchar(255) NOT NULL,",
                    "  `folder_name` varchar(255) NOT NULL,",
                    "  `category` varchar(64) NOT NULL,",
                    "  `filename` varchar(255) NOT NULL,",
                    "  `relative_path` varchar(500) NOT NULL,",
                    "  `file_size_bytes` bigint NOT NULL DEFAULT '0',",
                    "  `file_extension` varchar(16) NOT NULL,",
                    "  `modified_at` datetime DEFAULT NULL,",
                    "  `updated_at` datetime NOT NULL,",
                    "  PRIMARY KEY (`id`),",
                    "  KEY `idx_files_patient_id` (`patient_id`),",
                    "  KEY `idx_files_folder` (`folder_name`),",
                    "  KEY `idx_files_category` (`category`)",
                    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
                    "",
                    "-- Patient Folder Mapping Record",
                    f"INSERT INTO `patient_folders_mapping` (`patient_id`, `patient_number`, `patient_name`, `folder_name`, `folder_path`, `phone`, `total_files`, `total_size_bytes`, `updated_at`) "
                    f"VALUES ({sql_quote(p_rec['patient_id'])}, {sql_quote(p_rec['patient_number'])}, {sql_quote(p_rec['patient_name'])}, {sql_quote(p_rec['folder_name'])}, {sql_quote(p_rec['folder_path'])}, {sql_quote(p_rec['phone'])}, {p_rec['total_files']}, {p_rec['total_size_bytes']}, {sql_quote(p_rec['updated_at'])}) "
                    f"ON DUPLICATE KEY UPDATE `patient_number` = VALUES(`patient_number`), `patient_name` = VALUES(`patient_name`), `folder_name` = VALUES(`folder_name`), `folder_path` = VALUES(`folder_path`), `phone` = VALUES(`phone`), `total_files` = VALUES(`total_files`), `total_size_bytes` = VALUES(`total_size_bytes`), `updated_at` = VALUES(`updated_at`);",
                    ""
                ]
                if patient_files:
                    p_sql_lines.append(f"-- Patient Media Files ({len(patient_files)} files)")
                    for pf in patient_files:
                        p_sql_lines.append(
                            f"INSERT INTO `patient_files_mapping` (`id`, `patient_id`, `patient_name`, `folder_name`, `category`, `filename`, `relative_path`, `file_size_bytes`, `file_extension`, `modified_at`, `updated_at`) "
                            f"VALUES ({sql_quote(pf['id'])}, {sql_quote(pf['patient_id'])}, {sql_quote(pf['patient_name'])}, {sql_quote(pf['folder_name'])}, {sql_quote(pf['category'])}, {sql_quote(pf['filename'])}, {sql_quote(pf['relative_path'])}, {pf['file_size_bytes']}, {sql_quote(pf['file_extension'])}, {sql_quote(pf['modified_at'])}, {sql_quote(pf['updated_at'])}) "
                            f"ON DUPLICATE KEY UPDATE `patient_name` = VALUES(`patient_name`), `folder_name` = VALUES(`folder_name`), `category` = VALUES(`category`), `filename` = VALUES(`filename`), `relative_path` = VALUES(`relative_path`), `file_size_bytes` = VALUES(`file_size_bytes`), `file_extension` = VALUES(`file_extension`), `modified_at` = VALUES(`modified_at`), `updated_at` = VALUES(`updated_at`);"
                        )
                    p_sql_lines.append("")
                (d / "patient_mapping.sql").write_text("\n".join(p_sql_lines), encoding="utf-8")
            except Exception as e:
                logger.warning(f"Could not write patient_mapping.sql in {d.name}: {e}")

        # Master Files in STORAGE_ROOT
        master_sql_path = STORAGE_ROOT / "patients_mapping.sql"
        master_sqlite_path = STORAGE_ROOT / "patients_mapping.sqlite"
        master_json_path = STORAGE_ROOT / "patients_mapping.json"

        # 3. Master JSON
        try:
            master_json_path.write_text(json.dumps({
                "generated_at": now_str,
                "total_patients": len(patient_records),
                "total_files": len(file_records),
                "patients": patient_records,
                "files": file_records
            }, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning(f"Could not write master JSON: {e}")

        # 4. Master MySQL Dump
        try:
            m_sql_lines = [
                "-- =====================================================================",
                "-- Lumin Dental Clinic - Master Patient Storage Mapping (MySQL Dump)",
                f"-- Export Date:    {now_str}",
                f"-- Total Patients: {len(patient_records)}",
                f"-- Total Files:    {len(file_records)}",
                f"-- Root Storage:   {str(STORAGE_ROOT.resolve())}",
                "-- =====================================================================",
                "",
                "SET NAMES utf8mb4;",
                "SET FOREIGN_KEY_CHECKS = 0;",
                "",
                "CREATE TABLE IF NOT EXISTS `patient_folders_mapping` (",
                "  `patient_id` varchar(64) NOT NULL,",
                "  `patient_number` varchar(32) DEFAULT NULL,",
                "  `patient_name` varchar(255) NOT NULL,",
                "  `folder_name` varchar(255) NOT NULL,",
                "  `folder_path` text NOT NULL,",
                "  `phone` varchar(64) DEFAULT NULL,",
                "  `total_files` int NOT NULL DEFAULT '0',",
                "  `total_size_bytes` bigint NOT NULL DEFAULT '0',",
                "  `updated_at` datetime NOT NULL,",
                "  PRIMARY KEY (`patient_id`),",
                "  KEY `idx_pfm_folder` (`folder_name`),",
                "  KEY `idx_pfm_number` (`patient_number`)",
                ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
                "",
                "CREATE TABLE IF NOT EXISTS `patient_files_mapping` (",
                "  `id` varchar(255) NOT NULL,",
                "  `patient_id` varchar(64) NOT NULL,",
                "  `patient_name` varchar(255) NOT NULL,",
                "  `folder_name` varchar(255) NOT NULL,",
                "  `category` varchar(64) NOT NULL,",
                "  `filename` varchar(255) NOT NULL,",
                "  `relative_path` varchar(500) NOT NULL,",
                "  `file_size_bytes` bigint NOT NULL DEFAULT '0',",
                "  `file_extension` varchar(16) NOT NULL,",
                "  `modified_at` datetime DEFAULT NULL,",
                "  `updated_at` datetime NOT NULL,",
                "  PRIMARY KEY (`id`),",
                "  KEY `idx_files_patient_id` (`patient_id`),",
                "  KEY `idx_files_folder` (`folder_name`),",
                "  KEY `idx_files_category` (`category`)",
                ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
                "",
                "-- =====================================================================",
                "-- 1. Patient Folders",
                "-- =====================================================================",
                ""
            ]
            for pr in patient_records:
                m_sql_lines.append(
                    f"INSERT INTO `patient_folders_mapping` (`patient_id`, `patient_number`, `patient_name`, `folder_name`, `folder_path`, `phone`, `total_files`, `total_size_bytes`, `updated_at`) "
                    f"VALUES ({sql_quote(pr['patient_id'])}, {sql_quote(pr['patient_number'])}, {sql_quote(pr['patient_name'])}, {sql_quote(pr['folder_name'])}, {sql_quote(pr['folder_path'])}, {sql_quote(pr['phone'])}, {pr['total_files']}, {pr['total_size_bytes']}, {sql_quote(pr['updated_at'])}) "
                    f"ON DUPLICATE KEY UPDATE `patient_number` = VALUES(`patient_number`), `patient_name` = VALUES(`patient_name`), `folder_name` = VALUES(`folder_name`), `folder_path` = VALUES(`folder_path`), `phone` = VALUES(`phone`), `total_files` = VALUES(`total_files`), `total_size_bytes` = VALUES(`total_size_bytes`), `updated_at` = VALUES(`updated_at`);"
                )
            m_sql_lines.extend([
                "",
                "-- =====================================================================",
                "-- 2. Patient Media Files",
                "-- =====================================================================",
                ""
            ])
            for fr in file_records:
                m_sql_lines.append(
                    f"INSERT INTO `patient_files_mapping` (`id`, `patient_id`, `patient_name`, `folder_name`, `category`, `filename`, `relative_path`, `file_size_bytes`, `file_extension`, `modified_at`, `updated_at`) "
                    f"VALUES ({sql_quote(fr['id'])}, {sql_quote(fr['patient_id'])}, {sql_quote(fr['patient_name'])}, {sql_quote(fr['folder_name'])}, {sql_quote(fr['category'])}, {sql_quote(fr['filename'])}, {sql_quote(fr['relative_path'])}, {fr['file_size_bytes']}, {sql_quote(fr['file_extension'])}, {sql_quote(fr['modified_at'])}, {sql_quote(fr['updated_at'])}) "
                    f"ON DUPLICATE KEY UPDATE `patient_name` = VALUES(`patient_name`), `folder_name` = VALUES(`folder_name`), `category` = VALUES(`category`), `filename` = VALUES(`filename`), `relative_path` = VALUES(`relative_path`), `file_size_bytes` = VALUES(`file_size_bytes`), `file_extension` = VALUES(`file_extension`), `modified_at` = VALUES(`modified_at`), `updated_at` = VALUES(`updated_at`);"
                )
            master_sql_path.write_text("\n".join(m_sql_lines), encoding="utf-8")
        except Exception as e:
            logger.warning(f"Could not write master SQL: {e}")

        # 5. Master SQLite DB
        try:
            import sqlite3
            with sqlite3.connect(str(master_sqlite_path)) as con:
                cur = con.cursor()
                cur.execute("""
                CREATE TABLE IF NOT EXISTS patient_folders_mapping (
                    patient_id TEXT PRIMARY KEY,
                    patient_number TEXT,
                    patient_name TEXT NOT NULL,
                    folder_name TEXT NOT NULL,
                    folder_path TEXT NOT NULL,
                    phone TEXT,
                    total_files INTEGER NOT NULL DEFAULT 0,
                    total_size_bytes INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                """)
                cur.execute("""
                CREATE TABLE IF NOT EXISTS patient_files_mapping (
                    id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL,
                    patient_name TEXT NOT NULL,
                    folder_name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    file_size_bytes INTEGER NOT NULL DEFAULT 0,
                    file_extension TEXT NOT NULL,
                    modified_at TEXT,
                    updated_at TEXT NOT NULL
                );
                """)
                cur.execute("CREATE INDEX IF NOT EXISTS idx_pfm_folder ON patient_folders_mapping(folder_name);")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_pfm_number ON patient_folders_mapping(patient_number);")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_files_patient ON patient_files_mapping(patient_id);")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_files_folder ON patient_files_mapping(folder_name);")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_files_cat ON patient_files_mapping(category);")

                for pr in patient_records:
                    cur.execute("""
                    INSERT OR REPLACE INTO patient_folders_mapping (
                        patient_id, patient_number, patient_name, folder_name, folder_path, phone, total_files, total_size_bytes, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        pr["patient_id"], pr["patient_number"], pr["patient_name"], pr["folder_name"],
                        pr["folder_path"], pr["phone"], pr["total_files"], pr["total_size_bytes"], pr["updated_at"]
                    ))

                for fr in file_records:
                    cur.execute("""
                    INSERT OR REPLACE INTO patient_files_mapping (
                        id, patient_id, patient_name, folder_name, category, filename, relative_path, file_size_bytes, file_extension, modified_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        fr["id"], fr["patient_id"], fr["patient_name"], fr["folder_name"], fr["category"],
                        fr["filename"], fr["relative_path"], fr["file_size_bytes"], fr["file_extension"],
                        fr["modified_at"], fr["updated_at"]
                    ))
                con.commit()
        except Exception as e:
            logger.warning(f"Could not write master SQLite: {e}")

        logger.info(f"Updated storage mapping files: {len(patient_records)} patients, {len(file_records)} media files")
        _last_mapping_result = {
            "status": "synced",
            "updated_at": now_str,
            "total_patients": len(patient_records),
            "total_files": len(file_records),
            "sql_path": str(master_sql_path.resolve()),
            "sqlite_path": str(master_sqlite_path.resolve()),
            "json_path": str(master_json_path.resolve())
        }
        return _last_mapping_result


def tag_existing_patient_folders():
    """Scan all patient directories in STORAGE_ROOT and ensure each has a .patient_id file, then update mappings."""
    try:
        if not STORAGE_ROOT.is_dir():
            return
        all_metadata = fetch_all_patients_metadata_from_supabase()
        patients_by_id = {p["id"]: p for p in all_metadata if p.get("id")}
        patients_by_name = {p["name"].strip(): p for p in all_metadata if p.get("name")}
        for d in STORAGE_ROOT.iterdir():
            if not d.is_dir() or d.name.startswith('.'):
                continue
            meta = d / ".patient_id"
            pid = ""
            existing_meta = {}
            if meta.is_file():
                try:
                    txt = meta.read_text(encoding="utf-8").strip()
                    if txt.startswith("{"):
                        existing_meta = json.loads(txt)
                        pid = existing_meta.get("patient_id") or ""
                    else:
                        pid = txt
                except Exception:
                    pass
            clean_name = d.name.replace("_", " ")
            pdata = patients_by_id.get(pid) or patients_by_name.get(clean_name) or {}
            resolved_id = pdata.get("id") or pid
            if resolved_id:
                set_folder_patient_id(d, resolved_id, pdata.get("name") or clean_name, str(pdata.get("patient_number") or ""), str(pdata.get("phone") or ""))
                logger.info(f"Tagged existing folder {d.name} with patient_id {resolved_id} (Patient #{pdata.get('patient_number') or 'N/A'})")
        # Run storage mappings generation
        update_storage_mapping_files()
    except Exception as e:
        logger.warning(f"Error in tag_existing_patient_folders: {e}")

# Initialize Flask app
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}}, max_age=600)
app.config['MAX_CONTENT_LENGTH'] = config["max_file_size_mb"] * 1024 * 1024

_sync_engine = None
_sync_engine_lock = threading.Lock()


def _tailscale_keepalive_worker():
    """Keep the Tailscale Funnel / DERP connection warm to prevent idle drops on Windows."""
    while True:
        try:
            time.sleep(60)
            exe = shutil.which("tailscale")
            if not exe:
                cand = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Tailscale/tailscale.exe"
                if cand.is_file():
                    exe = str(cand)
            if exe:
                subprocess.run([exe, "status"], capture_output=True, timeout=5, check=False)
        except Exception:
            pass


_keepalive_thread = threading.Thread(target=_tailscale_keepalive_worker, daemon=True)
_keepalive_thread.start()


def get_sync_engine():
    global _sync_engine
    with _sync_engine_lock:
        if _sync_engine is None:
            _sync_engine = SyncEngine(
                STORAGE_ROOT,
                config.get('sync_state_path') or Path(__file__).parent / '.lumin-sync',
                config['allowed_extensions'], generate_thumbnail)
    return _sync_engine


def require_sync_admin(authorization):
    """Validate the JWT with Auth, then read the current role through caller-scoped RLS."""
    if not authorization.startswith('Bearer ') or not authorization[7:].strip():
        raise SyncError('Sign in as an administrator to synchronize storage.', 401)
    headers = {'apikey': SUPABASE_ANON_KEY, 'Authorization': authorization}
    try:
        user = json_request(SUPABASE_URL + '/auth/v1/user', headers=headers)
        user_id = user.get('id')
        if not user_id:
            raise SyncError('Invalid administrator session.', 401)
        query = urllib.parse.urlencode({
            'select': 'active,access_roles(is_admin)', 'user_id': 'eq.' + user_id})
        profiles = json_request(SUPABASE_URL + '/rest/v1/user_profiles?' + query, headers=headers)
    except SyncError as error:
        raise SyncError('Administrator verification failed. Sign in again or check the connection.',
                        401 if error.status in (401, 403) else 503)
    if not isinstance(profiles, list) or len(profiles) != 1:
        raise SyncError('Active administrator access is required.', 403)
    profile = profiles[0]
    role = profile.get('access_roles')
    if isinstance(role, list):
        role = role[0] if len(role) == 1 else None
    if not profile.get('active') or not isinstance(role, dict) or role.get('is_admin') is not True:
        raise SyncError('Active administrator access is required.', 403)


install_sync_routes(app, get_sync_engine, require_sync_admin)


def verify_auth():
    """Verify clinic secret key from headers or query parameters."""
    req_key = request.headers.get("x-lumin-key") or request.args.get("key")
    expected_key = config.get("clinic_secret_key", "")
    if expected_key and req_key != expected_key:
        return False
    return True

@app.before_request
def check_authentication():
    # Allow CORS preflight requests without authentication
    if request.method == "OPTIONS":
        return
    # Public health check
    if request.path == "/api/health":
        return
    # These routes validate their own separate server-to-server pairing credentials.
    if request.path.startswith('/api/sync/peer/'):
        return
    # Check key for other routes
    if not verify_auth():
        return jsonify({"error": "Unauthorized. Invalid or missing clinic secret key."}), 401

@app.route("/api/health", methods=["GET"])
def health_check():
    """Health check endpoint to verify server status and storage access."""
    try:
        total_folders = len([d for d in STORAGE_ROOT.iterdir() if d.is_dir() and not d.name.startswith('.')])
    except Exception:
        total_folders = 0
    return jsonify({
        "status": "online",
        "service": "Lumin Local Storage Server",
        "timestamp": datetime.now().isoformat(),
        "storageRoot": str(STORAGE_ROOT),
        "totalPatientFolders": total_folders,
        "maxFileSizeMB": config["max_file_size_mb"],
        "syncProtocol": 1
    })

@app.route("/api/upload", methods=["POST"])
def upload_file():
    """
    Upload an X-ray or clinical photo.
    Creates human-readable folders: STORAGE_ROOT/{patient_id}_{patient_name}/{category}/
    """
    if "image" not in request.files and "file" not in request.files:
        return jsonify({"error": "No file uploaded in request (expected 'image' or 'file')."}), 400

    uploaded_file = request.files.get("image") or request.files.get("file")
    if not uploaded_file or uploaded_file.filename == "":
        return jsonify({"error": "Uploaded file is empty."}), 400

    patient_id = sanitize_name(request.form.get("patientId") or request.form.get("patient_id") or "General") or "General"
    raw_name = request.form.get("patientName") or request.form.get("patient_name") or ""
    patient_name = resolve_patient_name(patient_id, raw_name)
    category = sanitize_name(request.form.get("category") or "General") or "General"

    # Folder format: Use clean patient name only (e.g. يحيى_سيد_أبو_غالي)
    patient_folder_name = patient_name if patient_name else patient_id

    # Auto-migrate if previous folder existed under an older name
    if patient_id and patient_id != "General":
        existing_folder = None
        for d in STORAGE_ROOT.iterdir():
            if d.is_dir() and not d.name.startswith('.'):
                if get_folder_patient_id(d) == patient_id:
                    existing_folder = d.name
                    break
        if not existing_folder:
            supa_folder = get_patient_folder_from_supabase(patient_id)
            if supa_folder and (STORAGE_ROOT / supa_folder).is_dir():
                existing_folder = supa_folder

        if existing_folder and existing_folder != patient_folder_name:
            if rename_patient_storage_folder(patient_id, existing_folder, patient_folder_name):
                logger.info(f"Auto-migrated folder {existing_folder} to {patient_folder_name} prior to upload")

    target_dir = STORAGE_ROOT / patient_folder_name / category
    target_dir.mkdir(parents=True, exist_ok=True)
    set_folder_patient_id(target_dir.parent, patient_id, patient_folder_name)

    # Clean file name and attach date
    original_filename = sanitize_name(Path(uploaded_file.filename).name)
    ext = Path(original_filename).suffix.lower().lstrip(".")
    if ext and ext not in config["allowed_extensions"]:
        return jsonify({"error": f"File extension '.{ext}' is not permitted."}), 400

    date_str = datetime.now().strftime("%Y-%m-%d")
    timestamp_unique = int(datetime.now().timestamp())
    saved_filename = f"{date_str}_{timestamp_unique}_{original_filename}"

    file_path = target_dir / saved_filename
    get_sync_engine().save_upload(uploaded_file, file_path.relative_to(STORAGE_ROOT).as_posix())

    relative_path = str(file_path.relative_to(STORAGE_ROOT)).replace("\\", "/")
    file_size = file_path.stat().st_size

    logger.info(f"Saved: {relative_path} ({file_size / 1024:.1f} KB)")

    try:
        threading.Thread(target=update_storage_mapping_files, daemon=True, name="lumin-update-mappings").start()
    except Exception:
        pass

    return jsonify({
        "success": True,
        "message": "File uploaded successfully",
        "patientFolder": patient_folder_name,
        "category": category,
        "filename": saved_filename,
        "originalName": uploaded_file.filename,
        "relativePath": relative_path,
        "sizeBytes": file_size,
        "uploadedAt": datetime.now().isoformat()
    })

@app.route("/api/patient/<patient_id>/files", methods=["GET"])
def list_patient_files(patient_id):
    """List all media files for a specific patient by ID or name with automatic rename migration."""
    safe_patient_id = sanitize_name(patient_id)
    raw_name = request.args.get("name") or request.args.get("patientName") or ""
    safe_patient_name = resolve_patient_name(patient_id, raw_name)

    matched_dirs = []

    # 1. Primary: match clean patient name folder
    if safe_patient_name:
        name_dir = STORAGE_ROOT / safe_patient_name
        if name_dir.is_dir():
            matched_dirs.append(name_dir)
            set_folder_patient_id(name_dir, patient_id, safe_patient_name)

    # 2. Match exact patient_id folder
    id_dir = STORAGE_ROOT / safe_patient_id
    if id_dir.is_dir() and id_dir not in matched_dirs:
        matched_dirs.append(id_dir)

    # 3. Match by .patient_id metadata across existing folders
    if not matched_dirs and safe_patient_id and safe_patient_id != "General":
        for d in STORAGE_ROOT.iterdir():
            if d.is_dir() and not d.name.startswith('.'):
                folder_pid = get_folder_patient_id(d)
                if folder_pid == patient_id:
                    if safe_patient_name and d.name != safe_patient_name:
                        if rename_patient_storage_folder(patient_id, d.name, safe_patient_name):
                            new_dir = STORAGE_ROOT / safe_patient_name
                            if new_dir.is_dir():
                                matched_dirs.append(new_dir)
                                break
                    matched_dirs.append(d)
                    break

    # 4. Check Supabase patient_media_details for previous folder if still not found
    if not matched_dirs and safe_patient_id and safe_patient_id != "General":
        supa_folder = get_patient_folder_from_supabase(patient_id)
        if supa_folder:
            candidate = STORAGE_ROOT / supa_folder
            if candidate.is_dir():
                if safe_patient_name and supa_folder != safe_patient_name:
                    if rename_patient_storage_folder(patient_id, supa_folder, safe_patient_name):
                        new_dir = STORAGE_ROOT / safe_patient_name
                        if new_dir.is_dir():
                            matched_dirs.append(new_dir)
                if not matched_dirs:
                    matched_dirs.append(candidate)
                    set_folder_patient_id(candidate, patient_id, safe_patient_name or supa_folder)

    # 5. Match legacy folders starting with patient_id_ or ending with _patient_name
    for d in STORAGE_ROOT.iterdir():
        if d.is_dir() and not d.name.startswith('.') and d not in matched_dirs:
            if d.name.startswith(f"{safe_patient_id}_"):
                matched_dirs.append(d)
            elif safe_patient_name and d.name.endswith(f"_{safe_patient_name}"):
                matched_dirs.append(d)

    files_list = []
    for patient_dir in matched_dirs:
        set_folder_patient_id(patient_dir, patient_id, safe_patient_name or patient_dir.name)
        for root, directories, files in os.walk(patient_dir):
            directories[:] = [name for name in directories if not name.startswith('.')]
            for filename in files:
                if filename.startswith('.') or filename.endswith(('.sql', '.json', '.sqlite', '.db')):
                    continue
                full_path = Path(root) / filename
                rel_path = full_path.relative_to(STORAGE_ROOT)
                category = full_path.parent.name
                stat = full_path.stat()
                files_list.append({
                    "filename": filename,
                    "category": category,
                    "relativePath": str(rel_path).replace("\\", "/"),
                    "sizeBytes": stat.st_size,
                    "modifiedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "patientFolder": patient_dir.name
                })

    # Sort newest first
    files_list.sort(key=lambda x: x["modifiedAt"], reverse=True)
    return jsonify({"patientId": patient_id, "total": len(files_list), "files": files_list})


@app.route("/api/patient/<patient_id>/rename", methods=["POST"])
def rename_patient(patient_id):
    """Explicitly rename a patient folder and migrate its thumbnails and sync records."""
    data = request.get_json(silent=True) or {}
    old_name = data.get("oldName") or data.get("old_name") or ""
    new_name = data.get("newName") or data.get("new_name") or ""

    safe_old = sanitize_name(old_name)
    safe_new = sanitize_name(new_name)

    if not safe_new or safe_new == "Unnamed":
        return jsonify({"error": "Valid newName is required."}), 400

    current_dir = None
    if safe_old and (STORAGE_ROOT / safe_old).is_dir():
        current_dir = STORAGE_ROOT / safe_old
    if not current_dir:
        for d in STORAGE_ROOT.iterdir():
            if d.is_dir() and not d.name.startswith('.'):
                if get_folder_patient_id(d) == patient_id:
                    current_dir = d
                    break
    if not current_dir:
        supa_folder = get_patient_folder_from_supabase(patient_id)
        if supa_folder and (STORAGE_ROOT / supa_folder).is_dir():
            current_dir = STORAGE_ROOT / supa_folder

    if not current_dir:
        return jsonify({"success": True, "message": "No existing storage folder to rename."})

    if current_dir.name == safe_new:
        set_folder_patient_id(current_dir, patient_id, safe_new)
        return jsonify({"success": True, "message": "Folder already matches target name.", "folder": safe_new})

    ok = rename_patient_storage_folder(patient_id, current_dir.name, safe_new)
    if ok:
        return jsonify({"success": True, "oldFolder": current_dir.name, "newFolder": safe_new})
    return jsonify({"error": "Failed to rename patient folder."}), 500

@app.route("/api/file", methods=["DELETE"])
def delete_file():
    """Delete a file from local storage."""
    data = request.get_json(silent=True) or {}
    rel_path_str = data.get("relativePath") or request.args.get("relativePath")
    if not rel_path_str:
        return jsonify({"error": "relativePath parameter is required."}), 400

    # Ensure path stays within STORAGE_ROOT (prevent directory traversal)
    target_path = safe_path(STORAGE_ROOT, rel_path_str)
    clean_rel_path = target_path.relative_to(STORAGE_ROOT).as_posix()

    if not target_path.exists() or not target_path.is_file():
        return jsonify({"error": "File not found."}), 404

    try:
        get_sync_engine().delete_local(clean_rel_path)
        thumb_candidate = (THUMBNAIL_ROOT / clean_rel_path).with_suffix(".webp")
        if thumb_candidate.exists():
            try:
                thumb_candidate.unlink()
            except Exception:
                pass
        logger.info(f"Deleted: {clean_rel_path}")
        try:
            threading.Thread(target=update_storage_mapping_files, daemon=True, name="lumin-update-mappings").start()
        except Exception:
            pass
        return jsonify({"success": True, "message": "File deleted successfully", "deletedPath": clean_rel_path})
    except SyncError:
        raise
    except Exception as e:
        logger.error(f"Failed to delete {clean_rel_path}: {e}")
        return jsonify({"error": f"Failed to delete file: {e}"}), 500

@app.route("/api/file/move", methods=["POST"])
def move_file():
    """Move a file to a different category folder."""
    data = request.get_json(silent=True) or {}
    rel_path_str = data.get("relativePath")
    target_category = sanitize_name(data.get("targetCategory") or data.get("category") or "")

    if not rel_path_str or not target_category:
        return jsonify({"error": "relativePath and targetCategory are required."}), 400

    source_path = safe_path(STORAGE_ROOT, rel_path_str)
    clean_rel_path = source_path.relative_to(STORAGE_ROOT).as_posix()

    if not source_path.exists() or not source_path.is_file():
        return jsonify({"error": "Source file not found."}), 404

    try:
        parts = clean_rel_path.split("/")
        if len(parts) < 3:
            return jsonify({"error": "Invalid relative path format (expected patient/category/filename)."}), 400

        patient_folder = parts[0]
        filename = parts[-1]
        dest_dir = STORAGE_ROOT / patient_folder / target_category
        dest_dir.mkdir(parents=True, exist_ok=True)

        dest_path = dest_dir / filename
        if dest_path.resolve() == source_path.resolve():
            return jsonify({
                "success": True,
                "message": "File is already in this category",
                "newRelativePath": clean_rel_path,
                "newCategory": target_category
            })

        if dest_path.exists():
            stem = dest_path.stem
            suffix = dest_path.suffix
            dest_path = dest_dir / f"{stem}_{int(datetime.now().timestamp())}{suffix}"

        get_sync_engine().move_local(clean_rel_path, dest_path.relative_to(STORAGE_ROOT).as_posix())

        # Move or update thumbnail
        old_thumb = (THUMBNAIL_ROOT / clean_rel_path).with_suffix(".webp")
        new_rel_path = str(dest_path.relative_to(STORAGE_ROOT)).replace("\\", "/")
        new_thumb = (THUMBNAIL_ROOT / new_rel_path).with_suffix(".webp")
        new_thumb.parent.mkdir(parents=True, exist_ok=True)

        if old_thumb.exists():
            try:
                shutil.move(str(old_thumb), str(new_thumb))
            except Exception:
                generate_thumbnail(dest_path)
        else:
            generate_thumbnail(dest_path)

        logger.info(f"Moved category: {clean_rel_path} -> {new_rel_path}")

        try:
            threading.Thread(target=update_storage_mapping_files, daemon=True, name="lumin-update-mappings").start()
        except Exception:
            pass

        return jsonify({
            "success": True,
            "message": "File moved successfully",
            "oldRelativePath": clean_rel_path,
            "newRelativePath": new_rel_path,
            "newCategory": target_category,
            "filename": dest_path.name
        })
    except SyncError:
        raise
    except Exception as e:
        logger.error(f"Failed to move file {clean_rel_path}: {e}")
        return jsonify({"error": f"Failed to move file: {e}"}), 500

@app.route("/api/thumbnail/<path:filename>", methods=["GET"])
def get_thumbnail(filename):
    """Serve a lightweight, compressed WebP thumbnail (max 480x480) for instant preview loading."""
    try:
        requested = safe_path(STORAGE_ROOT, filename)
        clean_filename = requested.relative_to(STORAGE_ROOT).as_posix()

        if not requested.exists() or not requested.is_file():
            return jsonify({"error": "File not found."}), 404

        thumb_path = generate_thumbnail(requested)
        if thumb_path and thumb_path.exists():
            rel_thumb = thumb_path.relative_to(THUMBNAIL_ROOT)
            resp = send_from_directory(THUMBNAIL_ROOT, str(rel_thumb).replace("\\", "/"))
            resp.headers["Cache-Control"] = "public, max-age=604800, immutable"
            return resp

        # Fallback to original if not an image
        resp = send_from_directory(STORAGE_ROOT, clean_filename)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp
    except SyncError:
        raise
    except Exception as e:
        logger.error(f"Error serving thumbnail {filename}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/files/<path:filename>", methods=["GET"])
def serve_file(filename):
    """Stream or serve the raw full-resolution image / file to the browser."""
    clean_filename = safe_path(STORAGE_ROOT, filename).relative_to(STORAGE_ROOT).as_posix()
    resp = send_from_directory(STORAGE_ROOT, clean_filename)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp

@app.route("/api/mapping/status", methods=["GET"])
def get_mapping_status():
    """Return status of storage mapping files (SQL, SQLite, JSON)."""
    return jsonify({
        "success": True,
        "mapping": _last_mapping_result,
        "storageRoot": str(STORAGE_ROOT.resolve())
    })

@app.route("/api/mapping/sync", methods=["POST"])
def sync_mappings():
    """Trigger synchronous update of all storage mapping files."""
    res = update_storage_mapping_files()
    return jsonify({"success": True, "result": res})

@app.route("/api/mapping/sql", methods=["GET"])
def get_mapping_sql():
    """Download or view the master MySQL dump file."""
    master_sql_path = STORAGE_ROOT / "patients_mapping.sql"
    if not master_sql_path.is_file():
        update_storage_mapping_files()
    as_dl = request.args.get("download") == "true"
    return send_from_directory(
        STORAGE_ROOT,
        "patients_mapping.sql",
        as_attachment=as_dl,
        mimetype="text/plain; charset=utf-8"
    )

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

if __name__ == "__main__":
    port = int(config.get("port", 5000))
    local_ip = get_local_ip()
    print("=" * 60)
    print("  LUMIN DENTAL CLINIC - LOCAL STORAGE SERVER")
    print("=" * 60)
    print(f"  Storage Directory: {STORAGE_ROOT}")
    print(f"  Local Host:        http://localhost:{port}")
    if local_ip:
        print(f"  Clinic LAN Access: http://{local_ip}:{port}")
    print(f"  Secret Clinic Key: {config.get('clinic_secret_key')}")
    print("=" * 60)
    threading.Thread(target=tag_existing_patient_folders, daemon=True, name="lumin-tag-folders").start()
    app.run(host="0.0.0.0", port=port, debug=False)
