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
import urllib.request
from PIL import Image, ImageOps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

SUPABASE_URL = "https://pqbayjkypzfxvnksgwwf.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxYmF5amt5cHpmeHZua3Nnd3dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMjI4NzAsImV4cCI6MjEwNDY5ODg3MH0.e5tPe3PKUiFiS_ZnXcpDF9CRtGtp_B1oZsK37phOQ8Q"
PATIENT_NAME_CACHE = {}

def sanitize_name(name: str) -> str:
    """Sanitize names for safe Windows folder/file naming."""
    # Replace illegal Windows filesystem chars: <>:"/\|?*
    cleaned = re.sub(r'[<>:"/\\|?*]+', '_', str(name or 'Unknown').strip())
    # Collapse multiple spaces or underscores
    cleaned = re.sub(r'[\s_]+', '_', cleaned).strip(' ._')
    return cleaned or "Unnamed"

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
CONFIG_FILE = Path(__file__).parent / "config.json"
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

# Initialize Flask app
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
app.config['MAX_CONTENT_LENGTH'] = config["max_file_size_mb"] * 1024 * 1024


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
    # Check key for other routes
    if not verify_auth():
        return jsonify({"error": "Unauthorized. Invalid or missing clinic secret key."}), 401

@app.route("/api/health", methods=["GET"])
def health_check():
    """Health check endpoint to verify server status and storage access."""
    try:
        total_folders = len([d for d in STORAGE_ROOT.iterdir() if d.is_dir()])
    except Exception:
        total_folders = 0
    return jsonify({
        "status": "online",
        "service": "Lumin Local Storage Server",
        "timestamp": datetime.now().isoformat(),
        "storageRoot": str(STORAGE_ROOT),
        "totalPatientFolders": total_folders,
        "maxFileSizeMB": config["max_file_size_mb"]
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

    patient_id = sanitize_name(request.form.get("patientId") or request.form.get("patient_id") or "General")
    raw_name = request.form.get("patientName") or request.form.get("patient_name") or ""
    patient_name = resolve_patient_name(patient_id, raw_name)
    category = sanitize_name(request.form.get("category") or "General")

    # Folder format: Use clean patient name only (e.g. يحيى_سيد_أبو_غالي)
    patient_folder_name = patient_name if patient_name else patient_id
    target_dir = STORAGE_ROOT / patient_folder_name / category
    target_dir.mkdir(parents=True, exist_ok=True)

    # Clean file name and attach date
    original_filename = sanitize_name(Path(uploaded_file.filename).name)
    ext = Path(original_filename).suffix.lower().lstrip(".")
    if ext and ext not in config["allowed_extensions"]:
        return jsonify({"error": f"File extension '.{ext}' is not permitted."}), 400

    date_str = datetime.now().strftime("%Y-%m-%d")
    timestamp_unique = int(datetime.now().timestamp())
    saved_filename = f"{date_str}_{timestamp_unique}_{original_filename}"

    file_path = target_dir / saved_filename
    uploaded_file.save(str(file_path))
    generate_thumbnail(file_path)

    relative_path = str(file_path.relative_to(STORAGE_ROOT)).replace("\\", "/")
    file_size = file_path.stat().st_size

    logger.info(f"Saved: {relative_path} ({file_size / 1024:.1f} KB)")

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
    """List all media files for a specific patient by ID or name."""
    safe_patient_id = sanitize_name(patient_id)
    raw_name = request.args.get("name") or request.args.get("patientName") or ""
    safe_patient_name = resolve_patient_name(patient_id, raw_name)

    matched_dirs = []

    # 1. Primary: match clean patient name folder
    if safe_patient_name:
        name_dir = STORAGE_ROOT / safe_patient_name
        if name_dir.is_dir():
            matched_dirs.append(name_dir)

    # 2. Match exact patient_id folder
    id_dir = STORAGE_ROOT / safe_patient_id
    if id_dir.is_dir() and id_dir not in matched_dirs:
        matched_dirs.append(id_dir)

    # 3. Match legacy folders starting with patient_id_ or ending with _patient_name
    for d in STORAGE_ROOT.iterdir():
        if d.is_dir() and d not in matched_dirs:
            if d.name.startswith(f"{safe_patient_id}_"):
                matched_dirs.append(d)
            elif safe_patient_name and d.name.endswith(f"_{safe_patient_name}"):
                matched_dirs.append(d)

    files_list = []
    for patient_dir in matched_dirs:
        for root, _, files in os.walk(patient_dir):
            for filename in files:
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

@app.route("/api/file", methods=["DELETE"])
def delete_file():
    """Delete a file from local storage."""
    data = request.get_json(silent=True) or {}
    rel_path_str = data.get("relativePath") or request.args.get("relativePath")
    if not rel_path_str:
        return jsonify({"error": "relativePath parameter is required."}), 400

    # Ensure path stays within STORAGE_ROOT (prevent directory traversal)
    clean_rel_path = Path(rel_path_str.replace("\\", "/")).as_posix().lstrip("/")
    target_path = (STORAGE_ROOT / clean_rel_path).resolve()

    if not str(target_path).startswith(str(STORAGE_ROOT)):
        return jsonify({"error": "Forbidden path access."}), 403

    if not target_path.exists() or not target_path.is_file():
        return jsonify({"error": "File not found."}), 404

    try:
        target_path.unlink()
        thumb_candidate = (THUMBNAIL_ROOT / clean_rel_path).with_suffix(".webp")
        if thumb_candidate.exists():
            try:
                thumb_candidate.unlink()
            except Exception:
                pass
        logger.info(f"Deleted: {clean_rel_path}")
        return jsonify({"success": True, "message": "File deleted successfully", "deletedPath": clean_rel_path})
    except Exception as e:
        logger.error(f"Failed to delete {clean_rel_path}: {e}")
        return jsonify({"error": f"Failed to delete file: {e}"}), 500

@app.route("/api/thumbnail/<path:filename>", methods=["GET"])
def get_thumbnail(filename):
    """Serve a lightweight, compressed WebP thumbnail (max 480x480) for instant preview loading."""
    try:
        clean_filename = Path(filename.replace("\\", "/")).as_posix().lstrip("/")
        requested = (STORAGE_ROOT / clean_filename).resolve()
        if not str(requested).startswith(str(STORAGE_ROOT)):
            return jsonify({"error": "Access denied."}), 403

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
    except Exception as e:
        logger.error(f"Error serving thumbnail {filename}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/files/<path:filename>", methods=["GET"])
def serve_file(filename):
    """Stream or serve the raw full-resolution image / file to the browser."""
    clean_filename = Path(filename.replace("\\", "/")).as_posix().lstrip("/")
    resp = send_from_directory(STORAGE_ROOT, clean_filename)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp

if __name__ == "__main__":
    port = int(config.get("port", 5000))
    print("=" * 60)
    print("  LUMIN DENTAL CLINIC - LOCAL STORAGE SERVER")
    print("=" * 60)
    print(f"  Storage Directory: {STORAGE_ROOT}")
    print(f"  Local Port:        http://localhost:{port}")
    print(f"  Secret Clinic Key: {config.get('clinic_secret_key')}")
    print("=" * 60)
    app.run(host="0.0.0.0", port=port, debug=False)
