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

## ⚙️ Configuration (`config.json`)

You can edit `config.json` in Notepad to customize:
* `"storage_path"`: Change the drive or folder (e.g. `E:\DentalRecords` or `D:\LuminStorage\Patients`).
* `"clinic_secret_key"`: Your private clinic authentication password.
* `"port"`: Default is 5000.
* `"max_file_size_mb"`: Default 50 MB per file.

## Troubleshooting tunnel errors

* `server.log` contains local server startup errors when using `start-storage.bat`.
* `tunnel.log` contains Cloudflare output, including errors after the tunnel starts. These logs stay in the `storage-server` folder and are excluded from Git.
* A generated `trycloudflare.com` address alone does not mean the tunnel is connected. Wait for `[OK] Storage server is reachable through ...`.
* If QUIC fails during startup, the launcher retries once using HTTP/2. To use HTTP/2 immediately, run `start-storage.bat --http2` (or `start-tunnel.bat --http2` for a separately started server).
* Cloudflare needs outbound access to `api.trycloudflare.com` on port 443 to create a quick tunnel and to its tunnel endpoints on port 7844 (UDP for QUIC, TCP for HTTP/2). HTTP/2 cannot fix a network that blocks both protocols. See [Cloudflare connection troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/).
* If the server is not ready, check `http://127.0.0.1:5000/api/health` on the storage computer, substituting the configured port if different. Check `server.log` or the `start-server.bat` window for the underlying error.
* Quick tunnel URLs change after restarting. Use the URL verified by the current running launcher; `start-storage.bat` syncs it automatically when the database is reachable.
