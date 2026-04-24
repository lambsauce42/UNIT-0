import { app, BrowserWindow, Menu, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  AppletSession,
  BeginTabDragPayload,
  BootstrapPayload,
  CloseTabPayload,
  FinishTabDragPayload,
  RectLike,
  RegisterStripBoundsPayload,
  TabDragSession,
  TabDropTarget,
  TabHostSnapshot,
  TabHostState,
  UnitState,
  UpdateTabDragPayload,
  Workspace,
  WorkspaceTab
} from "../shared/types.js";

const preloadPath = path.join(__dirname, "../preload/preload.js");
const rendererEntry = path.join(__dirname, "../renderer/index.html");
const windows = new Map<number, BrowserWindow>();
const captureOverlays = new Map<number, BrowserWindow>();
let dragBroadcastTimer: NodeJS.Timeout | null = null;
let dragLifecycleId = 0;
let overlayPointerCapturing = false;
let overlayWindowsVisible = false;

const DROP_SLOP = { left: 8, top: 4, right: 8, bottom: 40 };
const TAB_PREVIEW_SIZE = { width: 220, height: 46 };
const TAB_DEBUG = process.env.UNIT0_TAB_DEBUG !== "0";
const TAB_DEBUG_VERBOSE = process.env.UNIT0_TAB_DEBUG_VERBOSE === "1";
const TEST_WINDOW_MODE = process.env.UNIT0_E2E_WINDOW_MODE;
const HIDE_TEST_WINDOWS = process.env.NODE_ENV === "test" && TEST_WINDOW_MODE !== "visible";
const debugLogPath = path.join(process.cwd(), "logs", "tab-drag-debug.log");
let debugSeq = 0;
const stripDebugKeys = new Map<number, string>();

