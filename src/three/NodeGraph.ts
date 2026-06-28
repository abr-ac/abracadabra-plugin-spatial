/**
 * NodeGraph — reconciles the document tree (deep) into a Three.js scene graph.
 *
 * Every object/light/group document becomes a `Group` ("node group") that
 * carries its transform; kind-specific content (a loaded model, a light) lives
 * inside that group. Children node groups are parented under their parent's node
 * group, so nesting goes as deep as the document hierarchy — the same recursive
 * walk the built-in graph renderer does, but mutating Three objects in place.
 *
 * `reconcile()` is a diff, not a rebuild: it adds new nodes, disposes removed
 * ones, reparents moved ones, and updates transforms/params on existing ones —
 * cheap to call on every tree change.
 *
 * Documents tagged `meta.spFileUploadId` are NOT scene objects; they are
 * external file dependencies of their parent model and are folded into that
 * model's loader asset-map.
 */
import {
  Group,
  Mesh,
  BoxGeometry,
  MeshBasicMaterial,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  AnimationMixer,
  type AnimationClip,
  type Object3D,
  type Light,
} from 'three'
import type { AbraTreeApi, AbraTreeEntry, AbraFileApi } from '@abraca/plugin'
import {
  position,
  rotationRad,
  scale,
  num,
  type SpatialMeta,
} from '../scene.ts'
import { ModelLoader } from './ModelLoader.ts'
import { createLight, fallbackLights } from './Lights.ts'

interface NodeRecord {
  group: Group
  kind: string
  /** Signature of the currently-loaded model (uploadId + assetMap digest). */
  modelSig?: string
  modelObject?: Object3D
  placeholder?: Object3D
  light?: Light
  lightSig?: string
  mixer?: AnimationMixer
  /** Bumped on each model load to ignore stale async results. */
  loadToken: number
}

function meta(e: AbraTreeEntry): SpatialMeta {
  return (e.meta ?? {}) as SpatialMeta
}

function isFileAsset(m: SpatialMeta): boolean {
  return typeof m.spFileUploadId === 'string'
}

export class NodeGraph {
  private readonly records = new Map<string, NodeRecord>()
  private readonly failed = new Set<string>()
  private readonly fallback = new Group()
  private fallbackActive = false

  constructor(
    private readonly root: Object3D,
    private readonly tree: AbraTreeApi,
    private readonly fileApi: AbraFileApi | undefined,
    private readonly loader: ModelLoader,
    /** Called when async work (a model finished loading) changed the scene. */
    private readonly onInvalidate: () => void = () => {},
    /** Called with the current count of models that failed to load (HUD). */
    private readonly onFailures: (count: number) => void = () => {},
  ) {
    this.fallback.name = '__fallback_lights__'
    for (const l of fallbackLights()) this.fallback.add(l)
  }

  reconcile(): void {
    const rootId = this.tree.rootId
    const entries = this.tree.descendantsOf(rootId)
    const live = new Map<string, AbraTreeEntry>()
    let lightCount = 0
    for (const e of entries) {
      const m = meta(e)
      if (isFileAsset(m)) continue // folded into parent model, not a scene node
      live.set(e.id, e)
      if (m.spKind === 'light') lightCount++
    }

    // Remove records whose document vanished.
    for (const [id, rec] of this.records) {
      if (!live.has(id)) {
        rec.group.removeFromParent()
        this.disposeRecord(rec)
        this.records.delete(id)
        if (this.failed.delete(id)) this.onFailures(this.failed.size)
      }
    }

    // Ensure + update every live node. Two effective passes: groups are created
    // lazily as parents are resolved, so order within `entries` doesn't matter.
    for (const e of live.values()) this.ensureRecord(e.id)
    for (const e of live.values()) this.updateNode(e, rootId, live)

    // Fallback lights only when the scene defines none of its own.
    if (lightCount === 0 && !this.fallbackActive) {
      this.root.add(this.fallback)
      this.fallbackActive = true
    } else if (lightCount > 0 && this.fallbackActive) {
      this.fallback.removeFromParent()
      this.fallbackActive = false
    }
  }

  private ensureRecord(id: string): NodeRecord {
    let rec = this.records.get(id)
    if (!rec) {
      const group = new Group()
      group.userData.docId = id
      rec = { group, kind: '', loadToken: 0 }
      this.records.set(id, rec)
    }
    return rec
  }

