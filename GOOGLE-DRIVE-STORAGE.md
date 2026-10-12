# Google Drive storage for Lumin

Google Drive is a built-in choice in **Admin → Storage Server → Quick switch**.
One administrator connects the clinic account. Doctors with an active Lumin role
that can view Patients use their own Lumin sign-in to access that storage.
They do not need the administrator's Google password or a separate Google login.

**Sync patient files** still compares exactly two selected locations. Choose any
two saved local servers, or one local server and Google Drive. Drive can be first
or second in the selectors; the selected local server runs the durable sync job.
The existing PC/laptop pairing is saved independently and is not reset by Drive
pairing. Sync starts manually with **Sync now**; no three-location job is created.

## What is stored

The connector creates a private **Lumin Clinic** folder in the connected account:

```text
Lumin Clinic/
  أحمد_علي/
    Panoramic/
      2026-10-12_..._film.png
    Periapical/
      2026-10-12_..._film.jpg
    Clinical-Photos/
      ...
    3D-Scans/
      <upload-id>/original-archive.zip
  .Lumin_Recovery/
    <recovery-id>/previous-original.png
```

Files received from a local server keep their relative patient/category paths
and filenames. Patient UUIDs bind folders to the correct clinical record;
duplicate patient names get a UUID suffix when necessary. Renaming a patient
through Lumin renames the Drive folder and updates file paths and annotations.

Patient notes, display names, tooth assignments and scan settings are held in
private Supabase connector tables, and sync to the local server's clinical
metadata. Google credentials, sync clocks and annotation recovery history also
live in these backend tables. SQL/SQLite mapping exports remain a local-server
feature. Back up both the connector database tables and the Google files.

The connector manages files uploaded through Lumin or received through Lumin
sync. It tracks content changes and explicit trash events for those known files
using Google's Changes API. Directly adding, moving or renaming arbitrary files
in the Google Drive website is not an import workflow; use Lumin for those
operations. Missing access or a Google outage stops sync instead of inferring
that a file was deleted.

Concurrent edits appear in **Review**. Deleted copies also wait for review before
the remaining copy is removed. Replaced and deleted originals are moved to
`.Lumin_Recovery`; previous annotation snapshots remain in private database
history. The Google folder is not made public and is not automatically shared
with doctors' Google accounts. The **Open clinic folder** link uses Google's
own permissions; access within Lumin uses the doctor's Lumin permissions.

## First-release limits

- Maximum **24 MiB per file** for upload and sync with Drive. Larger images or
  scan ZIPs produce a clear error; use a local server for them.
- Supported patient files: JPG/JPEG, PNG, WEBP, GIF, BMP, TIFF, PDF, DCM/DICOM
  and 3D scan ZIPs.
- Drive needs an internet connection. A local server must be running for local
  ↔ Drive sync; viewing Drive files in Lumin does not require a local server.
- Disconnecting requires first choosing local storage for the clinic. Files,
  UUID mappings and revision history are retained for reconnection to the same
  Google account. Keep the encryption secret unchanged during updates.

## Google setup

1. In Google Cloud Console, enable **Google Drive API** for the OAuth project.
2. Configure the Google Auth Platform consent screen for the clinic's use.
   The connector requests `openid`, `email` and
   `https://www.googleapis.com/auth/drive.file`. This scope limits access to
   files created or explicitly opened with this app; it does not grant access
   to the rest of the account. See [Google's Drive scopes documentation](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
3. Create an OAuth client of type **Web application**. Add this exact authorized
   redirect URI for the current Lumin Supabase project:

   ```text
   https://pqbayjkypzfxvnksgwwf.supabase.co/functions/v1/google-drive/callback
   ```

4. Use a production consent configuration before relying on persistent clinic
   storage. Google's testing-mode refresh tokens may expire after seven days
   when Drive scopes are requested. Add the admin Google account as a test user
   while testing. See [Google's OAuth token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## Backend configuration and deployment

Set these **Supabase Edge Function secrets**, never frontend constants, browser
storage or committed files:

| Secret | Value |
| --- | --- |
| `GOOGLE_DRIVE_CLIENT_ID` | The Web application OAuth client ID |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Its OAuth client secret |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` | A random secret of at least 32 characters; preserve it across deployments |
| `GOOGLE_DRIVE_APP_URL` | The exact HTTPS URL of the deployed Lumin app; OAuth returns here |
| `GOOGLE_DRIVE_REDIRECT_URI` | Optional; defaults to this project's function callback URL above |
| `GOOGLE_DRIVE_ROOT_NAME` | Optional; defaults to `Lumin Clinic` |

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge
Functions. The service key must never be passed to doctors or put in HTML.

Review and apply **only**
`supabase/migrations/20261012121611_google_drive_storage.sql` to the intended
project. It adds private tables and lease/rename RPCs without changing existing
patient media or storage selections. Do not blindly push other pending repository
migrations as part of this change.

Upload the secrets through Supabase's dashboard or the CLI's `secrets set
--env-file` option using a private, untracked file. Then deploy the function:

```powershell
npx supabase functions deploy google-drive --project-ref pqbayjkypzfxvnksgwwf --no-verify-jwt
```

`verify_jwt = false` is intentional: Google callbacks, private image grants and
durable peer credentials cannot use the platform JWT gate. The handler performs
its own authentication. Account management and pairing require a current active
admin; media requires a current active clinical role. Refresh tokens are encrypted
with AES-GCM, media grants expire after 15 minutes, and peer secrets are stored
only as hashes. Grants are revoked on logout and are not saved in clinic settings.

Deploy the updated static app, including the new Drive JS/CSS and `sw.js`.
Update **`storage-server/server.py`** and **`storage-server/file_sync.py`** together
on every local device that will sync with Drive, then restart its storage app.
For a packaged executable, rebuild it from the updated source; an older EXE
does not expose `/api/drive-sync`. Preserve existing configuration and patient
storage; the independent Drive state is created under the existing private sync
state folder's `google-drive` subdirectory.

After deployment, sign in as admin, choose **Connect Google Drive**, approve
Google's consent screen, and select **Use Google Drive**. Choose two locations
in Sync patient files, click **Pair servers**, then **Sync now**. Verify the first
upload and sync with a disposable image before using the clinic's files.

## Verification

The tests use disposable patient folders and simulated Google responses; they do
not access a real Google account. Run from the repository root:

```powershell
deno test supabase/functions/google-drive/core_test.ts supabase/functions/google-drive/handler_test.ts
python tests/storage-file-sync.test.py
python tests/google-drive-sync.test.py
node --test tests/google-drive-browser.test.cjs tests/google-drive-migration.test.cjs
```

Python tests need the storage server dependencies. The Drive HTTP integration
test needs Deno on PATH, or `LUMIN_TEST_DENO` pointing to its executable. Browser
tests need Playwright and a browser; `LUMIN_TEST_BROWSER_CHANNEL=chrome` selects
installed Chrome. The migration test needs `@electric-sql/pglite` (tested with
`0.3.14`) and checks actual PostgreSQL privileges, leases and transactional rename.

Live activation still requires the OAuth credentials, deployment and the
administrator's Google consent. Local automated tests do not verify the real
account's permissions, quota or network availability.
