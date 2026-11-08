# Lumin Dedicated Storage Server — Complete Setup Guide

This guide explains how to set up the **Dedicated Server PC** for Lumin Dental Practice, enable universal access (for iPads, phones, and laptops), and synchronize patient files and **3D intraoral scans** between the dedicated PC and laptops.

---

## 🌟 What is the Dedicated Server PC?

The Dedicated Server PC acts as the **central repository** for all clinical records:
- **Intraoral Photos & X-Rays**: Panoramic (OPG), Periapical (PA), Bitewings, Cephalometric, and clinical camera photos.
- **3D Scans**: Full intraoral scans (upper and lower arch models, bite registrations, textures) in `.zip`, `.stl`, `.obj`, `.ply`, `.mtl`, `.gltf`, `.glb`.
- **Queryable SQL Database**: `patients_mapping.sql` and `patients_mapping.sqlite` generated locally on disk for instant SQL inspection or external dental software integration (Sidexis, EzDent-i, Carestream, etc.).
- **Always-Available Host**: Stays on during clinic hours so chairside tablets (iPads, Android tablets) and laptops can instantly load and view high-resolution media.

---

## 🚀 Quick Setup on the Dedicated Server PC

### Step 1: Place the Server Folder
1. Copy this entire folder to your dedicated server PC.
2. Recommended location:
   - `D:\LuminStorageServer` or `C:\LuminStorageServer`

> [!NOTE]
> Do NOT place the server inside OneDrive, Dropbox, or Google Drive synced folders to avoid file locking conflicts.

### Step 2: Install and Start
1. Ensure **Python 3.9+** is installed on Windows with **"Add python.exe to PATH"** checked during Python installation.
   - If not installed, download from: https://www.python.org/downloads/windows/
2. Double-click `start-server.bat`:
   - It automatically checks Python.
   - It creates a dedicated local `.venv` virtual environment.
   - It installs required packages (`flask`, `flask-cors`, `pillow`).
   - It starts the server on port `5000` (configurable in `config.json`).
3. You should see:
   ```text
   [*] Starting Storage Server...
   [OK] Storage server is running at http://localhost:5000
   ```

### Step 3: Enable Auto-Start on Windows Boot (Recommended)
Double-click `install-startup.bat`:
- It creates a background launcher in your Windows Startup folder.
- Every time Windows boots, the Lumin storage server runs quietly in the background without showing any black console windows.
- To remove auto-start later, double-click `uninstall-startup.bat`.

---

## 🌐 Connecting to the Server from Lumin

### A. Local Network (LAN) Connection (Fastest Chairside Speed)
1. Find the dedicated PC's local IP address (open Command Prompt and type `ipconfig`, e.g. `192.168.1.50`).
2. Open Lumin Dental Clinic on your browser or iPad connected to the same Wi-Fi.
3. Go to **Admin** → **Storage & X-Rays** tab.
4. Enter:
   - **Storage URL**: `http://192.168.1.50:5000` (use your dedicated PC's IP)
   - **Clinic Secret Key**: `LuminClinicKey_2026` (found in `config.json`)
5. Click **Test Connection** → **Save Settings**.

### B. Universal Remote Access (Tailscale Funnel — Recommended)
Tailscale Funnel gives your dedicated PC a permanent, secure HTTPS domain (e.g. `https://clinic-server.ts.net`) with **no port forwarding required**:
1. Install Tailscale from https://tailscale.com/download/windows and sign in.
2. Double-click `setup-tailscale-access.bat`.
3. It configures the Funnel, verifies TLS and CORS headers, and prints your permanent HTTPS URL.
4. Save that URL in Lumin **Admin → Storage & X-Rays**.
5. All devices (outside the clinic, iPads on cellular, or home laptops) can access storage seamlessly.

---

## 🦷 3D Intraoral Scan Storage & Synchronization

### 1. How 3D Scans are Stored on Disk
Whenever a 3D scan is imported in Lumin, it is saved directly into the patient's folder:
```text
D:\LuminStorage\Patients\
  ├── P1042_John_Doe\
  │     ├── 3D-Scans\
  │     │     └── 8a4c12ef90ab...\
  │     │           └── Upper_Lower_Scan.zip  (Original ZIP archive)
  │     ├── Panoramic\
  │     │     └── 2026-10-06_OPG.jpg
  │     └── Clinical-Photos\
  │           └── 2026-10-06_Upper_Arch.jpg
```
Raw 3D model exports directly from scanner software (Medit, 3Shape Trios, Shining 3D, Carestream) placed into `3D-Scans` folders are also supported:
- `.stl` (Stereolithography files)
- `.obj` & `.mtl` (3D surface meshes & material definitions)
- `.ply` (Polygon meshes with vertex color)
- `.gltf` / `.glb` (3D scene files)
- `.zip` (Packaged full arch scans)

### 2. Large File Support
- `max_file_size_mb` in `config.json` is set to **250 MB** by default to accommodate high-resolution intraoral scans and multi-megabyte color textures.

### 3. One-Click Two-Way Sync Tool (Dedicated PC ↔ Laptop)
To keep the dedicated PC and a mobile doctor laptop in perfect sync:
1. In Lumin Web App, open **Admin** → **Storage Server** tab.
2. Under **Saved servers**, add both computers:
   - **Dedicated PC**: e.g. `https://clinic-server.ts.net` or `http://192.168.1.50:5000`
   - **Laptop**: e.g. `http://localhost:5000` or the laptop's network address
3. In **Sync patient files**:
   - Set **Dedicated PC** as coordinator.
   - Set **Laptop** as peer.
   - Click **Pair servers** once (requires Admin session).
4. Click **Sync now**:
   - Replicates all patient files, photos, X-rays, **3D scan folders**, and **tooth assignments & clinical notes** (`patient_media_details.json`) in both directions!
   - Transfer progress shows real-time file count, transfer speed, and megabytes.
   - Automatic conflict protection: if a file was modified in both places, both versions are preserved with a `__conflict` suffix.
   - As soon as synchronization finishes, the storage server automatically regenerates `patients_mapping.sql` and `patients_mapping.sqlite` with full tooth indexing (`idx_files_tooth`)!

---

## 🛠️ Management & Diagnostic Utilities

| File | Purpose |
| :--- | :--- |
| `start-server.bat` | Starts the server with live console log window. |
| `start-server-headless.bat` | Starts the server in background writing to `server.log`. |
| `start-server-background.vbs` | Completely silent launch (no window). |
| `install-startup.bat` | Installs background auto-start on Windows boot. |
| `uninstall-startup.bat` | Removes auto-start from Windows boot. |
| `start-storage.bat` | Starts both storage server and Cloudflare quick tunnel. |
| `setup-tailscale-access.bat` | Sets up and tests permanent HTTPS access via Tailscale. |
| `repair-tailscale-access.bat` | Reconnects stale Tailscale registrations. |
| `diagnose-connection.bat` | Diagnostic script checking local and remote endpoint health. |

---

## ⚙️ Configuration (`config.json`)

```json
{
  "port": 5000,
  "storage_path": "D:\\LuminStorage\\Patients",
  "fallback_storage_path": "./LuminStorage/Patients",
  "clinic_secret_key": "LuminClinicKey_2026",
  "max_file_size_mb": 250,
  "allowed_extensions": [
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "pdf", "dcm", "tif", "tiff",
    "zip", "stl", "obj", "ply", "mtl", "gltf", "glb"
  ]
}
```

You can change the storage folder or drive anytime directly from the **Lumin Admin UI** (**Storage Location & Local Drive** section) with automatic migration of existing patient records.
