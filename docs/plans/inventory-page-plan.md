# Clinic inventory page plan

Revision 2: categories and quantity-based inventory. The core stock-control phase is implemented in the workspace, including reviewed CSV import, category management, role permissions, stock movements, corrections, and responsive Arabic/English UI. Purchasing and automation remain later phases. See the README for rollout and validation.

## Scope and placement

Add **Inventory / المخزون** inside **Clinic Management / إدارة العيادة**, following Lumin's existing theme, access control, language, and navigation conventions.

The page answers: what do we have, which category does it belong to, and what needs restocking? Track current quantity, minimum quantity, unit, receiving, usage, counts, and corrections. Expiry dates, expiry alerts, expiry filters, expiry-based allocation, and automatic expiry restrictions are removed from this plan. Receipt and movement dates remain for audit history. Batch tracking is not required for the first version.

## Source and proposed categories

Reference: `C:/Users/Lenovo/Downloads/Lumin Clinic Inventory - مستهلكات.csv`.

The supplied CSV has 18 items, all under `Consumables (مستهلكات يومية)`. Preserve that source grouping and every original name, quantity, minimum, unit, and reference note. The following five subcategories are proposed for review and can be changed independently of the source records:

| Category | Arabic label | Items from the CSV | Count |
| --- | --- | --- | --- |
| Patient disposables | مستلزمات المرضى | أكواب بلاستيك/ورق للمرضى, Napkin, Suction tips, Cotton pack, Cotton rolls, مناديل, Overshoes | 7 |
| Anesthesia & needles | التخدير والإبر | Anasthesia (Blue), Needles (short), Needles (long) | 3 |
| Infection control | مكافحة العدوى | صابون سائل, gloves, كحول 70% (Spray + جل), Masks | 4 |
| Clinical materials | مواد إكلينيكية | polishing paste, Articulating paper | 2 |
| Surgical supplies | مستلزمات جراحية | Blades, Sutures | 2 |

These are editable planning suggestions, not categories already present in the file. Future groups such as Restorative, Endodontics, or Orthodontics can be added when the clinic needs them; do not populate them with invented stock.

## Page layout

1. Header: **Inventory / المخزون**, **Add item / إضافة صنف**, and primary **Receive stock / استلام مخزون**.
2. Four compact summaries: **Total items / إجمالي الأصناف**, **Categories / التصنيفات**, **Low stock / مخزون منخفض**, and **Out of stock / نفد المخزون**.
3. Category navigator: All items, the original Consumables parent group, and five proposed categories with item counts. Use one selected category at a time and make **Manage categories / إدارة التصنيفات** accessible here.
4. Stock workspace: search, stock-status filters, a paginated stock list, and a compact data-review indicator.
5. Item details: edit the category, unit, and minimum; receive, record use, count/adjust, and inspect movement history. Desktop can use a side panel; tablet uses a full-width panel and mobile a bottom sheet. The inline concept expands a local editor to make review easy in the conversation.

Desktop list columns: **Item / الصنف**, **Category / التصنيف**, **Current quantity / الكمية الحالية**, **Minimum / الحد الأدنى**, **Unit / الوحدة**, and a visible **Details / التفاصيل** action. Stock status is a borderless badge. Narrow layouts combine quantity and unit and use stacked item cards.

Search and category/status filters work together. Preserve their state when opening an item. Include pagination rather than making a long clinic inventory one unbounded page. Do not sum quantities with different or missing units.

## Category management

- Require a category on item creation; imported unmapped items enter **Uncategorized / غير مصنف** until reviewed.
- Categories have a stable identifier, Arabic and English display names where available, an optional parent, and an active/archive flag.
- Let permitted staff create and rename categories, move items, and bulk-assign a category to selected items. Selecting a category when adding an item can prefill that field.
- Rename a category without changing stock balances or movement history. Category counts update from item assignments.
- Prevent ambiguous duplicate names within the same parent. Do not hard-delete a category while items still reference it. Reassign items or archive it. Archived categories remain resolvable in historical records and are unavailable for new assignments.
- An item belongs to one primary category. Additional clinical tags can be considered later if a real workflow needs them.
- The source's broad Consumables grouping stays available as import provenance. Suggested subcategories do not silently overwrite the original CSV.

## Item fields and daily actions

### Add/edit item

Required for a new active item: name, category, explicit stock unit, minimum level, and an opening count or an explicit **Not counted / لم يتم الجرد** state. Optional: SKU, brand/variant, storage location, preferred supplier, target quantity, and notes.

Keep different stock identities separate, such as needle length or glove size. Allow a single-language item name and preserve the CSV's mixed Arabic/English names. Do not require a translated clinical name before an item can be saved.

Imported missing fields may remain unresolved and visible in the review list. Record their completion as an attributable edit. Units such as Box and pack do not imply a number of individual pieces. Receive and use in the recorded stock unit until an explicit pack conversion is configured.

### Receive stock

Choose item, quantity, unit, receipt date, and optional supplier, location, reference, and cost if permitted. Preview the quantity change before confirmation. Increase stock only after successful server confirmation, using retry-safe submission.

An unknown opening count must be established with a stock count before adding receipts to it. Do not interpret a missing quantity as zero. Require the stock unit to be resolved before posting a movement. A later pack-conversion setting must not rewrite previous receipts.

### Record use

Choose item, quantity in its recorded stock unit, movement date, and optional location/treatment reference. Block reductions above the current recorded balance or against an unknown count. Require a unit before posting. Show a simple before/after balance. Manual recording is the first release's default.

### Count and adjust

Enter the observed quantity and reason. For a known balance, show and post the difference. For an unknown opening balance, record a distinct opening-count movement. Reject stale counts when a concurrent movement changed the expected balance.

