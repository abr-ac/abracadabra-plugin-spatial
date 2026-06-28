<script setup lang="ts">
/**
 * Spatial page-type renderer — pure Three.js. Thin Vue shell over an imperative
 * engine: it mounts the canvas, owns a DOM HUD (toolbar / inspector / presence),
 * and bridges document + awareness state into the scene. One renderer, one
 * on-demand render loop; the scene graph is reconciled from the document tree.
 *
 * Every object/light/group is a document; geometry comes only from GLB/GLTF
 * files attached to documents (no primitives). Cameras: damped Orbit ⇄ FPS
 * NoClip free-fly. Awareness: smooth remote cameras, selections, pointers,
 * follow. Fully offline (decoders inlined). Follows the built-in renderer
 * conventions — view state is awareness/local, transforms are document edits,
 * permissions gate every write, double-click opens the document's node panel.
 */
import { ref, shallowRef, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import type * as Y from 'yjs'
import { GridHelper, Vector3, Box3, Mesh, PlaneGeometry, ShadowMaterial, type Object3D } from 'three'
import type { AbraTreeApi, AbraFileApi, AbraTreeEntry } from '@abraca/plugin'
import { SceneEngine } from '../three/SceneEngine.ts'
import { CameraController, type CameraModeKind } from '../three/CameraController.ts'
import { NodeGraph } from '../three/NodeGraph.ts'
import { ModelLoader } from '../three/ModelLoader.ts'
import { Picking } from '../three/Picking.ts'
import { Presence, type RemoteUser } from '../three/Presence.ts'
import { SelectionHighlight } from '../three/Selection.ts'
import { Gizmo, type GizmoMode } from '../three/Gizmo.ts'
import { boxOfAll, boxOfIds } from '../three/Framing.ts'
import { loadEnvironment } from '../three/Environment.ts'
import {
  AW_CAMERA, AW_SELECTED, AW_POINTER, num,
  type SpatialMeta, type SpatialSceneMeta, type CameraAwareness, type PointerAwareness,
} from '../scene.ts'

interface AwarenessLike {
  getStates(): Map<number, Record<string, unknown>>
  getLocalState?(): Record<string, unknown> | null
  setLocalState?(s: Record<string, unknown>): void
  setLocalStateField?(field: string, value: unknown): void
  on(e: string, cb: () => void): void
  off(e: string, cb: () => void): void
  clientID: number
}
interface PageProvider {
  document: Y.Doc
  awareness?: AwarenessLike | null
  client?: { upload(docId: string, file: File | Blob, filename?: string): Promise<{ id?: string, uploadId?: string }> }
}

const props = withDefaults(
  defineProps<{
    docId: string
    childProvider: PageProvider
    docLabel?: string
    editable?: boolean
    followingUser?: string | null
    treeApi?: AbraTreeApi
    fileApi?: AbraFileApi
    onOpenNode?: (docId: string) => void
    onFollow?: (publicKey: string) => void
    onImportFiles?: (files: File[], parentId: string | null) => Promise<string[]>
  }>(),
  { editable: true, followingUser: null },
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const dropActive = ref(false)
const selectedIds = reactive(new Set<string>())
const remoteUsers = shallowRef<RemoteUser[]>([])
const sceneMeta = ref<SpatialSceneMeta>({})
const cameraMode = ref<CameraModeKind>('orbit')
const flySpeed = ref(5)
const gizmoMode = ref<GizmoMode>('translate')
const gizmoSpace = ref<'world' | 'local'>('local')
const loadingCount = ref(0)
const failedCount = ref(0)
const objectCount = ref(0)
const fpsLocked = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

let engine: SceneEngine | null = null
let cam: CameraController | null = null
let graph: NodeGraph | null = null
let loader: ModelLoader | null = null
let picking: Picking | null = null
let presence: Presence | null = null
let selection: SelectionHighlight | null = null
let gizmo: Gizmo | null = null
let grid: GridHelper | null = null
let ground: Mesh | null = null
let unsubscribeTree: (() => void) | null = null
let awChange: (() => void) | null = null
let reconcileTimer: ReturnType<typeof setTimeout> | null = null
let lastAppliedCamT = 0

const aw = (): AwarenessLike | null => props.childProvider.awareness ?? null
const tree = (): AbraTreeApi | null => props.treeApi ?? null
const MODE_KEY = `abra-spatial:mode:${props.docId}`
const CAM_KEY = `abra-spatial:cam:${props.docId}`

// ── Inspector model ───────────────────────────────────────────────────────────
const selectedEntry = computed<AbraTreeEntry | null>(() => {
  if (selectedIds.size !== 1) return null
  return tree()?.entry([...selectedIds][0]!) ?? null
})
const selMeta = computed<SpatialMeta>(() => (selectedEntry.value?.meta ?? {}) as SpatialMeta)
function setSelMeta(patch: Partial<SpatialMeta>): void {
  const id = selectedEntry.value?.id
  if (id && props.editable) { tree()?.updateMeta(id, patch as Record<string, unknown>); engine?.invalidate() }
}

// ── Reconcile (debounced) ─────────────────────────────────────────────────────
function scheduleReconcile(): void {
  if (reconcileTimer) return
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    graph?.reconcile()
    syncSceneMeta()
    selection?.set(selectedIds)
    syncGizmo()
    refreshObjectCount()
    engine?.invalidate()
  }, 16)
}

