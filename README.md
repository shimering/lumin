# Lumin Dental Clinic Management

A modern, high-performance Progressive Web Application (PWA) for comprehensive dental clinic management, featuring:
- Clinical interactive odontograms & charting
- Tooth-linked X-ray gallery with a visual selector for multiple permanent/deciduous teeth, saved clinical notes, and editable photo names
- Collapsible X-ray viewer beside the dental chart in landscape, with a patient attachments viewer for PDFs and other files
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

## Hosting & Deployment
This application is a static Single-Page Application (PWA). It is ready to be hosted on:
- **Cloudflare Pages**: Set build directory to `public`
- **Vercel**: Pre-configured via `vercel.json`
- **Netlify**: Pre-configured via `netlify.toml`

## Loading and finance queries

Patient workspaces fetch one complete patient record by ID; directory summaries omit chart data. A cached profile or chart remains read-only until a fresh record arrives, and background reads preserve pending chart saves. The dashboard uses selected-day appointment queries and compact invoice summaries, while the appointment calendar retains its own complete collection.

Clinic invoices and payments retain backend pagination. Expenses and patient debts use 10/20/50-result pages with full filtered totals from read-only, RLS-protected database functions. Expand a debt patient to fetch that patient's outstanding invoice page. Apply both `finance_loading_pages` and `optimize_finance_debt_aggregation` migrations before publishing this frontend. The existing finance overview and income-statement definitions are unchanged.

Run `node --test tests/targeted-loading.test.cjs` for the request-scoping checks and `supabase/tests/finance_loading_pages.test.sql` for rolled-back live database checks. Browser regressions use Playwright (via `NODE_PATH`) and `LUMIN_TEST_BROWSER_CHANNEL=chrome` when a system Chrome installation is available.
