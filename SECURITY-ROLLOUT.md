# Audit fixes and rollout

The changes are local and have not been deployed to Supabase, Cloudflare, or clinic PCs.

## Intentional behavior changes

| Finding | Result |
| --- | --- |
| S1: WhatsApp authorization | Staff actions require a verified JWT, active profile and WhatsApp permission (or administrator role). Incoming events require `X-Hub-Signature-256` verified with `WHATSAPP_APP_SECRET`. Requests larger than 25 MiB are rejected, including streaming bodies without Content-Length. |
| S2: exposed/default storage key | Empty and previously published default keys are rejected. Source configuration templates and public presets contain no credential. A real private key must be configured on each server. |
| S3: media compatibility RPCs | The uncommitted migration and the new corrective migration validate the current `clinic_settings.storage_secret_key`, with a minimum length of 32 characters. These remain compatibility capability endpoints for servers: calling them anonymously without the private configured key returns no data and performs no write. There is no hardcoded bypass. |
| S4: folder picker injection | Paths are carried in data attributes and never interpolated into executable handlers. Apostrophes/backslashes remain usable. |
| S5: privileged storage actions | Storage browsing, relocation and sync administration require an active Supabase administrator. Server Station's shared-key administrator bypass is removed; use the authenticated Lumin web Sync panel. Existing pairing credentials continue to authorize their narrowly scoped peer routes. |
| S6: media caching | Storage responses use `private, no-store`; successful request logs no longer record patient paths or temporary grants. |
| S7: browser/URL credentials | The active clinic key and inactive-server preset keys stay in memory. Legacy browser copies are removed. Local media URLs use revocable 15-minute, read-only grants. Downloads use headers and blob URLs. Google Drive retains its existing short-lived grants, with renewal before reads. Inactive preset keys may need to be re-entered after signing out. Local file APIs retain the shared clinic-key model; revoking a user who has learned that key requires rotating it. |
| S8: AI patient scope | Patient lookups and IDs are limited to the sender's existing phone/BSUID matches or an existing authorized conversation link. Shared-phone family selection remains available. Cross-clinic name matching is removed. A masked sender cannot attach an unrelated existing phone profile. No new OTP flow is introduced. |
| S9: logs | Expected webhook tokens, AI arguments/results, provider error payloads, and successful patient file paths are removed from routine logs. |
| S10: privileged RPCs | Anonymous callers cannot execute schedule/storage-usage RPCs. Current active staff need the relevant page permission; storage-usage service calls remain supported. |
| Additional provider credentials | Calendar OAuth client credentials and the calendar token-encryption key now come only from environment variables. Appointment notifications require `ONESIGNAL_REST_API_KEY`. Embedded fallbacks found in the formerly ignored source exports are removed; a missing configuration disables the affected integration. |
| H2: filename collision | Ordinary same-name uploads in the same second receive distinct random suffixes. Existing URLs and deterministic 3D scan upload IDs stay unchanged. |
| H3/H4: IO/migration | Provider calls have bounded timeouts and no automatic send retries. Calendar OAuth window messages must originate from the clinic app origin. The malformed historical SQL body is repaired; a new migration carries deployed permission corrections. Storage relocation now recognizes both supported success response shapes and sends the migration checkbox under the server's expected field name. |

## Dependencies

| Package | Before | After |
| --- | --- | --- |
| Supabase JS | 2.95.0 / 2.105.0 / 2.117.0 | 2.117.3, including the browser bundle |
| Supabase edge runtime declarations | Unpinned and 2.117.3 | All pinned to 2.117.3 |
| fflate | 0.8.2 | 0.8.3 (malformed ZIP64 denial of service fix) |
| Three.js | 0.180.0 | 0.186.1; viewer regressions exercised |
| Playwright development tool | Previously provided externally | 1.64.0, declared and locked |
| Flask / Flask-CORS / Pillow | Unbounded runtime requirements; installer already at current versions | Pinned to 3.1.3 / 6.0.5 / 12.3.0 |

`package-lock.json`, `deno.lock`, and hashed Python lockfiles make the resolved versions reproducible. The npm manifest records existing vendored libraries plus development tools; it introduces no frontend framework or bundler. The Python runtime lock is `storage-server/requirements.lock`; the Windows installer lock is `lumin-server-setup/requirements-build.lock`.

