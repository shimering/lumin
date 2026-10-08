# Clinical specialty icons

Fifteen fresh icons generated with the built-in `image_gen` tool. Each design uses one or two simple elements on a transparent background. Existing Lumin illustrations were not used as references.

This is Lumin's standard dental icon set. Clinical Actions, pricing categories, catalog administration, category previews and chart shortcuts all use these assets. Saved legacy icon names are mapped to the corresponding new icon; the old CSS tooth pictograms and chart shortcut illustration have been removed.

The UI displays the icons at 32px, with 48px category previews. The shipped WebP assets are capped at 64 x 64px for high-density displays, retain alpha transparency, and are cached with the offline shell. Each icon has an 8 KB budget; the whole set has a 64 KB budget.

The exact style prompt, individual subjects and export settings are saved in [generation.json](generation.json). Full prompts are the style prompt followed by the subject of each icon, unless a `promptOverride` records a later edit. The paediatric icon pairs the generated set's porcelain tooth with a small baby's head.

To reproduce the optimized exports, supply a JSON object mapping icon names (without extension) to their generated PNG source paths:

```sh
node scripts/optimize-specialty-icons.cjs /path/to/source-map.json
```

The export script uses `sharp` from the configured Node dependency runtime. Original generated images remain in Codex's generated-images folder.