Damaged/lost stock uses a reasoned wastage movement. Corrections use linked reversals or adjustments, preserving the original history. Archive referenced items rather than deleting them.

### Movement history

Show item, category context, type, quantity, unit, before/after balance, date, staff member, reason, and reference. Types: opening count, receipt, use, adjustment, wastage, transfer, and reversal. Preserve the unit and relevant identity snapshot at posting time. Changing an item's category does not rewrite old stock movements.

## Stock and missing-data rules

- **Out of stock:** a known quantity of zero, even if a minimum has not been configured.
- **Low stock:** a known positive quantity at or below a known minimum.
- **In stock:** a known quantity above a known minimum.
- **Not counted:** quantity is missing. Do not include it in low/out-of-stock counts.
- **Minimum not set:** quantity is positive but the minimum is missing. Do not claim the stock is healthy.
- **Needs review:** at least one required source value is missing, or a staff member has flagged an inconsistency. This is a data-quality dimension independent of stock status.

For the provided file and the stated at-or-below rule: 18 items, 5 proposed categories, 11 low-stock items, 4 out-of-stock items, 2 not-counted items, and 1 item above its minimum. Eleven items have one or more missing quantity/minimum/unit fields: 2 missing quantities, 3 missing minimums, and 10 missing units. Counts of missing fields overlap.

Specific review cases:

- Cotton pack and Cotton rolls: missing quantity, preserved as unknown.
- Napkin: quantity 8, minimum 235. Preserve both and flag the minimum for review; do not silently correct it.
- Cups: quantity 6, minimum 8, reference note `كمية جيدة ✅`. Keep the note as source text; the numeric rule classifies the item as low stock. Flag the conflict for review rather than letting a note override numeric stock rules.
- No acquisition costs are supplied. Omit stock valuation from this revision rather than inventing costs.

The preview shows numbers as recorded in the source. Unknown units are explicitly marked; counts remain provisional until the clinic confirms missing and inconsistent entries.

## Responsive and bilingual behavior

- Desktop: category navigator and stock list side by side, with room for item detail when opened.
- Tablet: a category dropdown replaces the sidebar; secondary metadata moves into detail views.
- Mobile: category dropdown, stacked item cards, bottom sheets, and primary actions above navigation with safe-area padding.
- Full Arabic/English controls, RTL mirroring, logical spacing, isolated mixed-script item names, localized numbers, and long-name wrapping.
- Reuse Lumin's surface/raised tokens, quiet slate surfaces, blue controls, borderless soft status/category pills, generous spacing, and Lucide icons. Use only compiled border colors or explicit CSS; no slash-opacity border utilities.
- Keep hover, active, focus-visible, disabled, skeleton, first-use, no-results, retry, validation, and success states. All essential controls have at least a 44 × 44 px touch footprint.
- Preserve existing viewport/pinch safeguards and use focus management and reduced-motion behavior for real dialogs.

## Access, integrity, and finance

Separate capabilities for viewing inventory, managing categories/items, receiving, recording use, counts/adjustments, and viewing costs. Enforce permissions and clinic scope on the server as well as in the UI.

Maintain atomic, retry-safe movements and reject negative balances. Changing categories or minimums does not itself add or remove stock. Item edits cannot change the meaning of units used in posted history. Keep a timestamped view on refresh errors and require a connection for first-release stock writes.

Supplier bills and payments remain in Lumin's financial workflow. A stock receipt does not become a paid expense. Later purchasing integration can explicitly link or create a supplier bill, with financial permission and a unique source reference to prevent duplication.

## Delivery sequence

1. **Category-based inventory:** review/import the CSV, editable categories, item fields, unit/count completion, receiving, manual use, low/out-of-stock rules, movement history, counts/adjustments, permissions, mobile, and Arabic/RTL.
2. **Purchasing:** suppliers, restock lists, purchase orders, partial deliveries, exports, optional acquisition costs, and explicit expense linking.
3. **Automation:** barcode scanning, reviewed treatment-consumption templates, and material-cost reporting after trustworthy unit/cost data exists.

## Acceptance examples

- All 18 CSV rows appear with their original numbers, units/blanks, and source notes.
- The five proposed category counts are 7, 3, 4, 2, and 2. Category selection combines correctly with search and stock filters.
- Moving Needles (short) to another category updates both category counts and the row badge without changing its quantity of 5.
- Renaming/adding a category updates the picker and item forms; existing references remain valid.
- Missing quantity never renders as zero, and missing unit never becomes an assumed box or piece.
- A receipt of 2 Box for Anasthesia (Blue) raises 2 Box to 4 Box. No piece conversion is inferred.
- Quantity at the minimum remains in the low-stock filter. Recorded zero is out of stock. Unknown count is neither.
- There are no expiry fields, filters, alerts, or expiry validation in item, receipt, usage, or reporting flows.
- Retrying a receipt does not duplicate stock; concurrent usage cannot spend the same final unit twice.
- At 320 px, tablet portrait, and desktop widths, category selection and item actions remain reachable in English and Arabic without page-level horizontal overflow.

## Implementation touchpoints

Keep the eventual feature in dedicated `lumin-inventory.js` and `lumin-inventory.css` modules, with a small Clinic Management tab integration in `index.html`. Extend access handling, bilingual labels, relevant restock/action-center alerts, and asset/service-worker lists as required. Meaningful checks should cover category assignments, preserved import blanks/values, unit semantics, movement integrity, permissions, concurrency, and mobile/RTL behavior.

The earlier inline concept uses local simulations. The implemented page starts with the proposed categories and supports reviewing/importing the original CSV through its Import CSV action. The supplied file is not modified or bundled into public web assets.
