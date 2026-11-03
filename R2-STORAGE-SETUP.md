# Cloudflare R2 storage

Lumin's existing `lumin` Worker serves the private storage API at `/r2`.
The `LUMIN_MEDIA` binding points to the `lumin-clinic-media` R2 bucket.
Keep public bucket access disabled. No Cloudflare API credentials are needed in
the browser or clinic settings.

## Using R2

Open **Admin → Storage Server**. Cloudflare R2 appears in Saved servers on every
device. **Test R2** checks the authenticated connection and, for administrators,
writes, reads, and deletes a small synthetic object. This does not select R2 or
upload patient data. **Use Cloudflare R2** selects it for the clinic using the
existing confirmed settings workflow.

Existing files stay on their original server. Switching does not migrate them.
Files up to 64 MB are supported, including 3D scan ZIPs. Image previews currently
return the original image.

## Google Drive ↔ R2 sync

In **Sync patient files**, select Google Drive and Cloudflare R2 in either order,
then pair them. R2 coordinates the job directly using the existing Drive peer
API; a local clinic server is not required. The peer secret stays in the private
bucket and is never returned to the browser.

**Sync now** transfers new files and changes in both directions, including tooth
assignments, notes, labels, scan dates, and scan settings. Content uses SHA-256
verification. A saved three-way baseline distinguishes one-sided edits from
conflicts. Conflicting changes and missing copies require explicit review;
replaced originals are preserved. Automatic deletion is disabled for cloud sync.
Choosing **Keep both** records an explicit exception rather than claiming the
copies match.

Keep the storage screen open while syncing. One bounded file operation runs per
request; the job and progress persist in R2. Reopening the screen resumes an
interrupted running job. Failed jobs can be retried without duplicate uploads.
Drive's existing sync API limits each file to **24 MB**. Larger R2 files remain
untouched and are listed for review.

Legacy Drive files without saved patient IDs are listed separately and never
assigned by guessing a name. They do not block files with confirmed identities.
Administrators can explicitly remove the listed unassigned files from active
Drive storage; the API rechecks their hashes and that no patient annotation was
added, then uses Drive's existing recovery archive. Assigned files cannot be
removed through that cleanup operation.
If the exact unassigned original was manually copied into R2, cleanup also
moves it into R2's private recovery area after verifying its checksum and saving
its original path. Linked or differing R2 copies remain untouched.

The administrator-only diagnostic API `/r2/api/cloud-sync/verify` uses an isolated synthetic image in
`Lumin_Sync_Verification/General`, sends it R2 → Drive → R2, and verifies the
round-trip hash. It removes the test from active storage and uses Drive's normal
recovery archive for its synthetic original. No patient records are created or
modified. Interrupted verification cleanup is resumed before the next test or
sync. This diagnostic is covered by integration tests and is not shown as a
button in the clinic interface.

## Access and data

Inventory item photos use the selected clinic storage. With R2 selected, new
photos are saved privately under `Lumin Clinic/Inventory/item-<item UUID>-<photo revision>.webp`
(or `.jpg`) without requiring Google Drive. The existing photo service still
enforces inventory view/manage permissions and the 300 KB optimization limit.
Supplier-list thumbnails reuse the same image service. Stock balances and
movements remain in the shared database.

Cloud **Sync now** includes current inventory photos as well as patient files.
The inventory service verifies each copy against the shared photo revision and
SHA-256 checksum before recording a second location. Existing manually copied
Drive images can be adopted at their original filenames after verification.
Photos with mismatched content remain preserved and stop sync until reviewed;
inventory replicas never create patient records or alter stock movements.
Replaced R2 originals are moved into the private recovery area. Apply only
`supabase/migrations/20261103144157_inventory_r2_photos.sql` and deploy the updated
`inventory-images` function alongside the Worker when upgrading this feature.

- Every API request verifies the caller with Supabase Auth and checks the
  current active profile and patient-page permission. Patient lookups use the
  caller's token and existing RLS policies; no service-role credentials are used.
- Browser media URLs use random read-only grants lasting at most 15 minutes,
  bounded by session expiry. Their server-side records are private R2 objects.
  Logout revokes outstanding grants; expired grants are rejected and cleaned up
  as new grants are issued. The session JWT is never included in a media URL.
- Originals are stored under `Lumin Clinic/<patient name>/<category>/...`, using
  the exact mapped Drive folder names for synchronized patients. Clinical notes,
  tooth assignments and scan settings remain under `metadata/`. Internal patient
  IDs and media links stay stable; they are resolved through a private folder
  registry rather than used as the visible patient folder names.
- **Refresh patient folders** discovers copied Drive folders using recorded
  patient UUIDs from the Drive catalog and saved sync mappings. It never infers
  ownership from a matching patient name. The versioned index can be rebuilt if
  older coded folders or the previous folder index were removed. Missing local
  notes, tooth assignments and scan settings are restored only after the copied
  file hash matches its recorded Drive original; existing R2 edits are retained.
- The same action migrates already-uploaded coded folders. It copies
  each file, verifies its SHA-256 hash and size, rechecks the source, then removes
  the old coded copy. Progress persists across reloads. Different destination
  content stops migration while preserving both originals. Patient renames keep
  old folders as readable aliases until organization moves their files.
- Future uploads use the confirmed named patient folder, and both sync
  directions retain that scheme. Deleting the old coded prefix does not require
  recreating it. Refresh clears session media caches so repaired files appear
  immediately in Lumin.
- Storage responses use `private, no-store`; the service worker excludes `/r2/`
  from its offline cache. Originals support byte-range requests.
- The API enforces allowed extensions/categories, request sizes, safe paths,
  patient ownership, and conditional metadata writes.

## Deployment and checks

Deploy the existing Worker with `wrangler deploy --keep-vars`; `wrangler.jsonc`
contains the bucket binding and `/r2/*` routing. Existing app routes continue to
use the same Worker. Patient storage requires no database migration; inventory
photos require the migration and photo-function deployment listed above.

Run the R2 tests with:

```powershell
$env:LUMIN_TEST_BROWSER_CHANNEL = 'msedge'
node --test tests/r2-storage.test.cjs tests/r2-runtime.test.cjs tests/r2-browser.test.cjs
```

The runtime test uses local R2 and synthetic identities. Production **Test R2**
uses only a synthetic object under `_checks/`, then removes it.
