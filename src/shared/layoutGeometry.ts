import type { WorkspaceLayoutNode } from "./types";

export const TILE_GUTTER_SIZE = 8;
export const MIN_APPLET_SIZE = 200;

export type SplitDirection = "row" | "column";
export type EdgeAxis = "vertical" | "horizontal";

export interface IntRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface CanonicalLeaf {
  id: string;
  appletInstanceId: string;
  rect: IntRect;
}

export interface CanonicalSplit {
  id: string;
  direction: SplitDirection;
  rect: IntRect;
  firstRect: IntRect;
  secondRect: IntRect;
  gutterRect: IntRect;
  availableSize: number;
  firstSize: number;
  secondSize: number;
  firstLeafIds: string[];
  secondLeafIds: string[];
}

export interface PrimitiveEdge {
  id: string;
  axis: EdgeAxis;
  splitId: string;
  center: number;
  start: number;
  end: number;
  beforeLeafId: string;
  afterLeafId: string;
}

export interface EdgeGroup {
  id: string;
  axis: EdgeAxis;
  center: number;
  start: number;
  end: number;
  edges: PrimitiveEdge[];
}

export interface CanonicalLayoutGeometry {
  rect: IntRect;
  leaves: CanonicalLeaf[];
  splits: CanonicalSplit[];
  primitiveEdges: PrimitiveEdge[];
}

export interface PointLike {
  x: number;
  y: number;
}

export type ResizeTarget =
  | { type: "edge"; vertical: EdgeGroup | null; horizontal: EdgeGroup | null }
  | { type: "junction"; vertical: EdgeGroup; horizontal: EdgeGroup };

export interface ResizeProjection {
  ratios: Record<string, number>;
  dx: number;
  dy: number;
}

type BuildResult = {
  leaves: CanonicalLeaf[];
  splits: CanonicalSplit[];
  primitiveEdges: PrimitiveEdge[];
};

export function computeCanonicalLayout(
  node: WorkspaceLayoutNode,
  size: SizeLike,
  ratios: Record<string, number> = {},
  gutterSize = TILE_GUTTER_SIZE
): CanonicalLayoutGeometry {
  const rect = {
    left: 0,
    top: 0,
    right: Math.max(0, Math.round(size.width)),
    bottom: Math.max(0, Math.round(size.height))
  };
  const result = buildNodeGeometry(node, rect, ratios, gutterSize);
  return { rect, ...result };
}

export function completedEdgeGroups(edges: PrimitiveEdge[], leaves: CanonicalLeaf[] = []): EdgeGroup[] {
  const groups: EdgeGroup[] = [];
  const used = new Set<string>();
  const leavesById = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  for (const edge of edges) {
    if (used.has(edge.id)) {
      continue;
    }
    const groupEdges = closeEdgeGroup(edge, edges, leavesById);
    for (const groupEdge of groupEdges) {
      used.add(groupEdge.id);
    }
    const extents = groupEdges.map((item) => edgeTouchedExtent(item, leavesById));
    const start = Math.min(...extents.map((item) => item[0]));
    const end = Math.max(...extents.map((item) => item[1]));
    groups.push({
      id: `${edge.axis}:${edge.center}:${start}:${end}`,
      axis: edge.axis,
      center: edge.center,
      start,
      end,
      edges: groupEdges.sort((left, right) => left.start - right.start || left.end - right.end)
    });
  }
  return groups.sort((left, right) => left.center - right.center || left.start - right.start);
}

