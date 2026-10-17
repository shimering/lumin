# Clinic inventory page

Revision 3 follows the requested item-details simplification.

## Fields and daily use

Items contain a name, category, unit, current quantity, and minimum quantity. SKU, location, supplier, item notes, review notes, import details, and item archival are removed from the interface and current database schema. The item dialog has no stock-action row. There is no expiry tracking.

Current stock has minus/plus buttons which post one unit of usage or receipt. Units and opening stock must be set first. Stock cannot become negative. The workspace Receive stock picker supports larger receipts. The main Movements tab retains history and permitted reversals.

Minimum is a plain numeric input in Item details. Changes wait for Save, require item-management permission, and do not change stock or post movements. An unset minimum stays blank until entered. Minimums cannot become negative. Stock units use a bilingual dropdown with common units including Box, Bottle, Pack, Piece, Roll, Tube, and Syringe. Existing spelling and recorded-unit locks are preserved.

An uncounted item's initial quantity can be entered in Item details with opening-stock permission. Existing balances change through stock controls. Categories support English/Arabic names, bulk assignment, and archiving unused categories.

## Source data

The supplied CSV contains 18 items, imported into NewLumin across five editable categories: Patient disposables, Anesthesia & needles, Infection control, Clinical materials, and Surgical supplies. Quantities, minimums, units, and blanks are preserved, including Napkin's minimum of 235. Original-import metadata is removed; the CSV itself remains unchanged. Future imports ignore reference/notes columns and reject duplicate normalized item names.

## Backend and permissions

Inventory view is required for all operations. Item management controls metadata and minimums. Receiving and usage have separate permissions. Opening stock and movement reversal use the existing additional permission. Direct table writes remain unavailable to browser roles. RPCs validate current permissions, expected revisions, numeric limits, and stable request identifiers.

The count, wastage, and item-archive write operations are retired. Existing posted history is retained because it supports the current stock controls. Removed metadata is cleared from the private retry cache too. Minimum changes create no stock movement.

Apply the initial inventory migration followed by 20261016213858_simplify_inventory_items.sql and 20261017061336_retire_inventory_minimum_steps.sql before deploying this frontend. Item identities, balances, thresholds, units, categories, and posted movements are preserved.

## Layout and verification

Desktop uses a stock table and category navigation. Tablet uses the category selector. Mobile uses item cards and bottom sheets. Controls have at least 44 by 44 pixel touch targets; current-stock controls retain minus, number, plus order in English and Arabic.

Integration checks cover permissions, imported blanks, duplicate prevention, safe retries after lost responses, rapid clicks, stale revisions, opening stock, minimum limits, and schema cleanup with existing records.

Purchasing, unit conversion, valuation, and automatic treatment consumption remain later phases.