// Track how many scene objects exist (drives the empty-state hint). Counts every
// descendant document except folded file-asset deps.
function refreshObjectCount(): void {
  const t = tree()
  if (!t) { objectCount.value = 0; return }
  objectCount.value = t.descendantsOf(t.rootId).filter((e) => !(e.meta as SpatialMeta | undefined)?.spFileUploadId).length
}

let envSig = ''
function syncSceneMeta(): void {
  const t = tree()
  if (!t || !engine) return
  const m = (t.entry(t.rootId)?.meta ?? {}) as SpatialSceneMeta
  sceneMeta.value = m
  const shadows = m.spShadows !== false
  if (grid) grid.visible = m.spGridVisible !== false
  if (ground) ground.visible = shadows && m.spGround !== false
  engine.setShadows(shadows)
  // Skip solid background when the environment is the skybox.
  if (!(m.spEnvUploadId && m.spEnvAsBackground)) engine.setBackground(m.spBackground ?? null)

  // Environment (HDR/EXR) — load once per change, via the offline blob cache.
  const sig = m.spEnvUploadId ?? ''
  if (sig !== envSig) {
    envSig = sig
    if (!sig) engine.setEnvironment(null)
    else void loadEnv(t.rootId, sig, m.spEnvType, !!m.spEnvAsBackground)
  }
}
async function loadEnv(
  docId: string, uploadId: string,
  type: SpatialSceneMeta['spEnvType'], asBackground: boolean,
): Promise<void> {
  if (!props.fileApi || !engine) return
  const url = await props.fileApi.getBlobUrl(docId, uploadId)
  if (!url || envSig !== uploadId) return
  try {
    const kind = type ?? (/\.exr($|\?)/i.test(url) ? 'exr' : 'hdr')
    engine.setEnvironment(await loadEnvironment(url, kind), asBackground)
  } catch (err) { console.error('[spatial] environment load failed', err) }
}

// ── Awareness ─────────────────────────────────────────────────────────────────
function readRemote(): void {
  const a = aw()
  if (!a) return
  const out: RemoteUser[] = []
  for (const [cid, st] of a.getStates()) {
    if (cid === a.clientID) continue
    const user = (st.user ?? {}) as { name?: string, color?: string, publicKey?: string }
    const camAw = st[AW_CAMERA] as CameraAwareness | undefined
    const sel = st[AW_SELECTED] as { ids?: string[] } | undefined
    const ptr = st[AW_POINTER] as PointerAwareness | undefined
    out.push({
      key: user.publicKey || String(cid),
      name: user.name || 'User',
      color: user.color || '#8b5cf6',
      camera: camAw ? { position: camAw.position, target: camAw.target } : undefined,
      selected: sel?.ids ?? [],
      pointer: ptr?.point ?? null,
    })
  }
  remoteUsers.value = out
  presence?.update(out)
  engine?.invalidate()

  // Follow-mode camera (timestamp-guarded, like the built-in renderer).
  if (props.followingUser) {
    const followed = a.getStates()
    for (const [cid, st] of followed) {
      if (cid === a.clientID) continue
      const u = (st.user ?? {}) as { publicKey?: string }
      if (u.publicKey !== props.followingUser) continue
      const c = st[AW_CAMERA] as CameraAwareness | undefined
      if (c && c.timestamp > lastAppliedCamT) { lastAppliedCamT = c.timestamp; cam?.applyRemote(c) }
    }
  }
}
function writeAwareness(field: string, value: unknown): void {
  const a = aw()
  if (!a) return
  if (a.setLocalStateField) a.setLocalStateField(field, value)
  else if (a.setLocalState) a.setLocalState({ ...(a.getLocalState?.() ?? {}), [field]: value })
}
function broadcastSelection(): void { writeAwareness(AW_SELECTED, { ids: [...selectedIds] }) }

// ── Selection ─────────────────────────────────────────────────────────────────
function onSelect(docId: string | null, additive: boolean): void {
  if (!additive) selectedIds.clear()
  if (docId) {
    if (additive && selectedIds.has(docId)) selectedIds.delete(docId)
    else selectedIds.add(docId)
  }
  selection?.set(selectedIds)
  broadcastSelection()
  syncGizmo()
  engine?.invalidate()
}
function syncGizmo(): void {
  if (!gizmo) return
  if (!props.editable || props.followingUser || cameraMode.value !== 'orbit') { gizmo.attach([]); return }
  const targets: { id: string, obj: Object3D }[] = []
  for (const id of selectedIds) { const o = graph?.groupFor(id); if (o) targets.push({ id, obj: o }) }
  gizmo.attach(targets)
}
function focusSelected(): void {
  const id = selectedEntry.value?.id
  const g = id ? graph?.groupFor(id) : null
  if (g && cam) { cam.focusOn(g.getWorldPosition(new Vector3())); engine?.invalidate() }
}
function frameAll(): void {
  if (!engine || !cam) return
  cam.frameBox(boxOfAll(engine.scene))
  engine.invalidate()
}
function frameSelection(): void {
  if (!cam) return
  const box: Box3 = selectedIds.size ? boxOfIds(graph!, selectedIds) : boxOfAll(engine!.scene)
  cam.frameBox(box)
  engine?.invalidate()
}

