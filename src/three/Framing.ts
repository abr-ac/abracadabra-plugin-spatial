/**
 * Framing — compute bounding boxes for "frame all" / "frame selection". Skips
 * presence/selection/helper overlays so framing reflects actual content.
 */
import { Box3, type Object3D } from 'three'
import type { NodeGraph } from './NodeGraph.ts'

export function boxOfAll(root: Object3D): Box3 {
  const box = new Box3()
  for (const child of root.children) {
    // Skip internal overlays (presence/selection/gizmo/ground/grid helpers).
    if (child.name.startsWith('__') || child.type === 'GridHelper') continue
    box.expandByObject(child)
  }
  return box
}

export function boxOfIds(graph: NodeGraph, ids: Iterable<string>): Box3 {
  const box = new Box3()
  for (const id of ids) {
    const g = graph.groupFor(id)
    if (g) box.expandByObject(g)
  }
  return box
}