export function resizeTargetAt(
  geometry: CanonicalLayoutGeometry,
  point: PointLike,
  handleSize = TILE_GUTTER_SIZE,
  junctionHandleSize = TILE_GUTTER_SIZE * 3
): ResizeTarget | null {
  const localPoint = { x: Math.round(point.x), y: Math.round(point.y) };
  const halfHandle = Math.floor(handleSize / 2);
  const halfJunctionHandle = Math.floor(junctionHandleSize / 2);
  const groups = completedEdgeGroups(geometry.primitiveEdges, geometry.leaves);
  const verticalGroups = groups.filter((group) => group.axis === "vertical");
  const horizontalGroups = groups.filter((group) => group.axis === "horizontal");
  const verticalIncidents = nearestCenterGroups(
    verticalGroups.filter(
      (group) =>
        Math.abs(localPoint.x - group.center) <= halfJunctionHandle &&
        localPoint.y >= group.start - halfJunctionHandle &&
        localPoint.y <= group.end + halfJunctionHandle
    ),
    localPoint.x
  );
  const horizontalIncidents = nearestCenterGroups(
    horizontalGroups.filter(
      (group) =>
        Math.abs(localPoint.y - group.center) <= halfJunctionHandle &&
        localPoint.x >= group.start - halfJunctionHandle &&
        localPoint.x <= group.end + halfJunctionHandle
    ),
    localPoint.y
  );
  if (verticalIncidents.length > 0 && horizontalIncidents.length > 0) {
    return {
      type: "junction",
      vertical: combineGroups(verticalIncidents),
      horizontal: combineGroups(horizontalIncidents)
    };
  }
  const vertical = verticalGroups.find(
    (group) =>
      Math.abs(localPoint.x - group.center) <= halfHandle && localPoint.y >= group.start && localPoint.y <= group.end
  );
  const horizontal = horizontalGroups.find(
    (group) =>
      Math.abs(localPoint.y - group.center) <= halfHandle && localPoint.x >= group.start && localPoint.x <= group.end
  );
  if (vertical && horizontal) {
    return { type: "junction", vertical, horizontal };
  }
  if (vertical) {
    return { type: "edge", vertical, horizontal: null };
  }
  if (horizontal) {
    return { type: "edge", vertical: null, horizontal };
  }
  return null;
}

export function projectResize(
  geometry: CanonicalLayoutGeometry,
  target: ResizeTarget,
  delta: PointLike,
  minSize = MIN_APPLET_SIZE
): ResizeProjection {
  const ratios: Record<string, number> = {};
  const dx = target.vertical ? clampGroupDelta(geometry, target.vertical, Math.round(delta.x), minSize) : 0;
  const dy = target.horizontal ? clampGroupDelta(geometry, target.horizontal, Math.round(delta.y), minSize) : 0;
  if (target.vertical) {
    addGroupRatios(geometry, target.vertical, dx, ratios);
  }
  if (target.horizontal) {
    addGroupRatios(geometry, target.horizontal, dy, ratios);
  }
  return { ratios, dx, dy };
}

export function applyRatioOverrides(node: WorkspaceLayoutNode, ratios: Record<string, number>): WorkspaceLayoutNode {
  if (node.type === "leaf") {
    return node;
  }
  return {
    ...node,
    ratio: ratios[node.id] ?? node.ratio,
    first: applyRatioOverrides(node.first, ratios),
    second: applyRatioOverrides(node.second, ratios)
  };
}

export function resizeLeafRectsForTarget(
  geometry: CanonicalLayoutGeometry,
  target: ResizeTarget,
  dx: number,
  dy: number
): CanonicalLeaf[] {
  const leaves = geometry.leaves.map((leaf) => ({ ...leaf, rect: { ...leaf.rect } }));
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  if (target.vertical && dx !== 0) {
    applyGroupDelta(byId, target.vertical, dx);
  }
  if (target.horizontal && dy !== 0) {
    applyGroupDelta(byId, target.horizontal, dy);
  }
  return leaves;
}

export function rebuildLayoutFromLeafRects(
  baseLayout: WorkspaceLayoutNode,
  leaves: CanonicalLeaf[],
  rect: IntRect,
  gutterSize = TILE_GUTTER_SIZE
): WorkspaceLayoutNode {
  const reusableIds = reusableSplitIds(baseLayout);
  return buildLayoutFromRects(leaves, rect, reusableIds, gutterSize);
}

