/**
 * Spatial plugin — CLIENT entry. Registers the `spatial` page type whose
 * renderer is a pure Three.js scene. Every object/light/group is a child
 * DOCUMENT (no primitives); models load from GLB/GLTF files attached to
 * documents, with full multi-user awareness.
 *
 * Typed against the shared `@abraca/plugin` contract only (NOT cou-sh's
 * `CouPlugin`, NOT `@abraca/nuxt`) so the same bundle loads in CouShell and any
 * host that narrows `AbraPlugin` and passes the `treeApi` / `fileApi` props.
 */
import { defineAsyncComponent } from 'vue'
import type { AbraPlugin } from '@abraca/plugin'

const spatialPlugin: AbraPlugin = {
  name: 'spatial',
  label: 'Spatial',
  version: '0.1.0',
  description: 'A collaborative 3D scene — every object, light, and group is a document; geometry comes from GLB/GLTF files, with real-time presence.',
  defaultEnabled: false,

  pageTypes: {
    spatial: {
      key: 'spatial',
      label: 'Spatial',
      icon: 'i-lucide-box',
      description: '3D scene with collaborative objects and real-time presence',
      available: true,
      supportsChildren: true,
      childLabel: 'Object',
      grandchildLabel: 'Part',
      defaultDepth: -1,
      component: defineAsyncComponent(() => import('./renderer/SpatialRenderer.vue')),
      // Meta editor fields (host-rendered) — no primitives; geometry is files.
      metaSchema: [
        { type: 'select', key: 'spKind', options: ['model', 'group', 'light', 'camera'], label: 'Kind' },
        { type: 'select', key: 'spLightType', options: ['directional', 'point', 'spot', 'ambient', 'hemisphere'], label: 'Light' },
        { type: 'colorPreset', key: 'color', presets: ['#ffffff', '#ffd9a0', '#a0c8ff', '#6366f1', '#22c55e', '#f97316'], label: 'Color' },
        { type: 'number', key: 'spIntensity', min: 0, step: 0.1, label: 'Intensity' },
        { type: 'slider', key: 'spOpacity', min: 0, max: 100, label: 'Opacity' },
        { type: 'select', key: 'spFit', options: ['raw', 'unit'], label: 'Fit' },
        { type: 'number', key: 'spX', step: 0.1, label: 'X' },
        { type: 'number', key: 'spY', step: 0.1, label: 'Y' },
        { type: 'number', key: 'spZ', step: 0.1, label: 'Z' },
        { type: 'number', key: 'spRX', min: -180, max: 180, step: 1, label: 'Rot X' },
        { type: 'number', key: 'spRY', min: -180, max: 180, step: 1, label: 'Rot Y' },
        { type: 'number', key: 'spRZ', min: -180, max: 180, step: 1, label: 'Rot Z' },
        { type: 'number', key: 'spSX', min: 0.01, step: 0.1, label: 'Scale X' },
        { type: 'number', key: 'spSY', min: 0.01, step: 0.1, label: 'Scale Y' },
        { type: 'number', key: 'spSZ', min: 0.01, step: 0.1, label: 'Scale Z' },
      ],
      defaultMetaFields: [
        { type: 'toggle', key: 'spGridVisible', label: 'Show Grid', default: true },
        { type: 'toggle', key: 'spShadows', label: 'Shadows', default: true },
      ],
    },
  },

  // Live camera, selection, and pointer are published per-doc on awareness.
  awarenessContributions: [
    { keys: ['spatial:camera', 'spatial:selected', 'spatial:pointer'] },
  ],

  commandPaletteItems: () => [
    {
      id: 'spatial:new-scene',
      label: 'New 3D Scene',
      icon: 'i-lucide-box',
      group: 'Create',
      handler: (ctx) => {
        const c = ctx as unknown as {
          docId?: string | null
          router?: { push(p: string): void }
          abracadabra?: { doc?: { value?: { getMap(n: string): { set(k: string, v: unknown): void } } } }
        }
        const id = crypto.randomUUID()
        const rootDoc = c.abracadabra?.doc?.value
        rootDoc?.getMap('doc-tree').set(id, {
          label: 'Untitled Scene',
          parentId: c.docId ?? null,
          order: Date.now(),
          type: 'spatial',
        })
        c.router?.push(`/doc/${id}`)
      },
    },
  ],
}

export default spatialPlugin
