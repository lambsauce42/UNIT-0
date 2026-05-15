import type { WorkspaceLayoutLeaf, WorkspaceLayoutNode } from "./types";

export function insertAppletLeafWithRatio(
  layout: WorkspaceLayoutNode | null,
  appletInstanceId: string,
  targetLeafId: string | undefined,
  splitDirection: "row" | "column",
  ratio: number
): WorkspaceLayoutNode {
  const leafNode: WorkspaceLayoutNode = {
    id: `leaf-${appletInstanceId}`,
    type: "leaf",
    appletInstanceId
  };
  const splitRatio = Math.max(0.05, Math.min(0.95, ratio));
  if (!layout) {
    if (targetLeafId) {
      throw new Error(`Cannot split missing layout leaf ${targetLeafId}`);
    }
    return leafNode;
  }
  if (!targetLeafId) {
    return {
      id: `split-root-${appletInstanceId}`,
      type: "split",
      direction: splitDirection,
      ratio: splitRatio,
      first: layout,
      second: leafNode
    };
  }
  const result = replaceLayoutLeaf(layout, targetLeafId, (targetLeaf) => ({
    id: `split-${targetLeaf.id}-${appletInstanceId}`,
    type: "split",
    direction: splitDirection,
    ratio: splitRatio,
    first: targetLeaf,
    second: leafNode
  }));
  if (!result.replaced) {
    throw new Error(`Layout leaf ${targetLeafId} does not exist`);
  }
  return result.node;
}

export function replaceLayoutLeaf(
  node: WorkspaceLayoutNode,
  leafId: string,
  replace: (leaf: WorkspaceLayoutLeaf) => WorkspaceLayoutNode
): { node: WorkspaceLayoutNode; replaced: boolean } {
  if (node.type === "leaf") {
    return node.id === leafId ? { node: replace(node), replaced: true } : { node, replaced: false };
  }
  const first = replaceLayoutLeaf(node.first, leafId, replace);
  if (first.replaced) {
    return { node: { ...node, first: first.node }, replaced: true };
  }
  const second = replaceLayoutLeaf(node.second, leafId, replace);
  if (second.replaced) {
    return { node: { ...node, second: second.node }, replaced: true };
  }
  return { node, replaced: false };
}