function buildNodeGeometry(
  node: WorkspaceLayoutNode,
  rect: IntRect,
  ratios: Record<string, number>,
  gutterSize: number
): BuildResult {
  if (node.type === "leaf") {
    return {
      leaves: [{ id: node.id, appletInstanceId: node.appletInstanceId, rect }],
      splits: [],
      primitiveEdges: []
    };
  }

  const ratio = ratios[node.id] ?? node.ratio;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const availableSize = Math.max(0, (node.direction === "row" ? width : height) - gutterSize);
  const firstSize = Math.max(0, Math.min(availableSize, Math.round(ratio * availableSize)));
  const secondSize = availableSize - firstSize;
  const firstRect =
    node.direction === "row"
      ? { left: rect.left, top: rect.top, right: rect.left + firstSize, bottom: rect.bottom }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.top + firstSize };
  const gutterRect =
    node.direction === "row"
      ? { left: firstRect.right, top: rect.top, right: firstRect.right + gutterSize, bottom: rect.bottom }
      : { left: rect.left, top: firstRect.bottom, right: rect.right, bottom: firstRect.bottom + gutterSize };
  const secondRect =
    node.direction === "row"
      ? { left: gutterRect.right, top: rect.top, right: gutterRect.right + secondSize, bottom: rect.bottom }
      : { left: rect.left, top: gutterRect.bottom, right: rect.right, bottom: gutterRect.bottom + secondSize };

  const first = buildNodeGeometry(node.first, firstRect, ratios, gutterSize);
  const second = buildNodeGeometry(node.second, secondRect, ratios, gutterSize);
  const split: CanonicalSplit = {
    id: node.id,
    direction: node.direction,
    rect,
    firstRect,
    secondRect,
    gutterRect,
    availableSize,
    firstSize,
    secondSize,
    firstLeafIds: first.leaves.map((leaf) => leaf.id),
    secondLeafIds: second.leaves.map((leaf) => leaf.id)
  };

  return {
    leaves: [...first.leaves, ...second.leaves],
    splits: [split, ...first.splits, ...second.splits],
    primitiveEdges: [
      ...primitiveEdgesForSplit(split, first.leaves, second.leaves, gutterSize),
      ...first.primitiveEdges,
      ...second.primitiveEdges
    ]
  };
}

function primitiveEdgesForSplit(
  split: CanonicalSplit,
  firstLeaves: CanonicalLeaf[],
  secondLeaves: CanonicalLeaf[],
  gutterSize: number
): PrimitiveEdge[] {
  const edges: PrimitiveEdge[] = [];
  for (const before of firstLeaves) {
    for (const after of secondLeaves) {
      if (split.direction === "row") {
        if (before.rect.right + gutterSize !== after.rect.left) {
          continue;
        }
        const start = Math.max(before.rect.top, after.rect.top);
        const end = Math.min(before.rect.bottom, after.rect.bottom);
        if (end <= start) {
          continue;
        }
        edges.push({
          id: `${split.id}:${before.id}:${after.id}:${start}:${end}`,
          axis: "vertical",
          splitId: split.id,
          center: before.rect.right + gutterSize / 2,
          start,
          end,
          beforeLeafId: before.id,
          afterLeafId: after.id
        });
      } else {
        if (before.rect.bottom + gutterSize !== after.rect.top) {
          continue;
        }
        const start = Math.max(before.rect.left, after.rect.left);
        const end = Math.min(before.rect.right, after.rect.right);
        if (end <= start) {
          continue;
        }
        edges.push({
          id: `${split.id}:${before.id}:${after.id}:${start}:${end}`,
          axis: "horizontal",
          splitId: split.id,
          center: before.rect.bottom + gutterSize / 2,
          start,
          end,
          beforeLeafId: before.id,
          afterLeafId: after.id
        });
      }
    }
  }
  return edges;
}

function closeEdgeGroup(
  startEdge: PrimitiveEdge,
  edges: PrimitiveEdge[],
  leavesById: Map<string, CanonicalLeaf>
): PrimitiveEdge[] {
  const included = new Map([[startEdge.id, startEdge]]);
  let [start, end] = edgeTouchedExtent(startEdge, leavesById);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (included.has(edge.id) || edge.axis !== startEdge.axis || edge.center !== startEdge.center) {
        continue;
      }
      const [edgeStart, edgeEnd] = edgeTouchedExtent(edge, leavesById);
      if (edgeStart <= end && edgeEnd >= start) {
        included.set(edge.id, edge);
        start = Math.min(start, edgeStart);
        end = Math.max(end, edgeEnd);
        changed = true;
      }
    }
  }
  return [...included.values()];
}

function edgeTouchedExtent(edge: PrimitiveEdge, leavesById: Map<string, CanonicalLeaf>): [number, number] {
  const before = leavesById.get(edge.beforeLeafId);
  const after = leavesById.get(edge.afterLeafId);
  if (!before || !after) {
    return [edge.start, edge.end];
  }
  if (edge.axis === "vertical") {
    return [Math.min(before.rect.top, after.rect.top), Math.max(before.rect.bottom, after.rect.bottom)];
  }
  return [Math.min(before.rect.left, after.rect.left), Math.max(before.rect.right, after.rect.right)];
}

function nearestCenterGroups(groups: EdgeGroup[], pointCoordinate: number): EdgeGroup[] {
  if (groups.length <= 1) {
    return groups;
  }
  const nearestDistance = Math.min(...groups.map((group) => Math.abs(group.center - pointCoordinate)));
  return groups.filter((group) => Math.abs(group.center - pointCoordinate) === nearestDistance);
}

