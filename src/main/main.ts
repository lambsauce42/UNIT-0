import { app, BrowserWindow, Menu, ipcMain, screen } from "electron";
import path from "node:path";
import type {
  AppletSession,
  BeginTabDragPayload,
  BootstrapPayload,
  CloseAppletInstancePayload,
  CloseTabPayload,
  CreateAppletPayload,
  CreateWorkspacePayload,
  FinishTabDragPayload,
  MoveAppletInstancePayload,
  OpenWorkspaceTabPayload,
  ReplaceWorkspaceLayoutPayload,
  RectLike,
  RegisterStripBoundsPayload,
  RenameWorkspacePayload,
  TabDragSession,
  TabDropTarget,
  TabHostSnapshot,
  TabHostState,
  UnitState,
  UpdateLayoutRatiosPayload,
  UpdateTabDragPayload,
  Workspace,
  AppletInstance,
  WorkspaceTab
} from "../shared/types.js";
import { WORKSPACE_TAB_SIZE } from "../shared/tabMetrics.js";
import { WorkspaceStateStore } from "./workspaceStateStore.js";

const preloadPath = path.join(__dirname, "../preload/preload.js");
const rendererEntry = path.join(__dirname, "../renderer/index.html");
const windows = new Map<number, BrowserWindow>();
const captureOverlays = new Map<number, BrowserWindow>();
let dragBroadcastTimer: NodeJS.Timeout | null = null;
let dragLifecycleId = 0;
let overlayPointerCapturing = false;
let overlayWindowsVisible = false;

const DROP_SLOP = { left: 8, top: 4, right: 8, bottom: 40 };

if (process.env.NODE_ENV === "test" && process.env.UNIT0_DATA_DIR) {
  app.setPath("userData", path.join(process.env.UNIT0_DATA_DIR, "electron-user-data"));
}
const TEST_WINDOW_MODE = process.env.UNIT0_E2E_WINDOW_MODE;
const HIDE_TEST_WINDOWS = process.env.NODE_ENV === "test" && TEST_WINDOW_MODE !== "visible";
const RESIZE_DEBUG = process.env.UNIT0_RESIZE_DEBUG === "1";

function logResizeDebug(event: string, payload: unknown): void {
  if (!RESIZE_DEBUG) {
    return;
  }
  console.log(`[unit0:resize] ${event}`, JSON.stringify(payload));
}