// ── Scene toggles + camera mode ───────────────────────────────────────────────
function toggleGrid(): void { tree()?.updateMeta(tree()!.rootId, { spGridVisible: sceneMeta.value.spGridVisible === false }) }
function toggleShadows(): void { tree()?.updateMeta(tree()!.rootId, { spShadows: sceneMeta.value.spShadows === false }) }
function setMode(kind: CameraModeKind): void {
  cameraMode.value = kind
  cam?.setMode(kind)
  syncGizmo() // gizmo only shows in orbit
  if (kind !== 'orbit') onHover(null)
  try { localStorage.setItem(MODE_KEY, kind) } catch { /* ignore */ }
  engine?.invalidate()
}
function setGizmoMode(mode: GizmoMode): void { gizmoMode.value = mode; gizmo?.setMode(mode); engine?.invalidate() }
function toggleGizmoSpace(): void {
  gizmoSpace.value = gizmoSpace.value === 'local' ? 'world' : 'local'
  gizmo?.setUserSpace(gizmoSpace.value)
  engine?.invalidate()
}

// Hover highlight + cursor.
function onHover(id: string | null): void {
  selection?.setHover(id)
  if (canvasEl.value) canvasEl.value.style.cursor = id ? 'pointer' : ''
  engine?.invalidate()
}

// Duplicate the selection (shares the model upload; offset so copies are visible).
function duplicateSelected(): void {
  const t = tree()
  if (!t || !props.editable || !selectedIds.size) return
  const newIds: string[] = []
  for (const id of [...selectedIds]) {
    const e = t.entry(id)
    if (!e) continue
    const m = { ...(e.meta ?? {}) } as Record<string, unknown>
    m.spX = (typeof m.spX === 'number' ? m.spX : 0) + 0.5
    m.spZ = (typeof m.spZ === 'number' ? m.spZ : 0) + 0.5
    newIds.push(t.createChild(e.parentId === t.rootId ? null : e.parentId, { label: `${e.label} copy`, type: e.type, meta: m }))
  }
  selectedIds.clear()
  for (const id of newIds) selectedIds.add(id)
  onSelect(null, true) // refresh highlight/gizmo/awareness without changing the set
}

// ── Add / delete objects ──────────────────────────────────────────────────────
function addLight(): void {
  const t = tree()
  if (!t || !props.editable) return
  const id = t.createChild(null, { label: 'Light', meta: { spKind: 'light', spLightType: 'directional', spX: 3, spY: 5, spZ: 2, spIntensity: 2 } as Record<string, unknown> })
  selectOnly(id)
}
function addGroup(): void {
  const t = tree()
  if (!t || !props.editable) return
  selectOnly(t.createChild(null, { label: 'Group', meta: { spKind: 'group' } as Record<string, unknown> }))
}
function deleteSelected(): void {
  const t = tree()
  if (!t || !props.editable) return
  for (const id of [...selectedIds]) t.deleteEntry(id)
  selectedIds.clear()
  onSelect(null, false)
}
function selectOnly(id: string): void { selectedIds.clear(); selectedIds.add(id); onSelect(id, false) }

// ── Grouping ──────────────────────────────────────────────────────────────────
// Reparent a node under `newParentId` while preserving its WORLD position. Groups
// created here carry identity rotation/scale, so position-only is exact for them
// (a manually-rotated parent would only be approximate — acceptable for v1).
function reparentPreservingWorld(id: string, newParentId: string | null, worldPos: Vector3): void {
  const t = tree(); if (!t) return
  const base = new Vector3()
  if (newParentId) graph?.groupFor(newParentId)?.getWorldPosition(base)
  const local = worldPos.clone().sub(base)
  t.updateMeta(id, { spX: local.x, spY: local.y, spZ: local.z })
  t.moveEntry(id, newParentId)
}

// Wrap the current selection in a new group at their centroid; each child keeps
// its world position (its local offset is recomputed against the group origin),
// then the group is selected so the gizmo moves the whole set.
function groupSelection(): void {
  const t = tree()
  if (!t || !props.editable || selectedIds.size < 1) return
  engine?.scene.updateMatrixWorld(true)
  const ids = [...selectedIds]
  const worlds = ids.map((id) => graph?.groupFor(id)?.getWorldPosition(new Vector3()) ?? new Vector3())
  const centroid = worlds.reduce((a, v) => a.add(v), new Vector3()).multiplyScalar(1 / ids.length)
  const groupId = t.createChild(null, {
    label: 'Group',
    meta: { spKind: 'group', spX: centroid.x, spY: centroid.y, spZ: centroid.z } as Record<string, unknown>,
  })
  ids.forEach((id, i) => {
    const local = worlds[i]!.clone().sub(centroid)
    t.updateMeta(id, { spX: local.x, spY: local.y, spZ: local.z })
    t.moveEntry(id, groupId)
  })
  selectOnly(groupId)
}

