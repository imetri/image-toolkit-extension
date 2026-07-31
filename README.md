# ImageFlow

ImageFlow is a privacy-first Chrome Extension for fast batch image workflows. It runs entirely in the browser: images are decoded, processed, previewed, and packaged locally. No accounts, uploads, or tracking are required.

## MVP

- Batch drag-and-drop intake for every image format Chrome can decode, plus local
  full-resolution sensor decoding for major camera RAW families through LibRaw
  (including DNG, CR2/CR3, NEF/NRW, ARW/SR2/SRF, RAF, ORF, RW2, PEF, and SRW).
- Convert to PNG, JPG, WebP, or AVIF.
- Resize by width, height, or percentage with optional aspect-ratio locking.
- Compress with an adjustable quality control.
- Remove portrait backgrounds locally and export transparent PNG files.
- Preview processed results and download the whole batch as a ZIP.
- Dark and light mode with a Linear/Raycast-inspired workspace UI.

## Local development

```bash
npm install
npm run dev
```

The Vite dev server is useful for UI work. Browser-extension testing should use a production build:

```bash
npm run build
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select the `dist` folder. Pin ImageFlow if desired, then click
its toolbar icon to toggle the native Chrome side panel.

## Architecture

`src/App.tsx` owns the product flow and presentation composition. `src/components` contains reusable UI primitives, `src/hooks` contains queue state, and `src/lib` contains pure-ish image and formatting utilities. The processing boundary is isolated in `imageProcessor.ts`, making it straightforward to move encoding into a worker or add future pipeline stages.

Lossy formats are encoded at maximum quality for Convert and Resize. The
adjustable quality value is applied only to Compress. RAW decoding runs inside a
sandboxed local extension page so LibRaw can execute without giving it access to
Chrome extension APIs. RAW-to-PNG conversion uses full-resolution, 16-bit
LibRaw output and a direct 16-bit PNG encoder; it does not pass through the
browser's 8-bit canvas or silently substitute an embedded JPEG preview. RAW
development also applies DCB demosaicing, light pre-demosaic noise cleanup,
highlight blending, color-artifact suppression, and restrained 16-bit capture
sharpening.

Background removal uses a bundled, MIT-licensed 512×512 BiRefNet-lite browser
export through Transformers.js. The half-precision model stays loaded in a
dedicated worker across a batch, uses local WebAssembly inference for broad
device compatibility, and never uploads the source image. A subject-aware
multi-pass stage gives each person more model resolution and adds dedicated
head-and-upper-body passes for fine hair and narrow background gaps enclosed by
raised arms. Overlap consensus clears background visible between adjacent
people, while guarded ownership bands protect neighboring bodies from an
uncertain crop. Small model-confirmed background pockets receive a guarded
inward expansion so interpolation cannot restore their rims as foreground. An
RGB-guided full-resolution filter then snaps the matte to source-image edges
and cleans color spill while the edge is still soft, before exporting a
lossless transparent PNG.

Premium readiness is intentionally represented at the workflow boundary: each future operation can be modeled as a typed operation and checked before `processImage` is called. Payments and account state are not included in the MVP.

## Chrome Web Store preparation

1. Replace the SVG source icon with exported PNGs at 16, 32, 48, and 128px if Chrome Web Store validation requires raster icons for your listing configuration.
2. Set a production publisher name, support URL, privacy policy URL, and final version number in `public/manifest.json`.
3. Create a ZIP containing the contents of `dist`, not the `dist` directory itself.
4. Prepare a 1280×800 or 640×400 store screenshot showing the drop zone, workflow controls, and results state.
5. State clearly in the listing that processing is local and that the extension requests no host permissions.
6. Test the built extension in a clean Chrome profile, including large batches, invalid files, light mode, and offline use.

## Performance notes

- Keep decode/encode work off the React render path. The current MVP isolates the work behind `processImage`; the next speed upgrade is a small worker pool using `OffscreenCanvas` where available.
- Limit concurrent encoders to the number of logical cores minus one and update progress once per completed file, not once per canvas event.
- Revoke every object URL after its preview leaves the UI to avoid retaining large decoded assets.
- Generate ZIP output with DEFLATE only after all image encodes finish; image formats are already compressed, so level 3–5 is usually a better speed/size tradeoff than maximum compression.
- For 100+ image batches, virtualize the queue/results list and retain only visible preview thumbnails.

## Roadmap

1. Worker pool and visible per-file progress.
2. Presets and premium batch limits behind a feature-entitlement interface.
3. Batch rename and metadata removal.
4. Watermark and OCR as composable pipeline stages.
5. Folder intake and saved workflow automation.

## License

Private product code. Add a commercial license before public distribution.