function combineGroups(groups: EdgeGroup[]): EdgeGroup {
  if (groups.length === 0) {
    throw new Error("Cannot combine an empty splitter group set");
  }
  const [first] = groups;
  const edges = groups.flatMap((group) => group.edges);
  const start = Math.min(...groups.map((group) => group.start));
  const end = Math.max(...groups.map((group) => group.end));
  return {
    id: `${first.axis}:${first.center}:${start}:${end}`,
    axis: first.axis,
    center: first.center,
    start,
    end,
    edges
  };
}

function clampGroupDelta(
  geometry: CanonicalLayoutGeometry,
  group: EdgeGroup,
  delta: number,
  minSize: number
): number {
  let minDelta = -Infinity;
  let maxDelta = Infinity;
  const leaves = new Map(geometry.leaves.map((leaf) => [leaf.id, leaf]));
  for (const edge of group.edges) {
    const before = leaves.get(edge.beforeLeafId);
    const after = leaves.get(edge.afterLeafId);
    if (!before || !after) {
      throw new Error(`Primitive edge ${edge.id} references missing leaf geometry`);
    }
    const beforeSize = group.axis === "vertical" ? before.rect.right - before.rect.left : before.rect.bottom - before.rect.top;
    const afterSize = group.axis === "vertical" ? after.rect.right - after.rect.left : after.rect.bottom - after.rect.top;
    minDelta = Math.max(minDelta, minSize - beforeSize);
    maxDelta = Math.min(maxDelta, afterSize - minSize);
  }
  const splitIds = new Set(group.edges.map((edge) => edge.splitId));
  for (const splitId of splitIds) {
    const split = geometry.splits.find((item) => item.id === splitId);
    if (!split) {
      throw new Error(`Primitive edge group references missing split ${splitId}`);
    }
    minDelta = Math.max(minDelta, -split.firstSize + 1);
    maxDelta = Math.min(maxDelta, split.secondSize - 1);
  }
  return Math.max(minDelta, Math.min(maxDelta, delta));
}

function addGroupRatios(
  geometry: CanonicalLayoutGeometry,
  group: EdgeGroup,
  delta: number,
  ratios: Record<string, number>
): void {
  const splitIds = new Set(group.edges.map((edge) => edge.splitId));
  for (const splitId of splitIds) {
    const split = geometry.splits.find((item) => item.id === splitId);
    if (!split || split.availableSize <= 0) {
      throw new Error(`Cannot resize split ${splitId} without positive available size`);
    }
    ratios[splitId] = (split.firstSize + delta) / split.availableSize;
  }
}

function applyGroupDelta(leaves: Map<string, CanonicalLeaf>, group: EdgeGroup, delta: number): void {
  const beforeIds = new Set(group.edges.map((edge) => edge.beforeLeafId));
  const afterIds = new Set(group.edges.map((edge) => edge.afterLeafId));
  for (const leafId of beforeIds) {
    const leaf = leaves.get(leafId);
    if (!leaf) {
      continue;
    }
    if (group.axis === "vertical") {
      leaf.rect.right += delta;
    } else {
      leaf.rect.bottom += delta;
    }
  }
  for (const leafId of afterIds) {
    const leaf = leaves.get(leafId);
    if (!leaf) {
      continue;
    }
    if (group.axis === "vertical") {
      leaf.rect.left += delta;
    } else {
      leaf.rect.top += delta;
    }
  }
}

function reusableSplitIds(layout: WorkspaceLayoutNode): Map<string, string> {
  const ids = new Map<string, string>();
  const visit = (node: WorkspaceLayoutNode): string[] => {
    if (node.type === "leaf") {
      return [node.id];
    }
    const first = visit(node.first);
    const second = visit(node.second);
    ids.set(splitPartitionKey(node.direction, first, second), node.id);
    return [...first, ...second].sort();
  };
  visit(layout);
  return ids;
}

function buildLayoutFromRects(
  leaves: CanonicalLeaf[],
  rect: IntRect,
  reusableIds: Map<string, string>,
  gutterSize: number
): WorkspaceLayoutNode {
  if (leaves.length === 1) {
    return { id: leaves[0].id, type: "leaf", appletInstanceId: leaves[0].appletInstanceId };
  }
  const verticalCut = findVerticalCut(leaves, rect, gutterSize);
  if (verticalCut) {
    return splitFromCut("row", verticalCut.left, verticalCut.right, leaves, rect, reusableIds, gutterSize);
  }
  const horizontalCut = findHorizontalCut(leaves, rect, gutterSize);
  if (horizontalCut) {
    return splitFromCut("column", horizontalCut.top, horizontalCut.bottom, leaves, rect, reusableIds, gutterSize);
  }
  throw new Error("Cannot rebuild workspace layout from non-slicing applet rectangles");
}

