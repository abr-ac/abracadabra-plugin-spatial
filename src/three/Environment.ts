/**
 * Environment — loads an equirectangular HDR (.hdr) or EXR (.exr) image-based
 * lighting map from a document upload (via the host's offline blob cache) and
 * hands it to the engine, which runs it through PMREM. Fully offline: the blob
 * URL comes from `AbraFileApi`, the loaders are bundled.
 */
import { EquirectangularReflectionMapping, type Texture } from 'three'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'

export async function loadEnvironment(
  url: string,
  kind: 'hdr' | 'exr',
): Promise<Texture> {
  const loader = kind === 'exr' ? new EXRLoader() : new RGBELoader()
  const tex = await loader.loadAsync(url)
  tex.mapping = EquirectangularReflectionMapping
  return tex
}
