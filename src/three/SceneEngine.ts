/**
 * SceneEngine — owns the single WebGLRenderer, scene, render loop, and resize
 * handling for one spatial document. Pure Three.js: the Vue layer only mounts a
 * canvas and hands it here; everything 3D is mutated imperatively. One RAF loop,
 * one renderer, disposed on teardown.
 */
import {
  Scene,
  WebGLRenderer,
  Color,
  PMREMGenerator,
  ACESFilmicToneMapping,
  type Texture,
  type PerspectiveCamera,
} from 'three'

export interface SceneEngineOptions {
  canvas: HTMLCanvasElement
  /**
   * Called every frame. Runs input/animation integration and returns whether
   * anything changed this frame; the engine renders only when it returns true
   * or the scene was explicitly invalidated (on-demand rendering → idle scenes
   * cost almost nothing).
   */
  onFrame?: (dt: number) => boolean
}

export class SceneEngine {
  readonly scene: Scene
  readonly renderer: WebGLRenderer
  readonly pmrem: PMREMGenerator
  /** Wall-clock of the previous frame (ms); 0 until the first tick. */
  private lastFrameTime = 0
  private readonly onFrame?: (dt: number) => boolean
  private camera: PerspectiveCamera | null = null
  private raf = 0
  private ro: ResizeObserver | null = null
  private disposed = false
  /** Frames still owed to the renderer after an explicit invalidate. */
  private dirtyFrames = 2
  /** Per-frame render hooks (e.g. CSS2D label renderer, outline pass). */
  private readonly renderHooks = new Set<(cam: PerspectiveCamera) => void>()

  constructor(opts: SceneEngineOptions) {
    this.onFrame = opts.onFrame
    this.scene = new Scene()
    this.scene.background = new Color(0x0b0b0f)

    this.renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.pmrem = new PMREMGenerator(this.renderer)
    this.pmrem.compileEquirectangularShader()

    this.resizeToParent()
    const parent = opts.canvas.parentElement
    if (parent && 'ResizeObserver' in globalThis) {
      this.ro = new ResizeObserver(() => this.resizeToParent())
      this.ro.observe(parent)
    }
  }

  setCamera(camera: PerspectiveCamera): void {
    this.camera = camera
    this.resizeToParent()
  }

  setBackground(hex: string | null): void {
    this.scene.background = hex ? new Color(hex) : new Color(0x0b0b0f)
  }

  private envTexture: Texture | null = null

  /**
   * Apply an equirectangular HDR/EXR texture as the scene environment (IBL),
   * optionally also as the background (skybox). Disposes the previously-built
   * environment map so repeated loads don't leak GPU memory.
   */
  setEnvironment(equirect: Texture | null, asBackground = false): void {
    this.envTexture?.dispose()
    this.envTexture = null
    if (!equirect) {
      this.scene.environment = null
      if (this.scene.background instanceof Color === false) this.scene.background = new Color(0x0b0b0f)
      this.invalidate()
      return
    }
    const env = this.pmrem.fromEquirectangular(equirect).texture
    this.scene.environment = env
    this.envTexture = env
    if (asBackground) this.scene.background = env
    equirect.dispose()
    this.invalidate()
  }

  setShadows(enabled: boolean): void {
    this.renderer.shadowMap.enabled = enabled
  }

  addRenderHook(fn: (cam: PerspectiveCamera) => void): () => void {
    this.renderHooks.add(fn)
    return () => this.renderHooks.delete(fn)
  }

  /** Force a render on the next few frames (e.g. after a tree/awareness change). */
  invalidate(): void {
    this.dirtyFrames = Math.max(this.dirtyFrames, 2)
  }

  start(): void {
    if (this.raf) return
    const tick = (): void => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(tick)
      // Manual dt (Clock is deprecated), clamped so a resumed on-demand loop
      // after an idle gap doesn't jump cameras/animations by a huge delta.
      const now = performance.now()
      const dt = this.lastFrameTime ? Math.min((now - this.lastFrameTime) / 1000, 0.1) : 0
      this.lastFrameTime = now
      const changed = this.onFrame?.(dt) ?? true
      if (changed) this.dirtyFrames = Math.max(this.dirtyFrames, 1)
      if (this.camera && this.dirtyFrames > 0) {
        this.dirtyFrames--
        this.renderer.render(this.scene, this.camera)
        for (const hook of this.renderHooks) hook(this.camera)
      }
    }
    this.raf = requestAnimationFrame(tick)
  }

  private resizeToParent(): void {
    const parent = this.renderer.domElement.parentElement
    const w = parent?.clientWidth || this.renderer.domElement.clientWidth || 1
    const h = parent?.clientHeight || this.renderer.domElement.clientHeight || 1
    this.renderer.setSize(w, h, false)
    if (this.camera) {
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
    this.invalidate()
  }

  dispose(): void {
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.ro?.disconnect()
    this.ro = null
    this.renderHooks.clear()
    this.envTexture?.dispose()
    this.pmrem.dispose()
    this.renderer.dispose()
  }
}
