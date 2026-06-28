/**
 * Standalone dev harness for SpatialRenderer.vue.
 *
 * Mounts the renderer against an in-memory mock host (tree + blob store + stub
 * awareness) so the full model → render → select → move → drop pipeline can be
 * exercised in a browser with NO cou-sh and NO plugin registry. A demo GLB is
 * generated at runtime via GLTFExporter (offline, no external asset), and
 * `onImportFiles` simulates the host importer for dropped files.
 *
 * Run: `npx vite --config vite.dev.config.ts` → opens /dev.html
 */
// @ts-nocheck — dev-only harness; mocks are structurally-typed against the contract.
import { createApp } from 'vue'
import * as Y from 'yjs'
import {
  Mesh, TorusKnotGeometry, MeshStandardMaterial, Group, BoxGeometry, Scene,
} from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import SpatialRenderer from '../src/renderer/SpatialRenderer.vue'

// ── Mock document tree (AbraTreeApi) ────────────────────────────────────────
class MockTree {
  rootId = 'scene-root'
  map = new Map()
  listeners = new Set()
  constructor() {
    this.map.set(this.rootId, { id: this.rootId, label: 'Scene', parentId: null, order: 0, type: 'spatial', meta: {} })
  }
  fire() { for (const l of this.listeners) l() }
  childrenOf(parentId) {
    const target = parentId === null ? this.rootId : parentId
    return [...this.map.values()].filter(e => e.parentId === target).sort((a, b) => a.order - b.order)
  }
  descendantsOf(id) {
    const out = []
    const walk = (pid) => { for (const c of this.childrenOf(pid)) { out.push(c); walk(c.id) } }
    walk(id)
    return out
  }
  entry(id) { return this.map.get(id) ?? null }
  createChild(parentId, init) {
    const id = crypto.randomUUID()
    this.map.set(id, {
      id, label: init.label, parentId: parentId ?? this.rootId,
      order: Date.now() + Math.random(), type: init.type, meta: init.meta ?? {},
    })
    this.fire()
    return id
  }
  moveEntry(id, newParentId, order) {
    const e = this.map.get(id); if (!e) return
    e.parentId = newParentId ?? this.rootId
    if (order != null) e.order = order
    this.fire()
  }
  updateMeta(id, patch) {
    const e = this.map.get(id) ?? { id, label: '', parentId: this.rootId, order: Date.now(), meta: {} }
    e.meta = { ...(e.meta ?? {}), ...patch }
    this.map.set(id, e)
    this.fire()
  }
  deleteEntry(id) {
    for (const d of [id, ...this.descendantsOf(id).map(e => e.id)]) this.map.delete(d)
    this.fire()
  }
  subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l) }
  seed(entry) { this.map.set(entry.id, entry); this.fire() }
}

// ── Mock blob store (AbraFileApi) ───────────────────────────────────────────
const blobs = new Map() // `${docId}:${uploadId}` -> objectURL
const fileApi = {
  async getBlobUrl(docId, uploadId) { return blobs.get(`${docId}:${uploadId}`) ?? null },
}

// ── Stub awareness (no remote peers; records local writes for test asserts) ──
const localAware: Record<string, unknown> = {}
const awareness = {
  clientID: 1,
  getStates: () => new Map(),
  getLocalState: () => localAware,
  setLocalState(s: Record<string, unknown>) { Object.assign(localAware, s) },
  setLocalStateField(field: string, value: unknown) { localAware[field] = value },
  on() {}, off() {},
}
const childProvider = { document: new Y.Doc(), awareness, client: undefined }

const tree = new MockTree()

// ── Host importer simulation (props.onImportFiles) ──────────────────────────
// Creates a child doc per dropped GLB, stores its blob, returns the ids — the
// renderer then positions them at the drop point (placeImported).
async function onImportFiles(files, parentId) {
  const ids = []
  for (const f of files) {
    if (!/\.(glb|gltf)$/i.test(f.name)) continue
    const uploadId = crypto.randomUUID()
    const id = tree.createChild(parentId, {
      label: f.name.replace(/\.(glb|gltf)$/i, ''),
      meta: { spKind: 'model', spModelUploadId: uploadId, spX: 0, spY: 0, spZ: 0 },
    })
    blobs.set(`${id}:${uploadId}`, URL.createObjectURL(f))
    tree.updateMeta(id, { spModelDocId: id })
    ids.push(id)
  }
  return ids
}

// ── Generate a demo GLB offline (so "does a model render?" is testable) ──────
function makeGlbUrl(geometry, color) {
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.45 }))
  const exporter = new GLTFExporter()
  return new Promise((resolve, reject) => {
    exporter.parse(mesh, (gltf) => {
      resolve(URL.createObjectURL(new Blob([gltf], { type: 'model/gltf-binary' })))
    }, (err) => reject(err), { binary: true })
  })
}

const demoUrl = await makeGlbUrl(new TorusKnotGeometry(0.5, 0.18, 120, 18), 0x818cf8)
blobs.set('seed-model:seed-upload', demoUrl)
tree.seed({
  id: 'seed-model', label: 'Demo Model', parentId: 'scene-root', order: 1,
  meta: { spKind: 'model', spModelUploadId: 'seed-upload', spModelDocId: 'seed-model', spX: 0, spY: 0.7, spZ: 0, spFit: 'unit' },
})
// A second model so multi-object selection / movement is exercisable.
const demoUrl2 = await makeGlbUrl(new BoxGeometry(0.8, 0.8, 0.8), 0x22c55e)
blobs.set('seed-box:seed-upload-2', demoUrl2)
tree.seed({
  id: 'seed-box', label: 'Demo Box', parentId: 'scene-root', order: 2,
  meta: { spKind: 'model', spModelUploadId: 'seed-upload-2', spModelDocId: 'seed-box', spX: 1.6, spY: 0.4, spZ: 0, spFit: 'raw' },
})

createApp(SpatialRenderer, {
  docId: 'scene-root',
  childProvider,
  treeApi: tree,
  fileApi,
  editable: true,
  followingUser: null,
  onImportFiles,
  onOpenNode: (id) => console.log('[harness] open node', id),
  onFollow: () => {},
  docLabel: 'Dev Scene',
}).mount('#app')

// Expose for console poking + test assertions.
;(globalThis).__spatialHarness = { tree, blobs, localAware }
console.log('[harness] mounted — seeded 2 models; drop a .glb to import')