// Dissolve selected group(s): lift their children to the group's parent (keeping
// world position), then remove the now-empty group. Non-group selections ignored.
function ungroupSelection(): void {
  const t = tree()
  if (!t || !props.editable) return
  engine?.scene.updateMatrixWorld(true)
  const groups = [...selectedIds].filter((id) => (t.entry(id)?.meta as SpatialMeta | undefined)?.spKind === 'group')
  if (!groups.length) return
  const lifted: string[] = []
  for (const gid of groups) {
    const e = t.entry(gid); if (!e) continue
    const newParent = e.parentId === t.rootId ? null : e.parentId
    for (const c of t.childrenOf(gid)) {
      const world = graph?.groupFor(c.id)?.getWorldPosition(new Vector3()) ?? new Vector3()
      reparentPreservingWorld(c.id, newParent, world)
      lifted.push(c.id)
    }
    t.deleteEntry(gid) // now childless
  }
  selectedIds.clear()
  for (const id of lifted) selectedIds.add(id)
  onSelect(null, true) // refresh highlight/gizmo without changing the set
}

// ── Model import (drop / picker) ──────────────────────────────────────────────
// A drop delegates to the HOST importer (props.onImportFiles): each GLB becomes a
// child document with a file node inside — exactly what a document-tree drop
// produces, offline-first — and we then place the returned model at the drop
// point. Falls back to a direct page-provider upload on hosts that don't expose
// the importer.
const GLB_RE = /\.(glb|gltf)$/i

async function importFiles(files: FileList | File[], at: Vector3 | null): Promise<void> {
  if (!props.editable) return
  const models = Array.from(files).filter((f) => GLB_RE.test(f.name))
  if (!models.length) return
  loadingCount.value++
  try {
    if (props.onImportFiles) {
      placeImported(await props.onImportFiles(models, props.docId), at)
    } else {
      await importDirect(models, at)
    }
  } catch (err) {
    console.error('[spatial] import failed', err)
  } finally {
    loadingCount.value--
  }
}

// Position freshly-imported models around the drop point (golden-angle spread so
// multiple files don't stack). The host already tagged each GLB with
// spModelUploadId + a default position; we only override the position so it lands
// where the cursor released, and select the last one.
function placeImported(ids: string[], at: Vector3 | null): void {
  const t = tree()
  if (!t || !ids.length) return
  const base = at ?? new Vector3(0, 0, 0)
  let i = 0
  let last: string | null = null
  for (const id of ids) {
    const e = t.entry(id)
    if (!e || !(e.meta as SpatialMeta | undefined)?.spModelUploadId) continue
    const angle = i * 2.39996323 // golden angle
    const radius = i === 0 ? 0 : 0.7 + i * 0.25
    t.updateMeta(id, {
      spKind: 'model',
      spX: base.x + Math.cos(angle) * radius,
      spY: base.y,
      spZ: base.z + Math.sin(angle) * radius,
    })
    last = id
    i++
  }
  if (last) selectOnly(last)
  engine?.invalidate()
}

// Fallback for hosts without onImportFiles: upload straight through the page
// provider's client (server-only — no offline blob, no fileBlock body). Removes
// the orphan entry if the upload fails so the scene never strands a placeholder.
async function importDirect(models: File[], at: Vector3 | null): Promise<void> {
  const t = tree()
  const client = props.childProvider.client
  if (!t || !client) return
  const base = at ?? new Vector3(0, 0, 0)
  let i = 0
  for (const file of models) {
    const label = file.name.replace(GLB_RE, '')
    const angle = i * 2.39996323
    const radius = i === 0 ? 0 : 0.7 + i * 0.25
    const id = t.createChild(null, {
      label,
      meta: { spKind: 'model', spX: base.x + Math.cos(angle) * radius, spY: base.y, spZ: base.z + Math.sin(angle) * radius } as Record<string, unknown>,
    })
    try {
      const up = await client.upload(id, file, file.name)
      const uploadId = up.id ?? up.uploadId
      if (!uploadId) throw new Error('upload returned no id')
      t.updateMeta(id, { spModelUploadId: uploadId, spModelDocId: id })
      selectOnly(id)
    } catch (err) { console.error('[spatial] upload failed', file.name, err); t.deleteEntry(id) }
    i++
  }
}

function onDrop(ev: DragEvent): void {
  ev.preventDefault(); dropActive.value = false
  const files = ev.dataTransfer?.files
  if (!files?.length) return
  const at = picking?.groundAt(ev.clientX, ev.clientY) ?? null
  void importFiles(files, at)
}
function onPickFiles(ev: Event): void {
  const input = ev.target as HTMLInputElement
  if (input.files?.length) void importFiles(input.files, null)
  input.value = ''
}

