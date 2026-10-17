# Clinic inventory page

Revision 5 adds separate category filters, drag-and-drop organization, and catalog deletion.

## Fields and daily use

Items contain English and Arabic names, category, unit, current quantity, minimum quantity, and an optional photo. Names follow the app language with a fallback to the available name. SKU, location, supplier, item notes, review notes, import details, and item archival are removed from the interface and current database schema. The item dialog has no stock-action row. There is no expiry tracking.

Current stock has minus/plus buttons which post one unit of usage or receipt. Units and opening stock must be set first. Stock cannot become negative. The workspace Receive stock picker supports larger receipts. The main Movements tab retains history and permitted reversals.

Minimum is a plain numeric input in Item details. Changes wait for Save, require item-management permission, and do not change stock or post movements. An unset minimum stays blank until entered. Minimums cannot become negative. Stock units use a bilingual dropdown with common units including Box, Bottle, Pack, Piece, Roll, Tube, and Syringe. Existing spelling and recorded-unit locks are preserved.

An uncounted item's initial quantity can be entered in Item details with opening-stock permission. Existing balances change through stock controls. Manage inventory contains Categories and Items tabs. Categories support three levels (Category → Subcategory → Second subcategory), English/Arabic names, bulk assignment, and archiving unused categories. Parent filters and counts include descendants. Main category and Subcategory are separate filters; second-level subcategories appear as relative paths in the second dropdown. Changing the main filter resets the subcategory.

Managers can drag a subcategory's grip to a new parent, retaining its descendants, or drag an item's photo-area grip to another category. The same grips open a Move dialog for touch and keyboard use. Main categories stay at the top level. The server checks expected revisions, active destinations, cycles, duplicate sibling names, and the full subtree's maximum depth. A transaction advisory lock serializes hierarchy changes. Item moves preserve stock and movement snapshots. Uncertain drops retry their original request identifier even after realtime refreshes.

Item details includes Delete item with a confirmation. Cancel returns to the unsaved detail draft. Deletion records a timestamp and removes the item from active catalog queries, counts, exports, and photo access; its balance and immutable movement history remain available to authorized staff. Deleted items cannot receive further edits, stock movements, category assignments or photos. Existing ledger entries are marked as belonging to a deleted item. Direct browser deletion remains denied.

## Source data

The original CSV contains 18 consumables already imported across five categories. The supplied full workbook, `Lumin Clinic Inventory.xlsx`, contains Consumables (18), Restorative (11), Endodontics (8), and Sterilization/cleaning (7). The 25 remaining unique items were imported, retaining all 19 existing items and their balances; inventory had 44 items after that import. Articulating paper occurs in both Consumables and Restorative and retains its existing entry without a second opening balance. Restorative, Endodontics, and Sterilization/cleaning have subcategories, including Restorative → Composites → Ivoclar / Meta. No expiry information was imported. Source files remain unchanged and contain no embedded item photos.

Quantities, minimums, units, and blanks remain as supplied, including Napkin's minimum of 235. Future CSV imports accept optional Subcategory and Second subcategory columns, resolve the complete existing category path, ignore reference/notes columns, and reject duplicate normalized item names. Exports include those hierarchy columns.

## Item photos

Every stock card has a full-width image area above its name/category row. Empty areas offer Add image to managers; existing photos have an icon-only Change image button with a label and tooltip. Item details supports upload, replacement, and removal. JPEG, PNG, and WebP source files up to 15 MB are resized to at most 960 px and compressed to WebP (JPEG fallback), at most 300 KiB. Canvas encoding removes source metadata. Visible photos load on demand and use a bounded, session-scoped object-URL cache cleared on reset.

Optimized bytes are stored privately in an Inventory folder in the clinic's connected Google Drive. The separate inventory-images Edge Function validates the current Supabase session and live inventory permissions on every request; patient permissions are not required or granted. Browser metadata exposes a photo version, dimensions, type and size, never Drive identifiers or credentials. Replacements use expected versions; lost replies retry the same upload identifier. Old photos are moved to Drive trash after a successful replacement or removal. Photo writes do not change stock revisions or create ledger movements. Patient sync mappings and snapshots are separate.

## Backend and permissions

Inventory view is required for all operations. Item management controls metadata and minimums. Receiving and usage have separate permissions. Opening stock and movement reversal use the existing additional permission. Direct table writes remain unavailable to browser roles. RPCs validate current permissions, expected revisions, numeric limits, and stable request identifiers.

The count, wastage, and item-archive write operations are retired. Existing posted history is retained because it supports the current stock controls. Removed metadata is cleared from the private retry cache too. Minimum changes create no stock movement.

Apply inventory migrations in order, including simplify_inventory_items, retire_inventory_minimum_steps, bilingual_inventory_names, inventory_category_hierarchy, inventory_item_images, and inventory_organization. Deploy inventory-images with the same configured Google Drive secrets as the existing connection. It authenticates within the handler, so gateway verify_jwt is false. Photo saves lock and recheck the live item in a database trigger so a late upload cannot attach to a deleted item. Item identities, balances, thresholds, units, categories, and posted movements are preserved.

## Layout and verification

Desktop uses a responsive photo-card grid and category navigation. Tablet uses the category selector. Mobile uses a single card column and bottom sheets. Category and name share a row; current stock, unit/status, and minimum share the next row. Controls have at least 44 by 44 pixel touch targets; current-stock controls retain minus, number, plus order in English and Arabic. Name is the default sort. Stock changes and their realtime notifications patch existing rows and controls, preserving scroll, focus and selection.

Integration checks cover permissions, imported blanks, duplicate prevention, safe retries after lost responses, rapid clicks, stale revisions, opening stock, minimum limits, schema cleanup, hierarchy paths/filtering, photo compression, private access, replacement/removal, and mobile/RTL stability. Drive endpoint tests use a local Google mock; live deployment checks cover authentication and database permissions.

Purchasing, unit conversion, valuation, and automatic treatment consumption remain later phases.