function uniqueWindowIds(windowIds: number[]): number[] {
  return [...new Set(windowIds)];
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
  readonly appletSessions: Record<string, AppletSession>;
  readonly workspaces: Record<string, Workspace>;
  readonly tabs: Record<string, WorkspaceTab>;
  readonly hosts: Record<number, TabHostState> = {};
  readonly stripBounds = new Map<number, RegisterStripBoundsPayload>();
  primaryWindowId = 0;
  dragSession: TabDragSession | null = null;
  shuttingDown = false;
  private readonly primaryHostSnapshot: TabHostSnapshot;
  private lastTargetKey = "";

  constructor(private readonly store: WorkspaceStateStore) {
    const model = store.load();
    this.appletSessions = model.appletSessions;
    this.workspaces = model.workspaces;
    this.tabs = model.tabs;
    this.primaryHostSnapshot = model.primaryHost;
  }

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
      return;
    }
    const tabIds = isFirst ? [...this.primaryHostSnapshot.tabIds] : [];
    this.hosts[windowId] = {
      windowId,
      tabIds,
      activeTabId: isFirst && tabIds.includes(this.primaryHostSnapshot.activeTabId)
        ? this.primaryHostSnapshot.activeTabId
        : (tabIds[0] ?? ""),
      isPrimary: isFirst
    };
    this.normalizeHost(this.hosts[windowId]);
    this.persistPrimaryHost();
  }

  activate(windowId: number, tabId: string): void {
    const host = this.hosts[windowId];
    if (!host || !host.tabIds.includes(tabId) || this.dragSession) {
      return;
    }
    host.activeTabId = tabId;
    this.persistPrimaryHost();
  }

  registerStripBounds(payload: RegisterStripBoundsPayload): void {
    const normalized = normalizeStripBounds(payload);
    this.stripBounds.set(payload.windowId, normalized);
    alignPendingWindow(normalized);
  }

  beginDrag(payload: BeginTabDragPayload): boolean {
    if (this.dragSession) {
      return false;
    }
    const tab = this.tabs[payload.tabId];
    const sourceHost = this.hosts[payload.sourceWindowId];
    if (!tab || tab.pinned || !sourceHost) {
      return false;
    }
    const originalIndex = sourceHost.tabIds.indexOf(payload.tabId);
    if (originalIndex === -1) {
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
    this.lastTargetKey = "";
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
    const nextKey = target ? `${target.windowId}:${target.insertionIndex}` : "floating";
    const targetChanged = nextKey !== this.lastTargetKey;
    if (targetChanged) {
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
    if (target) {
      this.moveDraggedTabTo(target.windowId, target.insertionIndex);
      const closeWindowIds = uniqueWindowIds([...this.emptyDetachedWindowIds(), ...updateResult.closeWindowIds]);
      this.dragSession = null;
      this.persistPrimaryHost();
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
    this.persistPrimaryHost();
    return result;
  }

  cancelDrag(): void {
    const session = this.dragSession;
    if (!session || session.finishing) {
      return;
    }
    session.finishing = true;
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
    this.persistPrimaryHost();
  }

  closeTab(payload: CloseTabPayload): { closeWindowIds: number[] } {
    const tab = this.tabs[payload.tabId];
    const host = this.hosts[payload.windowId];
    if (!tab || tab.pinned || !tab.closable || !host || this.dragSession) {
      return { closeWindowIds: [] };
    }
    host.tabIds = host.tabIds.filter((id) => id !== payload.tabId);
    this.normalizeHost(host);
    this.persistPrimaryHost();
    return { closeWindowIds: this.shouldCloseEmptyDetached(payload.windowId) ? [payload.windowId] : [] };
  }

  createWorkspace(windowId: number, title: string): Workspace {
    const host = this.hosts[windowId];
    if (!host || this.dragSession) {
      throw new Error(`Cannot create workspace in window ${windowId}`);
    }
    const created = this.store.createWorkspace(title);
    this.workspaces[created.workspace.id] = created.workspace;
    this.tabs[created.tab.id] = created.tab;
    this.addTabToHost(host, created.tab.id);
    this.persistPrimaryHost();
    return structuredClone(created.workspace);
  }

  openWorkspaceTab(windowId: number, workspaceId: string): void {
    const host = this.hosts[windowId];
    const workspace = this.workspaces[workspaceId];
    if (!host || !workspace || this.dragSession) {
      throw new Error(`Cannot open workspace ${workspaceId} in window ${windowId}`);
    }
    const tab = this.store.openWorkspaceTab(workspaceId);
    this.tabs[tab.id] = tab;
    this.addTabToHost(host, tab.id);
    this.persistPrimaryHost();
  }

  renameWorkspace(workspaceId: string, title: string): void {
    const renamed = this.store.renameWorkspace(workspaceId, title);
    const workspace = this.workspaces[workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }
    workspace.title = renamed.title;
    for (const tab of Object.values(this.tabs)) {
      if (tab.workspaceId === workspaceId) {
        tab.title = renamed.title;
      }
    }
  }

  updateLayoutRatios(payload: UpdateLayoutRatiosPayload): void {
    const workspace = this.workspaces[payload.workspaceId];
    if (!workspace || this.dragSession) {
      throw new Error(`Cannot update layout ratios for workspace ${payload.workspaceId}`);
    }
    logResizeDebug("main-update-ratios", {
      workspaceId: payload.workspaceId,
      ratios: payload.ratios
    });
    this.workspaces[payload.workspaceId] = this.store.updateLayoutRatios(payload);
  }

  replaceLayout(payload: ReplaceWorkspaceLayoutPayload): void {
    const workspace = this.workspaces[payload.workspaceId];
    if (!workspace || this.dragSession) {
      throw new Error(`Cannot replace layout for workspace ${payload.workspaceId}`);
    }
    logResizeDebug("main-replace-layout", {
      workspaceId: payload.workspaceId,
      layoutRootId: payload.layout.id
    });
    this.workspaces[payload.workspaceId] = this.store.replaceWorkspaceLayout(payload);
  }

  createApplet(payload: CreateAppletPayload): AppletInstance {
    const workspace = this.workspaces[payload.workspaceId];
    if (!workspace || this.dragSession) {
      throw new Error(`Cannot create applet in workspace ${payload.workspaceId}`);
    }
    const result = this.store.createApplet(payload);
    this.workspaces[payload.workspaceId] = result.workspace;
    for (const [sessionId, session] of Object.entries(result.appletSessions)) {
      this.appletSessions[sessionId] = session;
    }
    if (!result.instance) {
      throw new Error("Applet creation did not return an applet instance");
    }
    return structuredClone(result.instance);
  }

  closeAppletInstance(payload: CloseAppletInstancePayload): void {
    const workspace = this.workspaces[payload.workspaceId];
    if (!workspace || this.dragSession) {
      throw new Error(`Cannot close applet instance ${payload.appletInstanceId}`);
    }
    const result = this.store.closeAppletInstance(payload.workspaceId, payload.appletInstanceId);
    this.workspaces[payload.workspaceId] = result.workspace;
    if (result.deletedSessionId) {
      delete this.appletSessions[result.deletedSessionId];
    }
  }

  moveAppletInstance(payload: MoveAppletInstancePayload): void {
    const workspace = this.workspaces[payload.workspaceId];
    if (!workspace || this.dragSession) {
      throw new Error(`Cannot move applet instance ${payload.appletInstanceId}`);
    }
    this.workspaces[payload.workspaceId] = this.store.moveAppletInstance(payload);
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
    this.persistPrimaryHost();
  }

  beginShutdown(): number[] {
    this.mergeDetachedTabsIntoPrimaryHost();
    this.shuttingDown = true;
    this.dragSession = null;
    hideCaptureOverlays();
    this.persistPrimaryHost();
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
          right: screenX - session.hotSpot.x + WORKSPACE_TAB_SIZE.width,
          bottom: screenY - session.hotSpot.y + WORKSPACE_TAB_SIZE.height
        }
      : null;
    for (const strip of this.stripBounds.values()) {
      const expanded = this.expandRect(strip.bounds, DROP_SLOP);
      const pointerInside = this.pointInRect(screenX, screenY, expanded);
      const ghostIntersects = Boolean(dragRect && this.rectsIntersect(dragRect, expanded));
      const insertionIndex = this.insertionIndexFor(strip, screenX);
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
    return candidates[0] ?? null;
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
        return this.clampedInsertionIndex(host, candidateOrder.indexOf(tabId), draggedTabId);
      }
    }
    return this.clampedInsertionIndex(host, candidateOrder.length, draggedTabId);
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
    this.persistPrimaryHost();
  }

  private addTabToHost(host: TabHostState, tabId: string): void {
    this.removeTabFromAllHosts(tabId);
    if (host.isPrimary) {
      const firstMovable = this.firstMovableIndex(host);
      host.tabIds.splice(Math.max(firstMovable, host.tabIds.length), 0, tabId);
    } else {
      host.tabIds.push(tabId);
    }
    host.activeTabId = tabId;
    this.normalizeHost(host);
  }

  private mergeDetachedTabsIntoPrimaryHost(): void {
    const primary = this.hosts[this.primaryWindowId];
    if (!primary) {
      return;
    }
    for (const host of Object.values(this.hosts)) {
      if (host.windowId === this.primaryWindowId) {
        continue;
      }
      for (const tabId of host.tabIds) {
        if (!primary.tabIds.includes(tabId)) {
          primary.tabIds.push(tabId);
        }
      }
    }
    this.normalizeHost(primary);
  }

  private persistPrimaryHost(): void {
    const primary = this.hosts[this.primaryWindowId];
    if (!primary) {
      return;
    }
    this.store.savePrimaryHost({
      tabIds: [...primary.tabIds],
      activeTabId: primary.activeTabId
    });
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

let registry: TabRegistry;

function workspaceDatabasePath(): string {
  const dataDir = process.env.UNIT0_DATA_DIR ?? app.getPath("userData");
  return path.join(dataDir, "unit0.sqlite");
}

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
  if (result.action === "create-window") {
    const browserWindow = createWindow({ tabId: result.tabId, x: result.x, y: result.y });
    if (alignment) {
      const timeout = setTimeout(() => {
        pendingAlignments.delete(browserWindow.id);
        closeEmptyWindows(result.closeWindowIds);
        closeDragWindows();
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
  void reason;
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
    return;
  }
  const desiredLeft = pending.screenX - pending.hotSpot.x;
  const desiredTop = pending.screenY - pending.hotSpot.y;
  const currentBounds = browserWindow.getBounds();
  browserWindow.setPosition(
    Math.round(currentBounds.x + desiredLeft - metric.left),
    Math.round(currentBounds.y + desiredTop - payload.bounds.top)
  );
  clearTimeout(pending.timeout);
  pendingAlignments.delete(payload.windowId);
  closeEmptyWindows(pending.closeWindowIds);
  closeDragWindows();
}

async function createCaptureOverlays(): Promise<boolean> {
  if (process.env.NODE_ENV === "test") {
    return false;
  }
  const lifecycleId = ++dragLifecycleId;
  const created: BrowserWindow[] = [];
  const session = registry.dragSession;
  const tab = session ? registry.tabs[session.tabId] : null;
  const displays = screen.getAllDisplays();
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
  for (const overlay of created) {
    if (overlay.isDestroyed()) {
      continue;
    }
    if (!registry.dragSession || lifecycleId !== dragLifecycleId) {
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
.tab{position:fixed;left:0;top:0;display:${options.visible ? "grid" : "none"};grid-template-columns:16px minmax(0,1fr) 16px;align-items:center;gap:8px;width:${WORKSPACE_TAB_SIZE.width}px;height:${WORKSPACE_TAB_SIZE.height}px;padding:0 10px 0 14px;border:1px solid #7aa2ff;border-radius:6px;background:rgba(26,35,48,.88);color:#e6edf6;font-weight:600;box-shadow:0 14px 32px rgba(0,0,0,.42);opacity:.92;will-change:transform;pointer-events:none}
.dot{width:12px;height:12px;border:1px solid #b7c2d1;border-radius:3px}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.x{opacity:.55;color:#b7c2d1}
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
});
ipcRenderer.on("drag:end", () => {
  captureActive = false;
  setVisible(false);
});
ipcRenderer.on("drag:capture", (_event, payload) => {
  captureActive = Boolean(payload.capture);
  setVisible(Boolean(payload.visible));
});
renderGhost(lastPoint);
window.addEventListener("pointermove", event => {
  lastPoint = point(event);
  renderGhost(lastPoint);
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
  const workspaceStore = new WorkspaceStateStore(workspaceDatabasePath());
  registry = new TabRegistry(workspaceStore);
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
      return { captureOwned: false };
    }
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
  ipcMain.handle("workspaces:createWorkspace", (_event, payload: CreateWorkspacePayload) => {
    const workspace = registry.createWorkspace(payload.windowId, payload.title);
    broadcastState();
    return workspace;
  });
  ipcMain.handle("workspaces:openWorkspaceTab", (_event, payload: OpenWorkspaceTabPayload) => {
    registry.openWorkspaceTab(payload.windowId, payload.workspaceId);
    broadcastState();
  });
  ipcMain.handle("workspaces:renameWorkspace", (_event, payload: RenameWorkspacePayload) => {
    registry.renameWorkspace(payload.workspaceId, payload.title);
    broadcastState();
  });
  ipcMain.handle("workspaces:updateLayoutRatios", (_event, payload: UpdateLayoutRatiosPayload) => {
    registry.updateLayoutRatios(payload);
    broadcastState();
  });
  ipcMain.handle("workspaces:replaceLayout", (_event, payload: ReplaceWorkspaceLayoutPayload) => {
    registry.replaceLayout(payload);
    broadcastState();
  });
  ipcMain.handle("applets:createApplet", (_event, payload: CreateAppletPayload) => {
    const applet = registry.createApplet(payload);
    broadcastState();
    return applet;
  });
  ipcMain.handle("applets:closeAppletInstance", (_event, payload: CloseAppletInstancePayload) => {
    registry.closeAppletInstance(payload);
    broadcastState();
  });
  ipcMain.handle("applets:moveAppletInstance", (_event, payload: MoveAppletInstancePayload) => {
    registry.moveAppletInstance(payload);
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
