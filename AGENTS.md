# Lumin Workspace & UI/UX Engineering Rules

This repository contains **Lumin**, a modern clinical dental practice management web application. All code, component additions, and visual redesigns must strictly follow the modern UI/UX engineering standards outlined below.

---

## 1. Aesthetic Standard & Design Philosophy

Lumin must look and feel like a **top-tier modern clinical SaaS** (Linear / Apple Human Interface / Vercel design standard):
- **Clinical Elegance**: Interfaces should feel calm, trustworthy, high-precision, and uncluttered.
- **Surface Elevation & Layering**:
  - Do not use harsh 100% black/white borders. Use subtle, semi-transparent borders: `border border-slate-200/80` (or `border-white/10` in dark themes).
  - Use layered surface elevation: Page background (`bg-slate-50/50` or `var(--lumin-surface)`) -> Card container (`bg-white` or `var(--lumin-face)`) -> Inner sections/inputs (`bg-slate-50` or elevated controls).
  - Respect the `.lumin-raised` styling system defined in `lumin-theme.css` (`var(--lumin-raised)`, `var(--lumin-small-raised)`, `var(--lumin-face)`).
- **No Generic/Bland UI**:
  - Never generate raw, unstyled HTML tables, generic blue alert boxes, or default browser forms.
  - Ban harsh, saturated primary backgrounds (e.g., avoid plain `bg-blue-600` cards). Use refined gradients, tinted status surfaces, or soft colored badges.

---

## 2. Color Palette & Clinical Tokens

- **Brand & Primary**: Dental Blue / Modern Cyan (`#2563eb`, `hsl(215, ...)`).
- **Neutrals**: Slate scale (`slate-50` to `slate-900`) for balanced contrast and clean clinical readability.
- **Status & Findings Palette**:
  - **Healthy / Completed**: `emerald-600` on `bg-emerald-50`, border `border-emerald-200/60`.
  - **Caries / Urgent / Danger**: `rose-600` on `bg-rose-50`, border `border-rose-200/60`.
  - **Restorations / Composite / In Progress**: `blue-600` on `bg-blue-50`, border `border-blue-200/60`.
  - **Pending / Warning / Follow-up**: `amber-600` on `bg-amber-50`, border `border-amber-200/60`.
  - **Muted / Inactive**: `slate-500` on `bg-slate-100`, border `border-slate-200/60`.

---

## 3. Typography & Spatial Rhythm

- **Hierarchy**:
  - Page/Modal Titles: `text-lg` or `text-xl font-semibold tracking-tight text-slate-900`.
  - Section Headers: `text-sm font-semibold uppercase tracking-wider text-slate-500`.
  - Body Text: `text-sm text-slate-700 leading-relaxed`.
  - Metadata / Secondary Labels: `text-xs text-slate-400 font-medium`.
- **Strict 8pt Grid & Spacing**:
  - Containers and cards must have generous breathing room (`p-5`, `p-6`).
  - Form grids and stat blocks should use consistent gaps (`gap-3`, `gap-4`, `gap-6`).
  - Avoid cramped UI or edge-to-edge content without padding.
- **Border Radii**:
  - Cards & Modals: `rounded-2xl` or `rounded-xl`.
  - Buttons, Inputs, & Dropdowns: `rounded-lg` or `rounded-xl`.
  - Badges, Tags, & Avatars: `rounded-full`.

---

## 4. Components & Interactive Affordances

