import type { RectLike, TabHostState, WorkspaceTab } from "../shared/types";

export const TAB_CLOSE_SIZE = 14;
export const TAB_CLOSE_RIGHT_PADDING = 10;
export const TAB_CLOSE_GAP = 8;
export const TAB_CLOSE_HIT_SLOP_X = 5;
export const TAB_CLOSE_HIT_SLOP_Y = 7;

export function closeRectForTab(rect: RectLike): RectLike {
  const centerY = (rect.top + rect.bottom) / 2;
  return {
    left: rect.right - TAB_CLOSE_RIGHT_PADDING - TAB_CLOSE_SIZE,
    right: rect.right - TAB_CLOSE_RIGHT_PADDING,
    top: centerY - TAB_CLOSE_SIZE / 2,
    bottom: centerY + TAB_CLOSE_SIZE / 2
  };
}

export function closeHitRectForTab(rect: RectLike): RectLike {
  const close = closeRectForTab(rect);
  return {
    left: Math.max(rect.left, close.left - TAB_CLOSE_HIT_SLOP_X),
    right: Math.min(rect.right, close.right + TAB_CLOSE_HIT_SLOP_X),
    top: Math.max(rect.top, close.top - TAB_CLOSE_HIT_SLOP_Y),
    bottom: Math.min(rect.bottom, close.bottom + TAB_CLOSE_HIT_SLOP_Y)
  };
}

export function titleRectForTab(rect: RectLike, closable: boolean): RectLike {
  const rightCut = closable ? TAB_CLOSE_RIGHT_PADDING + TAB_CLOSE_SIZE + TAB_CLOSE_GAP : TAB_CLOSE_RIGHT_PADDING;
  return {
    left: rect.left + 36,
    right: Math.max(rect.left + 44, rect.right - rightCut),
    top: rect.top,
    bottom: rect.bottom
  };
}

export function insertionIndexForX(
  screenX: number,
  tabRects: Array<{ tabId: string; rect: RectLike }>,
  host: TabHostState,
  tabs: Record<string, WorkspaceTab>,
  draggedTabId?: string
): number {
  const firstMovable = firstMovableIndex(host, tabs);
  const orderedRects = tabRects.filter((item) => item.tabId !== draggedTabId);
  const candidateOrder = host.tabIds.filter((tabId) => tabId !== draggedTabId);
  for (const item of orderedRects) {
    const center = (item.rect.left + item.rect.right) / 2;
    if (screenX < center) {
      const index = candidateOrder.indexOf(item.tabId);
      return Math.max(firstMovable, index === -1 ? candidateOrder.length : index);
    }
  }
  return candidateOrder.length;
}

export function firstMovableIndex(host: TabHostState, tabs: Record<string, WorkspaceTab>): number {
  const index = host.tabIds.findIndex((tabId) => !tabs[tabId]?.pinned);
  return index === -1 ? host.tabIds.length : index;
}
