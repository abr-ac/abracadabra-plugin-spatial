/**
 * Picking — raycast selection, "look-here" pointer broadcast, and double-click
 * to open a node's document. Object transforms are handled by the Gizmo
 * (TransformControls), so Picking does not move objects — it only selects,
 * reports the pointer hit for presence, and opens nodes. Selection is gated to
 * the interactive (orbit, not-following) state; pointer broadcast runs whenever
 * the cursor is over the canvas.
 */
import {
  Raycaster,
  Vector2,
  Vector3,
  Plane,
  type PerspectiveCamera,
  type Object3D,
} from 'three'
import type { NodeGraph } from './NodeGraph.ts'

export interface PickingOptions {
  dom: HTMLElement
  camera: PerspectiveCamera
  root: Object3D
  graph: NodeGraph
  onSelect: (docId: string | null, additive: boolean) => void
  /** Broadcast the world-space point under the cursor (or null off-geometry). */
  onPointer: (point: Vector3 | null) => void
  /** Hovered document under the cursor (or null) — for highlight + cursor. */
  onHover: (docId: string | null) => void
  /** Open a document's node panel (host-provided). */
  onOpenNode: (docId: string) => void
  /** Clicking a remote user's in-scene camera gizmo → follow them. */
  onFollowUser: (publicKey: string) => void
  /** True only when clicks should select (orbit mode, not following). */
  isInteractive: () => boolean
  /** True while NoClip pointer-lock is engaged (cursor is screen-centred). */
  isPointerLocked: () => boolean
}

export class Picking {
  private readonly ray = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly groundPlane = new Plane(new Vector3(0, 1, 0), 0)
  private downPos = { x: 0, y: 0 }
  private moved = false
  private lastPointer = 0

  constructor(private readonly o: PickingOptions) {
    o.dom.addEventListener('pointerdown', this.onDown)
    o.dom.addEventListener('pointermove', this.onMove)
    globalThis.addEventListener('pointerup', this.onUp)
    o.dom.addEventListener('dblclick', this.onDblClick)
  }

  private setNdc(ev: { clientX: number; clientY: number }): void {
    // Under pointer-lock the OS cursor is pinned to screen centre, so raycast
    // from the viewport centre (where the user is actually looking).
    if (this.o.isPointerLocked()) { this.ndc.set(0, 0); return }
    const r = this.o.dom.getBoundingClientRect()
    this.ndc.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
    )
  }

  /**
   * World point on the ground plane (y=0) under a client-space coordinate —
   * used to place a dropped model where the cursor released, even over empty
   * space. Returns null only if the camera ray is parallel to the ground.
   */
  groundAt(clientX: number, clientY: number): Vector3 | null {
    const r = this.o.dom.getBoundingClientRect()
    this.ndc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    )
    this.ray.setFromCamera(this.ndc, this.o.camera)
    // Prefer a real surface hit (drop onto an existing model), else the ground.
    const hit = this.ray.intersectObject(this.o.root, true).find((h) => !inOverlay(h.object))
    if (hit) return hit.point.clone()
    const out = new Vector3()
    return this.ray.ray.intersectPlane(this.groundPlane, out) ? out.clone() : null
  }

  /** Public for the renderer's continuous NoClip pointer broadcast. */
  pointerHit(): Vector3 | null {
    this.ndc.set(0, 0)
    this.ray.setFromCamera(this.ndc, this.o.camera)
    const hit = this.ray.intersectObject(this.o.root, true).find((h) => !inOverlay(h.object))
    return hit ? hit.point.clone() : null
  }

  /** Walk up to a tagged remote-user key, if this object is a presence gizmo. */
  private userKeyOf(obj: Object3D | null): string | null {
    let o: Object3D | null = obj
    while (o) {
      if (typeof o.userData?.userKey === 'string') return o.userData.userKey
      o = o.parent
    }
    return null
  }

  private pick(ev: { clientX: number; clientY: number }): { docId: string | null; point: Vector3 | null } {
    this.setNdc(ev)
    this.ray.setFromCamera(this.ndc, this.o.camera)
    const hits = this.ray.intersectObject(this.o.root, true)
    // Skip presence/selection overlays (they live in named helper groups).
    const hit = hits.find((h) => !inOverlay(h.object))
    return {
      docId: hit ? this.o.graph.docIdForObject(hit.object) : null,
      point: hit ? hit.point.clone() : null,
    }
  }

  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return
    this.downPos = { x: ev.clientX, y: ev.clientY }
    this.moved = false
  }

  private onMove = (ev: PointerEvent): void => {
    if (Math.hypot(ev.clientX - this.downPos.x, ev.clientY - this.downPos.y) > 3) this.moved = true
    const now = Date.now()
    if (now - this.lastPointer < 50) return // ~20 fps pointer broadcast
    this.lastPointer = now
    const { docId, point } = this.pick(ev)
    this.o.onPointer(point)
    this.o.onHover(this.o.isInteractive() ? docId : null)
  }

  private onUp = (ev: PointerEvent): void => {
    if (this.moved || ev.button !== 0) return
    // Clicking a remote user's camera gizmo follows them (works in any mode).
    this.setNdc(ev)
    this.ray.setFromCamera(this.ndc, this.o.camera)
    const all = this.ray.intersectObject(this.o.root, true)
    const key = this.userKeyOf(all[0]?.object ?? null)
    if (key) { this.o.onFollowUser(key); return }
    if (!this.o.isInteractive()) return
    const hit = all.find((h) => !inOverlay(h.object))
    this.o.onSelect(hit ? this.o.graph.docIdForObject(hit.object) : null, ev.shiftKey)
  }

  private onDblClick = (ev: MouseEvent): void => {
    const { docId } = this.pick(ev)
    if (docId) this.o.onOpenNode(docId)
  }

  dispose(): void {
    this.o.dom.removeEventListener('pointerdown', this.onDown)
    this.o.dom.removeEventListener('pointermove', this.onMove)
    globalThis.removeEventListener('pointerup', this.onUp)
    this.o.dom.removeEventListener('dblclick', this.onDblClick)
  }
}

function inOverlay(obj: Object3D): boolean {
  // Internal overlays (presence, selection, gizmo, pivot) are all `__`-named —
  // never selectable. Keeps clicking a gizmo handle from deselecting.
  let o: Object3D | null = obj
  while (o) {
    if (o.name.startsWith('__')) return true
    o = o.parent
  }
  return false
}
