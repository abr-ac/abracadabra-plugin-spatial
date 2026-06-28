/**
 * Shared keys + types for the spatial plugin — the analog of the terminal
 * plugin's `session.ts`. Both the renderer modules and `index.ts` import from
 * here so the meta-key contract and awareness field names live in one place.
 *
 * The scene graph is the document tree: every object/light/group is a child
 * DOCUMENT, and its transform + parameters live in the document's page-meta
 * (the `sp*` keys below). There are NO primitives — geometry comes only from
 * real GLB/GLTF files attached to documents.
 */

// ── Node kinds ─────────────────────────────────────────────────────────────────

/** What a document represents in the scene. Read from `meta.spKind`. */
export type SpKind = 'model' | 'group' | 'light' | 'camera'

/** Light sub-type when `spKind === 'light'`. Read from `meta.spLightType`. */
export type SpLightType =
  | 'directional'
  | 'point'
  | 'spot'
  | 'ambient'
  | 'hemisphere'

// ── Meta keys (per-object document) ─────────────────────────────────────────────

/**
 * The page-meta shape a spatial object document carries. All optional — sane
 * defaults are applied by the renderer. Mirrors (a trimmed, primitive-free
 * version of) cou-sh's `DocPageMeta` spatial keys.
 */
export interface SpatialMeta {
  spKind?: SpKind

  // Transform (TRS). Rotation in DEGREES; scale defaults to 1.
  spX?: number
  spY?: number
  spZ?: number
  spRX?: number
  spRY?: number
  spRZ?: number
  spSX?: number
  spSY?: number
  spSZ?: number

  // Model source — a content-addressed upload owned by `spModelDocId`.
  spModelUploadId?: string
  spModelDocId?: string
  /** 'raw' keeps the asset's own scale (default); 'unit' fits it in a 1³ box. */
  spFit?: 'raw' | 'unit'

  /**
   * Marks this document as an EXTERNAL ASSET FILE of its parent model (a .bin
   * buffer or texture referenced by a sibling .gltf), not a scene object. The
   * upload is owned by THIS document; its label is the referenced filename.
   * NodeGraph folds such children into the parent model's resolver map
   * (basename → blob url) instead of rendering them as geometry — this is how
   * "load 3d models from nested files" resolves arbitrarily deep dependencies.
   */
  spFileUploadId?: string

  // Light parameters (when spKind === 'light').
  spLightType?: SpLightType
  spIntensity?: number
  spDistance?: number
  spAngle?: number // spotlight cone half-angle, degrees
  spPenumbra?: number // 0..1
  spCastShadow?: boolean

  // Common.
  color?: string // hex; light colour or selection tint
  spVisible?: boolean
  spOpacity?: number // 0..100
}

/** Scene-level settings, stored on the PAGE doc's own meta. */
export interface SpatialSceneMeta {
  spGridVisible?: boolean
  spShadows?: boolean
  spBackground?: string // hex background colour
  /** HDR/EXR environment map: upload owned by the page doc. */
  spEnvUploadId?: string
  /** Force the environment decoder; otherwise sniffed from the filename. */
  spEnvType?: 'hdr' | 'exr'
  /** Also show the environment as the scene background (skybox). */
  spEnvAsBackground?: boolean
  /** Ground plane that catches shadows (default on when shadows are on). */
  spGround?: boolean
}

// ── Awareness fields ─────────────────────────────────────────────────────────

/** Awareness key carrying a user's live camera. */
export const AW_CAMERA = 'spatial:camera'
/** Awareness key carrying a user's selected document ids. */
export const AW_SELECTED = 'spatial:selected'
/** Awareness key carrying a user's live 3D pointer (optional "look here"). */
export const AW_POINTER = 'spatial:pointer'

export interface CameraAwareness {
  /** [x,y,z] world position of the camera. */
  position: [number, number, number]
  /** [x,y,z] orbit/look target. */
  target: [number, number, number]
  /** Monotonic timestamp so followers ignore stale frames. */
  timestamp: number
}

export interface SelectionAwareness {
  ids: string[]
}

export interface PointerAwareness {
  /** World-space point the user is pointing at (raycast hit), or null. */
  point: [number, number, number] | null
  timestamp: number
}

// ── Defaults / helpers ─────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180

export function num(v: unknown, fallback: number): number {
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** TRS triplet helpers with defaults. */
export function position(m: SpatialMeta): [number, number, number] {
  return [num(m.spX, 0), num(m.spY, 0), num(m.spZ, 0)]
}
export function rotationRad(m: SpatialMeta): [number, number, number] {
  return [
    num(m.spRX, 0) * DEG2RAD,
    num(m.spRY, 0) * DEG2RAD,
    num(m.spRZ, 0) * DEG2RAD,
  ]
}
export function scale(m: SpatialMeta): [number, number, number] {
  return [num(m.spSX, 1), num(m.spSY, 1), num(m.spSZ, 1)]
}