function splitFromCut(
  direction: SplitDirection,
  cutStart: number,
  cutEnd: number,
  leaves: CanonicalLeaf[],
  rect: IntRect,
  reusableIds: Map<string, string>,
  gutterSize: number
): WorkspaceLayoutNode {
  const firstLeaves =
    direction === "row" ? leaves.filter((leaf) => leaf.rect.right <= cutStart) : leaves.filter((leaf) => leaf.rect.bottom <= cutStart);
  const secondLeaves =
    direction === "row" ? leaves.filter((leaf) => leaf.rect.left >= cutEnd) : leaves.filter((leaf) => leaf.rect.top >= cutEnd);
  const firstRect =
    direction === "row"
      ? { left: rect.left, top: rect.top, right: cutStart, bottom: rect.bottom }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: cutStart };
  const secondRect =
    direction === "row"
      ? { left: cutEnd, top: rect.top, right: rect.right, bottom: rect.bottom }
      : { left: rect.left, top: cutEnd, right: rect.right, bottom: rect.bottom };
  const first = buildLayoutFromRects(firstLeaves, firstRect, reusableIds, gutterSize);
  const second = buildLayoutFromRects(secondLeaves, secondRect, reusableIds, gutterSize);
  const firstIds = collectLeafNodeIds(first);
  const secondIds = collectLeafNodeIds(second);
  const availableSize = Math.max(1, (direction === "row" ? rect.right - rect.left : rect.bottom - rect.top) - gutterSize);
  const firstSize = direction === "row" ? cutStart - rect.left : cutStart - rect.top;
  return {
    id:
      reusableIds.get(splitPartitionKey(direction, firstIds, secondIds)) ??
      `split-${direction}-${[...firstIds, ...secondIds].sort().join("-")}`,
    type: "split",
    direction,
    ratio: firstSize / availableSize,
    first,
    second
  };
}

function findVerticalCut(leaves: CanonicalLeaf[], rect: IntRect, gutterSize: number): { left: number; right: number } | null {
  const candidates = [...new Set(leaves.map((leaf) => leaf.rect.right))]
    .filter((cut) => cut > rect.left && cut + gutterSize < rect.right)
    .sort((left, right) => left - right);
  for (const left of candidates) {
    const right = left + gutterSize;
    if (validCut(leaves, "row", left, right)) {
      return { left, right };
    }
  }
  return null;
}

function findHorizontalCut(leaves: CanonicalLeaf[], rect: IntRect, gutterSize: number): { top: number; bottom: number } | null {
  const candidates = [...new Set(leaves.map((leaf) => leaf.rect.bottom))]
    .filter((cut) => cut > rect.top && cut + gutterSize < rect.bottom)
    .sort((left, right) => left - right);
  for (const top of candidates) {
    const bottom = top + gutterSize;
    if (validCut(leaves, "column", top, bottom)) {
      return { top, bottom };
    }
  }
  return null;
}

function validCut(leaves: CanonicalLeaf[], direction: SplitDirection, cutStart: number, cutEnd: number): boolean {
  let firstCount = 0;
  let secondCount = 0;
  for (const leaf of leaves) {
    if (direction === "row") {
      if (leaf.rect.right <= cutStart) {
        firstCount += 1;
      } else if (leaf.rect.left >= cutEnd) {
        secondCount += 1;
      } else {
        return false;
      }
    } else if (leaf.rect.bottom <= cutStart) {
      firstCount += 1;
    } else if (leaf.rect.top >= cutEnd) {
      secondCount += 1;
    } else {
      return false;
    }
  }
  return firstCount > 0 && secondCount > 0;
}

function collectLeafNodeIds(node: WorkspaceLayoutNode): string[] {
  if (node.type === "leaf") {
    return [node.id];
  }
  return [...collectLeafNodeIds(node.first), ...collectLeafNodeIds(node.second)].sort();
}

function splitPartitionKey(direction: SplitDirection, firstLeafIds: string[], secondLeafIds: string[]): string {
  return `${direction}:${[...firstLeafIds].sort().join(",")}|${[...secondLeafIds].sort().join(",")}`;
}
