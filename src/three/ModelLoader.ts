/**
 * ModelLoader — loads GLB/GLTF models from blob URLs, resolving NESTED file
 * dependencies (.bin buffers, external textures) through a pre-built asset map.
 *
 * Why a pre-built map: three's `LoadingManager.setURLModifier` is synchronous,
 * but resolving a sibling document's upload to an object URL is async
 * (`AbraFileApi.getBlobUrl`). So the renderer resolves every child "file"
 * document of the model doc up-front into `assetMap` (basename → objectURL),
 * and the loader does a synchronous basename lookup when GLTFLoader requests a
 * referenced URI. Self-contained GLBs need no map.
 *
 * Draco-compressed and Meshopt-packed models are supported. KTX2 (basis)
 * textures are out of scope for v1 (documented wiring point).
 */
import {
  Box3,
  Vector3,
  type Object3D,
  type WebGLRenderer,
  Mesh,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { LoadingManager } from 'three'
import { getDracoLoader, getKTX2Loader, MeshoptDecoder, disposeDecoders } from './decoders.ts'

export interface ModelLoadOptions {
  /** basename → object URL, for external GLTF resources (textures, .bin). */
  assetMap?: Map<string, string>
  /** 'unit' normalizes the model into a 1³ box; 'raw' (default) keeps scale. */
  fit?: 'raw' | 'unit'
}

function basename(url: string): string {
  const clean = url.split('?')[0]?.split('#')[0] ?? url
  return clean.substring(clean.lastIndexOf('/') + 1)
}

export class ModelLoader {
  private readonly draco = getDracoLoader()
  private readonly ktx2: KTX2Loader

  constructor(private readonly renderer: WebGLRenderer) {
    // Both decoders resolve their wasm/js from the INLINED bundle — fully
    // offline, no CDN. KTX2 needs the renderer to detect GPU texture support.
    this.ktx2 = getKTX2Loader(renderer)
  }

  async load(url: string, opts: ModelLoadOptions = {}): Promise<Object3D> {
    const manager = new LoadingManager()
    if (opts.assetMap && opts.assetMap.size) {
      manager.setURLModifier((requested) => {
        // The top-level url passes through; referenced resources resolve by
        // basename against the pre-resolved sibling-document uploads.
        if (requested === url) return requested
        const hit = opts.assetMap!.get(basename(requested))
        return hit ?? requested
      })
    }
    const loader = new GLTFLoader(manager)
    loader.setDRACOLoader(this.draco)
    loader.setKTX2Loader(this.ktx2)
    loader.setMeshoptDecoder(MeshoptDecoder)

    const gltf = await loader.loadAsync(url)
    const root = gltf.scene

    root.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })

    // Carry animation clips on the object so NodeGraph can drive a mixer.
    root.animations = gltf.animations ?? []

    if (opts.fit === 'unit') this.fitUnit(root)
    return root
  }

  private fitUnit(root: Object3D): void {
    const box = new Box3().setFromObject(root)
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 0) {
      const s = 1 / maxDim
      root.scale.multiplyScalar(s)
      root.position.sub(center.multiplyScalar(s))
    }
  }

  dispose(): void {
    this.ktx2.dispose()
    disposeDecoders()
  }
}
