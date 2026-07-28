# ImageFlow product notes

## Positioning

ImageFlow is the browser-native batch image workbench for people who repeatedly prepare product, content, and design assets. The wedge is speed and focus, not a broad online image editor.

## Pricing shape

The current app is free and local. A future entitlement provider can expose `canUse(feature, context)` to gate unlimited batch size, saved presets, and heavier AI operations without coupling billing to the processing engine.

## Product guardrails

- Never upload an image without an explicit future user action.
- Keep permissions empty unless a future feature genuinely requires one.
- Always show output count and file-size impact before export.
- Preserve the original queue until the user clears it.
- Keep background-removal inference local; its bundled BiRefNet-lite model
  outputs high-quality transparent PNG files.