// ── Global hotkeys (document-scope, gated to not fight inputs) ─────────────────
function onHotkey(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (e.code === 'KeyD' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); duplicateSelected(); return }
  if (e.code === 'KeyG' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return }
  switch (e.code) {
    case 'Tab': e.preventDefault(); setMode(cameraMode.value === 'orbit' ? 'noclip' : 'orbit'); break
    case 'KeyF': if (cameraMode.value === 'orbit') focusSelected(); break
    case 'KeyG': if (e.shiftKey) break; frameAll(); break
    case 'KeyR': if (props.editable && cameraMode.value === 'orbit') setGizmoMode('rotate'); break
    case 'KeyE': if (props.editable && cameraMode.value === 'orbit') setGizmoMode('scale'); break
    case 'KeyT': if (props.editable && cameraMode.value === 'orbit') setGizmoMode('translate'); break
    case 'Delete': case 'Backspace': if (props.editable && selectedIds.size) { e.preventDefault(); deleteSelected() } break
    case 'Escape': if (selectedIds.size) onSelect(null, false); break
    case 'ShiftLeft': case 'ShiftRight': if (cameraMode.value === 'orbit') gizmo?.setSnap(true); break
  }
}
function onHotkeyUp(e: KeyboardEvent): void {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') gizmo?.setSnap(false)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  const canvas = canvasEl.value!
  engine = new SceneEngine({ canvas, onFrame })
  cam = new CameraController(canvas, onCameraChange)
  engine.setCamera(cam.camera)
  try { const saved = localStorage.getItem(MODE_KEY) as CameraModeKind | null; if (saved) { cameraMode.value = saved; cam.setMode(saved) } } catch { /* ignore */ }
  // Restore the last view for this scene (local preference, not a doc edit).
  try { const v = localStorage.getItem(CAM_KEY); if (v) cam.restore(JSON.parse(v)) } catch { /* ignore */ }

  grid = new GridHelper(40, 40, 0x444466, 0x222233)
  ;(grid.material as { opacity?: number, transparent?: boolean }).opacity = 0.4
  ;(grid.material as { transparent?: boolean }).transparent = true
  engine.scene.add(grid)

  // Invisible shadow-catching ground so cast shadows land on something.
  ground = new Mesh(new PlaneGeometry(200, 200), new ShadowMaterial({ opacity: 0.28 }))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  ground.name = '__ground__'
  engine.scene.add(ground)

  loader = new ModelLoader(engine.renderer)
  graph = new NodeGraph(
    engine.scene, props.treeApi!, props.fileApi, loader,
    () => engine?.invalidate(),
    (n) => { failedCount.value = n },
  )
  presence = new Presence(engine.scene, graph)
  selection = new SelectionHighlight(engine.scene, graph)
  gizmo = new Gizmo({
    camera: cam.camera, dom: canvas, scene: engine.scene, tree: props.treeApi!,
    onDraggingChanged: (d) => { draggingGizmo = d; cam?.setInteractive(!d); engine?.invalidate() },
    onInvalidate: () => engine?.invalidate(),
  })
  gizmo.setMode(gizmoMode.value)

  gizmo.setUserSpace(gizmoSpace.value)

  picking = new Picking({
    dom: canvas, camera: cam.camera, root: engine.scene, graph,
    onSelect,
    onPointer: broadcastPointer,
    onHover,
    onOpenNode: (id) => props.onOpenNode?.(id),
    onFollowUser: (key) => props.onFollow?.(key),
    isInteractive: () => cameraMode.value === 'orbit' && !props.followingUser,
    isPointerLocked: () => cam?.pointerLocked ?? false,
  })

  engine.start()
  graph.reconcile(); syncSceneMeta(); selection.set(selectedIds); refreshObjectCount()
  unsubscribeTree = tree()?.subscribe(scheduleReconcile) ?? null

  const a = aw()
  if (a) { awChange = () => readRemote(); a.on('change', awChange); readRemote() }
  globalThis.addEventListener('keydown', onHotkey)
  globalThis.addEventListener('keyup', onHotkeyUp)
})

let lastFlyPointer = 0
function broadcastPointer(pt: Vector3 | null): void {
  writeAwareness(AW_POINTER, { point: pt ? (pt.toArray() as [number, number, number]) : null, timestamp: Date.now() } as PointerAwareness)
}

// Camera change → broadcast to awareness + throttled local-view save.
let lastCamSave = 0
function onCameraChange(c: CameraAwareness): void {
  writeAwareness(AW_CAMERA, c)
  const now = Date.now()
  if (now - lastCamSave > 700 && cam) {
    lastCamSave = now
    try { localStorage.setItem(CAM_KEY, JSON.stringify(cam.serialize())) } catch { /* ignore */ }
  }
}

let draggingGizmo = false

// Per-frame: integrate camera + presence/selection smoothing; return whether to render.
function onFrame(dt: number): boolean {
  const camMoved = cam?.update(dt) ?? false
  if (cameraMode.value === 'noclip') {
    flySpeed.value = cam?.speed ?? flySpeed.value
    const locked = cam?.pointerLocked ?? false
    if (locked !== fpsLocked.value) fpsLocked.value = locked
    // Pointer-lock pins the cursor, so pointermove stops firing — broadcast the
    // look-at point from screen centre instead (throttled).
    if (locked) {
      const now = Date.now()
      if (now - lastFlyPointer > 80) { lastFlyPointer = now; broadcastPointer(picking?.pointerHit() ?? null) }
    }
  }
  const presenceMoved = presence?.tick(dt) ?? false
  const animActive = graph?.tick(dt) ?? false
  selection?.tick()
  return camMoved || presenceMoved || animActive || draggingGizmo || loadingCount.value > 0
}

watch(() => props.followingUser, (v) => { cam?.setFollowing(!!v); syncGizmo(); engine?.invalidate() })