  private updateNode(
    e: AbraTreeEntry,
    rootId: string,
    live: Map<string, AbraTreeEntry>,
  ): void {
    const rec = this.records.get(e.id)!
    const m = meta(e)

    // Transform.
    rec.group.position.fromArray(position(m))
    rec.group.rotation.set(...rotationRad(m))
    rec.group.scale.fromArray(scale(m))
    rec.group.visible = m.spVisible !== false
    this.applyOpacity(rec, m)

    // Parent: under the parent node group, or the scene root if the parent is
    // the scene doc (or a folded/absent parent).
    const parentId = e.parentId
    const parentGroup =
      parentId && parentId !== rootId && live.has(parentId)
        ? this.records.get(parentId)?.group ?? this.root
        : this.root
    if (rec.group.parent !== parentGroup) parentGroup.add(rec.group)

    const kind = m.spKind ?? 'model'
    rec.kind = kind
    if (kind === 'light') this.syncLight(rec, m)
    else this.clearLight(rec)
    if (kind === 'model') this.syncModel(e.id, rec, m)
    else this.clearModel(rec)
  }

  // ── Lights ────────────────────────────────────────────────────────────────
  private syncLight(rec: NodeRecord, m: SpatialMeta): void {
    const sig = JSON.stringify([
      m.spLightType, m.color, m.spIntensity, m.spDistance,
      m.spAngle, m.spPenumbra, m.spCastShadow,
    ])
    if (rec.lightSig === sig && rec.light) return
    this.clearLight(rec)
    const light = createLight(m)
    rec.group.add(light)
    rec.light = light
    rec.lightSig = sig
  }

  private clearLight(rec: NodeRecord): void {
    if (rec.light) {
      rec.light.removeFromParent()
      rec.light.dispose?.()
      rec.light = undefined
      rec.lightSig = undefined
    }
  }

  // ── Models ──────────────────────────────────────────────────────────────────
  private syncModel(docId: string, rec: NodeRecord, m: SpatialMeta): void {
    const uploadId = m.spModelUploadId
    const ownerDoc = m.spModelDocId ?? docId
    if (!uploadId || !this.fileApi) {
      this.clearModel(rec)
      this.ensurePlaceholder(rec)
      return
    }
    // Asset-map digest: which child file docs exist (so a new texture reloads).
    const assetChildren = this.tree
      .childrenOf(docId)
      .filter((c) => isFileAsset(meta(c)))
    const sig = JSON.stringify([
      ownerDoc, uploadId, m.spFit,
      assetChildren.map((c) => [c.id, c.label, meta(c).spFileUploadId]),
    ])
    if (rec.modelSig === sig && rec.modelObject) return
    rec.modelSig = sig

    const token = ++rec.loadToken
    this.ensurePlaceholder(rec)
    void this.loadModel(rec, token, ownerDoc, uploadId, m.spFit, assetChildren)
  }

  private async loadModel(
    rec: NodeRecord,
    token: number,
    ownerDoc: string,
    uploadId: string,
    fit: SpatialMeta['spFit'],
    assetChildren: readonly AbraTreeEntry[],
  ): Promise<void> {
    const docId = rec.group.userData.docId as string
    try {
      const url = await this.fileApi!.getBlobUrl(ownerDoc, uploadId)
      if (token !== rec.loadToken || !url) return

      // Pre-resolve nested file dependencies (basename → blob url).
      let assetMap: Map<string, string> | undefined
      if (assetChildren.length) {
        assetMap = new Map()
        for (const child of assetChildren) {
          const cm = meta(child)
          if (!cm.spFileUploadId) continue
          const childUrl = await this.fileApi!.getBlobUrl(child.id, cm.spFileUploadId)
          if (childUrl) assetMap.set(child.label, childUrl)
        }
      }
      if (token !== rec.loadToken) return

      const obj = await this.loader.load(url, { assetMap, fit })
      if (token !== rec.loadToken) {
        disposeObject(obj)
        return
      }
      this.clearModel(rec)
      this.removePlaceholder(rec)
      rec.group.add(obj)
      rec.modelObject = obj
      if (this.failed.delete(docId)) this.onFailures(this.failed.size)
      const e = this.tree.entry(docId)
      if (e) this.applyOpacity(rec, (e.meta ?? {}) as SpatialMeta)

      // Drive glTF animations (play every clip) so animated models come alive.
      const clips = (obj.animations ?? []) as AnimationClip[]
      if (clips.length) {
        const mixer = new AnimationMixer(obj)
        for (const clip of clips) mixer.clipAction(clip).play()
        rec.mixer = mixer
      }
      this.onInvalidate()
    } catch (err) {
      // Keep the placeholder; a bad/missing model shouldn't kill the scene.
      console.error('[spatial] model load failed', ownerDoc, uploadId, err)
      this.failed.add(docId)
      this.onFailures(this.failed.size)
    }
  }