- **Interactive States**: Every interactive element (buttons, table rows, menu items, tabs) must have explicit:
  - Hover: `hover:bg-slate-50 hover:border-slate-300 transition-all duration-150 ease-out`
  - Active: `active:scale-[0.98]`
  - Focus-visible: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 focus-visible:border-blue-500`
  - Disabled: `disabled:opacity-50 disabled:pointer-events-none`
- **Iconography**:
  - Exclusively use **Lucide Icons** (`vendor/lucide.min.js`).
  - Always call `if (window.lucide) lucide.createIcons();` after dynamically rendering or updating HTML containing icons.
  - Pair text labels with contextual icons (`w-4 h-4` or `w-5 h-5`) for quick visual scanning.
- **Empty & Loading States**:
  - When data is loading, provide animated skeleton loaders (`animate-pulse bg-slate-200/70 rounded-lg`).
  - When lists are empty, render a well-crafted empty state: a soft-toned icon circle, clear bold title, friendly subtitle, and a primary call-to-action button.

---

## 5. Bilingual & RTL Support (Arabic & English)

- Lumin supports both English (`ltr`) and Arabic (`rtl`).
- Always check `currentUiLanguage` or `document.documentElement.dir === 'rtl'`.
- Never hardcode directional padding (`pl-4` / `pr-4`) for elements that need RTL flipping; use start/end logical spacing or test in both layouts.
- Provide bilingual string templates or Arabic translations for any newly introduced user-facing labels.

---

## 6. Modals, Sheets & Overlays

- Backdrop: Soft blur and subtle dark tint (`backdrop-blur-sm bg-slate-900/40`).
- Dialog Box: Crisp white card (`bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200/80 max-w-lg w-full overflow-hidden`).
- Clear visual anatomy: Distinct header with close button, scrollable body (`max-h-[75vh] overflow-y-auto p-6`), and pinned bottom footer with right-aligned action buttons (`flex justify-end gap-2.5 p-4 bg-slate-50/50 border-t border-slate-100`).

---

## 7. Multi-Device & Responsive Ergonomics (Desktop, iPad, Tablets, & Mobile)

Lumin is used extensively in dental clinics across **desktops, laptops, iPads, Android tablets (chairside), and mobile phones**. Every UI implementation must be flawlessly responsive:

### A. Device Breakpoint Strategy
- **Desktop & Laptop ($\ge 1024$px / `lg:`, `xl:`, `.is-laptop-device`)**:
  - Maximize screen real estate with multi-pane workflows (e.g. Odontogram stage side-by-side with clinical treatment notes and invoice ledger).
  - High-density data tables with sorting, multi-column filters, and full metadata visible.
- **iPads & Android Tablets (768px - 1023px / `md:`)**:
  - **Chairside Optimization**: Ergonomics for doctors holding a tablet with one hand.
  - Fluid layout: Convert 3-column desktop layouts into adaptive 2-column or segmented tabbed sections.
  - Dental chart / Odontogram: Must remain fully inspectable without clipping or page-breaking horizontal scroll (`overflow-x-auto` with smooth scrolling).
  - Popovers and dropdowns: Must compute viewport bounds so calendar pickers or quick actions do not render off-screen.
- **Mobile Phones (< 768px / base & `sm:`)**:
  - Single-column vertical flow with thumb-friendly navigation.
  - **Card Stacks over Data Tables**: Transform wide horizontal tables into compact, structured clinical summary cards.
  - **Bottom Sheets for Dialogs**: On mobile, modals should adapt to bottom-anchored sheets (`fixed inset-x-0 bottom-0 rounded-t-2xl max-h-[90vh]`) with pinned action footers.
  - Pinned or sticky action bars for primary actions (e.g. "Save Treatment", "Book Appointment", "Send WhatsApp").

### B. Touch vs Pointer Ergonomics
- **Touch Target Sizing**: All interactive buttons, tabs, tooth surface selectors, and dropdown triggers must meet Apple & Android touch guidelines: **minimum $44 \times 44$px** touch footprint.
- **No Hover-Only Disclosures**: Never hide essential actions (edit, delete, WhatsApp, status change) behind `:hover` states on touch devices. Provide permanently visible action triggers or a dedicated touch-friendly `...` menu button.
- **Input Zoom Prevention (iOS Safari)**: Ensure form inputs on mobile use `text-base` ($\ge 16$px) or avoid triggering aggressive mobile Safari viewport zoom when focused.
- **Safe Area Inset Support**: Always respect device notches and home swipe bars:
  - `padding-bottom: max(1rem, env(safe-area-inset-bottom))` for sticky footers and bottom sheets.
  - `padding-top: env(safe-area-inset-top)` for full-screen fixed modals.

### C. Layout Hygiene & Overflow Prevention
- Never allow accidental horizontal scroll on the main layout (`overflow-x-hidden` on parent shells).
- Prevent long patient names, phone numbers, or notes from breaking cards by using `truncate` or `break-words` with `min-w-0`.
- Use CSS grid auto-fit or flex-wrap: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`.