onBeforeUnmount(() => {
  if (reconcileTimer) clearTimeout(reconcileTimer)
  const a = aw(); if (a && awChange) a.off('change', awChange)
  globalThis.removeEventListener('keydown', onHotkey)
  globalThis.removeEventListener('keyup', onHotkeyUp)
  unsubscribeTree?.()
  gizmo?.dispose(); picking?.dispose(); presence?.dispose(); selection?.dispose()
  graph?.dispose(); loader?.dispose(); cam?.dispose(); engine?.dispose()
})
</script>

<template>
  <div
    class="abra-spatial"
    @dragover.prevent="editable && (dropActive = true)"
    @dragleave="dropActive = false"
    @drop="onDrop"
    @pointerleave="onHover(null)"
  >
    <canvas ref="canvasEl" class="abra-spatial__canvas" />

    <!-- Toolbar -->
    <div class="abra-spatial__toolbar">
      <div class="seg">
        <button type="button" :class="{ on: cameraMode === 'orbit' }" title="Orbit (Tab)" @click="setMode('orbit')">Orbit</button>
        <button type="button" :class="{ on: cameraMode === 'noclip' }" title="Free-fly / NoClip (Tab) — WASD + mouse, Space/Ctrl up·down, Shift sprint" @click="setMode('noclip')">Fly</button>
      </div>
      <template v-if="editable && cameraMode === 'orbit'">
        <div class="seg">
          <button type="button" :class="{ on: gizmoMode === 'translate' }" title="Move (T)" @click="setGizmoMode('translate')">Move</button>
          <button type="button" :class="{ on: gizmoMode === 'rotate' }" title="Rotate (R)" @click="setGizmoMode('rotate')">Rot</button>
          <button type="button" :class="{ on: gizmoMode === 'scale' }" title="Scale (E)" @click="setGizmoMode('scale')">Scale</button>
        </div>
        <button type="button" title="Gizmo space (hold Shift to snap)" @click="toggleGizmoSpace">{{ gizmoSpace === 'local' ? 'Local' : 'World' }}</button>
      </template>
      <button type="button" :class="{ on: sceneMeta.spGridVisible !== false }" @click="toggleGrid">Grid</button>
      <button type="button" :class="{ on: sceneMeta.spShadows !== false }" @click="toggleShadows">Shadows</button>
      <button type="button" title="Frame all (G)" @click="frameAll">Frame</button>
      <template v-if="editable">
        <button type="button" @click="fileInput?.click()">+ Model</button>
        <button type="button" @click="addLight">+ Light</button>
        <button type="button" @click="addGroup">+ Group</button>
      </template>
      <input ref="fileInput" type="file" accept=".glb,.gltf" multiple style="display:none" @change="onPickFiles">
    </div>

    <!-- Fly HUD -->
    <div v-if="cameraMode === 'noclip'" class="abra-spatial__fly">
      <span>WASD · Space/Ctrl · Shift sprint</span>
      <span class="speed">{{ flySpeed.toFixed(1) }} m/s</span>
      <span v-if="!fpsLocked" class="hint">click to look</span>
    </div>

    <!-- Presence -->
    <div v-if="remoteUsers.length" class="abra-spatial__presence">
      <button
        v-for="u in remoteUsers" :key="u.key" type="button"
        class="dot" :style="{ background: u.color }" :title="`Follow ${u.name}`"
        @click="onFollow?.(u.key)"
      />
    </div>

    <!-- Loading / failures -->
    <div v-if="loadingCount > 0" class="abra-spatial__loading">Loading {{ loadingCount }} model{{ loadingCount > 1 ? 's' : '' }}…</div>
    <div v-else-if="failedCount > 0" class="abra-spatial__loading err">{{ failedCount }} model{{ failedCount > 1 ? 's' : '' }} failed to load</div>

    <!-- Multi-select badge -->
    <div v-if="selectedIds.size > 1" class="abra-spatial__inspector">
      <div class="title">{{ selectedIds.size }} selected</div>
      <div class="kind">drag the gizmo to move them together</div>
      <div class="actions">
        <button type="button" @click="frameSelection">Frame</button>
        <button v-if="editable" type="button" title="Group into a new container (⌘/Ctrl+G)" @click="groupSelection">Group</button>
        <button v-if="editable" type="button" class="danger" @click="deleteSelected">Delete</button>
      </div>
    </div>

    <!-- Inspector -->
    <div v-if="selectedEntry" class="abra-spatial__inspector">
      <div class="title">{{ selectedEntry.label }}</div>
      <div class="kind">{{ selMeta.spKind ?? 'model' }}</div>
      <template v-if="editable">
        <div class="row3">
          <label>X<input type="number" step="0.1" :value="num(selMeta.spX, 0)" @input="setSelMeta({ spX: +($event.target as HTMLInputElement).value })"></label>
          <label>Y<input type="number" step="0.1" :value="num(selMeta.spY, 0)" @input="setSelMeta({ spY: +($event.target as HTMLInputElement).value })"></label>
          <label>Z<input type="number" step="0.1" :value="num(selMeta.spZ, 0)" @input="setSelMeta({ spZ: +($event.target as HTMLInputElement).value })"></label>
        </div>
        <div class="row3">
          <label>rX<input type="number" step="1" :value="num(selMeta.spRX, 0)" @input="setSelMeta({ spRX: +($event.target as HTMLInputElement).value })"></label>
          <label>rY<input type="number" step="1" :value="num(selMeta.spRY, 0)" @input="setSelMeta({ spRY: +($event.target as HTMLInputElement).value })"></label>
          <label>rZ<input type="number" step="1" :value="num(selMeta.spRZ, 0)" @input="setSelMeta({ spRZ: +($event.target as HTMLInputElement).value })"></label>
        </div>
        <div class="row3">
          <label>sX<input type="number" step="0.1" :value="num(selMeta.spSX, 1)" @input="setSelMeta({ spSX: +($event.target as HTMLInputElement).value })"></label>
          <label>sY<input type="number" step="0.1" :value="num(selMeta.spSY, 1)" @input="setSelMeta({ spSY: +($event.target as HTMLInputElement).value })"></label>
          <label>sZ<input type="number" step="0.1" :value="num(selMeta.spSZ, 1)" @input="setSelMeta({ spSZ: +($event.target as HTMLInputElement).value })"></label>
        </div>
        <template v-if="selMeta.spKind === 'light'">
          <label class="wide">Type
            <select :value="selMeta.spLightType ?? 'directional'" @change="setSelMeta({ spLightType: ($event.target as HTMLSelectElement).value as SpatialMeta['spLightType'] })">
              <option>directional</option><option>point</option><option>spot</option><option>ambient</option><option>hemisphere</option>
            </select>
          </label>
          <label class="wide">Intensity<input type="number" step="0.1" :value="num(selMeta.spIntensity, 1)" @input="setSelMeta({ spIntensity: +($event.target as HTMLInputElement).value })"></label>
          <label class="wide">Color<input type="color" :value="selMeta.color ?? '#ffffff'" @input="setSelMeta({ color: ($event.target as HTMLInputElement).value })"></label>
          <template v-if="selMeta.spLightType === 'point' || selMeta.spLightType === 'spot'">
            <label class="wide">Distance<input type="number" step="0.5" :value="num(selMeta.spDistance, 0)" @input="setSelMeta({ spDistance: +($event.target as HTMLInputElement).value })"></label>
          </template>
          <template v-if="selMeta.spLightType === 'spot'">
            <label class="wide">Angle<input type="number" step="1" :value="num(selMeta.spAngle, 30)" @input="setSelMeta({ spAngle: +($event.target as HTMLInputElement).value })"></label>
            <label class="wide">Penumbra<input type="range" min="0" max="100" :value="num(selMeta.spPenumbra, 0.1) * 100" @input="setSelMeta({ spPenumbra: +($event.target as HTMLInputElement).value / 100 })"></label>
          </template>
          <label class="wide chk">Shadow<input type="checkbox" :checked="!!selMeta.spCastShadow" @change="setSelMeta({ spCastShadow: ($event.target as HTMLInputElement).checked })"></label>
        </template>
        <template v-else-if="selMeta.spKind !== 'group'">
          <label class="wide">Opacity<input type="range" min="0" max="100" :value="num(selMeta.spOpacity, 100)" @input="setSelMeta({ spOpacity: +($event.target as HTMLInputElement).value })"></label>
          <label class="wide chk">Fit unit<input type="checkbox" :checked="selMeta.spFit === 'unit'" @change="setSelMeta({ spFit: ($event.target as HTMLInputElement).checked ? 'unit' : 'raw' })"></label>
        </template>
      </template>
      <div class="actions">
        <button type="button" @click="frameSelection">Frame</button>
        <button v-if="onOpenNode" type="button" @click="onOpenNode(selectedEntry.id)">Open</button>
        <button v-if="editable" type="button" title="Duplicate (⌘/Ctrl+D)" @click="duplicateSelected">Dup</button>
        <button v-if="editable && selMeta.spKind === 'group'" type="button" title="Ungroup — lift children out (⌘/Ctrl+Shift+G)" @click="ungroupSelection">Ungroup</button>
        <button v-if="editable" type="button" class="danger" @click="deleteSelected">Delete</button>
      </div>
    </div>

    <!-- First-run empty state — make it obvious how to add the first object. -->
    <div v-if="objectCount === 0 && !dropActive" class="abra-spatial__empty">
      <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
      </svg>
      <div class="headline">Empty scene</div>
      <div class="sub">
        Drop a <strong>.glb</strong> / <strong>.gltf</strong> model here<template v-if="editable"> — or use <strong>+ Model</strong> above</template>
      </div>
    </div>

    <div v-if="dropActive" class="abra-spatial__drop">Drop GLB / GLTF to add a model</div>
  </div>
