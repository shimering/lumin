# Lumin Local Storage Server & Cloudflare Tunnel

Self-hosted file storage for Lumin Dental Clinic. Saves patient X-rays and clinical photos directly into human-readable Windows folders on your local hard drive, with secure, universal online access via Cloudflare Tunnel.

---

## 📁 How Folders Are Saved On Your Computer

Whenever any user in Lumin uploads a photo or X-ray, the server automatically organizes it into clean, readable folders:

```text
D:\LuminStorage\Patients\
  ├── P1042_John_Doe\
  │     ├── Panoramic\
  │     │     └── 2026-09-13_1726210000_Pano_Full.jpg
  │     ├── Periapical\
  │     │     └── 2026-09-13_1726210010_Tooth_14_PA.jpg
  │     └── Clinical-Photos\
  │           └── 2026-09-13_1726210020_Intraoral_Upper.jpg
  └── P1043_Sarah_Connor\
        └── ...
```

You can open these folders in **Windows File Explorer** anytime to view, copy, or drag-and-drop images into other dental imaging software (Sidexis, EzDent-i, Carestream, etc.).

---

## 🗄️ SQL & MySQL Mapping Files on Local Storage

Lumin maintains full, human-readable and queryable database mapping files directly on your local storage drive (`D:\LuminStorage\Patients\`):

1. **`patients_mapping.sql`** (Root folder `D:\LuminStorage\Patients\`):
   A complete **MySQL / MariaDB dump file** mapping every patient (`patient_id` UUID, `patient_number`, `patient_name`, `phone`, `folder_name`, and absolute path) and all of their media files (`category`, `filename`, `relative_path`, `file_size_bytes`, `file_extension`, and timestamps) with standard `INSERT INTO ... ON DUPLICATE KEY UPDATE` syntax.
2. **`patients_mapping.sqlite`** (Root folder `D:\LuminStorage\Patients\`):
   A portable **SQLite database file** containing indexed tables `patient_folders_mapping` and `patient_files_mapping`. You can query this file directly with SQLite GUI tools (DB Browser for SQLite, DBeaver, or Python scripts) without needing any database server installed!
3. **`patients_mapping.json`** (Root folder `D:\LuminStorage\Patients\`):
   A clean JSON registry of all patient folders and their media files inventory.
4. **`patient_mapping.sql` & `patient_mapping.json`** (Inside each patient's folder):
   Each individual patient directory (e.g. `D:\LuminStorage\Patients\ميرفت_سعيد_عبد_الصادق\`) contains its own dedicated MySQL dump file (`patient_mapping.sql`) and JSON file (`patient_mapping.json`) for instant standalone import, audit, or verification.

These mapping files are automatically synchronized whenever a file is uploaded, moved, deleted, or when a patient folder is renamed.

---

## 🚀 How to Run

### Step 1: Start the Local Storage Server
Double-click `start-server.bat`.
* The server will launch at `http://localhost:5000`.
* It searches for Python 3.9 or newer using the Python launcher, PATH, and common installation folders.
* If the copied `.venv` points to Python on another computer, it rebuilds the environment automatically.
* It installs missing packages from `requirements.txt` before starting.

### Step 2: Start the Cloudflare Tunnel
Double-click `start-tunnel.bat`.
* It detects whether Windows is 32-bit or 64-bit and launches the correct version automatically.
* On first run, it downloads the matching official Cloudflare executable.
* You can also manually run `start-tunnel-windows-32bit.bat` or `start-tunnel-windows-64bit.bat`.
* It will output a public HTTPS address like:
  `https://random-words.trycloudflare.com`

Alternatively, double-click `start-storage.bat` to prepare Python, start the local server, and start the correctly matched Cloudflare Tunnel together. It waits for the server and verifies the public health endpoint before automatically syncing the new URL to Lumin. Keep its window open while storage is in use.

All tunnel launchers use the port from `config.json` and monitor the connection continuously. The separate `start-tunnel.bat` requires the local server to be running and leaves saving the verified URL to you.

### Step 3: Connect in Lumin App
1. Open **Lumin Dental Clinic** in your browser.
2. Go to **Admin** &rarr; **Storage & X-Rays** tab.
3. Paste your tunnel URL (or `http://localhost:5000` if on the same computer) and your secret key:
   - **Storage URL**: `https://random-words.trycloudflare.com`
   - **Clinic Secret Key**: `LuminClinicKey_2026` (set in `config.json`)
4. Click **Test Connection** &rarr; **Save Settings**. Once connected, all users can upload and view patient media instantly!

---

## ⚙️ Configuration (`config.json`) & Changing Drive Location from Lumin

You can change your storage folder anytime **directly from inside the Lumin web app (Admin &rarr; Storage Server tab)** or by editing `config.json` in Notepad:
* `"storage_path"`: Change the drive or folder (e.g. `E:\DentalRecords` or `D:\LuminStorage\Patients`).
* `"clinic_secret_key"`: Your private clinic authentication password.
* `"port"`: Default is 5000.
* `"max_file_size_mb"`: Default 50 MB per file.

### 💽 Changing Drive / Folder from Inside Lumin Web App
1. Open **Lumin Dental Clinic** &rarr; **Admin** &rarr; **Storage Server** tab.
2. Under **Storage Location & Local Drive**, inspect the active directory (e.g. `D:\LuminStorage\Patients`), free space on host drives (C:, D:, etc.), and total patient folders and media files.
3. Click **Change Location / Move**.
4. Choose any detected host drive pill, browse subfolders, or create a new subfolder.
5. Keep **Migrate & Copy Existing Patient Files** checked to automatically copy all existing patient records and X-rays to the new location without losing data.
6. Click **Apply Location**. The storage server will immediately update `config.json`, migrate the files, and regenerate the MySQL and SQLite mappings.

## Troubleshooting tunnel errors

* `server.log` contains local server startup errors when using `start-storage.bat`.
* `tunnel.log` contains Cloudflare output, including errors after the tunnel starts. These logs stay in the `storage-server` folder and are excluded from Git.
* A generated `trycloudflare.com` address alone does not mean the tunnel is connected. Wait for `[OK] Storage server is reachable through ...`.
* If QUIC fails during startup, the launcher retries once using HTTP/2. To use HTTP/2 immediately, run `start-storage.bat --http2` (or `start-tunnel.bat --http2` for a separately started server).
* Cloudflare needs outbound access to `api.trycloudflare.com` on port 443 to create a quick tunnel and to its tunnel endpoints on port 7844 (UDP for QUIC, TCP for HTTP/2). HTTP/2 cannot fix a network that blocks both protocols. See [Cloudflare connection troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/).
* If the server is not ready, check `http://127.0.0.1:5000/api/health` on the storage computer, substituting the configured port if different. Check `server.log` or the `start-server.bat` window for the underlying error.
* Quick tunnel URLs change after restarting. Use the URL verified by the current running launcher; `start-storage.bat` syncs it automatically when the database is reachable.

---

## 🔄 Automatic Windows Startup & Permanent Access

If you want the storage server to start automatically whenever your computer powers on:

1. **Auto-Start on Boot**:
   Double-click `install-startup.bat`.
   * It creates a silent shortcut in your Windows Startup folder.
   * On every boot, the server runs quietly in the background without opening any command prompt windows.
   * To remove it from startup later, double-click `uninstall-startup.bat`.

2. **Permanent Free Access via Tailscale Funnel (No Domain Needed)**:
   * Double-click `start-tailscale-funnel.bat` (or run `tailscale funnel --bg 5000`).
   * Gives you a permanent HTTPS URL like `https://your-pc.tailnet.ts.net`.
   * Clients (iPads, phones, laptops) do not need any app installed—they open the URL directly in their web browser!

## One-click patient-file synchronization

Install the updated `server.py` and its new companion `file_sync.py` on **both**
computers, keeping each computer's own `config.json`, storage folders, and private
`.lumin-sync` directory. Restart each storage server using its existing launcher.
No new Python packages or Supabase migrations are required.

In **Admin → Storage Server**:

1. Save the laptop and dedicated PC URLs and clinic keys in **Saved servers**.
   Both addresses must be reachable from the dedicated PC. A laptop's `localhost`
   address identifies the dedicated PC when used there; use its LAN or HTTPS address instead.
2. In **Sync patient files**, select the dedicated PC and laptop, then click
   **Pair servers** once. Pairing requires an active Lumin administrator session
   and stores a separate secret on the servers. It does not switch active storage.
3. Verify with disposable patient files first, then click **Sync now** to transfer
   patient files. Both computers must stay on. The browser may be closed after
   starting; reopen the panel to recover the current job and its progress.

The first run merges files. Subsequent runs replicate additions, changes,
deletions, and category moves in both directions. If one copy is edited while
the other is deleted, the edited copy is preserved and marked for review.
Conflicting edits keep both originals and create deterministic conflict copies.
Review these files before deciding which version to retain. There is no automatic schedule.

Progress shows scanning, transfer bytes/file counts, deletions, verification, and
completion. A restart or connection failure leaves a failed job; **Retry** scans
again, skips verified transfers, and restarts unfinished files. Updated tunnel
URLs can be applied by editing the saved profile and clicking **Update pairing**.
The existing coordinator remains the dedicated PC.

Private runtime data lives in `storage-server/.lumin-sync/` (or the optional
`sync_state_path` configured outside patient storage). `archive/<unique-id>/`
retains original folder paths for files removed or replaced through Lumin or sync.
To recover a version, copy it from that archive back to its original patient path;
the next sync recognizes it as a new local change. Archives are retained until
manually cleared and are not served or replicated. Ordinary File Explorer
deletions can only be archived on the other server while its copy still exists.

Back up each machine's patient folders **and its own private sync state**. Do not
copy `.lumin-sync` from one computer to the other: each machine needs a distinct
identity and deletion history. Patient files, pairing credentials, archives, and
runtime databases must stay out of Git and deployment packages.

Administrator verification uses Supabase Auth and the existing active
`user_profiles → access_roles.is_admin` relationship. No service-role key is used.
If administrator verification is unavailable, starting or pairing a job fails
closed; an already authorized background job uses its server pairing credentials.

## Patient 3D scans

The **3D Scans** patient tab accepts ZIP archives containing upper and lower OBJ
models with their MTL materials and JPEG, PNG, or WebP textures. Preview the pair,
confirm the arch selections, then save it. The ZIP is stored byte for byte under
the patient's **3D-Scans** folder. Each import has its own subfolder, with the ZIP
filename exactly as uploaded, including spaces, Arabic characters, and letter case.
Repeated filenames remain separate scans. The server never extracts or converts it.
**Download original ZIP** restores the imported filename. The extra STL and all
other original archive entries remain inside that download.

Scan names, notes, optional scan dates, selected OBJ paths, and display orientation
are shared through `patient_media_details` in Supabase. Patient permissions remain
the same. Rendering modes, opacity, lights, camera movement, and section cuts only
affect the viewer. Comparison links two cameras without registering the scans or
calculating contacts. Cuts show existing surfaces without generating interior geometry.
The viewer starts with a dark background. Drag with the left mouse button to rotate;
hold the left and right buttons together to pan. Touch panning still uses two fingers.

Update **both paired servers** before synchronizing scans. On the other computer:

1. Stop the running storage server.
2. Extract `lumin-storage-sync-update.zip` into its existing server installation
   folder, replacing `server.py`, `file_sync.py`, and `README.md`.
3. Keep that computer's `config.json`, patient files, and `.lumin-sync` directory.
4. Restart with its existing `start-storage.bat` or server launcher.
5. Verify `/api/health` includes `capabilities.patient3dScans: true` and
   `capabilities.scanOriginalFilenames: true`, then sync.

Existing installations support ZIPs without editing `allowed_extensions`. Other
file restrictions and the configured upload limit still apply. Each new scan uses
a unique identifier; retrying an interrupted upload reuses that identifier without
replacing its archive. ZIP downloads require the storage key and are not publicly cached.
Older servers show an update message before import.

The browser rejects traversal paths, external material/texture URLs, encrypted or
damaged ZIPs, and expansion beyond 128 entries, 128 MB per entry, or 256 MB total.
Each arch is limited to 750,000 triangles and 1,000,000 vertices. Textures are limited
to 8192 pixels per side, 16 megapixels each, and 32 megapixels per scan. WebGL2 is
required for the viewer; downloads remain available without it.
