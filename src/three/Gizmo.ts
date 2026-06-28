/**
 * Gizmo — TransformControls (translate / rotate / scale) for the selection.
 *
 *  - **Single node:** the gizmo attaches directly to that node so editing
 *    happens in its own local space; the decomposed TRS is written to meta.
 *  - **Multiple nodes:** the gizmo attaches to a centroid PIVOT. On drag the
 *    pivot's world delta is applied to every selected node (each converted back
 *    into its own parent's local space), so groups transform rigidly together.
 *
 * Optional snapping (translate 0.25 / rotate 15° / scale 0.1). Writes are
 * throttled during a drag and flushed on release. Disabled for viewers. Bundled
 * with three → offline.
 */
import {
  Object3D, Matrix4, Vector3, Quaternion, Euler, MathUtils,
  type PerspectiveCamera,
} from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { AbraTreeApi } from '@abraca/plugin'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

export interface GizmoOptions {
  camera: PerspectiveCamera
  dom: HTMLElement
  scene: Object3D
  tree: AbraTreeApi
  onDraggingChanged: (dragging: boolean) => void
  onInvalidate: () => void
}

interface Target { id: string; obj: Object3D }

const _m = new Matrix4()
const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()
const _e = new Euler()

export class Gizmo {
  readonly controls: TransformControls
  private readonly pivot = new Object3D()
  private targets: Target[] = []
  private multi = false
  private userSpace: 'world' | 'local' = 'local'
  private lastWrite = 0

  // Drag snapshots (multi-select).
  private pivotStartInv = new Matrix4()
  private startWorld: Matrix4[] = []
  private parentInv: Matrix4[] = []

  constructor(private readonly o: GizmoOptions) {
    this.pivot.name = '__gizmo_pivot__'
    o.scene.add(this.pivot)

    this.controls = new TransformControls(o.camera, o.dom)
    this.controls.setSpace('world')
    const helper = this.controls.getHelper?.() ?? (this.controls as unknown as Object3D)
    helper.name = '__gizmo__'
    o.scene.add(helper)

    this.controls.addEventListener('dragging-changed', (e) => {
      const dragging = !!(e as unknown as { value: boolean }).value
      if (dragging) this.snapshot()
      else this.flush()
      this.o.onDraggingChanged(dragging)
    })
    this.controls.addEventListener('objectChange', () => this.onObjectChange())
    this.controls.addEventListener('change', () => this.o.onInvalidate())
  }

  setMode(mode: GizmoMode): void { this.controls.setMode(mode) }

  /** Single-node transform space (multi-select always uses world). */
  setUserSpace(space: 'world' | 'local'): void {
    this.userSpace = space
    if (!this.multi && this.targets.length === 1) this.controls.setSpace(space)
  }

  setSnap(on: boolean): void {
    this.controls.setTranslationSnap(on ? 0.25 : null)
    this.controls.setRotationSnap(on ? MathUtils.degToRad(15) : null)
    this.controls.setScaleSnap(on ? 0.1 : null)
  }

  /** Attach to a set of selected nodes (single → direct, many → pivot). */
  attach(targets: Target[]): void {
    this.targets = targets
    if (targets.length === 0) { this.multi = false; this.controls.detach(); return }
    if (targets.length === 1) {
      this.multi = false
      this.controls.setSpace(this.userSpace)
      this.controls.attach(targets[0]!.obj)
      return
    }
    // Multi: park an identity pivot at the selection centroid.
    this.multi = true
    this.controls.setSpace('world')
    const c = _p.set(0, 0, 0)
    for (const t of targets) c.add(t.obj.getWorldPosition(_s))
    c.divideScalar(targets.length)
    this.pivot.position.copy(c)
    this.pivot.quaternion.identity()
    this.pivot.scale.set(1, 1, 1)
    this.pivot.updateMatrixWorld(true)
    this.controls.attach(this.pivot)
  }

  private snapshot(): void {
    if (!this.multi) return
    this.pivot.updateMatrixWorld(true)
    this.pivotStartInv.copy(this.pivot.matrixWorld).invert()
    this.startWorld = []
    this.parentInv = []
    for (const t of this.targets) {
      t.obj.updateMatrixWorld(true)
      this.startWorld.push(t.obj.matrixWorld.clone())
      this.parentInv.push(
        t.obj.parent ? t.obj.parent.matrixWorld.clone().invert() : new Matrix4(),
      )
    }
  }

  private onObjectChange(): void {
    if (this.multi) this.applyMulti()
    else this.applySingle()
  }

  private applySingle(): void {
    const t = this.targets[0]
    if (!t) return
    this.writeTRS(t.id, t.obj, true)
  }

  private applyMulti(): void {
    this.pivot.updateMatrixWorld(true)
    // Delta = pivotNow * pivotStart⁻¹  (in world space).
    const delta = _m.multiplyMatrices(this.pivot.matrixWorld, this.pivotStartInv)
    const throttled = Date.now() - this.lastWrite < 40
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!
      const newWorld = new Matrix4().multiplyMatrices(delta, this.startWorld[i]!)
      const local = newWorld.premultiply(this.parentInv[i]!)
      local.decompose(_p, _q, _s)
      t.obj.position.copy(_p)
      t.obj.quaternion.copy(_q)
      t.obj.scale.copy(_s)
      if (!throttled) this.writeTRS(t.id, t.obj, false)
    }
    if (!throttled) this.lastWrite = Date.now()
  }

  /** Write a node's current local TRS to its document meta. */
  private writeTRS(id: string, obj: Object3D, gate: boolean): void {
    if (gate) {
      const now = Date.now()
      if (now - this.lastWrite < 40) return
      this.lastWrite = now
    }
    _e.setFromQuaternion(obj.quaternion)
    this.o.tree.updateMeta(id, {
      spX: r(obj.position.x), spY: r(obj.position.y), spZ: r(obj.position.z),
      spRX: r(MathUtils.radToDeg(_e.x)), spRY: r(MathUtils.radToDeg(_e.y)), spRZ: r(MathUtils.radToDeg(_e.z)),
      spSX: r(obj.scale.x), spSY: r(obj.scale.y), spSZ: r(obj.scale.z),
    })
  }

  /** Force-write every target's final transform on drag release. */
  private flush(): void {
    this.lastWrite = 0
    for (const t of this.targets) this.writeTRS(t.id, t.obj, false)
    this.lastWrite = 0
  }

  get dragging(): boolean {
    return (this.controls as unknown as { dragging?: boolean }).dragging ?? false
  }

  dispose(): void {
    this.controls.detach()
    this.controls.dispose()
    this.pivot.removeFromParent()
  }
}

function r(n: number): number { return Math.round(n * 1000) / 1000 }
