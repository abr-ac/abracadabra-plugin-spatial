/**
 * CameraController — owns the single PerspectiveCamera and swaps between two
 * input strategies sharing it, so awareness/follow/focus are identical in both:
 *
 *  - **Orbit** — damped OrbitControls (turntable around a target).
 *  - **NoClip** — FPS-style free-fly spectator: PointerLockControls mouse-look
 *    + WASD movement along the true view direction, Space/Ctrl world up/down,
 *    Shift sprint, Alt crawl, scroll-wheel base-speed, velocity damping. Flies
 *    through everything (no collision).
 *
 * Mode is a LOCAL viewer preference (never written to the document). Follow-mode
 * supersedes both: controls are disabled and the camera lerps to the followed
 * user's broadcast. Every change broadcasts `spatial:camera` through one
 * throttled path, so remote viewers/followers are mode-agnostic.
 *
 * `update(dt)` returns whether the camera moved this frame, which the engine
 * uses to render on demand.
 */
import { PerspectiveCamera, Vector3, Box3, MathUtils } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import type { CameraAwareness } from '../scene.ts'

export type CameraModeKind = 'orbit' | 'noclip'

const KEY = {
  forward: new Set(['KeyW', 'ArrowUp']),
  back: new Set(['KeyS', 'ArrowDown']),
  left: new Set(['KeyA', 'ArrowLeft']),
  right: new Set(['KeyD', 'ArrowRight']),
  up: new Set(['Space']),
  down: new Set(['ControlLeft', 'ControlRight']),
  sprint: new Set(['ShiftLeft', 'ShiftRight']),
  crawl: new Set(['AltLeft', 'AltRight']),
}

export class CameraController {
  readonly camera: PerspectiveCamera
  private readonly orbit: OrbitControls
  private readonly pointerLock: PointerLockControls
  private mode: CameraModeKind = 'orbit'
  private following = false
  private followTarget: { position: Vector3; target: Vector3 } | null = null

  // NoClip state.
  private readonly keys = new Set<string>()
  private readonly velocity = new Vector3()
  private baseSpeed = 5 // metres / second
  private readonly fwd = new Vector3()
  private readonly rightV = new Vector3()
  private readonly worldUp = new Vector3(0, 1, 0)
  private readonly tmp = new Vector3()

  private onChange?: (cam: CameraAwareness) => void
  private lastBroadcast = 0
  private movedSinceBroadcast = false

  constructor(
    private readonly dom: HTMLElement,
    onChange?: (cam: CameraAwareness) => void,
  ) {
    this.onChange = onChange
    this.camera = new PerspectiveCamera(55, 1, 0.01, 5000)
    this.camera.position.set(4, 3, 6)

    this.orbit = new OrbitControls(this.camera, dom)
    this.orbit.enableDamping = true
    this.orbit.dampingFactor = 0.08
    this.orbit.target.set(0, 0.5, 0)
    this.orbit.addEventListener('change', () => { this.movedSinceBroadcast = true })

    this.pointerLock = new PointerLockControls(this.camera, dom)
    this.pointerLock.addEventListener('change', () => { this.movedSinceBroadcast = true })

    dom.addEventListener('wheel', this.onWheel, { passive: false })
    globalThis.addEventListener('keydown', this.onKeyDown)
    globalThis.addEventListener('keyup', this.onKeyUp)
    this.dom.addEventListener('pointerdown', this.onPointerDown)
  }

  // ── Mode ────────────────────────────────────────────────────────────────────
  getMode(): CameraModeKind { return this.mode }

  setMode(kind: CameraModeKind): void {
    if (this.mode === kind) return
    this.mode = kind
    this.keys.clear()
    this.velocity.set(0, 0, 0)
    if (kind === 'orbit') {
      this.pointerLock.unlock()
      // Re-aim the orbit target a few metres ahead of the current view.
      this.camera.getWorldDirection(this.fwd)
      this.orbit.target.copy(this.tmp.copy(this.camera.position).add(this.fwd.multiplyScalar(4)))
      this.orbit.enabled = !this.following
    } else {
      this.orbit.enabled = false
    }
  }

  // ── Follow ────────────────────────────────────────────────────────────────────
  setFollowing(on: boolean): void {
    this.following = on
    this.orbit.enabled = on ? false : this.mode === 'orbit'
    if (on) this.pointerLock.unlock()
    else this.followTarget = null
  }

  /** Enable/disable orbit interaction (e.g. suspended while a gizmo drags). */
  setInteractive(on: boolean): void {
    if (this.mode === 'orbit' && !this.following) this.orbit.enabled = on
  }

  applyRemote(cam: CameraAwareness): void {
    if (!this.following) return
    this.followTarget = {
      position: new Vector3().fromArray(cam.position),
      target: new Vector3().fromArray(cam.target),
    }
  }

