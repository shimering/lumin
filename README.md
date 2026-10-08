# Lumin Dental Clinic Management

A modern, high-performance Progressive Web Application (PWA) for comprehensive dental clinic management, featuring:
- Clinical interactive odontograms & charting
- Tooth-linked X-ray gallery with a visual selector for multiple permanent/deciduous teeth, saved clinical notes, and editable photo names
- Collapsible X-ray viewer with multiple-tooth filters and direct uploads from the chart; new X-rays prefill the selected teeth and default to Periapical
- Patient attachments viewer for PDFs and other files
- Patient directory and records management
- Appointment scheduling & calendar synchronization
- Invoice, payment, and financial ledger tracking
- Loyalty and referral program tracking
- Multi-provider authentication and RBAC
- Cloud database powered by Supabase

## Technology Stack
- **Frontend**: Vanilla HTML5, CSS3, ES6+, Tailwind utility classes, Lucide Icons, Service Worker PWA
- **Backend-as-a-Service**: Supabase (PostgreSQL, Auth, Edge Functions, Row-Level Security)
- **Notifications**: OneSignal Web Push

## Patient quotations

Set the clinic name and international WhatsApp number in **Admin → Print forms → Quotation settings**. Quotations automatically use the clinic logo saved in the prescription form settings, including later logo changes or removal on existing links. Use **Manage form logo** to reach that shared setting. Select planned procedures on a patient's chart and use the small quotation button beside **Add invoice**. Preview the dental chart and item prices, choose an expiry date (30 days by default), create the link, then copy it or open a prepared WhatsApp message. Sending the message remains a staff action in WhatsApp.

**Patient Info → Quotations** lists that patient's links. Staff can extend expiry, replace the included procedures with the current planned selection, or disable a link. The same link follows saved prices, tooth/surface changes, and Plan/In Progress statuses; completed, deleted, and Existed procedures disappear. New procedures are included only when staff update the selection. Patients can switch English/Arabic, inspect the chart, print, and contact the clinic.

Deploy migrations `20261008163914_patient_quotations.sql` and `20261008192405_patient_quotation_form_logo.sql` and both Edge Functions before publishing the frontend. Deploy `quotation-manage` with JWT verification enabled, and `quotation-view` with JWT verification disabled because it authenticates the unguessable 256-bit quotation token itself. Include the root `lumin-quotation-model.js` dependency when deploying either function. The public page uses the project's public anon key, exposes only the quotation display projection, requires no patient login, and does not store patient information offline. Anyone with the private link can view it until expiry or revocation; share it directly with the intended patient.

Publish `quotation.html` and all `lumin-quotation*`, `lumin-quotations*`, `lumin-tooth-anatomy.js`, `lumin-tooth-images.css`, and `lumin-public-config.js` files with the existing frontend. The quotation and clinic charts share the tooth photo renderer and the existing images in `assets/teeth-3d/`. Preserve direct access to `/quotation.html` through the host's routing rules. The service worker intentionally uses a network-only route for the public page.

Run `node --test tests/quotations-model.test.cjs tests/quotations-edge.test.cjs tests/quotations-browser.test.cjs` using Node 24+ and Playwright (set `NODE_PATH` if needed and `LUMIN_TEST_BROWSER_CHANNEL=chrome` for system Chrome). Edge tests execute the actual handlers with isolated database/auth clients. Run `supabase/tests/patient_quotations.test.sql` for rolled-back live permission, expiry, revocation, and deletion checks.

## Hosting & Deployment
This application is a static Single-Page Application (PWA). It is ready to be hosted on:
- **Cloudflare Pages**: Set build directory to `public`
- **Vercel**: Pre-configured via `vercel.json`
- **Netlify**: Pre-configured via `netlify.toml`

## Loading and finance queries

Clinic Management → Analytics includes a Cash flow tab with monthly income and expense lines, money in/out and net totals, selectable months, and 6/12-month or year-to-date presets. Apply `clinic_cash_flow` before serving this frontend. Its compact aggregate requires Analytics access and groups actual receipts and expense installments by payment date; older paid amounts without installment history use the recorded expense date and are identified in the chart. Zero-activity months remain visible. English, Arabic, keyboard navigation, touch controls, and the raised theme are supported.

Run `node --test tests/cash-flow.test.cjs tests/cash-flow-browser.test.cjs` (with Playwright in `NODE_PATH` and `LUMIN_TEST_BROWSER_CHANNEL=chrome` for browser checks), and `supabase/tests/clinic_cash_flow.test.sql` for rolled-back ledger and permission checks.

