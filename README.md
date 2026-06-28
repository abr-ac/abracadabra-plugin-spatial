# abracadabra-plugin-spatial

A collaborative **3D scene** page type for CouShell, rendered with **pure
Three.js** (no TresJS). Every object, light, and group is a *document*; geometry
comes only from **GLB/GLTF files** attached to documents — there are no
primitives. Real-time multi-user awareness shows other people's cameras,
selections, and pointers, with follow-mode. Two cameras — damped **Orbit** and
an FPS **NoClip** free-fly spectator. **Fully offline** (model decoders are
inlined into the bundle — no CDN).

- **Client** (`src/index.ts` → `dist/plugin.js`): registers the `spatial` page
  type; the renderer (`src/renderer/SpatialRenderer.vue`) is a thin Vue shell
  around an imperative Three.js engine (`src/three/*`).
- **No server runner.** Unlike the terminal plugin, spatial is pure client — it
  needs no process host. Models stream from the host's offline-first blob cache.

Typed against the shared **`@abraca/plugin`** contract only — no `@abraca/nuxt`,
no cou-sh imports. The same bundle loads in CouShell and any host that narrows
`AbraPlugin` **and passes the `treeApi` / `fileApi` props** (the contract
additions this plugin relies on).

## How it works

- **Scene = document tree.** The renderer receives `treeApi` (a scoped,
  reactivity-free view of the page's child documents) and walks it recursively —
  arbitrarily deep, like the built-in graph renderer. Each document becomes a
  Three.js node group carrying its transform (`meta.spX/spY/spZ`, rotation,
  scale); nesting follows the document hierarchy.
- **Models from files.** A `model` document points at a GLB/GLTF upload
  (`meta.spModelUploadId` + `spModelDocId`), resolved to a URL through `fileApi`
  (the host's IDB-cached `FileBlobStore`, so models work offline once loaded).
- **Nested file dependencies.** A `.gltf` referencing external `.bin`/texture
  files is supported: child documents tagged `meta.spFileUploadId` are folded
  into the model's loader as a basename→blob map, so the dependency graph
  resolves as deep as it goes. Self-contained GLBs need none of this.
- **Lights are documents** (`meta.spKind: 'light'`), mapped to real
  Directional/Point/Spot/Ambient/Hemisphere lights. A neutral fallback rig is
  added only when a scene defines no lights of its own.
- **Awareness.** Local camera → `spatial:camera`, selection → `spatial:selected`,
  pointer → `spatial:pointer` (per-doc awareness). Remote users render as
  **smoothly-interpolated** camera gizmos + name labels, colored selection
  outlines, and a "look-here" pointer reticle; `followingUser` lerps your camera
  to theirs (timestamp-guarded). Mode is mode-agnostic — followers track Orbit
  and NoClip users alike.
- **Cameras.** **Orbit** (damped turntable) and **NoClip** (FPS free-fly:
  `WASD` + mouse-look via pointer-lock, `Space`/`Ctrl` up·down, `Shift` sprint,
  `Alt` crawl, scroll-wheel speed). `Tab` toggles; mode is a local preference,
  never written to the document.
- **Editing.** Selected node(s) get a **TransformControls gizmo** (Move/Rotate/
  Scale, `T`/`R`/`E`; **World/Local** toggle) writing TRS back to meta;
  **multi-select** transforms many nodes rigidly around their centroid; hold
  **`Shift`** to snap (0.25 / 15° / 0.1). `⌘/Ctrl+D` duplicates, `F` focus,
  `G` frame-all, double-click opens the node's document, `Esc` deselects,
  `Delete` removes. Hovering highlights + shows a pointer cursor. Viewers are
  watch-only with full presence.
- **Animation.** glTF skeletal/morph clips play automatically (all clips), and
  the on-demand loop keeps rendering while anything is animating.
- **View memory.** The camera position is remembered per scene (localStorage,
  not a document edit) and restored on reopen. Failed model loads surface in a
  HUD badge and clear when fixed/removed.
- **Follow.** Click a remote user's in-scene camera gizmo (or their HUD dot) to
  follow them; your camera glides to theirs in either mode.
- **Offline.** Draco + Meshopt + KTX2/basis decoders and HDR/EXR environment
  loaders are bundled and the decoder binaries are **inlined as data URLs**, so
  every supported format decodes with zero network once the plugin is cached.
- **On-demand rendering.** The loop renders only while something moves (camera,
  remote presence, a loading model, a gizmo drag) — idle scenes cost ~nothing.

## Object meta (no primitives)

| Key | Meaning |
|---|---|
| `spKind` | `model` \| `group` \| `light` \| `camera` |
| `spX/Y/Z`, `spRX/RY/RZ`, `spSX/SY/SZ` | transform (rotation in degrees) |
| `spModelUploadId` + `spModelDocId` | GLB/GLTF source upload |
| `spFit` | `raw` (default) or `unit` (normalize to 1³) |
| `spFileUploadId` | marks a child doc as an external asset file of its parent model |
| `spLightType`, `spIntensity`, `spDistance`, `spAngle`, `spPenumbra`, `spCastShadow`, `color` | light params |
| `spVisible`, `spOpacity` | common |

Scene-level (on the page doc's own meta): `spGridVisible`, `spShadows`,
`spBackground`, `spEnvUploadId`.

## Build

```bash
pnpm install --ignore-workspace
pnpm build        # dist/plugin.js (single-file: three + loaders + css inlined)
pnpm typecheck    # vue-tsc
```

`three` is **bundled** (it is not a host singleton like `vue`/`yjs`, which are
externalized to `globalThis.__ABRACA_SHARED__`). The Draco + basis decoder
binaries are **inlined as base64 data URLs** (`assetsInlineLimit` is raised) so
the plugin is fully offline. The bundle is therefore large (~2.4 MB / ~780 KB
gz); the host loads it lazily on first `spatial` doc open.

`abra-plugin pack` refreshes `manifest.json` integrity (the value is currently
set by `shasum -a 256 dist/plugin.js`). The runtime loader imports the JS
directly and doesn't read the manifest; it's for `abra-plugin validate` +
registry submission.

> Dev note: `tsconfig.json` points `@abraca/plugin` at local source until the
> `TreeApi`/`FileApi`/`onOpenNode`/`onFollow` contract additions are published
> (≥ 2.30). Drop that override after `wand publish --ts`.

## Scene settings (on the page doc's meta)

`spGridVisible`, `spShadows`, `spGround` (shadow-catching plane), `spBackground`,
`spEnvUploadId` + `spEnvType` (`hdr`/`exr`) + `spEnvAsBackground` (skybox).

## Wiring points still open

- **KTX2 transcoder**: wired and offline; broad GPU-format detection relies on
  `KTX2Loader.detectSupport(renderer)` — exotic targets may fall back.
- **Animation control**: all clips auto-play; per-clip play/pause/scrub and
  choosing a single clip aren't exposed yet.
- **Per-node materials**: opacity is applied; PBR overrides (metalness/roughness)
  are not exposed in the inspector.