  // ── Framing ────────────────────────────────────────────────────────────────
  focusOn(point: Vector3, distance = 4): void {
    this.orbit.target.copy(point)
    const dir = this.tmp.copy(this.camera.position).sub(point)
    if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1)
    this.camera.position.copy(point).add(dir.normalize().multiplyScalar(distance))
    this.movedSinceBroadcast = true
  }

  /** Frame a bounding box so it comfortably fills the view. */
  frameBox(box: Box3): void {
    if (box.isEmpty()) return
    const center = box.getCenter(new Vector3())
    const size = box.getSize(new Vector3())
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1
    const fov = MathUtils.degToRad(this.camera.fov)
    const dist = (radius / Math.sin(fov / 2)) * 1.3
    const dir = this.tmp.copy(this.camera.position).sub(center)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.7, 1)
    this.camera.position.copy(center).add(dir.normalize().multiplyScalar(dist))
    this.orbit.target.copy(center)
    this.movedSinceBroadcast = true
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────
  /** @returns true if the camera moved this frame (drives on-demand render). */
  update(dt: number): boolean {
    let moved = false
    if (this.following && this.followTarget) {
      this.camera.position.lerp(this.followTarget.position, 0.15)
      this.orbit.target.lerp(this.followTarget.target, 0.15)
      moved = true
    } else if (this.mode === 'orbit') {
      moved = this.orbit.update() || this.movedSinceBroadcast
    } else {
      moved = this.stepNoClip(dt)
    }
    if (this.movedSinceBroadcast || moved) this.broadcast()
    return moved
  }

  private stepNoClip(dt: number): boolean {
    // Target speed from keys.
    let speed = this.baseSpeed
    if (this.anyKey(KEY.sprint)) speed *= 4
    if (this.anyKey(KEY.crawl)) speed *= 0.25

    this.camera.getWorldDirection(this.fwd).normalize()
    this.rightV.copy(this.fwd).cross(this.worldUp).normalize()

    const target = this.tmp.set(0, 0, 0)
    if (this.anyKey(KEY.forward)) target.add(this.fwd)
    if (this.anyKey(KEY.back)) target.addScaledVector(this.fwd, -1)
    if (this.anyKey(KEY.right)) target.add(this.rightV)
    if (this.anyKey(KEY.left)) target.addScaledVector(this.rightV, -1)
    if (this.anyKey(KEY.up)) target.add(this.worldUp)
    if (this.anyKey(KEY.down)) target.addScaledVector(this.worldUp, -1)
    if (target.lengthSq() > 0) target.normalize().multiplyScalar(speed)

    // Critically-damped-ish smoothing toward the target velocity.
    const k = 1 - Math.pow(0.0001, dt)
    this.velocity.lerp(target, k)
    if (this.velocity.lengthSq() < 1e-6) {
      this.velocity.set(0, 0, 0)
      return this.movedSinceBroadcast
    }
    this.camera.position.addScaledVector(this.velocity, dt)
    return true
  }

  private anyKey(set: Set<string>): boolean {
    for (const k of set) if (this.keys.has(k)) return true
    return false
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  private onPointerDown = (): void => {
    if (this.mode === 'noclip' && !this.following && !this.pointerLock.isLocked) {
      this.pointerLock.lock()
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.mode !== 'noclip' || this.following) return
    if (isAllKey(e.code)) {
      this.keys.add(e.code)
      if (KEY.up.has(e.code)) e.preventDefault() // Space scroll guard
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.mode !== 'noclip' || this.following) return
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    this.baseSpeed = MathUtils.clamp(this.baseSpeed * factor, 0.2, 200)
  }

  /** Current free-fly base speed (for the HUD readout). */
  get speed(): number { return this.baseSpeed }
  get pointerLocked(): boolean { return this.pointerLock.isLocked }

  /** Serialise the view for per-scene local persistence. */
  serialize(): { position: [number, number, number]; target: [number, number, number] } {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.orbit.target.toArray() as [number, number, number],
    }
  }

  /** Restore a previously-saved view (no broadcast). */
  restore(state: { position: [number, number, number]; target: [number, number, number] }): void {
    this.camera.position.fromArray(state.position)
    this.orbit.target.fromArray(state.target)
    this.camera.lookAt(this.orbit.target)
    this.orbit.update()
  }

  private broadcast(): void {
    this.movedSinceBroadcast = false
    if (!this.onChange) return
    const now = Date.now()
    if (now - this.lastBroadcast < 60) return // ~16 fps awareness cap
    this.lastBroadcast = now
    // Orbit broadcasts its target; noclip broadcasts a point ahead of the view.
    let target: Vector3
    if (this.mode === 'orbit' || this.following) {
      target = this.orbit.target
    } else {
      this.camera.getWorldDirection(this.fwd)
      target = this.tmp.copy(this.camera.position).add(this.fwd.multiplyScalar(4))
    }
    this.onChange({
      position: this.camera.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      timestamp: now,
    })
  }

  dispose(): void {
    this.dom.removeEventListener('wheel', this.onWheel)
    this.dom.removeEventListener('pointerdown', this.onPointerDown)
    globalThis.removeEventListener('keydown', this.onKeyDown)
    globalThis.removeEventListener('keyup', this.onKeyUp)
    this.orbit.dispose()
    this.pointerLock.dispose()
  }
}

function isAllKey(code: string): boolean {
  return (
    KEY.forward.has(code) || KEY.back.has(code) || KEY.left.has(code) ||
    KEY.right.has(code) || KEY.up.has(code) || KEY.down.has(code) ||
    KEY.sprint.has(code) || KEY.crawl.has(code)
  )
}