  private ensurePlaceholder(rec: NodeRecord): void {
    if (rec.placeholder || rec.modelObject) return
    const ph = new LineSegments(
      new EdgesGeometry(new BoxGeometry(0.6, 0.6, 0.6)),
      new LineBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.5 }),
    )
    ph.name = '__placeholder__'
    rec.group.add(ph)
    rec.placeholder = ph
  }

  private removePlaceholder(rec: NodeRecord): void {
    if (!rec.placeholder) return
    rec.placeholder.removeFromParent()
    disposeObject(rec.placeholder)
    rec.placeholder = undefined
  }

  private clearModel(rec: NodeRecord): void {
    if (rec.mixer) {
      rec.mixer.stopAllAction()
      if (rec.modelObject) rec.mixer.uncacheRoot(rec.modelObject)
      rec.mixer = undefined
    }
    if (rec.modelObject) {
      rec.modelObject.removeFromParent()
      disposeObject(rec.modelObject)
      rec.modelObject = undefined
      rec.modelSig = undefined
    }
  }

  /** Advance animation mixers. @returns true if any animation is playing. */
  tick(dt: number): boolean {
    let active = false
    for (const rec of this.records.values()) {
      if (rec.mixer) { rec.mixer.update(dt); active = true }
    }
    return active
  }

  /** Apply spOpacity/visibility to a node's loaded materials. */
  private applyOpacity(rec: NodeRecord, m: SpatialMeta): void {
    if (!rec.modelObject) return
    const opacity = num(m.spOpacity, 100) / 100
    const transparent = opacity < 1
    rec.modelObject.traverse((o) => {
      const mat = (o as Mesh).material as
        | (MeshBasicMaterial & { opacity: number; transparent: boolean })
        | undefined
      if (!mat) return
      const list = Array.isArray(mat) ? mat : [mat]
      for (const mm of list as Array<{ opacity: number; transparent: boolean; needsUpdate: boolean }>) {
        mm.opacity = opacity
        // Toggling `transparent` redefines the material's shader program —
        // without `needsUpdate` three keeps the opaque program and the new
        // opacity has no visible effect. Only flip it when it actually changed
        // (needsUpdate forces a recompile).
        if (mm.transparent !== transparent) { mm.transparent = transparent; mm.needsUpdate = true }
      }
    })
  }

  private disposeRecord(rec: NodeRecord): void {
    rec.loadToken++
    this.clearModel(rec)
    this.removePlaceholder(rec)
    this.clearLight(rec)
  }

  /** Object3D for a doc id, for picking/selection. */
  groupFor(id: string): Object3D | undefined {
    return this.records.get(id)?.group
  }

  /** docId owning an Object3D hit by a raycast (walks up to a node group). */
  docIdForObject(obj: Object3D | null): string | null {
    let o: Object3D | null = obj
    while (o) {
      if (o.userData?.docId) return o.userData.docId as string
      o = o.parent
    }
    return null
  }

  dispose(): void {
    for (const rec of this.records.values()) {
      rec.group.removeFromParent()
      this.disposeRecord(rec)
    }
    this.records.clear()
    this.fallback.removeFromParent()
  }
}

/** Recursively dispose geometries/materials under an object. */
function disposeObject(obj: Object3D): void {
  obj.traverse((o) => {
    const mesh = o as Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = (mesh as unknown as { material?: unknown }).material
    if (Array.isArray(mat)) for (const mm of mat) (mm as MeshBasicMaterial)?.dispose?.()
    else (mat as MeshBasicMaterial | undefined)?.dispose?.()
  })
}

/** re-exported for callers that need the numeric meta coercion. */
export { num }