function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (!TAB_DEBUG) {
    return;
  }
  const entry = {
    seq: ++debugSeq,
    t: new Date().toISOString(),
    event,
    ...data
  };
  const line = `[tab-drag] ${JSON.stringify(entry)}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
    fs.appendFileSync(debugLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.warn("[tab-drag] failed to write debug log", error);
  }
}

function rectDebug(rect: RectLike | Electron.Rectangle | undefined): Record<string, number> | null {
  if (!rect) {
    return null;
  }
  if ("right" in rect) {
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.right - rect.left),
      height: Math.round(rect.bottom - rect.top)
    };
  }
  return {
    left: Math.round(rect.x),
    top: Math.round(rect.y),
    right: Math.round(rect.x + rect.width),
    bottom: Math.round(rect.y + rect.height),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function uniqueWindowIds(windowIds: number[]): number[] {
  return [...new Set(windowIds)];
}

function pointDebug(point: { x?: number; y?: number; screenX?: number; screenY?: number }): Record<string, number> {
  return {
    x: Math.round(point.x ?? point.screenX ?? 0),
    y: Math.round(point.y ?? point.screenY ?? 0)
  };
}

type DragFinishResult =
  | { action: "none"; closeWindowIds: number[] }
  | { action: "create-window"; tabId: string; x: number; y: number; closeWindowIds: number[] };

type DragUpdateResult = {
  closeWindowIds: number[];
  captureOverlayPointer: boolean;
  stateChanged: boolean;
  targetChanged: boolean;
};

type PendingAlignment = {
  tabId: string;
  screenX: number;
  screenY: number;
  hotSpot: { x: number; y: number };
  closeWindowIds: number[];
  timeout: NodeJS.Timeout;
};

const pendingAlignments = new Map<number, PendingAlignment>();
const earlyClosedDragSourceWindowIds = new Set<number>();

class TabRegistry {
  readonly appletSessions: Record<string, AppletSession> = {
    "session-terminal": { id: "session-terminal", kind: "terminal", title: "Terminal" },
    "session-file-viewer": { id: "session-file-viewer", kind: "fileViewer", title: "File Viewer" },
    "session-browser": { id: "session-browser", kind: "browser", title: "Browser" },
    "session-chat": { id: "session-chat", kind: "chat", title: "Chat" },
    "session-sandbox": { id: "session-sandbox", kind: "sandbox", title: "Sandbox" }
  };

  readonly workspaces: Record<string, Workspace> = {
    manager: { id: "manager", title: "Workspace Manager", applets: [] },
    atlas: {
      id: "atlas",
      title: "Project Atlas",
      applets: [
        { id: "atlas-terminal", sessionId: "session-terminal", area: "terminal" },
        { id: "atlas-browser", sessionId: "session-browser", area: "browser" },
        { id: "atlas-file-viewer", sessionId: "session-file-viewer", area: "fileViewer" },
        { id: "atlas-sandbox", sessionId: "session-sandbox", area: "sandbox" },
        { id: "atlas-chat", sessionId: "session-chat", area: "chat" }
      ]
    },
    redesign: {
      id: "redesign",
      title: "Website Redesign",
      applets: [
        { id: "redesign-browser", sessionId: "session-browser", area: "browser" },
        { id: "redesign-chat", sessionId: "session-chat", area: "chat" },
        { id: "redesign-file-viewer", sessionId: "session-file-viewer", area: "fileViewer" }
      ]
    },
    lab: {
      id: "lab",
      title: "VM Lab",
      applets: [
        { id: "lab-sandbox", sessionId: "session-sandbox", area: "sandbox" },
        { id: "lab-terminal", sessionId: "session-terminal", area: "terminal" }
      ]
    },
    research: {
      id: "research",
      title: "Research",
      applets: [
        { id: "research-browser", sessionId: "session-browser", area: "browser" },
        { id: "research-chat", sessionId: "session-chat", area: "chat" }
      ]
    }
  };

  readonly tabs: Record<string, WorkspaceTab> = {
    "tab-manager": {
      id: "tab-manager",
      title: "Workspace Manager",
      workspaceId: "manager",
      pinned: true,
      closable: false
    },
    "tab-atlas": { id: "tab-atlas", title: "Project Atlas", workspaceId: "atlas", pinned: false, closable: true },
    "tab-redesign": { id: "tab-redesign", title: "Website Redesign", workspaceId: "redesign", pinned: false, closable: true },
    "tab-lab": { id: "tab-lab", title: "VM Lab", workspaceId: "lab", pinned: false, closable: true },
    "tab-research": { id: "tab-research", title: "Research", workspaceId: "research", pinned: false, closable: true }
  };

  readonly hosts: Record<number, TabHostState> = {};
  readonly stripBounds = new Map<number, RegisterStripBoundsPayload>();
  primaryWindowId = 0;
  dragSession: TabDragSession | null = null;
  shuttingDown = false;
  private updateCount = 0;
  private lastTargetKey = "";
  private lastDropDiagnostics: Record<string, unknown> | null = null;

  snapshot(): UnitState {
    return structuredClone({
      workspaces: this.workspaces,
      appletSessions: this.appletSessions,
      tabs: this.tabs,
      hosts: this.hosts,
      primaryWindowId: this.primaryWindowId,
      dragSession: this.dragSession
    });
  }

  registerWindow(windowId: number, options: { primary?: boolean; tabId?: string } = {}): void {
    const isFirst = this.primaryWindowId === 0 || Boolean(options.primary);
    if (isFirst) {
      this.primaryWindowId = windowId;
    }
    if (this.hosts[windowId]) {
      return;
    }
    if (options.tabId) {
      this.removeTabFromAllHosts(options.tabId);
      this.hosts[windowId] = {
        windowId,
        tabIds: [options.tabId],
        activeTabId: options.tabId,
        isPrimary: false
      };
      debugLog("registry.window.register", {
        windowId,
        primary: false,
        tabId: options.tabId,
        host: this.hosts[windowId]
      });
      return;
    }
    const tabIds = isFirst ? ["tab-manager", "tab-atlas", "tab-redesign", "tab-lab", "tab-research"] : [];
    this.hosts[windowId] = {
      windowId,
      tabIds,
      activeTabId: tabIds.includes("tab-atlas") ? "tab-atlas" : (tabIds[0] ?? ""),
      isPrimary: isFirst
    };
    debugLog("registry.window.register", {
      windowId,
      primary: isFirst,
      tabIds,
      activeTabId: this.hosts[windowId].activeTabId
    });
  }

  activate(windowId: number, tabId: string): void {
    const host = this.hosts[windowId];
    if (!host || !host.tabIds.includes(tabId) || this.dragSession) {
      return;
    }
    host.activeTabId = tabId;
  }

  registerStripBounds(payload: RegisterStripBoundsPayload): void {
    const normalized = normalizeStripBounds(payload);
    this.stripBounds.set(payload.windowId, normalized);
    const logPayload = {
      windowId: normalized.windowId,
      rawBounds: rectDebug(payload.bounds),
      bounds: rectDebug(normalized.bounds),
      correction: stripCorrection(payload.windowId),
      hostTabIds: this.hosts[normalized.windowId]?.tabIds ?? [],
      activeTabId: this.hosts[normalized.windowId]?.activeTabId ?? null,
      metrics: normalized.tabMetrics.map((metric) => ({
        tabId: metric.tabId,
        left: Math.round(metric.left),
        width: Math.round(metric.width),
        center: Math.round(metric.left + metric.width / 2)
      }))
    };
    const debugKey = JSON.stringify(logPayload);
    if (TAB_DEBUG_VERBOSE || stripDebugKeys.get(normalized.windowId) !== debugKey) {
      stripDebugKeys.set(normalized.windowId, debugKey);
      debugLog("strip.bounds.register", logPayload);
    }
    alignPendingWindow(normalized);
  }

  beginDrag(payload: BeginTabDragPayload): boolean {
    if (this.dragSession) {
      debugLog("drag.begin.reject.active-session", { payload });
      return false;
    }
    const tab = this.tabs[payload.tabId];
    const sourceHost = this.hosts[payload.sourceWindowId];
    if (!tab || tab.pinned || !sourceHost) {
      debugLog("drag.begin.reject.invalid-source", {
        payload,
        tabExists: Boolean(tab),
        pinned: tab?.pinned ?? null,
        sourceHostExists: Boolean(sourceHost)
      });
      return false;
    }
    const originalIndex = sourceHost.tabIds.indexOf(payload.tabId);
    if (originalIndex === -1) {
      debugLog("drag.begin.reject.tab-not-in-source", {
        payload,
        sourceTabIds: sourceHost.tabIds
      });
      return false;
    }
    const previousActiveByWindow = Object.fromEntries(
      Object.values(this.hosts).map((host) => [host.windowId, host.activeTabId])
    );
    this.dragSession = {
      tabId: payload.tabId,
      sourceWindowId: payload.sourceWindowId,
      ownerWindowId: payload.sourceWindowId,
      originalIndex,
      touchedHostSnapshots: {},
      previousActiveByWindow,
      hotSpot: { x: payload.hotSpotX, y: payload.hotSpotY },
      currentScreen: { x: payload.screenX, y: payload.screenY },
      currentTarget: null,
      floating: false,
      finishing: false
    };
    this.updateCount = 0;
    this.lastTargetKey = "";
    debugLog("drag.begin.accept", {
      tabId: payload.tabId,
      title: tab.title,
      sourceWindowId: payload.sourceWindowId,
      sourceTabIds: sourceHost.tabIds,
      originalIndex,
      start: pointDebug({ screenX: payload.screenX, screenY: payload.screenY }),
      hotSpot: pointDebug({ x: payload.hotSpotX, y: payload.hotSpotY }),
      stripWindows: [...this.stripBounds.keys()]
    });
    this.updateDrag({ screenX: payload.screenX, screenY: payload.screenY });
    return true;
  }

  updateDrag(payload: UpdateTabDragPayload): DragUpdateResult {
    const session = this.dragSession;
    if (!session || session.finishing) {
      return { closeWindowIds: [], captureOverlayPointer: false, stateChanged: false, targetChanged: false };
    }
    session.currentScreen = { x: payload.screenX, y: payload.screenY };
    const target = this.validTarget(this.dropTargetFor(payload.screenX, payload.screenY));
    session.currentTarget = target;
    session.floating = target === null;
    this.updateCount += 1;
    const nextKey = target ? `${target.windowId}:${target.insertionIndex}` : "floating";
    const targetChanged = nextKey !== this.lastTargetKey;
    if (targetChanged || this.updateCount % 12 === 0) {
      debugLog("drag.update.target", {
        count: this.updateCount,
        tabId: session.tabId,
        point: pointDebug({ screenX: payload.screenX, screenY: payload.screenY }),
        floating: session.floating,
        target: target
          ? {
              windowId: target.windowId,
              insertionIndex: target.insertionIndex,
              screenRect: rectDebug(target.screenRect),
              targetHostTabIds: this.hosts[target.windowId]?.tabIds ?? []
            }
          : null,
        ownerWindowId: session.ownerWindowId,
        diagnostics: this.lastDropDiagnostics
      });
      this.lastTargetKey = nextKey;
    }
    const earlyCloseResult = this.maybeCloseEmptyDetachedSourceDuringDrag();
    return { ...earlyCloseResult, targetChanged };
  }

  finishDrag(payload: FinishTabDragPayload): DragFinishResult {
    const session = this.dragSession;
    if (!session || session.finishing) {
      return { action: "none", closeWindowIds: [] };
    }
    const updateResult = this.updateDrag({ screenX: payload.screenX, screenY: payload.screenY });
    session.finishing = true;
    const target = this.validTarget(session.currentTarget);
    debugLog("drag.finish.start", {
      tabId: session.tabId,
      point: pointDebug({ screenX: payload.screenX, screenY: payload.screenY }),
      target: target
        ? { windowId: target.windowId, insertionIndex: target.insertionIndex, screenRect: rectDebug(target.screenRect) }
        : null,
      floating: !target,
      diagnostics: this.lastDropDiagnostics
    });
    if (target) {
      this.moveDraggedTabTo(target.windowId, target.insertionIndex);
      const closeWindowIds = uniqueWindowIds([...this.emptyDetachedWindowIds(), ...updateResult.closeWindowIds]);
      this.dragSession = null;
      debugLog("drag.finish.attach", {
        tabId: session.tabId,
        targetWindowId: target.windowId,
        insertionIndex: target.insertionIndex,
        targetTabIds: this.hosts[target.windowId]?.tabIds ?? [],
        closeWindowIds
      });
      return { action: "none", closeWindowIds };
    }
    this.floatDraggedTab();
    const closeWindowIds = uniqueWindowIds([...this.emptyDetachedWindowIds(), ...updateResult.closeWindowIds]);
    const result = {
      action: "create-window" as const,
      tabId: session.tabId,
      x: Math.round(payload.screenX - Math.max(20, session.hotSpot.x)),
      y: Math.round(payload.screenY - Math.max(18, session.hotSpot.y)),
      closeWindowIds
    };
    this.dragSession = null;
    debugLog("drag.finish.detach", {
      tabId: session.tabId,
      createAt: { x: result.x, y: result.y },
      release: pointDebug({ screenX: payload.screenX, screenY: payload.screenY }),
      hotSpot: pointDebug(session.hotSpot),
      closeWindowIds
    });
    return result;
  }

  cancelDrag(): void {
    const session = this.dragSession;
    if (!session || session.finishing) {
      return;
    }
    session.finishing = true;
    debugLog("drag.cancel", {
      tabId: session.tabId,
      touchedHosts: Object.keys(session.touchedHostSnapshots),
      point: pointDebug(session.currentScreen),
      target: session.currentTarget
    });
    for (const [windowIdText, snapshot] of Object.entries(session.touchedHostSnapshots)) {
      const windowId = Number(windowIdText);
      if (earlyClosedDragSourceWindowIds.has(windowId)) {
        continue;
      }
      const host = this.hosts[windowId];
      if (!host) {
        continue;
      }
      host.tabIds = [...snapshot.tabIds];
      host.activeTabId = snapshot.activeTabId;
      this.normalizeHost(host);
    }
    if (this.findOwner(session.tabId) === null) {
      const primary = this.hosts[this.primaryWindowId];
      if (primary && !primary.tabIds.includes(session.tabId)) {
        primary.tabIds.push(session.tabId);
        this.normalizeHost(primary);
      }
    }
    earlyClosedDragSourceWindowIds.clear();
    this.dragSession = null;
  }

  closeTab(payload: CloseTabPayload): { closeWindowIds: number[] } {
    const tab = this.tabs[payload.tabId];
    const host = this.hosts[payload.windowId];
    if (!tab || tab.pinned || !tab.closable || !host || this.dragSession) {
      return { closeWindowIds: [] };
    }
    host.tabIds = host.tabIds.filter((id) => id !== payload.tabId);
    this.normalizeHost(host);
    return { closeWindowIds: this.shouldCloseEmptyDetached(payload.windowId) ? [payload.windowId] : [] };
  }

  windowClosed(windowId: number): void {
    this.stripBounds.delete(windowId);
    const session = this.dragSession;
    const isEarlyClosedDragSource = earlyClosedDragSourceWindowIds.delete(windowId);
    if (session) {
      const ownsDrag = session.ownerWindowId === windowId || session.sourceWindowId === windowId;
      if (ownsDrag && !isEarlyClosedDragSource) {
        this.cancelDrag();
        hideCaptureOverlays();
      } else {
        delete session.touchedHostSnapshots[windowId];
      }
    }
    const host = this.hosts[windowId];
    delete this.hosts[windowId];
    if (!host || this.shuttingDown || isEarlyClosedDragSource) {
      return;
    }
    if (windowId === this.primaryWindowId) {
      this.shuttingDown = true;
      return;
    }
    const primary = this.hosts[this.primaryWindowId];
    if (!primary) {
      return;
    }
    for (const tabId of host.tabIds) {
      if (!primary.tabIds.includes(tabId)) {
        primary.tabIds.push(tabId);
      }
    }
    this.normalizeHost(primary);
  }

  beginShutdown(): number[] {
    this.shuttingDown = true;
    this.dragSession = null;
    hideCaptureOverlays();
    return Object.keys(this.hosts)
      .map((value) => Number(value))
      .filter((windowId) => windowId !== this.primaryWindowId);
  }

  private moveDraggedTabTo(targetWindowId: number, targetIndex: number): void {
    const session = this.dragSession;
    const targetHost = this.hosts[targetWindowId];
    if (!session || !targetHost) {
      return;
    }
    const currentOwner = this.findOwner(session.tabId);
    const insertAt = this.clampedInsertionIndex(targetHost, targetIndex, session.tabId);
    if (currentOwner === targetWindowId && targetHost.tabIds.indexOf(session.tabId) === insertAt) {
      session.ownerWindowId = targetWindowId;
      session.floating = false;
      debugLog("drag.move.noop", {
        tabId: session.tabId,
        targetWindowId,
        targetIndex,
        insertAt,
        tabIds: targetHost.tabIds
      });
      return;
    }
    if (currentOwner !== null) {
      this.snapshotHost(currentOwner);
      const ownerHost = this.hosts[currentOwner];
      ownerHost.tabIds = ownerHost.tabIds.filter((id) => id !== session.tabId);
      this.restorePreviousActive(ownerHost);
    }
    this.snapshotHost(targetWindowId);
    targetHost.tabIds = targetHost.tabIds.filter((id) => id !== session.tabId);
    targetHost.tabIds.splice(insertAt, 0, session.tabId);
    this.normalizeHost(targetHost);
    this.restorePreviousActive(targetHost);
    session.ownerWindowId = targetWindowId;
    session.floating = false;
    debugLog("drag.move.commit", {
      tabId: session.tabId,
      fromWindowId: currentOwner,
      targetWindowId,
      targetIndex,
      insertAt,
      targetTabIds: targetHost.tabIds,
      sourceTabIds: currentOwner !== null ? (this.hosts[currentOwner]?.tabIds ?? null) : null
    });
  }

  private floatDraggedTab(): void {
    const session = this.dragSession;
    if (!session) {
      return;
    }
    const owner = this.findOwner(session.tabId);
    if (owner !== null) {
      this.snapshotHost(owner);
      const host = this.hosts[owner];
      host.tabIds = host.tabIds.filter((id) => id !== session.tabId);
      this.restorePreviousActive(host);
    }
    session.ownerWindowId = null;
    session.floating = true;
    session.currentTarget = null;
    debugLog("drag.float.commit", {
      tabId: session.tabId,
      previousOwner: owner,
      remainingTabIds: owner !== null ? (this.hosts[owner]?.tabIds ?? []) : []
    });
  }

  private maybeCloseEmptyDetachedSourceDuringDrag(): DragUpdateResult {
    const session = this.dragSession;
    if (!session) {
      return { closeWindowIds: [], captureOverlayPointer: false, stateChanged: false, targetChanged: false };
    }
    const sourceHost = this.hosts[session.sourceWindowId];
    if (
      !sourceHost ||
      sourceHost.isPrimary ||
      sourceHost.tabIds.length !== 1 ||
      sourceHost.tabIds[0] !== session.tabId ||
      session.currentTarget?.windowId === session.sourceWindowId ||
      earlyClosedDragSourceWindowIds.has(session.sourceWindowId)
    ) {
      return { closeWindowIds: [], captureOverlayPointer: false, stateChanged: false, targetChanged: false };
    }
    this.snapshotHost(session.sourceWindowId);
    sourceHost.tabIds = [];
    sourceHost.activeTabId = "";
    session.ownerWindowId = null;
    earlyClosedDragSourceWindowIds.add(session.sourceWindowId);
    debugLog("drag.source.empty-detached-close", {
      tabId: session.tabId,
      sourceWindowId: session.sourceWindowId,
      target: session.currentTarget
        ? {
            windowId: session.currentTarget.windowId,
            insertionIndex: session.currentTarget.insertionIndex,
            screenRect: rectDebug(session.currentTarget.screenRect)
          }
        : null,
      floating: session.floating,
      point: pointDebug(session.currentScreen)
    });
    return { closeWindowIds: [session.sourceWindowId], captureOverlayPointer: true, stateChanged: true, targetChanged: false };
  }

  private snapshotHost(windowId: number): void {
    const session = this.dragSession;
    const host = this.hosts[windowId];
    if (!session || !host || session.touchedHostSnapshots[windowId]) {
      return;
    }
    session.touchedHostSnapshots[windowId] = {
      tabIds: [...host.tabIds],
      activeTabId: host.activeTabId
    };
    debugLog("drag.snapshot.host", {
      tabId: session.tabId,
      windowId,
      tabIds: host.tabIds,
      activeTabId: host.activeTabId
    });
  }

  private restorePreviousActive(host: TabHostState): void {
    const session = this.dragSession;
    const previous = session?.previousActiveByWindow[host.windowId];
    this.normalizeHost(host);
    if (previous && host.tabIds.includes(previous)) {
      host.activeTabId = previous;
    }
  }

  private validTarget(target: TabDropTarget | null): TabDropTarget | null {
    if (!target) {
      return null;
    }
    const host = this.hosts[target.windowId];
    const browserWindow = windows.get(target.windowId);
    if (!host || !browserWindow || browserWindow.isDestroyed()) {
      return null;
    }
    return {
      ...target,
      insertionIndex: this.clampedInsertionIndex(host, target.insertionIndex, this.dragSession?.tabId)
    };
  }

  private dropTargetFor(screenX: number, screenY: number): TabDropTarget | null {
    const candidates: TabDropTarget[] = [];
    const session = this.dragSession;
    const dragRect = session
      ? {
          left: screenX - session.hotSpot.x,
          top: screenY - session.hotSpot.y,
          right: screenX - session.hotSpot.x + TAB_PREVIEW_SIZE.width,
          bottom: screenY - session.hotSpot.y + TAB_PREVIEW_SIZE.height
        }
      : null;
    const strips: Array<Record<string, unknown>> = [];
    for (const strip of this.stripBounds.values()) {
      const expanded = this.expandRect(strip.bounds, DROP_SLOP);
      const pointerInside = this.pointInRect(screenX, screenY, expanded);
      const ghostIntersects = Boolean(dragRect && this.rectsIntersect(dragRect, expanded));
      const insertionIndex = this.insertionIndexFor(strip, screenX);
      strips.push({
        windowId: strip.windowId,
        bounds: rectDebug(strip.bounds),
        expanded: rectDebug(expanded),
        pointerInside,
        ghostIntersects,
        insertionIndex,
        hostTabIds: this.hosts[strip.windowId]?.tabIds ?? [],
        metrics: strip.tabMetrics.map((metric) => ({
          tabId: metric.tabId,
          left: Math.round(metric.left),
          width: Math.round(metric.width),
          center: Math.round(metric.left + metric.width / 2)
        }))
      });
      if (!pointerInside && !ghostIntersects) {
        continue;
      }
      candidates.push({
        windowId: strip.windowId,
        insertionIndex,
        screenRect: strip.bounds
      });
    }
    candidates.sort((left, right) => {
      const leftCenter = this.rectCenter(left.screenRect);
      const rightCenter = this.rectCenter(right.screenRect);
      return (
        (leftCenter.x - screenX) ** 2 +
        (leftCenter.y - screenY) ** 2 -
        ((rightCenter.x - screenX) ** 2 + (rightCenter.y - screenY) ** 2)
      );
    });
    const selected = candidates[0] ?? null;
    this.lastDropDiagnostics = {
      point: pointDebug({ screenX, screenY }),
      ghostRect: rectDebug(dragRect ?? undefined),
      stripCount: this.stripBounds.size,
      candidateCount: candidates.length,
      selected: selected ? { windowId: selected.windowId, insertionIndex: selected.insertionIndex } : null,
      strips
    };
    return selected;
  }

  private insertionIndexFor(strip: RegisterStripBoundsPayload, screenX: number): number {
    const host = this.hosts[strip.windowId];
    const draggedTabId = this.dragSession?.tabId;
    if (!host) {
      return 0;
    }
    const candidateOrder = host.tabIds.filter((tabId) => tabId !== draggedTabId);
    for (const tabId of candidateOrder) {
      const metric = strip.tabMetrics.find((item) => item.tabId === tabId);
      if (!metric) {
        continue;
      }
      const center = metric.left + metric.width / 2;
      if (screenX < center) {
        const index = this.clampedInsertionIndex(host, candidateOrder.indexOf(tabId), draggedTabId);
        if (TAB_DEBUG_VERBOSE) {
          debugLog("drag.insertion.before-center", {
            windowId: strip.windowId,
            screenX: Math.round(screenX),
            beforeTabId: tabId,
            center: Math.round(center),
            candidateOrder,
            draggedTabId,
            index
          });
        }
        return index;
      }
    }
    const index = this.clampedInsertionIndex(host, candidateOrder.length, draggedTabId);
    if (TAB_DEBUG_VERBOSE) {
      debugLog("drag.insertion.end", {
        windowId: strip.windowId,
        screenX: Math.round(screenX),
        candidateOrder,
        draggedTabId,
        index
      });
    }
    return index;
  }

  private clampedInsertionIndex(host: TabHostState, targetIndex: number, draggedTabId?: string): number {
    const orderWithoutDragged = host.tabIds.filter((tabId) => tabId !== draggedTabId);
    const firstMovable = this.firstMovableIndex({ ...host, tabIds: orderWithoutDragged });
    return Math.max(firstMovable, Math.min(targetIndex, orderWithoutDragged.length));
  }

  private firstMovableIndex(host: TabHostState): number {
    const index = host.tabIds.findIndex((tabId) => !this.tabs[tabId]?.pinned);
    return index === -1 ? host.tabIds.length : index;
  }

  private normalizeHost(host: TabHostState): void {
    if (host.isPrimary && !host.tabIds.includes("tab-manager")) {
      host.tabIds.unshift("tab-manager");
    }
    const movable = host.tabIds.filter((tabId) => !this.tabs[tabId]?.pinned);
    host.tabIds = host.isPrimary ? ["tab-manager", ...movable.filter((id) => id !== "tab-manager")] : movable;
    if (!host.tabIds.includes(host.activeTabId)) {
      host.activeTabId = host.tabIds.find((tabId) => !this.tabs[tabId]?.pinned) ?? host.tabIds[0] ?? "";
    }
  }

  private removeTabFromAllHosts(tabId: string): void {
    for (const host of Object.values(this.hosts)) {
      host.tabIds = host.tabIds.filter((id) => id !== tabId);
      this.normalizeHost(host);
    }
  }

  private findOwner(tabId: string): number | null {
    for (const host of Object.values(this.hosts)) {
      if (host.tabIds.includes(tabId)) {
        return host.windowId;
      }
    }
    return null;
  }

  private emptyDetachedWindowIds(): number[] {
    return Object.values(this.hosts)
      .filter((host) => this.shouldCloseEmptyDetached(host.windowId))
      .map((host) => host.windowId);
  }

  private shouldCloseEmptyDetached(windowId: number): boolean {
    const host = this.hosts[windowId];
    return Boolean(host && !host.isPrimary && host.tabIds.length === 0);
  }

  private pointInRect(x: number, y: number, rect: RectLike): boolean {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private rectsIntersect(left: RectLike, right: RectLike): boolean {
    return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
  }

  private expandRect(rect: RectLike, slop: typeof DROP_SLOP): RectLike {
    return {
      left: rect.left - slop.left,
      top: rect.top - slop.top,
      right: rect.right + slop.right,
      bottom: rect.bottom + slop.bottom
    };
  }

  private rectCenter(rect: RectLike): { x: number; y: number } {
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  }
}

const registry = new TabRegistry();

function payloadFor(windowId: number): BootstrapPayload {
  return { windowId, state: registry.snapshot() };
}

function stripCorrection(windowId: number): { dx: number; dy: number } {
  const browserWindow = windows.get(windowId);
  if (!browserWindow || browserWindow.isDestroyed()) {
    return { dx: 0, dy: 0 };
  }
  const outer = browserWindow.getBounds();
  const content = browserWindow.getContentBounds();
  return {
    dx: content.x - outer.x,
    dy: content.y - outer.y
  };
}

function normalizeStripBounds(payload: RegisterStripBoundsPayload): RegisterStripBoundsPayload {
  const correction = stripCorrection(payload.windowId);
  if (correction.dx === 0 && correction.dy === 0) {
    return payload;
  }
  return {
    ...payload,
    bounds: {
      left: payload.bounds.left + correction.dx,
      top: payload.bounds.top + correction.dy,
      right: payload.bounds.right + correction.dx,
      bottom: payload.bounds.bottom + correction.dy
    },
    tabMetrics: payload.tabMetrics.map((metric) => ({
      ...metric,
      left: metric.left + correction.dx
    }))
  };
}

function broadcastState(): void {
  if (dragBroadcastTimer) {
    clearTimeout(dragBroadcastTimer);
    dragBroadcastTimer = null;
  }
  for (const [windowId, browserWindow] of windows) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.webContents.send("unit:state-changed", payloadFor(windowId));
    }
  }
}

function scheduleDragBroadcast(): void {
  if (dragBroadcastTimer) {
    return;
  }
  dragBroadcastTimer = setTimeout(() => {
    dragBroadcastTimer = null;
    broadcastState();
  }, 16);
}

async function loadRenderer(browserWindow: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await browserWindow.loadURL(devServerUrl);
    return;
  }
  await browserWindow.loadFile(rendererEntry);
}

function createWindow(options: { tabId?: string; x?: number; y?: number; primary?: boolean } = {}): BrowserWindow {
  const display = screen.getDisplayNearestPoint({ x: Math.round(options.x ?? 120), y: Math.round(options.y ?? 120) });
  const browserWindow = new BrowserWindow({
    show: !HIDE_TEST_WINDOWS,
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    x: Math.round(options.x ?? display.workArea.x + 80),
    y: Math.round(options.y ?? display.workArea.y + 80),
    title: "UNIT-0",
    backgroundColor: "#f5f6f8",
    autoHideMenuBar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });
  windows.set(browserWindow.id, browserWindow);
  registry.registerWindow(browserWindow.id, { primary: options.primary, tabId: options.tabId });
  browserWindow.webContents.once("did-finish-load", () => {
    browserWindow.webContents.send("unit:window-registered", browserWindow.id);
    browserWindow.webContents.send("unit:state-changed", payloadFor(browserWindow.id));
  });
  browserWindow.on("close", () => {
    if (browserWindow.id === registry.primaryWindowId) {
      for (const windowId of registry.beginShutdown()) {
        windows.get(windowId)?.close();
      }
      destroyCaptureOverlays();
    }
  });
  browserWindow.on("closed", () => {
    windows.delete(browserWindow.id);
    const pending = pendingAlignments.get(browserWindow.id);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAlignments.delete(browserWindow.id);
    }
    registry.windowClosed(browserWindow.id);
    broadcastState();
  });
  void loadRenderer(browserWindow);
  return browserWindow;
}

function handleDragFinish(result: DragFinishResult, alignment?: Omit<PendingAlignment, "timeout" | "closeWindowIds">): void {
  debugLog("drag.finish.handle-result", {
    result,
    alignment: alignment
      ? {
          tabId: alignment.tabId,
          screenX: alignment.screenX,
          screenY: alignment.screenY,
          hotSpot: alignment.hotSpot
        }
      : null
  });
  if (result.action === "create-window") {
    const browserWindow = createWindow({ tabId: result.tabId, x: result.x, y: result.y });
    if (alignment) {
      const timeout = setTimeout(() => {
        pendingAlignments.delete(browserWindow.id);
        closeEmptyWindows(result.closeWindowIds);
        closeDragWindows();
        debugLog("drag.detach.align.timeout", {
          windowId: browserWindow.id,
          tabId: result.tabId
        });
      }, 350);
      pendingAlignments.set(browserWindow.id, { ...alignment, closeWindowIds: result.closeWindowIds, timeout });
      return;
    }
  }
  closeEmptyWindows(result.closeWindowIds);
  closeDragWindows();
}

function closeEmptyWindows(windowIds: number[]): void {
  for (const windowId of windowIds) {
    windows.get(windowId)?.close();
  }
}

function closeEarlyDragSourceWindows(result: DragUpdateResult): void {
  closeEmptyWindows(result.closeWindowIds);
}

function publishDragUpdate(result: DragUpdateResult): void {
  if (result.captureOverlayPointer || result.stateChanged || result.targetChanged) {
    broadcastState();
    return;
  }
  scheduleDragBroadcast();
}

function syncDragOverlayState(reason: string): void {
  const session = registry.dragSession;
  const shouldShow = Boolean(session?.floating);
  const shouldCapture = Boolean(session && session.ownerWindowId === null && session.floating);
  const visibilityChanged = shouldShow !== overlayWindowsVisible;
  const captureChanged = shouldCapture !== overlayPointerCapturing;
  if (!visibilityChanged && !captureChanged) {
    return;
  }
  overlayWindowsVisible = shouldShow;
  overlayPointerCapturing = shouldCapture;
  debugLog("overlay.state.sync", {
    reason,
    overlayCount: captureOverlays.size,
    visible: shouldShow,
    capturePointer: shouldCapture,
    tabId: session?.tabId ?? null,
    floating: session?.floating ?? null,
    targetWindowId: session?.currentTarget?.windowId ?? null
  });
  for (const overlay of captureOverlays.values()) {
    if (!overlay.isDestroyed()) {
      overlay.setIgnoreMouseEvents(!shouldCapture);
      overlay.webContents.send("drag:capture", { visible: shouldShow, capture: shouldCapture });
      if (shouldShow) {
        overlay.showInactive();
      } else {
        overlay.hide();
      }
    }
  }
}

function alignPendingWindow(payload: RegisterStripBoundsPayload): void {
  const pending = pendingAlignments.get(payload.windowId);
  if (!pending) {
    return;
  }
  const metric = payload.tabMetrics.find((item) => item.tabId === pending.tabId);
  const browserWindow = windows.get(payload.windowId);
  if (!metric || !browserWindow || browserWindow.isDestroyed()) {
    debugLog("drag.detach.align.waiting", {
      windowId: payload.windowId,
      tabId: pending.tabId,
      hasMetric: Boolean(metric),
      hasWindow: Boolean(browserWindow),
      destroyed: browserWindow?.isDestroyed() ?? null,
      metrics: payload.tabMetrics
    });
    return;
  }
  const desiredLeft = pending.screenX - pending.hotSpot.x;
  const desiredTop = pending.screenY - pending.hotSpot.y;
  const currentBounds = browserWindow.getBounds();
  browserWindow.setPosition(
    Math.round(currentBounds.x + desiredLeft - metric.left),
    Math.round(currentBounds.y + desiredTop - payload.bounds.top)
  );
  debugLog("drag.detach.align.success", {
    windowId: payload.windowId,
    tabId: pending.tabId,
    release: { x: pending.screenX, y: pending.screenY },
    hotSpot: pending.hotSpot,
    desiredLeft: Math.round(desiredLeft),
    desiredTop: Math.round(desiredTop),
    metric: { tabId: metric.tabId, left: Math.round(metric.left), width: Math.round(metric.width) },
    stripBounds: rectDebug(payload.bounds),
    oldWindowBounds: rectDebug(currentBounds),
    newWindowBounds: rectDebug(browserWindow.getBounds())
  });
  clearTimeout(pending.timeout);
  pendingAlignments.delete(payload.windowId);
  closeEmptyWindows(pending.closeWindowIds);
  closeDragWindows();
}

async function createCaptureOverlays(): Promise<boolean> {
  if (process.env.NODE_ENV === "test") {
    debugLog("overlay.capture.disabled-in-test");
    return false;
  }
  const lifecycleId = ++dragLifecycleId;
  const created: BrowserWindow[] = [];
  const session = registry.dragSession;
  const tab = session ? registry.tabs[session.tabId] : null;
  const displays = screen.getAllDisplays();
  debugLog("overlay.capture.create.start", {
    lifecycleId,
    existingCount: captureOverlays.size,
    displayCount: displays.length,
    tabId: session?.tabId ?? null,
    title: tab?.title ?? null
  });
  if (captureOverlays.size > 0) {
    for (const display of displays) {
      const overlay = captureOverlays.get(display.id);
      if (!overlay || overlay.isDestroyed()) {
        continue;
      }
      overlay.setBounds(display.bounds);
      overlay.webContents.send("drag:start", overlayDragPayload(display.bounds, session, tab));
      overlay.setIgnoreMouseEvents(true);
      if (session?.floating) {
        overlay.showInactive();
        overlayWindowsVisible = true;
      } else {
        overlay.hide();
        overlayWindowsVisible = false;
      }
      debugLog("overlay.capture.reuse.show", {
        lifecycleId,
        displayId: display.id,
        visible: Boolean(session?.floating),
        bounds: rectDebug(display.bounds)
      });
    }
    return true;
  }
  for (const display of displays) {
    const overlay = new BrowserWindow({
      show: false,
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: { contextIsolation: false, nodeIntegration: true }
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setIgnoreMouseEvents(true);
    captureOverlays.set(display.id, overlay);
    created.push(overlay);
    debugLog("overlay.capture.create.window", {
      lifecycleId,
      displayId: display.id,
      bounds: rectDebug(display.bounds)
    });
    void overlay.loadURL(captureOverlayDataUrl(overlayDragPayload(display.bounds, session, tab)));
  }
  await Promise.all(
    created.map(
      (overlay) =>
        new Promise<void>((resolve) => {
          overlay.webContents.once("did-finish-load", () => resolve());
        })
    )
  );
  debugLog("overlay.capture.create.loaded", { lifecycleId, createdCount: created.length });
  for (const overlay of created) {
    if (overlay.isDestroyed()) {
      continue;
    }
    if (!registry.dragSession || lifecycleId !== dragLifecycleId) {
      debugLog("overlay.capture.create.stale-hide", {
        lifecycleId,
        currentLifecycleId: dragLifecycleId,
        hasDragSession: Boolean(registry.dragSession)
      });
      overlay.webContents.send("drag:end");
      overlay.setIgnoreMouseEvents(true);
      overlay.hide();
      continue;
    }
    overlay.setIgnoreMouseEvents(true);
    if (registry.dragSession.floating) {
      overlay.showInactive();
      overlayWindowsVisible = true;
    } else {
      overlay.hide();
      overlayWindowsVisible = false;
    }
    debugLog("overlay.capture.create.show", {
      lifecycleId,
      overlayId: overlay.id,
      visible: registry.dragSession.floating
    });
  }
  return true;
}

function sendOverlayMove(payload: UpdateTabDragPayload): void {
  const visual = overlayVisualPayload(payload);
  for (const overlay of captureOverlays.values()) {
    if (!overlay.isDestroyed()) {
      overlay.webContents.send("drag:move", visual);
    }
  }
}

function overlayVisualPayload(payload: UpdateTabDragPayload): UpdateTabDragPayload & { visible: boolean; docked: boolean } {
  const session = registry.dragSession;
  if (!session) {
    return { ...payload, visible: false, docked: false };
  }
  return {
    ...payload,
    visible: session.floating,
    docked: false
  };
}

function overlayDragPayload(bounds: Electron.Rectangle, session: TabDragSession | null, tab: WorkspaceTab | null) {
  return {
    displayX: bounds.x,
    displayY: bounds.y,
    initialScreenX: session?.currentScreen.x ?? bounds.x,
    initialScreenY: session?.currentScreen.y ?? bounds.y,
    hotSpotX: session?.hotSpot.x ?? 0,
    hotSpotY: session?.hotSpot.y ?? 0,
    visible: session?.floating ?? false,
    title: tab?.title ?? ""
  };
}

function hideCaptureOverlays(): void {
  dragLifecycleId += 1;
  overlayPointerCapturing = false;
  overlayWindowsVisible = false;
  debugLog("overlay.capture.hide", {
    lifecycleId: dragLifecycleId,
    overlayCount: captureOverlays.size
  });
  for (const overlay of captureOverlays.values()) {
    if (!overlay.isDestroyed()) {
      overlay.webContents.send("drag:end");
      overlay.setIgnoreMouseEvents(true);
      overlay.hide();
    }
  }
}

function destroyCaptureOverlays(): void {
  dragLifecycleId += 1;
  overlayPointerCapturing = false;
  overlayWindowsVisible = false;
  debugLog("overlay.capture.destroy", {
    lifecycleId: dragLifecycleId,
    overlayCount: captureOverlays.size
  });
  for (const overlay of captureOverlays.values()) {
    if (!overlay.isDestroyed()) {
      overlay.close();
    }
  }
  captureOverlays.clear();
}

function closeDragWindows(): void {
  if (dragBroadcastTimer) {
    clearTimeout(dragBroadcastTimer);
    dragBroadcastTimer = null;
  }
  hideCaptureOverlays();
}

function finishDragAt(payload: FinishTabDragPayload): void {
  const session = registry.dragSession;
  const result = registry.finishDrag(payload);
  handleDragFinish(
    result,
    session ? { tabId: session.tabId, screenX: payload.screenX, screenY: payload.screenY, hotSpot: session.hotSpot } : undefined
  );
  broadcastState();
}

function captureOverlayDataUrl(options: ReturnType<typeof overlayDragPayload>): string {
  const safeTitle = escapeHtml(options.title);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>
html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden;font-family:Segoe UI,Arial,sans-serif}
.tab{position:fixed;left:0;top:0;display:${options.visible ? "grid" : "none"};grid-template-columns:16px minmax(0,1fr) 16px;align-items:center;gap:8px;width:${TAB_PREVIEW_SIZE.width}px;height:${TAB_PREVIEW_SIZE.height}px;padding:0 10px 0 14px;border:1px solid #9ab7ff;border-radius:6px;background:rgba(255,255,255,.97);color:#121821;font-weight:600;box-shadow:0 12px 30px rgba(38,67,118,.22);will-change:transform;pointer-events:none}
.dot{width:12px;height:12px;border:1px solid #6f7a8c;border-radius:3px}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.x{opacity:.55}
</style></head><body><div class="tab" id="ghost"><span class="dot"></span><span class="title">${safeTitle}</span><span class="x">x</span></div><script>
const { ipcRenderer } = require("electron");
let drag = ${JSON.stringify(options)};
const ghost = document.getElementById("ghost");
let lastPoint = { screenX: drag.initialScreenX, screenY: drag.initialScreenY };
let updateScheduled = false;
let captureActive = false;
function point(event){ return { screenX: event.screenX, screenY: event.screenY }; }
function renderGhost(value){
  ghost.style.transform = "translate3d(" + (value.screenX - drag.displayX - drag.hotSpotX) + "px," + (value.screenY - drag.displayY - drag.hotSpotY) + "px,0)";
}
function setVisible(visible){ ghost.style.display = visible ? "grid" : "none"; }
function setTitle(title){ ghost.querySelector(".title").textContent = title || ""; }
function sendUpdate(){
  updateScheduled = false;
  ipcRenderer.send("tabs:updateDragFast", lastPoint);
}
function scheduleUpdate(){
  if (updateScheduled) return;
  updateScheduled = true;
  requestAnimationFrame(sendUpdate);
}
ipcRenderer.on("drag:start", (_event, payload) => {
  drag = payload;
  lastPoint = { screenX: drag.initialScreenX, screenY: drag.initialScreenY };
  setTitle(drag.title);
  renderGhost(lastPoint);
  setVisible(Boolean(drag.visible));
  ipcRenderer.send("debug:log", { source: "overlay", event: "overlay.drag.start", drag });
});
ipcRenderer.on("drag:end", () => {
  captureActive = false;
  setVisible(false);
  ipcRenderer.send("debug:log", { source: "overlay", event: "overlay.drag.end", lastPoint });
});
ipcRenderer.on("drag:capture", (_event, payload) => {
  captureActive = Boolean(payload.capture);
  setVisible(Boolean(payload.visible));
  ipcRenderer.send("debug:log", { source: "overlay", event: "overlay.drag.capture", lastPoint, payload });
});
renderGhost(lastPoint);
let moveCount = 0;
window.addEventListener("pointermove", event => {
  lastPoint = point(event);
  renderGhost(lastPoint);
  moveCount += 1;
  if (captureActive) {
    scheduleUpdate();
  }
});
window.addEventListener("pointerup", event => {
  if (!captureActive) return;
  lastPoint = point(event);
  renderGhost(lastPoint);
  ipcRenderer.send("tabs:finishDragFast", lastPoint);
});
window.addEventListener("pointercancel", event => {
  if (!captureActive) return;
  lastPoint = point(event);
  ipcRenderer.send("tabs:cancelDragFast");
});
window.addEventListener("keydown", event => {
  if (captureActive && event.key === "Escape") {
    ipcRenderer.send("tabs:cancelDragFast");
  }
});
ipcRenderer.on("drag:move", (_event, payload) => {
  lastPoint = payload;
  renderGhost(lastPoint);
  setVisible(Boolean(payload.visible));
  ghost.dataset.docked = payload.docked ? "true" : "false";
});
</script></body></html>`)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char] ?? char;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ipcMain.handle("unit:bootstrap", (event) => payloadFor(BrowserWindow.fromWebContents(event.sender)?.id ?? 0));
  ipcMain.handle("tabs:bootstrap", (event) => payloadFor(BrowserWindow.fromWebContents(event.sender)?.id ?? 0));
  ipcMain.handle("tabs:activate", (_event, payload: { windowId: number; tabId: string }) => {
    registry.activate(payload.windowId, payload.tabId);
    broadcastState();
  });
  ipcMain.handle("tabs:beginDrag", async (_event, payload: BeginTabDragPayload) => {
    if (registry.beginDrag(payload)) {
      await createCaptureOverlays();
      syncDragOverlayState("begin-drag");
      broadcastState();
      debugLog("drag.begin.result", { captureOwned: false, visualOverlay: true, tabId: payload.tabId });
      return { captureOwned: false };
    }
    debugLog("drag.begin.result", { captureOwned: false, tabId: payload.tabId });
    return { captureOwned: false };
  });
  ipcMain.handle("tabs:updateDrag", (_event, payload: UpdateTabDragPayload) => {
    const result = registry.updateDrag(payload);
    sendOverlayMove(payload);
    syncDragOverlayState("ipc-update");
    closeEarlyDragSourceWindows(result);
    publishDragUpdate(result);
  });
  ipcMain.handle("tabs:finishDrag", (_event, payload: FinishTabDragPayload) => {
    finishDragAt(payload);
  });
  ipcMain.on("tabs:updateDragFast", (_event, payload: UpdateTabDragPayload) => {
    const result = registry.updateDrag(payload);
    sendOverlayMove(payload);
    syncDragOverlayState("ipc-update-fast");
    closeEarlyDragSourceWindows(result);
    publishDragUpdate(result);
  });
  ipcMain.on("tabs:finishDragFast", (_event, payload: FinishTabDragPayload) => {
    finishDragAt(payload);
  });
  ipcMain.on("debug:log", (_event, payload: Record<string, unknown>) => {
    const event = typeof payload.event === "string" ? payload.event : "renderer.debug";
    debugLog(event, payload);
  });
  ipcMain.handle("tabs:cancelDrag", () => {
    registry.cancelDrag();
    closeDragWindows();
    broadcastState();
  });
  ipcMain.on("tabs:cancelDragFast", () => {
    registry.cancelDrag();
    closeDragWindows();
    broadcastState();
  });
  ipcMain.handle("tabs:closeTab", (_event, payload: CloseTabPayload) => {
    const result = registry.closeTab(payload);
    for (const windowId of result.closeWindowIds) {
      windows.get(windowId)?.close();
    }
    broadcastState();
  });
  ipcMain.handle("tabs:registerStripBounds", (_event, payload: RegisterStripBoundsPayload) => {
    registry.registerStripBounds(payload);
  });
  ipcMain.handle("tabs:windowClosing", (_event, windowId: number) => {
    if (windowId === registry.primaryWindowId) {
      for (const detachedId of registry.beginShutdown()) {
        windows.get(detachedId)?.close();
      }
      destroyCaptureOverlays();
    }
  });
  createWindow({ primary: true });
});

app.on("window-all-closed", () => {
  destroyCaptureOverlays();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow({ primary: true });
  }
});
