# Lumin storage access from iPads, iPhones and other computers

A green badge on the storage computer and a Tailscale device marked online do
not prove that the server is reachable from other devices. On the server,
Tailscale's MagicDNS resolves its own HTTPS address to a private Tailscale IP.
Public devices use Funnel's public relay instead. A stale Funnel registration
can leave the private route working while public HTTPS fails.

The checker in `tailscale_access.py` uses public DNS and connects directly to
the public relays with normal certificate validation. It verifies the real
Lumin health response and the browser's CORS preflight. It does not read patient
files or transmit the clinic secret key. In read-only mode, run:

```powershell
.\.venv\Scripts\python.exe .\tailscale_access.py
```

## Set up the dedicated PC

1. Copy the storage-server software to the PC. Keep its existing `config.json`
   and patient folders. Configure its storage path and clinic key, then start
   the server using `start-server.bat`.
2. Install Tailscale from its official website and sign in on that PC.
3. Run `setup-tailscale-access.bat`. It enables a persistent Funnel using the
   port from this PC's `config.json`, verifies public HTTPS and browser access,
   and reconnects Tailscale once if its public registration is stale. It
   preserves other applications' port-443 configuration instead of replacing it.
4. Only after both public checks pass, save the printed **HTTPS URL** and that
   PC's existing clinic key in Lumin **Admin > Storage & X-Rays**. This selects
   the PC's storage for the clinic. Do not save `localhost`, `127.0.0.1`, or a
   laptop's URL as the dedicated PC's address.
5. Refresh Lumin on the iPad/iPhone and confirm **Connected**. Also verify a
   patient X-ray loads. The PC must stay powered on, connected to the internet,
   and awake while storage is needed.

For availability after a Windows sign-out, enable **Tailscale > Preferences >
Run unattended**. Tailscale and the storage server both need to start when the
PC is used. A Windows Startup-folder shortcut starts the storage server **after
sign-in**, not before anyone signs in; use a properly configured Windows service
or startup task if storage is required before sign-in.

## Repair laptop-only connectivity

Run `repair-tailscale-access.bat` on the computer hosting storage. It checks
local storage first and only reconnects an existing Tailscale session when
public TLS/TCP access fails. It does not clear Funnel settings, change the
clinic's active storage URL, replace another application's proxy, or disable
authentication. If an application or CORS error is detected, it reports that
error without restarting the VPN.

The manual equivalent for a stale registration is:

```powershell
tailscale down
tailscale up --timeout=20s
```

This briefly reconnects Tailscale while retaining its saved configuration.
Re-run the checker afterward. If reconnection requires signing in, finish that
in the official Tailscale app and run the checker again.

Tailscale documents [persistent Funnel configuration](https://tailscale.com/docs/reference/tailscale-cli/funnel)
and [Windows unattended mode](https://tailscale.com/docs/how-to/run-unattended).
A similar Windows registration failure is reported in
[Tailscale issue #19508](https://github.com/tailscale/tailscale/issues/19508).
