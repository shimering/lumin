# Lumin → Baytna Finance

This integration exports **new actual patient receipts and expense payments**, in EGP. Unpaid invoices, unpaid expenses, discounts, and debt releases are not cash movements and are not exported. Old patient payments are excluded. Additional payments on an existing expense are tracked from the moment this integration is installed; its previous paid balance is not reconstructed.

The live Lumin and Baytna database migrations and Baytna's `lumin-finance-sync` Edge Function are installed. The connection has passed a signed catalogue request. **Financial delivery is initially paused** until the frontend changes are deployed and enabled under **Admin → Finance sync**. Deploy the updated Lumin shell and Baytna frontend; then select **Enable synchronization → Save settings**.

## Defaults and controls

- Cash → the personal **Cash wallet** account; InstaPay → **Main bank**; Card and unknown methods → **Do not sync**.
- Admins can change these mappings, pause/resume delivery, separately include new income/expenses, map categories, refresh destination accounts/categories, retry failures, and assign missing expense methods.
- Existing Baytna categories are reused. Income initially uses **Clinic salary**; expenses default to **Clinic**, with matching categories for expense types such as Salary and Dental Lab. These defaults are editable.
- Expense installments retain distinct payment methods and Cairo payment dates. Reducing an expense's paid total corrects its newest tracked installments first. Reductions affecting only pre-integration payments are excluded.
- Salary expenses and payments recorded by older clients without a method appear as **Choose method**. No destination account is guessed.
- Changed mappings apply to subsequent activity. Previously posted transactions are not moved automatically. A future historical-import feature must be explicitly invoked and reconcile amounts already included in opening balances; no historical-import endpoint is installed.

## Delivery and security

Database triggers append durable delivery events in the same transaction as the original payment. A PostgreSQL job sends at most 25 events per minute, records acknowledgements, and retries with increasing delays. After twelve attempts an administrator can retry. Pausing preserves eligible queued activity. Type switches exclude new imports; corrections to already tracked entries continue to reconcile.

Each request carries an HMAC-SHA256 signature over the PostgreSQL canonical JSON event. The signing secret stays in Lumin Vault; Baytna stores a derived signing key in its inaccessible private integration configuration. No reusable credentials are sent in HTTP headers or shipped to either frontend. The Edge Function has custom signature authentication; platform JWT checking is disabled specifically for this webhook. Its service-only RPC validates the configured personal space, account, category, amount, source project, and event version.

Baytna keeps one ledger entry per source record. Duplicate and older events are acknowledged without applying changes. Deletion versions remain recorded to prevent an older event from resurrecting a removed entry. Imported rows are protected against manual modification and labeled **Managed in Lumin**; corrections happen in Lumin. No patient names, phone numbers, or clinical records are exported.

Baytna recalculates balances through its existing ledger view and refreshes visible pages every 30 seconds. Lumin's Admin delivery panel refreshes every 15 seconds while visible. The local preview uses synthetic entries only and does not submit financial transactions.

## Verification

- `node --test tests/*.test.cjs` in Lumin; syntax-check `lumin-finance-sync.js` and the inline application scripts.
- Run `supabase/tests/finance_sync.test.sql` on Lumin and `integrations/baytna/supabase/tests/lumin_receiver.test.sql` on Baytna. Both use transactions and roll back every fixture and outgoing test request.
- In Baytna's project, run `pnpm test` and `pnpm build`.
- Check desktop, tablet, phone, English, and Arabic layouts. Verify cash/InstaPay mappings, excluded Card, settings persistence, 44px controls, missing-method review, and no page overflow.

The destination's migration/function source is included under this directory and in Baytna's own `supabase` directory. Baytna's `supabase/config.toml` sets `verify_jwt = false` for this signature-authenticated receiver. Apply those SQL files only to Baytna, never to Lumin. Migration filenames match the installed database history. Secret values and account-specific bootstrap SQL are deliberately absent from the repository.
