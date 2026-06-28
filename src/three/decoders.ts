/**
 * Offline decoders — Draco, Meshopt, and KTX2/basis decode with ZERO network.
 *
 * The decoder binaries that three normally fetches from a CDN/path are vendored
 * and INLINED into the bundle as base64 `data:` URLs (Vite `?url` + a raised
 * `assetsInlineLimit`). Each loader is handed a private `LoadingManager` whose
 * `setURLModifier` maps the synthetic decoder filenames (e.g.
 * `draco/draco_decoder.wasm`) to those inlined data URLs — so DRACOLoader /
 * KTX2Loader fetch the decoder out of the bundle itself, never the network.
 *
 * This keeps the single-file plugin self-contained AND fully offline-first:
 * once the plugin JS is cached, every supported model format decodes without a
 * connection.
 */
import { LoadingManager, type WebGLRenderer } from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

// Inlined decoder assets (data: URLs after Vite asset inlining).
import dracoWrapperUrl from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url'
import dracoWasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url'
import basisJsUrl from 'three/examples/jsm/libs/basis/basis_transcoder.js?url'
import basisWasmUrl from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url'

export { MeshoptDecoder }

function basename(url: string): string {
  const clean = url.split('?')[0]?.split('#')[0] ?? url
  return clean.substring(clean.lastIndexOf('/') + 1)
}

/** A LoadingManager that resolves the given basename→url map, else passthrough. */
function inlineManager(map: Record<string, string>): LoadingManager {
  const mgr = new LoadingManager()
  mgr.setURLModifier((requested) => map[basename(requested)] ?? requested)
  return mgr
}

let _draco: DRACOLoader | null = null

/** Shared Draco loader whose decoder is served from the inlined bundle. */
export function getDracoLoader(): DRACOLoader {
  if (_draco) return _draco
  const mgr = inlineManager({
    'draco_wasm_wrapper.js': dracoWrapperUrl,
    'draco_decoder.wasm': dracoWasmUrl,
  })
  const loader = new DRACOLoader(mgr)
  // Path is synthetic — the manager rewrites the two filenames to data URLs.
  loader.setDecoderPath('draco/')
  loader.setDecoderConfig({ type: 'wasm' })
  _draco = loader
  return loader
}

/**
 * KTX2/basis loader (GPU-compressed textures), transcoder served from the
 * inlined bundle. Must be given the renderer so it can detect GPU support.
 */
export function getKTX2Loader(renderer: WebGLRenderer): KTX2Loader {
  const mgr = inlineManager({
    'basis_transcoder.js': basisJsUrl,
    'basis_transcoder.wasm': basisWasmUrl,
  })
  const loader = new KTX2Loader(mgr)
  loader.setTranscoderPath('basis/')
  loader.detectSupport(renderer)
  return loader
}

export function disposeDecoders(): void {
  _draco?.dispose()
  _draco = null
}