Lucide 0.468.0 → 1.56.0 is a major upgrade and remains unapplied. Check renamed icons and browser bundle compatibility before migrating.

## Cleanup before/after

| Item | Before | After |
| --- | --- | --- |
| D1 / reusable conversation resolution | Manual and template sends separately duplicated phone lookup, patient linking and insertion. | One local helper. Each action retains its original conversation-ID fallback behavior and its own message content. |
| H1: regression fixtures | Missing chart-media collaborators, scan state and a required tunnel binary prevented meaningful baseline checks. | Fixtures provide the current collaborators and mock the tunnel executable. The Server Station import now boots with a disposable configuration rather than the default clinic path. |
| SDK type annotations | An uninstantiated generic client return type and inferred JSON schedule maps failed the current compiler. | Correct generic instantiation and JSON annotations; emitted runtime logic is unchanged. |
| D2 / R1 scope | Three server variants have different metadata and sync protocols; the webhook dispatcher is large. | Security fixes are applied to all three source variants. Full server consolidation and a broader dispatcher rewrite are deferred to avoid changing those working protocols. The existing installer still packages the canonical `storage-server` sources. |

## Before deployment

1. Generate a private random clinic/server key of at least 32 characters outside the repository. Configure it on the clinic servers and in Lumin Admin storage settings. Do not commit real credentials. Local-only secrets must never be copied into public presets or build assets.
2. Configure each custom application origin in the server's `allowed_origins` list. The existing `https://lumin.gazarxperia.workers.dev` origin and HTTP loopback development origins are supported by default; unrelated browser origins are denied.
3. Set the Supabase Edge secret `WHATSAPP_APP_SECRET` from the Meta app configuration. Configure a private webhook verification token too. Deploy `whatsapp-webhook` using its checked-in `verify_jwt = false` setting: staff JWT and Meta signature verification now happen in the handler.
   Before deploying Calendar/appointment notifications, set `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`, and `ONESIGNAL_REST_API_KEY` as Edge secrets. Rotate the embedded Google client secret and OneSignal key. Changing the calendar encryption key requires migrating existing encrypted tokens or reconnecting calendars; configure that migration before replacing the key.
4. Review/apply `20261013085204_audit_security_hardening.sql`. The migration is tested in isolated PostgreSQL fixtures; the production base schema, existing grants and actual role configuration still need staging validation. Existing migration history must not be reset.
5. Rebuild and distribute the supported storage-server programs before publishing the frontend. Existing EXEs/ZIPs, their bundled `_internal` source/configuration copies, and already running clinic services are not updated by source edits; replace them and configure private keys before reuse. Server Station's native GUI sync shortcuts need an authenticated GUI flow if they must remain supported; the web administrator Sync workflow is supported now.
6. Build with `npm ci --ignore-scripts` and `npm run build`, then deploy the generated `.cloudflare-assets` directory. Source/configuration/database/test files are excluded by the existing build allowlist. Google Calendar and appointment-push entry points are included in this update despite the existing directory ignore rules; deploy their tracked sources when updating those functions. Reload the clinic clients after release.

## Verification commands

Local verification passed: the full Node/browser/isolated SQL suite (397 tests), the final focused attachment/download checks (11 tests, including the new server-switch case), all 120 Python tests across storage/sync/tunnel/launcher/Drive checks, all 26 Deno tests, all eight Edge entry-point type checks, and the public web build. The locked npm/Edge npm dependencies and both Python locks have no known vulnerabilities in their audit results. The production database and already-built Windows programs have not been exercised or changed.

- `npm test` with `LUMIN_TEST_BROWSER_CHANNEL=chrome` for an installed Chrome.
- `npm run test:sql` for the isolated PostgreSQL authorization regression. This does not connect to the clinic database.
- `python tests/storage-security.test.py` and `python tests/storage-file-sync.test.py` after installing the locked runtime requirements.
- `npx deno@2.9.6 test --no-config --node-modules-dir=none --lock=deno.lock --frozen-lockfile --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions/google-drive/*_test.ts`.
- Run the existing Supabase SQL permission/business fixtures against staging before a production rollout. They were not executed on production during this audit.