Patient workspaces fetch one complete patient record by ID; directory summaries omit chart data. A cached profile or chart remains read-only until a fresh record arrives, and background reads preserve pending chart saves. The dashboard uses selected-day appointment queries and compact invoice summaries, while the appointment calendar retains its own complete collection.

Clinic invoices and payments retain backend pagination. Expenses and patient debts use 10/20/50-result pages with full filtered totals from read-only, RLS-protected database functions. Expand a debt patient to fetch that patient's outstanding invoice page. Apply both `finance_loading_pages` and `optimize_finance_debt_aggregation` migrations before publishing this frontend. The existing finance overview and income-statement definitions are unchanged.

Run `node --test tests/targeted-loading.test.cjs` for the request-scoping checks and `supabase/tests/finance_loading_pages.test.sql` for rolled-back live database checks. Browser regressions use Playwright (via `NODE_PATH`) and `LUMIN_TEST_BROWSER_CHANNEL=chrome` when a system Chrome installation is available.

Appointment forms fetch patients only after typing, with a 250 ms debounce and a maximum of five lightweight matches. Apply the `appointment_patient_search` migration before publishing this frontend. Run `node --test tests/appointment-patient-search.test.cjs` with Playwright and `supabase/tests/appointment_patient_search.test.sql` for rolled-back search, result-limit, and permission checks.

Dashboard appointment saves update the selected-day caches immediately. Reads started before a save preserve that change, while later reads accept updates from other staff. Run `node --test tests/dashboard-appointment-sync.test.cjs tests/appointment-status-picker.test.cjs` for cache races, failed saves, and visible status continuity.

## WhatsApp message actions

Opening the WhatsApp page or a conversation leaves the composer unfocused on every device.
Hold a message bubble or use its visible ellipsis button to react, reply, copy text, or delete
from the shared Lumin chat. Long presses show a bubble effect and suppress native text selection;
moving or scrolling cancels the hold. The reaction row's plus button opens more emojis grouped
by category. Emoji buttons and menus also suppress native long-press selection and callouts.
Phones use a bottom sheet; larger screens use a bounded menu.
All new actions support Arabic, English, keyboard navigation, and both appearance themes.

Apply `delete_whatsapp_message_from_lumin` before frontend rollout. The authenticated RPC checks
active staff access, removes quoted copies, and repairs the conversation preview in one transaction.
Deletion is local to the clinic chat: Meta Cloud API has no documented recipient-recall operation.
Run `node --test tests/whatsapp-message-actions-browser.test.cjs tests/whatsapp-chat-swipe-close.test.cjs`
with Playwright available and `LUMIN_TEST_BROWSER_CHANNEL=chrome`, plus the rolled-back database
checks in `supabase/tests/whatsapp_message_deletion.test.sql`.

## Patient 3D scans

Patients have a **3D Scans** tab beside **X-Rays & Media**, with multiple original
ZIP archives, import previews, textured OBJ arches, synchronized two-scan comparison,
rendering controls, and movable section cuts. Originals stay unchanged on local
storage and can be downloaded with their imported filename. Names, notes, scan dates,
and arch selections use the existing patient media metadata and permissions.
New imports keep their uploaded ZIP filename inside a separate folder per scan.
The viewer defaults to a dark background and pans when both mouse buttons are held.
Use the fullscreen icon to expand a single scan or both comparison panes together.
Single scans use a centered square viewer. The settings button at the lower right
opens a panel on the left inside the viewer with view presets, rendering, arch
visibility, opacity, lighting, and section cuts. The panel is hidden initially and
also works in fullscreen; close it with its close button, the settings button, or Escape.

The `patient_3d_scans` metadata migration must precede frontend rollout. Update each
storage server with [the update ZIP](storage-server/lumin-storage-sync-update.zip);
installation instructions are in [the storage README](storage-server/README.md#patient-3d-scans).
Pinned Three.js 0.180.0 and fflate 0.8.2 browser modules and their licenses are under
`vendor/`; `scripts/bundle-3d-vendors.py` reproduces that bundle without running package scripts.
The supplied patient archive is used locally for verification and is not included in Git.

Run `node --test tests/patient-scans-parser.test.cjs tests/patient-scans-browser.test.cjs`
with Playwright available. `LUMIN_SCAN_SAMPLE` selects a local sample ZIP; otherwise
the browser test uses synthetic OBJ arches. Run `python tests/storage-file-sync.test.py`
for original-byte downloads, retry identifiers, and paired-server synchronization.
