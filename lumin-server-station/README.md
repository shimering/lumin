# 🦷 Lumin Server Station & Two-Node Sync Hub (Tailscale Edition)

**Lumin Server Station** is the self-hosted storage and synchronization engine for Lumin Dental Practice. It provides a native Windows management UI application, local REST storage server, **Tailscale Remote Funnel integration**, and a two-node file replication system.

---

## 🌟 Key Capabilities

### 1. Remade Two-Node File Synchronization
* **Folder Hierarchy Preservation**: Keeps all patient folders (`P1042_John_Doe/Panoramic/...` and `P1042_John_Doe/3D-Scans/...`) structured identically on both the Dedicated Clinic PC and doctor laptops.
* **X-Rays & Clinical Photos**: Automatically replicates all dental image formats (`.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp`, `.dcm`, `.dicom`, `.tif`, `.tiff`, `.pdf`).
* **3D Intraoral Scans**: Replicates 3D dental scans **strictly as original `.zip` archives** (`Upper_Lower_Scan.zip`). Loose uncompressed mesh files are excluded.
* **Central Cloud Metadata**: Tooth assignments, display labels, and clinical notes are managed in **Supabase Cloud**, eliminating local JSON metadata sync conflicts.
* **Two-Node Version Vectors (Causality)**: Tracks causal revisions (`{node_a: rev, node_b: rev}`) instead of wall clocks, avoiding timezone and clock-drift issues.
* **Safe Conflicts & Recovery**: If both servers edit a file independently, both versions are kept with a `__conflict` suffix. Replaced or deleted files are preserved in a recovery archive (`.lumin-sync/archive/`).

### 2. Tailscale Remote Access & Funnel
* **Permanent HTTPS Domain**: Uses Tailscale Funnel (`https://<device-name>.<tailnet>.ts.net`) with an automatic, valid Let's Encrypt TLS certificate. No port forwarding or dynamic DNS required!
* **Automated Supabase Registration**: Automatically registers the active Tailscale URL with Supabase so all iPads, iPhones, and workstations connect without typing IP addresses.
* **Zero Configuration for Remote Devices**: Any device outside the clinic or on cellular data securely reaches the clinic storage server.
* **One-Click Controls**: Enable or disable the Funnel directly from the Manager UI.

### 3. Desktop Manager Application (`LuminServerStation.exe`)
* **Service Control**: One-click **Start**, **Stop**, and **Restart** for the local storage server (with live uptime counter, port, LAN IP, and PID).
* **Tailscale Monitoring**: Displays live Tailscale status (`● FUNNEL ACTIVE`, `● TAILNET ONLY`, etc.), tailnet IP (`100.x.y.z`), and public URL.
* **One-Click Sync**: Pair Coordinator and Replica nodes and run manual or background scheduled syncs with a real-time progress bar, file count, and byte counters.
* **Background Automation**:
  * **Windows Startup**: Automatically launch on Windows boot.
  * **Auto-Start**: Start server and enable Tailscale Funnel automatically on launch.
  * **System Tray**: Minimize to the Windows notification tray with a right-click quick menu.
  * **Scheduled Auto-Sync**: Background sync on interval (15m, 30m, 1h, or 4h).
* **Storage Capacity**: Live drive space monitor (Free GB / Total GB).
* **Live Console**: Real-time streaming log viewer with export and clear options.

---

## 📁 Folder Structure

```text
lumin-server-station/
├── LuminServerStation/
│   └── LuminServerStation.exe # Standalone Windows executable UI manager
├── start-station.bat          # Quick launcher script
├── build_exe.py / .bat        # Packaging scripts
├── manager_app.py             # CustomTkinter desktop UI & Tailscale manager
├── server.py                  # Local storage HTTP API server
├── file_sync.py               # Remade Protocol 1 file replication engine
├── tailscale_access.py        # Tailscale Funnel integration & health verifier
├── tunnel_sync.py             # Tunnel utilities
├── config.json                # Storage server configuration (port, storage_path, key)
├── station_config.json        # Manager UI & automation preferences
└── README.md                  # Comprehensive setup & user manual
```

---

## 🚀 How to Run

### Option A: Double-Click the Executable
Double-click `LuminServerStation.exe` (or `start-station.bat`).
1. Click **Start Server** on the **Services & Health** tab.
2. Click **Enable Funnel** (or it starts automatically) to activate the secure public Tailscale domain.
3. Open Lumin Web App in your browser (`Admin → Storage & X-Rays`) to confirm Connected.

### Option B: Two-Node Server Pairing & Sync
1. On the **Dedicated Clinic PC**:
   - Set role to **Coordinator**.
   - Note its Tailscale or local IP URL.
2. On the **Doctor's Laptop**:
   - Set role to **Replica**.
   - Start the server on both machines.
3. On the **Coordinator**:
   - Enter the laptop's URL and Secret Key in the **File Synchronization** tab.
   - Click **Pair Servers**.
   - Click **⚡ Sync Files Now** to synchronize all X-ray photos and 3D scan `.zip` files in both directions!
