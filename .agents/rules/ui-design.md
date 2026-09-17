# Modern UI/UX Engineering Rules

Whenever designing, styling, or refactoring user interfaces in Lumin, strictly adhere to these aesthetic and structural standards:

## 1. Aesthetic Standard & Visual Polish
- **Modern SaaS & Clinical Standard**: Prioritize calm, high-precision, clean clinical interfaces (Linear / Vercel / Apple HIG vibe).
- **Borders & Surfaces (CRITICAL: Zero Black Borders Rule)**:
  - **NEVER use slash-opacity syntax on border classes** (e.g. `border-slate-200/80`, `border-emerald-200/60`). `lumin-app.css` is a precompiled bundle that lacks slash-opacity border classes. Uncompiled border classes fall back to `currentColor`, resulting in **harsh, ugly solid black borders**!
  - **Borderless by default**: Avatars, small badges, action pills, chips, and quick replies must be **completely borderless** by default with soft tinted fills (`bg-emerald-50 text-emerald-700`, `bg-blue-50 text-blue-700`, `bg-violet-100 text-violet-800`, `bg-amber-100 text-amber-800`, `bg-slate-100 text-slate-700`).
  - **Compiled tokens only**: When containers genuinely require a border, ONLY use compiled classes: `border-slate-100`, `border-slate-200`, `border-slate-300`, or explicit CSS (`border: 1px solid #e2e8f0;`).
  - Layer surfaces using elevation (`bg-slate-50` background -> `bg-white` cards -> `bg-slate-50` inputs/insets).
- **Raised Theme Compatibility**: Ensure new components support the `.lumin-raised` theme system (`var(--lumin-face)`, `var(--lumin-raised)`, `var(--lumin-small-raised)`).

## 2. Color Palette & Clinical Tokens
- **Brand**: Blue / Cyan (`#2563eb`, `hsl(215, ...)`).
- **Neutrals**: Slate scale (`slate-50` to `slate-900`) for balanced contrast and readability.
- **Clinical Status Badges (Borderless Soft Surfaces)**:
  - Healthy / Completed: `text-emerald-700` on `bg-emerald-50` (or `bg-emerald-100 text-emerald-800`).
  - Caries / Urgent / Danger: `text-rose-700` on `bg-rose-50` (or `bg-rose-100 text-rose-800`).
  - In Progress / Composite: `text-blue-700` on `bg-blue-50` (or `bg-blue-100 text-blue-800`).
  - Pending / Warning: `text-amber-800` on `bg-amber-100` (or `bg-amber-50 text-amber-700`).

## 3. Spatial Rhythm & Typography
- **Hierarchy**: Clear distinction between headings (`font-semibold tracking-tight text-slate-900`), body (`text-sm text-slate-700`), and secondary labels (`text-xs text-slate-400 font-medium`).
- **8pt Spacing Grid**: Cards and dialogs must have generous breathing room (`p-5`, `p-6`, `gap-3`, `gap-4`). Avoid cramped UI.
- **Radii**: `rounded-2xl` for cards/modals, `rounded-xl` or `rounded-lg` for inputs/buttons, `rounded-full` for badges/avatars.

## 4. Multi-Device & Responsive Ergonomics (Desktop, iPad, Tablet, Mobile)
- **Desktop ($\ge 1024$px / `lg:`, `xl:`, `.is-laptop-device`)**:
  - Multi-pane clinical workflows (odontogram + notes + ledger side-by-side).
  - Rich data tables with full column visibility and sorting.
- **iPads & Android Tablets (768px - 1023px / `md:`)**:
  - **Chairside Optimization**: Fluid 2-column or tabbed views; no horizontal shell clipping.
  - Odontogram & charts: Contained in `overflow-x-auto` viewports so doctors can zoom/pan smoothly.
  - Popovers & dropdowns: Viewport-aware so menus don't render off-screen.
- **Mobile Phones (< 768px)**:
  - Single-column linear flow with bottom navigation or sticky action bars.
  - Convert wide tables into structured clinical summary cards.
  - Bottom-sheet dialogs: Anchored to the bottom (`rounded-t-2xl max-h-[90vh]`) for easy thumb reach.
  - Safe area insets: Always include `env(safe-area-inset-bottom)` and `env(safe-area-inset-top)`.
- **Touch Targets**: Strictly maintain $\ge 44 \times 44$px for all touchable controls, buttons, surface selectors, and checkboxes.
- **No Hover-Only Triggers**: Never conceal critical actions behind hover-only states; always provide visible touch affordances.

## 5. Micro-Interactions & Icons
- Every interactive element must include hover, active (`active:scale-[0.98]`), focus-visible (`focus-visible:ring-2`), and disabled states.
- Exclusively use **Lucide Icons** (`vendor/lucide.min.js`) with `lucide.createIcons()` called after dynamic rendering.
- Always implement elegant empty states and animated skeleton loaders (`animate-pulse`).

## 6. Bilingual & RTL Support
- Support both English (`ltr`) and Arabic (`rtl`).
- Never assume left-to-right alignment; use logical spacing (`start`/`end`) or test in both LTR and RTL.