</template>

<style scoped>
.abra-spatial { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--ui-bg); color: var(--ui-text); }
.abra-spatial__canvas { display: block; width: 100%; height: 100%; outline: none; }

/* Floating glass panels share one surface treatment so the HUD reads as one UI
   and tracks the app's light/dark palette. */
.abra-spatial__toolbar { position: absolute; top: 12px; left: 12px; display: flex; gap: 6px; flex-wrap: wrap; max-width: calc(100% - 24px); }
.abra-spatial__toolbar .seg { display: flex; border-radius: var(--ui-radius, 6px); overflow: hidden; border: 1px solid var(--ui-border); }
.abra-spatial__toolbar .seg button { border: 0; border-right: 1px solid var(--ui-border); border-radius: 0; }
.abra-spatial__toolbar .seg button:last-child { border-right: 0; }
.abra-spatial__toolbar button {
  font-size: 12px; font-weight: 500; padding: 5px 11px; border-radius: var(--ui-radius, 6px);
  background: color-mix(in oklab, var(--ui-bg-elevated) 80%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  color: var(--ui-text-toned); border: 1px solid var(--ui-border);
  cursor: pointer; transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.abra-spatial__toolbar button:hover { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.abra-spatial__toolbar button.on { background: var(--ui-primary); color: var(--ui-bg); border-color: var(--ui-primary); }

.abra-spatial__fly {
  position: absolute; bottom: 12px; left: 12px; display: flex; gap: 10px; align-items: center;
  padding: 6px 12px; border-radius: var(--ui-radius, 6px);
  background: color-mix(in oklab, var(--ui-bg-elevated) 82%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid var(--ui-border); color: var(--ui-text-muted); font-size: 11px;
}
.abra-spatial__fly .speed { color: var(--ui-primary); font-variant-numeric: tabular-nums; }
.abra-spatial__fly .hint { color: var(--ui-text-dimmed); }

.abra-spatial__presence { position: absolute; top: 12px; right: 12px; display: flex; gap: 4px; }
.abra-spatial__presence .dot { width: 14px; height: 14px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; box-shadow: 0 0 0 2px var(--ui-bg); }

.abra-spatial__loading {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  padding: 5px 12px; border-radius: var(--ui-radius, 6px);
  background: color-mix(in oklab, var(--ui-bg-elevated) 82%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid var(--ui-border); color: var(--ui-primary); font-size: 11px;
}
.abra-spatial__loading.err { color: var(--ui-color-error-500); border-color: color-mix(in oklab, var(--ui-color-error-500) 40%, transparent); }

.abra-spatial__inspector {
  position: absolute; bottom: 12px; right: 12px; width: 216px; padding: 12px 13px;
  background: color-mix(in oklab, var(--ui-bg-elevated) 88%, transparent);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border: 1px solid var(--ui-border); border-radius: calc(var(--ui-radius, 6px) * 1.5);
  color: var(--ui-text); font-size: 12px; display: flex; flex-direction: column; gap: 8px;
  box-shadow: 0 10px 34px rgba(0, 0, 0, .32);
}
.abra-spatial__inspector .title { font-weight: 600; color: var(--ui-text-highlighted); }
.abra-spatial__inspector .kind { color: var(--ui-text-dimmed); text-transform: capitalize; margin-top: -6px; font-size: 11px; }
.abra-spatial__inspector .row3 { display: flex; gap: 6px; }
.abra-spatial__inspector .row3 label { flex: 1; display: flex; flex-direction: column; gap: 3px; font-size: 10px; color: var(--ui-text-muted); }
.abra-spatial__inspector .row3 input { width: 100%; }
.abra-spatial__inspector label.wide { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--ui-text-muted); }
.abra-spatial__inspector label.chk { cursor: pointer; }
.abra-spatial__inspector label.chk input { width: auto; }
.abra-spatial__inspector input, .abra-spatial__inspector select {
  background: var(--ui-bg); border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius, 6px) - 2px); color: var(--ui-text-highlighted); padding: 3px 6px;
}
.abra-spatial__inspector input:focus, .abra-spatial__inspector select:focus { outline: none; border-color: var(--ui-primary); }
.abra-spatial__inspector select { max-width: 116px; }
.abra-spatial__inspector .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.abra-spatial__inspector .actions button { min-width: 56px; }
.abra-spatial__inspector .actions button {
  flex: 1; padding: 5px; border-radius: calc(var(--ui-radius, 6px) - 1px);
  background: var(--ui-primary); color: var(--ui-bg); border: 0; cursor: pointer; font-size: 11px; font-weight: 500;
  transition: filter .12s ease;
}
.abra-spatial__inspector .actions button:hover { filter: brightness(1.08); }
.abra-spatial__inspector .actions button.danger { background: var(--ui-color-error-500); }

.abra-spatial__empty {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 9px; padding: 24px; text-align: center; color: var(--ui-text-dimmed); pointer-events: none;
}
.abra-spatial__empty svg { opacity: 0.65; }
.abra-spatial__empty .headline { font-size: 15px; font-weight: 600; color: var(--ui-text-muted); }
.abra-spatial__empty .sub { font-size: 12px; max-width: 320px; line-height: 1.55; }
.abra-spatial__empty strong { color: var(--ui-text-muted); font-weight: 600; }

.abra-spatial__drop {
  position: absolute; inset: 16px; border: 2px dashed var(--ui-primary); border-radius: calc(var(--ui-radius, 6px) * 2);
  display: flex; align-items: center; justify-content: center;
  color: var(--ui-primary); font-size: 15px; font-weight: 600;
  background: color-mix(in oklab, var(--ui-primary) 12%, transparent); pointer-events: none;
}
</style>
