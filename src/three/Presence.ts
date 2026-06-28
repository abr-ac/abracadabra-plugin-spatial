/**
 * Presence — renders remote collaborators in the scene: a smoothly-interpolated
 * camera gizmo + floating name label at each remote camera, colored selection
 * outlines around objects others have selected, and a "look-here" reticle at
 * each user's broadcast pointer. Diffed by user key; `update()` ingests new
 * awareness, `tick(dt)` interpolates gizmos toward their targets each frame so
 * remote cameras glide instead of snapping.
 */
import {
  Group,
  Mesh,
  ConeGeometry,
  MeshBasicMaterial,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  BoxHelper,
  Color,
  Vector3,
  Quaternion,
  Matrix4,
  DoubleSide,
  type Object3D,
} from 'three'
import type { NodeGraph } from './NodeGraph.ts'

export interface RemoteUser {
  key: string
  name: string
  color: string
  camera?: { position: [number, number, number]; target: [number, number, number] }
  selected?: string[]
  pointer?: [number, number, number] | null
}

interface UserGizmo {
  group: Group
  cone: Mesh
  label: Sprite
  reticle: Mesh
  outlines: Map<string, BoxHelper>
  color: string
  name: string
  // Interpolation targets.
  targetPos: Vector3
  targetQuat: Quaternion
  hasCam: boolean
  targetReticle: Vector3 | null
}

const M = new Matrix4()
const UP = new Vector3(0, 1, 0)

export class Presence {
  private readonly container = new Group()
  private readonly gizmos = new Map<string, UserGizmo>()

  constructor(private readonly root: Object3D, private readonly graph: NodeGraph) {
    this.container.name = '__presence__'
    this.root.add(this.container)
  }

  update(users: readonly RemoteUser[]): void {
    const seen = new Set<string>()
    for (const u of users) {
      seen.add(u.key)
      let g = this.gizmos.get(u.key)
      if (!g || g.color !== u.color || g.name !== u.name) {
        if (g) { g.group.removeFromParent(); this.disposeGizmo(g) }
        g = this.createGizmo(u)
        this.gizmos.set(u.key, g)
        this.container.add(g.group)
      }

      // Camera target (interpolated in tick).
      if (u.camera) {
        g.hasCam = true
        g.targetPos.fromArray(u.camera.position)
        M.lookAt(
          new Vector3().fromArray(u.camera.position),
          new Vector3().fromArray(u.camera.target),
          UP,
        )
        g.targetQuat.setFromRotationMatrix(M)
        if (!g.group.visible) {
          g.group.visible = true
          g.group.position.copy(g.targetPos)
          g.group.quaternion.copy(g.targetQuat)
        }
      } else {
        g.hasCam = false
        g.group.visible = false
      }

      // Pointer reticle target.
      g.targetReticle = u.pointer ? new Vector3().fromArray(u.pointer) : null
      g.reticle.visible = !!g.targetReticle

      this.syncOutlines(g, u)
    }

    for (const [key, g] of this.gizmos) {
      if (seen.has(key)) continue
      g.group.removeFromParent()
      this.disposeGizmo(g)
      this.gizmos.delete(key)
    }
  }

  /**
   * Per-frame smoothing so remote cameras glide between awareness frames.
   * @returns true while anything is still moving (drives on-demand render).
   */
  tick(dt: number): boolean {
    const k = 1 - Math.pow(0.001, dt) // framerate-independent smoothing factor
    let moving = false
    for (const g of this.gizmos.values()) {
      if (g.hasCam) {
        if (g.group.position.distanceToSquared(g.targetPos) > 1e-6) moving = true
        g.group.position.lerp(g.targetPos, k)
        g.group.quaternion.slerp(g.targetQuat, k)
      }
      if (g.targetReticle) {
        if (g.reticle.position.distanceToSquared(g.targetReticle) > 1e-6) moving = true
        g.reticle.position.lerp(g.targetReticle, k)
        g.reticle.lookAt(g.targetReticle.clone().add(UP))
      }
    }
    return moving
  }

  private createGizmo(u: RemoteUser): UserGizmo {
    const group = new Group()
    group.userData.userKey = u.key
    const color = new Color(u.color || '#ffffff')

    const cone = new Mesh(
      new ConeGeometry(0.12, 0.3, 4),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    )
    cone.rotation.x = -Math.PI / 2 // tip points -Z (look direction)
    cone.userData.userKey = u.key
    group.add(cone)

    const label = makeLabel(u.name || 'User', u.color || '#ffffff')
    label.position.set(0, 0.32, 0)
    group.add(label)

    // Pointer reticle lives in the container (world space), not the cam group.
    const reticle = new Mesh(
      new RingGeometry(0.12, 0.18, 24),
      new MeshBasicMaterial({ color, side: DoubleSide, transparent: true, opacity: 0.85, depthTest: false }),
    )
    reticle.visible = false
    this.container.add(reticle)

    return {
      group, cone, label, reticle, outlines: new Map(),
      color: u.color, name: u.name,
      targetPos: new Vector3(), targetQuat: new Quaternion(),
      hasCam: false, targetReticle: null,
    }
  }

  private syncOutlines(g: UserGizmo, u: RemoteUser): void {
    const want = new Set(u.selected ?? [])
    for (const [id, helper] of g.outlines) {
      if (!want.has(id)) {
        helper.removeFromParent()
        helper.geometry.dispose()
        g.outlines.delete(id)
      }
    }
    for (const id of want) {
      const obj = this.graph.groupFor(id)
      if (!obj) continue
      let helper = g.outlines.get(id)
      if (!helper) {
        helper = new BoxHelper(obj, new Color(u.color || '#ffffff'))
        g.outlines.set(id, helper)
        this.container.add(helper)
      } else {
        helper.setFromObject(obj)
      }
    }
  }

  private disposeGizmo(g: UserGizmo): void {
    g.cone.geometry.dispose()
    ;(g.cone.material as MeshBasicMaterial).dispose()
    ;(g.label.material as SpriteMaterial).map?.dispose()
    ;(g.label.material as SpriteMaterial).dispose()
    g.reticle.removeFromParent()
    g.reticle.geometry.dispose()
    ;(g.reticle.material as MeshBasicMaterial).dispose()
    for (const h of g.outlines.values()) {
      h.removeFromParent()
      h.geometry.dispose()
    }
    g.outlines.clear()
  }

  dispose(): void {
    for (const g of this.gizmos.values()) this.disposeGizmo(g)
    this.gizmos.clear()
    this.container.removeFromParent()
  }
}

function makeLabel(text: string, color: string): Sprite {
  const canvas = document.createElement('canvas')
  const pad = 16
  const probe = canvas.getContext('2d')!
  probe.font = '600 28px system-ui, sans-serif'
  const w = probe.measureText(text).width
  canvas.width = w + pad * 2
  canvas.height = 48
  const ctx = canvas.getContext('2d')!
  ctx.font = '600 28px system-ui, sans-serif'
  ctx.fillStyle = color
  ctx.globalAlpha = 0.92
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 10)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#0b0b0f'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, canvas.height / 2)

  const tex = new CanvasTexture(canvas)
  const sprite = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  const aspect = canvas.width / canvas.height
  sprite.scale.set(0.4 * aspect, 0.4, 1)
  return sprite
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
