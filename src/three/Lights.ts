/**
 * Lights — maps a light DOCUMENT's meta to a real Three.js light. Lights are
 * documents too (spKind === 'light'); their transform is applied by NodeGraph
 * on the wrapping group, so the light itself sits at the group origin.
 */
import {
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  PointLight,
  SpotLight,
  Color,
  type Light,
} from 'three'
import { num, type SpatialMeta, type SpLightType } from '../scene.ts'

type ShadowLight = DirectionalLight | SpotLight | PointLight

/** Quality shadow defaults: crisp maps + a sane frustum so shadows aren't acne-y. */
function configureShadow(light: ShadowLight, cast: boolean): void {
  light.castShadow = cast
  if (!cast) return
  light.shadow.mapSize.set(2048, 2048)
  light.shadow.bias = -0.0004
  light.shadow.normalBias = 0.02
  const cam = light.shadow.camera as unknown as {
    near: number; far: number; left?: number; right?: number; top?: number; bottom?: number
    updateProjectionMatrix(): void
  }
  cam.near = 0.1
  cam.far = 100
  if ((light as DirectionalLight).isDirectionalLight) {
    cam.left = -20; cam.right = 20; cam.top = 20; cam.bottom = -20
  }
  cam.updateProjectionMatrix()
}

export function createLight(meta: SpatialMeta): Light {
  const type: SpLightType = meta.spLightType ?? 'directional'
  const color = new Color(meta.color ?? '#ffffff')
  const intensity = num(meta.spIntensity, type === 'ambient' ? 0.6 : 1)
  const cast = meta.spCastShadow ?? false

  switch (type) {
    case 'ambient':
      return new AmbientLight(color, intensity)
    case 'hemisphere':
      return new HemisphereLight(color, new Color('#444444'), intensity)
    case 'point': {
      const l = new PointLight(color, intensity, num(meta.spDistance, 0))
      configureShadow(l, cast)
      return l
    }
    case 'spot': {
      const l = new SpotLight(
        color,
        intensity,
        num(meta.spDistance, 0),
        num(meta.spAngle, 30) * (Math.PI / 180),
        num(meta.spPenumbra, 0.1),
      )
      configureShadow(l, cast)
      return l
    }
    case 'directional':
    default: {
      const l = new DirectionalLight(color, intensity)
      configureShadow(l, cast)
      return l
    }
  }
}

/**
 * A neutral fallback rig added ONLY when a scene has zero light documents, so an
 * empty scene isn't pitch black. These are not documents — purely a default.
 */
export function fallbackLights(): Light[] {
  const key = new DirectionalLight(0xffffff, 2)
  key.position.set(5, 8, 6)
  const fill = new DirectionalLight(0xffffff, 0.6)
  fill.position.set(-6, 3, -4)
  const ambient = new AmbientLight(0xffffff, 0.4)
  return [key, fill, ambient]
}
