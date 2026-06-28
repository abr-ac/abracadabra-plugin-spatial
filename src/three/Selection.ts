/**
 * Selection — highlights the LOCAL user's current selection with bright bounding
 * boxes that track moving objects. (Remote users' selections are drawn by
 * Presence in their own colour.) Kept cheap: one BoxHelper per selected node,
 * refreshed each frame so it follows drags/gizmo edits.
 */
import { Group, BoxHelper, Color, type Object3D } from 'three'
import type { NodeGraph } from './NodeGraph.ts'

const SELECTION_COLOR = new Color('#ffffff')
const HOVER_COLOR = new Color('#8b9cff')

export class SelectionHighlight {
  private readonly container = new Group()
  private readonly helpers = new Map<string, BoxHelper>()
  private ids: string[] = []
  private hoverId: string | null = null
  private hoverHelper: BoxHelper | null = null

  constructor(private readonly root: Object3D, private readonly graph: NodeGraph) {
    this.container.name = '__selection__'
    this.root.add(this.container)
  }

  /** Highlight a hovered (not selected) node with a dim box, or clear (null). */
  setHover(id: string | null): void {
    // Don't double-draw a node that's already selected.
    const effective = id && !this.ids.includes(id) ? id : null
    if (effective === this.hoverId) return
    this.hoverId = effective
    if (this.hoverHelper) {
      this.hoverHelper.removeFromParent()
      this.hoverHelper.geometry.dispose()
      this.hoverHelper = null
    }
    if (!effective) return
    const obj = this.graph.groupFor(effective)
    if (!obj) return
    this.hoverHelper = new BoxHelper(obj, HOVER_COLOR)
    this.container.add(this.hoverHelper)
  }

  set(ids: Iterable<string>): void {
    this.ids = [...ids]
    const want = new Set(this.ids)
    for (const [id, h] of this.helpers) {
      if (!want.has(id)) {
        h.removeFromParent()
        h.geometry.dispose()
        this.helpers.delete(id)
      }
    }
    for (const id of want) {
      if (this.helpers.has(id)) continue
      const obj = this.graph.groupFor(id)
      if (!obj) continue
      const h = new BoxHelper(obj, SELECTION_COLOR)
      this.helpers.set(id, h)
      this.container.add(h)
    }
  }

  /** Per-frame: keep boxes glued to (possibly moving) objects. */
  tick(): void {
    for (const [id, h] of this.helpers) {
      const obj = this.graph.groupFor(id)
      if (obj) h.setFromObject(obj)
    }
    if (this.hoverId && this.hoverHelper) {
      const obj = this.graph.groupFor(this.hoverId)
      if (obj) this.hoverHelper.setFromObject(obj)
    }
  }

  dispose(): void {
    for (const h of this.helpers.values()) {
      h.removeFromParent()
      h.geometry.dispose()
    }
    this.helpers.clear()
    this.hoverHelper?.removeFromParent()
    this.hoverHelper?.geometry.dispose()
    this.container.removeFromParent()
  }
}
