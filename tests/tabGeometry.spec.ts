import { expect, test } from "@playwright/test";
import type { TabHostState, WorkspaceTab } from "../src/shared/types";
import { closeHitRectForTab, closeRectForTab, firstMovableIndex, insertionIndexForX, titleRectForTab } from "../src/renderer/tabGeometry";

const tabs: Record<string, WorkspaceTab> = {
  manager: { id: "manager", title: "Workspace Manager", workspaceId: "manager", pinned: true, closable: false },
  atlas: { id: "atlas", title: "Project Atlas", workspaceId: "atlas", pinned: false, closable: true },
  lab: { id: "lab", title: "VM Lab", workspaceId: "lab", pinned: false, closable: true }
};

const host: TabHostState = {
  windowId: 1,
  tabIds: ["manager", "atlas", "lab"],
  activeTabId: "atlas",
  isPrimary: true
};

test("close hit rect has usable slop and title stays left of close", () => {
  const rect = { left: 10, top: 0, right: 210, bottom: 46 };
  const close = closeRectForTab(rect);
  const hit = closeHitRectForTab(rect);
  const title = titleRectForTab(rect, true);

  expect(hit.right - hit.left).toBeGreaterThan(close.right - close.left);
  expect(hit.bottom - hit.top).toBeGreaterThan(close.bottom - close.top);
  expect(title.right).toBeLessThan(close.left);
});

test("insertion index respects tab centers and pinned manager", () => {
  const tabRects = [
    { tabId: "manager", rect: { left: 0, top: 0, right: 200, bottom: 46 } },
    { tabId: "atlas", rect: { left: 200, top: 0, right: 360, bottom: 46 } },
    { tabId: "lab", rect: { left: 360, top: 0, right: 500, bottom: 46 } }
  ];

  expect(firstMovableIndex(host, tabs)).toBe(1);
  expect(insertionIndexForX(20, tabRects, host, tabs)).toBe(1);
  expect(insertionIndexForX(420, tabRects, host, tabs)).toBe(2);
  expect(insertionIndexForX(540, tabRects, host, tabs)).toBe(3);
});

test("insertion index ignores the dragged tab", () => {
  const tabRects = [
    { tabId: "manager", rect: { left: 0, top: 0, right: 200, bottom: 46 } },
    { tabId: "atlas", rect: { left: 200, top: 0, right: 360, bottom: 46 } },
    { tabId: "lab", rect: { left: 360, top: 0, right: 500, bottom: 46 } }
  ];

  expect(insertionIndexForX(260, tabRects, host, tabs, "atlas")).toBe(1);
  expect(insertionIndexForX(430, tabRects, host, tabs, "atlas")).toBe(2);
});
