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
* It uses your local Python virtual environment (`.venv`).

### Step 2: Start the Cloudflare Tunnel
Double-click `start-tunnel.bat`.
* On first run, it will automatically download `cloudflared.exe`.
* It will output a public HTTPS address like:
  `https://random-words.trycloudflare.com`

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
