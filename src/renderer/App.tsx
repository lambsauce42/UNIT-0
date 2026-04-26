import {
  Bot,
  Code2,
  Columns2,
  PanelRight,
  PanelTop,
  Globe,
  Grid2X2,
  Monitor,
  Plus,
  Power,
  Replace,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
  X
} from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  AppletKind,
  AppletSession,
  BootstrapPayload,
  RectLike,
  TabHostState,
  UnitState,
  Workspace,
  WorkspaceLayoutNode,
  WorkspaceTab
} from "../shared/types";
import {
  MIN_APPLET_SIZE,
  TILE_GUTTER_SIZE,
  applyRatioOverrides,
  completedEdgeGroups,
  computeCanonicalLayout,
  projectResize,
  rebuildLayoutFromLeafRects,
  resizeTargetAt,
  resizeLeafRectsForTarget,
  type CanonicalLayoutGeometry,
  type EdgeGroup,
  type ResizeTarget
} from "../shared/layoutGeometry";
import { WORKSPACE_TAB_SIZE } from "../shared/tabMetrics";
import { closeHitRectForTab } from "./tabGeometry";

type PendingDrag = {
  tabId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScreenX: number;
  startScreenY: number;
  hotSpotX: number;
  hotSpotY: number;
  dragging: boolean;
  beginRequested: boolean;
  captureOwned: boolean;
  captureElement: HTMLElement | null;
};

type WorkspaceNameDialogState =
  | { mode: "create"; title: string }
  | { mode: "rename"; workspaceId: string; title: string };

const iconByKind: Record<AppletKind, typeof SquareTerminal> = {
  terminal: SquareTerminal,
  wslTerminal: SquareTerminal,
  fileViewer: Code2,
  browser: Globe,
  chat: Bot,
  sandbox: Monitor
};

const appletCatalog: Array<{ kind: AppletKind; label: string }> = [
  { kind: "terminal", label: "Terminal" },
  { kind: "wslTerminal", label: "WSL Terminal" },
  { kind: "fileViewer", label: "File Viewer" },
  { kind: "browser", label: "Browser" },
  { kind: "chat", label: "Chat" },
  { kind: "sandbox", label: "Sandbox" }
];

type AppletDropTarget = {
  targetLeafId?: string;
  splitDirection: "row" | "column";
  placement: "first" | "second";
  rect: { left: number; top: number; width: number; height: number };
};

type AppletDragState = {
  instanceId: string;
  title: string;
  kind: AppletKind;
  pointerX: number;
  pointerY: number;
  offsetX: number;
  offsetY: number;
  target: AppletDropTarget | null;
};

type LayoutSize = { width: number; height: number };

type ResizeDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  target: ResizeTarget;
  geometry: CanonicalLayoutGeometry;
  layout: WorkspaceLayoutNode;
};

type ResizeSnapGuide = {
  axis: "vertical" | "horizontal";
  center: number;
  start: number;
  end: number;
};

const WORKSPACE_SURFACE_PADDING = 10;
const RESIZE_SNAP_RADIUS = 8;

export function App() {
  const [payload, setPayload] = useState<BootstrapPayload | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.unitApi.tabs.bootstrap().then((nextPayload) => {
      if (mounted) {
        setPayload(nextPayload);
      }
    });
    const removeState = window.unitApi.onStateChanged((nextPayload) => setPayload(nextPayload));
    return () => {
      mounted = false;
      removeState();
    };
  }, []);

  useEffect(() => {
    if (!payload) {
      return;
    }
    const onBeforeUnload = () => {
      void window.unitApi.tabs.windowClosing(payload.windowId);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [payload]);

  if (!payload) {
    return <div className="boot-screen" />;
  }

  const host = payload.state.hosts[payload.windowId];
  const activeTab = host ? payload.state.tabs[host.activeTabId] : null;
  const activeWorkspace = activeTab ? payload.state.workspaces[activeTab.workspaceId] : null;

  return (
    <main className="app-shell">
      <header className="workspace-bar">
        {host ? <WorkspaceTabStrip host={host} state={payload.state} windowId={payload.windowId} /> : <div />}
        <div className="window-tools">
          <button className="icon-button active" type="button" aria-label="Workspace grid">
            <Columns2 size={18} />
          </button>
          <button className="icon-button" type="button" aria-label="Settings">
            <Settings size={18} />
          </button>
        </div>
      </header>
      {activeWorkspace?.id === "manager" ? (
        <WorkspaceManagerSurface state={payload.state} />
      ) : activeWorkspace ? (
        <WorkspaceSurface state={payload.state} workspace={activeWorkspace} />
      ) : (
        <div />
      )}
    </main>
  );
}

function WorkspaceTabStrip({ host, state, windowId }: { host: TabHostState; state: UnitState; windowId: number }) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const displayLeftsRef = useRef(new Map<string, number>());
  const targetLeftsRef = useRef(new Map<string, number>());
  const pendingDragRef = useRef<PendingDrag | null>(null);
  const localDragPointRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const publishRafRef = useRef<number | null>(null);
  const localDragRafRef = useRef<number | null>(null);
  const publishBoundsRef = useRef<() => void>(() => undefined);
  const [, forceRender] = useState(0);
  const [nameDialog, setNameDialog] = useState<WorkspaceNameDialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    workspaceId: string;
    title: string;
    left: number;
    top: number;
  } | null>(null);

  const tabIdsKey = host.tabIds.join("|");
  const baseTabs = useMemo(() => host.tabIds.map((tabId) => state.tabs[tabId]).filter(Boolean), [tabIdsKey, state.tabs]);
  const orderedTabs = useMemo(() => {
    const drag = state.dragSession;
    if (!drag) {
      return baseTabs;
    }
    const draggedTab = state.tabs[drag.tabId];
    if (!draggedTab) {
      return baseTabs;
    }
    const withoutDragged = baseTabs.filter((tab) => tab.id !== drag.tabId);
    if (drag.currentTarget?.windowId === windowId) {
      const firstMovable = withoutDragged.findIndex((tab) => !tab.pinned);
      const minIndex = firstMovable === -1 ? withoutDragged.length : firstMovable;
      const insertAt = Math.max(minIndex, Math.min(drag.currentTarget.insertionIndex, withoutDragged.length));
      const next = [...withoutDragged];
      next.splice(insertAt, 0, draggedTab);
      return next;
    }
    if (baseTabs.some((tab) => tab.id === drag.tabId)) {
      if (windowId === drag.sourceWindowId) {
        return baseTabs;
      }
      return withoutDragged;
    }
    return baseTabs;
  }, [baseTabs, state.dragSession, state.tabs, windowId]);
  const tabLayout = useMemo(() => {
    let left = 0;
    return orderedTabs.map((tab) => {
      const width = WORKSPACE_TAB_SIZE.width;
      const item = { tab, left, width };
      left += width;
      return item;
    });
  }, [orderedTabs]);
  const totalTabsWidth = tabLayout.at(-1) ? tabLayout.at(-1)!.left + tabLayout.at(-1)!.width : 0;

  const measureStrip = (): { bounds: RectLike; tabMetrics: Array<{ tabId: string; left: number; width: number }> } | null => {
    const strip = stripRef.current;
    if (!strip) {
      return null;
    }
    const stripRect = strip.getBoundingClientRect();
    const bounds = toScreenRect(stripRect);
    const tabMetrics = tabLayout.map((item) => ({
      tabId: item.tab.id,
      left: window.screenX + stripRect.left + item.left,
      width: item.width
    }));
    return { bounds, tabMetrics };
  };

  const publishBounds = () => {
    const measurement = measureStrip();
    if (!measurement) {
      return;
    }
    void window.unitApi.tabs.registerStripBounds({
      windowId,
      bounds: measurement.bounds,
      tabMetrics: measurement.tabMetrics
    });
  };
  publishBoundsRef.current = publishBounds;

  const schedulePublishBounds = () => {
    if (publishRafRef.current !== null) {
      return;
    }
    publishRafRef.current = window.requestAnimationFrame(() => {
      publishRafRef.current = null;
      publishBoundsRef.current();
    });
  };

  useLayoutEffect(() => {
    targetLeftsRef.current = new Map(tabLayout.map((item) => [item.tab.id, item.left]));
    for (const item of tabLayout) {
      if (!displayLeftsRef.current.has(item.tab.id)) {
        displayLeftsRef.current.set(item.tab.id, item.left);
      }
    }
    schedulePublishBounds();
  }, [tabLayout]);

  useEffect(() => {
    if (!state.dragSession) {
      pendingDragRef.current = null;
      localDragPointRef.current = null;
    }
  }, [state.dragSession]);

  const scheduleLocalDragRender = () => {
    if (localDragRafRef.current !== null) {
      return;
    }
    localDragRafRef.current = window.requestAnimationFrame(() => {
      localDragRafRef.current = null;
      forceRender((value) => value + 1);
    });
  };

  useEffect(() => {
    const animate = () => {
      let changed = false;
      for (const [tabId, target] of targetLeftsRef.current) {
        if (state.dragSession?.tabId === tabId && !state.dragSession.floating) {
          continue;
        }
        const current = displayLeftsRef.current.get(tabId) ?? target;
        const next = current + (target - current) * 0.35;
        const settled = Math.abs(target - next) < 0.6 ? target : next;
        if (Math.abs(settled - current) > 0.1) {
          changed = true;
        }
        displayLeftsRef.current.set(tabId, settled);
      }
      if (changed) {
        forceRender((value) => value + 1);
      }
      rafRef.current = window.requestAnimationFrame(animate);
    };
    rafRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [state.dragSession?.tabId, state.dragSession?.floating]);

  useEffect(() => {
    const onResize = () => schedulePublishBounds();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (nameDialog || contextMenu)) {
        setNameDialog(null);
        setContextMenu(null);
        return;
      }
      if (event.key === "Escape") {
        pendingDragRef.current = null;
        void window.unitApi.tabs.cancelDrag();
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("focus", onResize);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", dismissContextMenu);
    const resizeObserver = new ResizeObserver(onResize);
    if (stripRef.current) {
      resizeObserver.observe(stripRef.current);
    }
    return () => {
      if (publishRafRef.current !== null) {
        window.cancelAnimationFrame(publishRafRef.current);
        publishRafRef.current = null;
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", dismissContextMenu);
    };
  }, [contextMenu, nameDialog]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = pendingDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const crossedThreshold =
        Math.abs(event.clientX - drag.startClientX) > 8 || Math.abs(event.clientY - drag.startClientY) > 8;
      if (!drag.dragging && crossedThreshold && !drag.beginRequested) {
        drag.dragging = true;
        drag.beginRequested = true;
        void window.unitApi.tabs.beginDrag({
          tabId: drag.tabId,
          sourceWindowId: windowId,
          screenX: drag.startScreenX,
          screenY: drag.startScreenY,
          hotSpotX: drag.hotSpotX,
          hotSpotY: drag.hotSpotY
        }).then((result) => {
          if (!result.captureOwned) {
            return;
          }
          const current = pendingDragRef.current;
          if (current?.pointerId === drag.pointerId) {
            current.captureOwned = true;
            if (current.captureElement?.hasPointerCapture?.(event.pointerId)) {
              current.captureElement.releasePointerCapture(event.pointerId);
            }
            pendingDragRef.current = null;
          }
        });
      }
      if (drag.dragging && !drag.captureOwned) {
        localDragPointRef.current = { screenX: event.screenX, screenY: event.screenY };
        scheduleLocalDragRender();
        window.unitApi.tabs.updateDragFast({
          screenX: event.screenX,
          screenY: event.screenY
        });
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = pendingDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      pendingDragRef.current = null;
      if (drag.dragging && !drag.captureOwned) {
        void window.unitApi.tabs.finishDrag({
          screenX: event.screenX,
          screenY: event.screenY
        });
        return;
      }
      void window.unitApi.tabs.activate({ windowId, tabId: drag.tabId });
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      if (localDragRafRef.current !== null) {
        window.cancelAnimationFrame(localDragRafRef.current);
        localDragRafRef.current = null;
      }
    };
  }, [windowId]);

  useEffect(() => {
    const drag = state.dragSession;
    if (!drag || drag.ownerWindowId !== null || drag.currentTarget?.windowId !== windowId) {
      return;
    }
    const onPointerMove = (event: PointerEvent) => {
      window.unitApi.tabs.updateDragFast({
        screenX: event.screenX,
        screenY: event.screenY
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      void window.unitApi.tabs.finishDrag({
        screenX: event.screenX,
        screenY: event.screenY
      });
    };
    const onPointerCancel = () => {
      void window.unitApi.tabs.cancelDrag();
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [
    state.dragSession?.tabId,
    state.dragSession?.ownerWindowId,
    state.dragSession?.currentTarget?.windowId,
    windowId
  ]);

  const draggedTabId = state.dragSession?.tabId ?? null;
  const draggedTabInThisStrip = Boolean(draggedTabId && orderedTabs.some((tab) => tab.id === draggedTabId));
  const renderDraggedInTargetLayer = Boolean(
    draggedTabId &&
      draggedTabInThisStrip &&
      state.dragSession &&
      !state.dragSession.floating &&
      state.dragSession.currentTarget?.windowId === windowId
  );
  const stripRect = stripRef.current?.getBoundingClientRect() ?? null;

  const renderTab = (tab: WorkspaceTab, index: number, draggedLayer: boolean) => {
    const workspace = state.workspaces[tab.workspaceId];
    const active = host.activeTabId === tab.id;
    const isDragged = draggedTabId === tab.id;
    const drag = state.dragSession;
    const draggedAwayFromSource =
      Boolean(drag && isDragged && drag.sourceWindowId === windowId && drag.currentTarget?.windowId !== windowId);
    const layout = tabLayout[index];
    const targetLeft = layout?.left ?? 0;
    const displayLeft = displayLeftsRef.current.get(tab.id) ?? targetLeft;
    const cursorScreenX =
      isDragged && drag?.sourceWindowId === windowId && localDragPointRef.current
        ? localDragPointRef.current.screenX
        : (drag?.currentScreen.x ?? 0);
    const cursorLeft =
      stripRect && drag && isDragged && !drag.floating && drag.currentTarget?.windowId === windowId
        ? cursorScreenX - window.screenX - stripRect.left - drag.hotSpot.x
        : displayLeft;
    if (isDragged && drag && !drag.floating && drag.currentTarget?.windowId === windowId) {
      displayLeftsRef.current.set(tab.id, cursorLeft);
    }
    const visualLeft = isDragged && !drag?.floating && drag?.currentTarget?.windowId === windowId ? cursorLeft : displayLeft;
    const exposeAsTab = !draggedAwayFromSource;
    return (
      <button
        className={`workspace-tab ${active ? "active" : ""} ${tab.pinned ? "pinned" : ""} ${isDragged ? "dragging" : ""}`}
        data-workspace-tab={exposeAsTab ? "" : undefined}
        data-tab-id={tab.id}
        data-target-left={window.screenX + (stripRect?.left ?? 0) + targetLeft}
        data-testid={exposeAsTab ? `workspace-tab-${workspace.id}` : undefined}
        aria-hidden={exposeAsTab ? undefined : true}
        key={`${tab.id}-${draggedLayer ? "drag" : "base"}`}
        ref={(element) => {
          if (element) {
            tabRefs.current.set(tab.id, element);
          } else {
            tabRefs.current.delete(tab.id);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || tab.pinned || closeHitContains(event, event.currentTarget, tab)) {
            return;
          }
          setContextMenu(null);
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          pendingDragRef.current = {
            tabId: tab.id,
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startScreenX: event.screenX,
            startScreenY: event.screenY,
            hotSpotX: event.clientX - rect.left,
            hotSpotY: event.clientY - rect.top,
            dragging: false,
            beginRequested: false,
            captureOwned: false,
            captureElement: event.currentTarget
          };
          forceRender((value) => value + 1);
        }}
        onClick={() => {
          if (tab.pinned) {
            void window.unitApi.tabs.activate({ windowId, tabId: tab.id });
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (tab.workspaceId === "manager") {
            return;
          }
          setContextMenu({
            tabId: tab.id,
            workspaceId: tab.workspaceId,
            title: tab.title,
            left: event.clientX,
            top: event.clientY
          });
        }}
        style={{
          width: layout?.width,
          transform: `translateX(${visualLeft}px)`,
          zIndex: draggedLayer ? 20 : active ? 3 : 1,
          visibility: draggedAwayFromSource ? "hidden" : undefined
        }}
        type="button"
      >
        <Grid2X2 size={14} />
        <span>{tab.title}</span>
        {tab.closable ? (
          <X
            className="tab-close"
            size={14}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void window.unitApi.tabs.closeTab({ windowId, tabId: tab.id });
            }}
          />
        ) : null}
      </button>
    );
  };

  return (
    <div className="workspace-tabs" ref={stripRef} data-testid="workspace-tab-strip">
      <div className="workspace-tab-stage" style={{ width: totalTabsWidth }}>
        {orderedTabs.map((tab, index) =>
          tab.id === draggedTabId && renderDraggedInTargetLayer ? null : renderTab(tab, index, false)
        )}
        {renderDraggedInTargetLayer
          ? orderedTabs.map((tab, index) => (tab.id === draggedTabId ? renderTab(tab, index, true) : null))
          : null}
      </div>
      <button
        className="new-workspace-button icon-button"
        style={{ transform: `translateX(${totalTabsWidth + 8}px)` }}
        type="button"
        aria-label="New workspace"
        onClick={() => {
          setContextMenu(null);
          setNameDialog({ mode: "create", title: "" });
        }}
      >
        <Plus size={18} />
      </button>
      {contextMenu ? (
        <div
          className="workspace-context-menu"
          data-testid="workspace-context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: contextMenu.left, top: contextMenu.top }}
        >
          <button
            data-testid="workspace-context-rename"
            onClick={() => {
              setNameDialog({ mode: "rename", workspaceId: contextMenu.workspaceId, title: contextMenu.title });
              setContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            Rename
          </button>
        </div>
      ) : null}
      {nameDialog ? (
        <WorkspaceNameDialog
          initialTitle={nameDialog.title}
          mode={nameDialog.mode}
          onCancel={() => setNameDialog(null)}
          onSubmit={(title) => {
            if (nameDialog.mode === "create") {
              void window.unitApi.workspaces.createWorkspace({ windowId, title });
            } else {
              void window.unitApi.workspaces.renameWorkspace({ workspaceId: nameDialog.workspaceId, title });
            }
            setNameDialog(null);
          }}
        />
      ) : null}
    </div>
  );

  function dismissContextMenu(event: PointerEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest(".workspace-context-menu")) {
      return;
    }
    setContextMenu(null);
  }

  function closeHitContains(event: React.PointerEvent<HTMLElement>, element: HTMLElement, tab: WorkspaceTab): boolean {
    if (!tab.closable) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const hit = closeHitRectForTab(toClientRect(rect));
    return event.clientX >= hit.left && event.clientX <= hit.right && event.clientY >= hit.top && event.clientY <= hit.bottom;
  }
}

function WorkspaceNameDialog({
  initialTitle,
  mode,
  onCancel,
  onSubmit
}: {
  initialTitle: string;
  mode: "create" | "rename";
  onCancel: () => void;
  onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmedTitle = title.trim();
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="dialog-backdrop" data-testid="workspace-name-dialog" role="presentation">
      <form
        className="workspace-name-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedTitle) {
            onSubmit(trimmedTitle);
          }
        }}
      >
        <label htmlFor="workspace-title-input">{mode === "create" ? "Workspace name" : "Rename workspace"}</label>
        <input
          id="workspace-title-input"
          ref={inputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Workspace name"
        />
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={!trimmedTitle} type="submit">
            {mode === "create" ? "Create" : "Rename"}
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkspaceManagerSurface({ state }: { state: UnitState }) {
  const workspaces = Object.values(state.workspaces).filter((workspace) => workspace.id !== "manager");
  const primaryHost = state.hosts[state.primaryWindowId];
  return (
    <section className="workspace-manager" data-testid="workspace-manager">
      <div className="manager-list">
        {workspaces.map((workspace) => (
          <button
            className="manager-row"
            data-testid={`workspace-manager-row-${workspace.id}`}
            key={workspace.id}
            onClick={() => {
              if (primaryHost) {
                void window.unitApi.workspaces.openWorkspaceTab({ windowId: primaryHost.windowId, workspaceId: workspace.id });
              }
            }}
            type="button"
          >
            <span>{workspace.title}</span>
            <span>{workspace.applets.length}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function WorkspaceSurface({ state, workspace }: { state: UnitState; workspace: Workspace }) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const [appletDrag, setAppletDrag] = useState<AppletDragState | null>(null);
  const appletDragRef = useRef<AppletDragState | null>(null);
  const resizeDragRef = useRef<ResizeDragState | null>(null);
  const resizePublishRafRef = useRef<number | null>(null);
  const pendingResizeRatiosRef = useRef<Record<string, number> | null>(null);
  const pendingResizeLayoutRef = useRef<WorkspaceLayoutNode | null>(null);
  const [layoutSize, setLayoutSize] = useState<LayoutSize>({ width: 0, height: 0 });
  const [ratioOverrides, setRatioOverrides] = useState<Record<string, number>>({});
  const [layoutOverride, setLayoutOverride] = useState<WorkspaceLayoutNode | null>(null);
  const [hoverResizeTarget, setHoverResizeTarget] = useState<ResizeTarget | null>(null);
  const [resizeDrag, setResizeDrag] = useState<ResizeDragState | null>(null);
  const [resizeSnapGuides, setResizeSnapGuides] = useState<ResizeSnapGuide[]>([]);
  const appletsById = useMemo(
    () =>
      new Map(
        workspace.applets.map((instance) => [
          instance.id,
          {
            instance,
            session: state.appletSessions[instance.sessionId]
          }
        ])
      ),
    [state.appletSessions, workspace.applets]
  );
  const appletByInstanceId = useMemo(
    () =>
      new Map(
        workspace.applets.map((instance) => {
          const session = state.appletSessions[instance.sessionId];
          return [instance.id, session ? { instance, session } : null];
        })
    ),
    [state.appletSessions, workspace.applets]
  );
  const ratioOverrideKey = JSON.stringify(ratioOverrides);
  const effectiveLayout = useMemo(
    () => layoutOverride ?? (workspace.layout ? applyRatioOverrides(workspace.layout, ratioOverrides) : null),
    [layoutOverride, workspace.layout, ratioOverrideKey]
  );
  const layoutGeometry = useMemo(
    () =>
      effectiveLayout && layoutSize.width > 0 && layoutSize.height > 0
        ? computeCanonicalLayout(effectiveLayout, layoutSize)
        : null,
    [effectiveLayout, layoutSize.height, layoutSize.width]
  );
  const completedGroups = useMemo(
    () => (layoutGeometry ? completedEdgeGroups(layoutGeometry.primitiveEdges, layoutGeometry.leaves) : []),
    [layoutGeometry]
  );
  const resizeEnabledGroups = useMemo(
    () =>
      layoutGeometry
        ? completedGroups.filter((group) => resizeGroupMeetsMinimumSize(layoutGeometry, group))
        : [],
    [completedGroups, layoutGeometry]
  );
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }
    const measure = () => {
      setLayoutSize({
        width: Math.max(0, Math.round(surface.clientWidth - WORKSPACE_SURFACE_PADDING * 2)),
        height: Math.max(0, Math.round(surface.clientHeight - WORKSPACE_SURFACE_PADDING * 2))
      });
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(surface);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    if (!resizeDragRef.current) {
      setRatioOverrides({});
      setLayoutOverride(null);
    }
  }, [workspace.id, workspace.layout]);
  const localTilingPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const surface = surfaceRef.current;
    if (!surface) {
      return null;
    }
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.round(clientX - rect.left - WORKSPACE_SURFACE_PADDING),
      y: Math.round(clientY - rect.top - WORKSPACE_SURFACE_PADDING)
    };
  }, []);
  const publishResizeRatios = useCallback(
    (ratios: Record<string, number>) => {
      pendingResizeLayoutRef.current = null;
      pendingResizeRatiosRef.current = ratios;
      if (resizePublishRafRef.current !== null) {
        return;
      }
      resizePublishRafRef.current = window.requestAnimationFrame(() => {
        resizePublishRafRef.current = null;
        const nextRatios = pendingResizeRatiosRef.current;
        pendingResizeRatiosRef.current = null;
        if (nextRatios && Object.keys(nextRatios).length > 0) {
          void window.unitApi.workspaces
            .updateLayoutRatios({ workspaceId: workspace.id, ratios: nextRatios })
            .catch((error) => console.error("Failed to update layout ratios", error));
        }
      });
    },
    [workspace.id]
  );
  const publishResizeLayout = useCallback(
    (layout: WorkspaceLayoutNode) => {
      pendingResizeRatiosRef.current = null;
      pendingResizeLayoutRef.current = layout;
      if (resizePublishRafRef.current !== null) {
        return;
      }
      resizePublishRafRef.current = window.requestAnimationFrame(() => {
        resizePublishRafRef.current = null;
        const nextLayout = pendingResizeLayoutRef.current;
        pendingResizeLayoutRef.current = null;
        if (nextLayout) {
          void window.unitApi.workspaces
            .replaceLayout({ workspaceId: workspace.id, layout: nextLayout })
            .catch((error) => console.error("Failed to replace workspace layout", error));
        }
      });
    },
    [workspace.id]
  );
  const flushResizeRatios = useCallback(() => {
    if (resizePublishRafRef.current !== null) {
      window.cancelAnimationFrame(resizePublishRafRef.current);
      resizePublishRafRef.current = null;
    }
    const nextRatios = pendingResizeRatiosRef.current;
    const nextLayout = pendingResizeLayoutRef.current;
    pendingResizeRatiosRef.current = null;
    pendingResizeLayoutRef.current = null;
    if (nextLayout) {
      void window.unitApi.workspaces
        .replaceLayout({ workspaceId: workspace.id, layout: nextLayout })
        .catch((error) => console.error("Failed to replace workspace layout", error));
      return;
    }
    if (nextRatios && Object.keys(nextRatios).length > 0) {
      void window.unitApi.workspaces
        .updateLayoutRatios({ workspaceId: workspace.id, ratios: nextRatios })
        .catch((error) => console.error("Failed to update layout ratios", error));
    }
  }, [workspace.id]);
  const beginResizeDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, target: ResizeTarget) => {
      if (
        !layoutGeometry ||
        !effectiveLayout ||
        event.button !== 0 ||
        !resizeTargetMeetsMinimumSize(layoutGeometry, target)
      ) {
        return;
      }
      const point = localTilingPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const nextDrag = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        grabOffsetX: target.vertical ? point.x - target.vertical.center : 0,
        grabOffsetY: target.horizontal ? point.y - target.horizontal.center : 0,
        target,
        geometry: layoutGeometry,
        layout: effectiveLayout
      };
      resizeDragRef.current = nextDrag;
      setResizeDrag(nextDrag);
      setHoverResizeTarget(target);
    },
    [effectiveLayout, layoutGeometry, localTilingPoint]
  );
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const point = localTilingPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }
      const rawDelta = {
        x: point.x - drag.startX,
        y: point.y - drag.startY
      };
      const snapTrace = traceResizeSnap(drag, rawDelta, event.altKey);
      const snapped = snapTrace.snapped;
      const projected = projectResize(drag.geometry, drag.target, snapped);
      const structural = requiresStructuralResize(drag.geometry, drag.target);
      if (structural) {
        const structuralDelta = clampStructuralResize(drag, projected.dx, projected.dy);
        setResizeSnapGuides(activeSnapGuides(drag.target, snapped.guides, structuralDelta.dx, structuralDelta.dy, snapped));
        const resizedLeaves = resizeLeafRectsForTarget(drag.geometry, drag.target, structuralDelta.dx, structuralDelta.dy);
        const nextLayout = rebuildLayoutFromLeafRects(drag.layout, resizedLeaves, drag.geometry.rect);
        setLayoutOverride(nextLayout);
        setRatioOverrides({});
        publishResizeLayout(nextLayout);
        return;
      }
      setResizeSnapGuides(activeSnapGuides(drag.target, snapped.guides, projected.dx, projected.dy, snapped));
      const nextRatios = compensatedResizeRatios(drag, projected.ratios, projected.dx, projected.dy, layoutSize);
      setRatioOverrides((current) => ({ ...current, ...nextRatios }));
      setLayoutOverride(null);
      publishResizeRatios(nextRatios);
    };
    const finishDrag = (event: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      resizeDragRef.current = null;
      setResizeDrag(null);
      setResizeSnapGuides([]);
      flushResizeRatios();
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", finishDrag);
    document.addEventListener("pointercancel", finishDrag);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", finishDrag);
      document.removeEventListener("pointercancel", finishDrag);
      if (resizePublishRafRef.current !== null) {
        window.cancelAnimationFrame(resizePublishRafRef.current);
        resizePublishRafRef.current = null;
      }
    };
  }, [flushResizeRatios, layoutSize, localTilingPoint, publishResizeLayout, publishResizeRatios]);
  const dropTargetFor = useCallback(
    (clientX: number, clientY: number, draggedInstanceId: string): AppletDropTarget | null => {
      const surface = surfaceRef.current;
      if (!surface) {
        return null;
      }
      const surfaceRect = surface.getBoundingClientRect();
      if (
        clientX < surfaceRect.left ||
        clientX > surfaceRect.right ||
        clientY < surfaceRect.top ||
        clientY > surfaceRect.bottom
      ) {
        return null;
      }
      const rootZone = Math.min(84, surfaceRect.width * 0.18, surfaceRect.height * 0.18);
      const rootEdges = [
        { edge: "left" as const, distance: clientX - surfaceRect.left },
        { edge: "right" as const, distance: surfaceRect.right - clientX },
        { edge: "top" as const, distance: clientY - surfaceRect.top },
        { edge: "bottom" as const, distance: surfaceRect.bottom - clientY }
      ].filter((edge) => edge.distance <= rootZone);
      if (rootEdges.length > 0) {
        const edge = rootEdges.sort((left, right) => left.distance - right.distance)[0].edge;
        return {
          splitDirection: edge === "left" || edge === "right" ? "row" : "column",
          placement: edge === "left" || edge === "top" ? "first" : "second",
          rect: relativeRect(surfaceRect, surfaceRect, edge)
        };
      }
      const leafElement = document.elementFromPoint(clientX, clientY)?.closest(".layout-leaf");
      if (!(leafElement instanceof HTMLElement)) {
        return null;
      }
      const targetLeafId = leafElement.dataset.layoutLeafId;
      if (!targetLeafId || leafElement.dataset.appletInstanceId === draggedInstanceId) {
        return null;
      }
      const leafRect = leafElement.getBoundingClientRect();
      const distances = [
        { edge: "left" as const, value: clientX - leafRect.left },
        { edge: "right" as const, value: leafRect.right - clientX },
        { edge: "top" as const, value: clientY - leafRect.top },
        { edge: "bottom" as const, value: leafRect.bottom - clientY }
      ].sort((left, right) => left.value - right.value);
      const edge = distances[0].edge;
      return {
        targetLeafId,
        splitDirection: edge === "left" || edge === "right" ? "row" : "column",
        placement: edge === "left" || edge === "top" ? "first" : "second",
        rect: relativeRect(leafRect, surfaceRect, edge)
      };
    },
    []
  );
  const beginAppletDrag = useCallback(
    (drag: Omit<AppletDragState, "target">) => {
      const nextDrag = {
        ...drag,
        target: dropTargetFor(drag.pointerX, drag.pointerY, drag.instanceId)
      };
      appletDragRef.current = nextDrag;
      setAppletDrag(nextDrag);
    },
    [dropTargetFor]
  );
  const updateAppletDrag = useCallback(
    (clientX: number, clientY: number) => {
      const drag = appletDragRef.current;
      if (!drag) {
        return;
      }
      const nextDrag = {
        ...drag,
        pointerX: clientX,
        pointerY: clientY,
        target: dropTargetFor(clientX, clientY, drag.instanceId)
      };
      appletDragRef.current = nextDrag;
      setAppletDrag(nextDrag);
    },
    [dropTargetFor]
  );
  const finishAppletDrag = useCallback(() => {
    const drag = appletDragRef.current;
    appletDragRef.current = null;
    setAppletDrag(null);
    if (drag?.target) {
      void window.unitApi.applets.moveAppletInstance({
        workspaceId: workspace.id,
        appletInstanceId: drag.instanceId,
        targetLeafId: drag.target.targetLeafId,
        splitDirection: drag.target.splitDirection,
        placement: drag.target.placement
      });
    }
  }, [workspace.id]);
  const cancelAppletDrag = useCallback(() => {
    appletDragRef.current = null;
    setAppletDrag(null);
  }, []);
  const draggedApplet = appletDrag ? appletByInstanceId.get(appletDrag.instanceId) : null;
  const DragIcon = draggedApplet?.session ? iconByKind[draggedApplet.session.kind] : SquareTerminal;
  const activeResizeTarget = resizeDrag?.target ?? hoverResizeTarget;
  const activeResizeGroups = resizeGroupsForTarget(activeResizeTarget, resizeEnabledGroups);
  return (
    <section className="workspace-surface" data-testid="workspace-surface" ref={surfaceRef}>
      {effectiveLayout && layoutGeometry ? (
        <WorkspaceLayout
          geometry={layoutGeometry}
          appletsById={appletsById}
          workspaceId={workspace.id}
          onBeginAppletDrag={beginAppletDrag}
          onUpdateAppletDrag={updateAppletDrag}
          onFinishAppletDrag={finishAppletDrag}
          onCancelAppletDrag={cancelAppletDrag}
          onHoverResizeTarget={(clientX, clientY) => {
            if (resizeDragRef.current) {
              return;
            }
            const point = localTilingPoint(clientX, clientY);
            const target = point ? resizeTargetAt(layoutGeometry, point) : null;
            setHoverResizeTarget(target && resizeTargetMeetsMinimumSize(layoutGeometry, target) ? target : null);
          }}
          onLeaveResizeTarget={() => {
            if (!resizeDragRef.current) {
              setHoverResizeTarget(null);
            }
          }}
          completedGroups={resizeEnabledGroups}
          activeGroups={activeResizeGroups}
          snapGuides={resizeSnapGuides}
          onBeginResizeDrag={beginResizeDrag}
        />
      ) : (
        <div className="workspace-empty" data-testid="workspace-empty">
          <button
            className="empty-spawn-button"
            type="button"
            onClick={() => {
              void window.unitApi.applets.createApplet({ workspaceId: workspace.id, kind: "terminal" });
            }}
          >
            <SquareTerminal size={17} />
            <span>New terminal</span>
          </button>
        </div>
      )}
      {appletDrag?.target ? (
        <div
          className="applet-drop-indicator"
          data-testid="applet-drop-indicator"
          style={{
            left: appletDrag.target.rect.left,
            top: appletDrag.target.rect.top,
            width: appletDrag.target.rect.width,
            height: appletDrag.target.rect.height
          }}
        />
      ) : null}
      {appletDrag ? (
        <div
          className="applet-drag-ghost"
          data-testid="applet-drag-ghost"
          style={{
            transform: `translate3d(${appletDrag.pointerX - appletDrag.offsetX}px, ${appletDrag.pointerY - appletDrag.offsetY}px, 0)`
          }}
        >
          <DragIcon size={15} />
          <span>{appletDrag.title}</span>
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceLayout({
  geometry,
  appletsById,
  workspaceId,
  onBeginAppletDrag,
  onUpdateAppletDrag,
  onFinishAppletDrag,
  onCancelAppletDrag,
  onHoverResizeTarget,
  onLeaveResizeTarget,
  completedGroups,
  activeGroups,
  snapGuides,
  onBeginResizeDrag
}: {
  geometry: CanonicalLayoutGeometry;
  appletsById: Map<string, { instance: Workspace["applets"][number]; session: AppletSession | undefined }>;
  workspaceId: string;
  onBeginAppletDrag: (drag: Omit<AppletDragState, "target">) => void;
  onUpdateAppletDrag: (clientX: number, clientY: number) => void;
  onFinishAppletDrag: () => void;
  onCancelAppletDrag: () => void;
  onHoverResizeTarget: (clientX: number, clientY: number) => void;
  onLeaveResizeTarget: () => void;
  completedGroups: EdgeGroup[];
  activeGroups: EdgeGroup[];
  snapGuides: ResizeSnapGuide[];
  onBeginResizeDrag: (event: ReactPointerEvent<HTMLElement>, target: ResizeTarget) => void;
}) {
  return (
    <div
      className="workspace-layout layout-root"
      data-testid="workspace-layout"
      style={{
        width: geometry.rect.right - geometry.rect.left,
        height: geometry.rect.bottom - geometry.rect.top
      }}
      onPointerMove={(event) => onHoverResizeTarget(event.clientX, event.clientY)}
      onPointerLeave={onLeaveResizeTarget}
    >
      {geometry.leaves.map((leaf) => {
        const applet = appletsById.get(leaf.appletInstanceId);
        if (!applet?.session) {
          throw new Error(`Layout leaf references missing applet instance ${leaf.appletInstanceId}`);
        }
        return (
          <div
            className="layout-leaf"
            data-testid={`layout-leaf-${leaf.appletInstanceId}`}
            data-layout-leaf-id={leaf.id}
            data-applet-instance-id={leaf.appletInstanceId}
            key={leaf.id}
            style={rectStyle(leaf.rect)}
          >
            <AppletFrame
              session={applet.session}
              instanceId={applet.instance.id}
              leafId={leaf.id}
              workspaceId={workspaceId}
              canSplitRow={leaf.rect.right - leaf.rect.left >= MIN_APPLET_SIZE * 2 + TILE_GUTTER_SIZE}
              canSplitColumn={leaf.rect.bottom - leaf.rect.top >= MIN_APPLET_SIZE * 2 + TILE_GUTTER_SIZE}
              onBeginAppletDrag={onBeginAppletDrag}
              onUpdateAppletDrag={onUpdateAppletDrag}
              onFinishAppletDrag={onFinishAppletDrag}
              onCancelAppletDrag={onCancelAppletDrag}
            />
          </div>
        );
      })}
      <SplitterOverlay
        completedGroups={completedGroups}
        activeGroups={activeGroups}
        snapGuides={snapGuides}
        onBeginResizeDrag={onBeginResizeDrag}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ResizeSnapTrace = {
  snapped: { x: number; y: number; guides: ResizeSnapGuide[] };
  disabled: boolean;
  vertical: AxisSnapTrace | null;
  horizontal: AxisSnapTrace | null;
};

type AxisSnapTrace = {
  axis: "vertical" | "horizontal";
  groupCenter: number;
  delta: number;
  currentCenter: number;
  pointerCoordinate: number;
  grabOffset: number;
  radius: number;
  chosen: { center: number; start: number; end: number; distance: number; delta: number } | null;
  nearest: Array<{ center: number; start: number; end: number; edgeCount: number; distance: number }>;
};

type SnapCandidate = {
  center: number;
  start: number;
  end: number;
  edgeCount: number;
  key: string;
};

function traceResizeSnap(drag: ResizeDragState, delta: { x: number; y: number }, disabled: boolean): ResizeSnapTrace {
  if (disabled) {
    return {
      snapped: { x: Math.round(delta.x), y: Math.round(delta.y), guides: [] },
      disabled: true,
      vertical: null,
      horizontal: null
    };
  }
  let x = Math.round(delta.x);
  let y = Math.round(delta.y);
  const guides: ResizeSnapGuide[] = [];
  const vertical = drag.target.vertical ? traceGroupSnap(drag.geometry, drag.target.vertical, x, drag.grabOffsetX) : null;
  if (vertical?.chosen) {
    x = vertical.chosen.delta;
    guides.push(fullWorkspaceSnapGuide(drag.geometry, drag.target.vertical, vertical.chosen.center));
  }
  const horizontal = drag.target.horizontal ? traceGroupSnap(drag.geometry, drag.target.horizontal, y, drag.grabOffsetY) : null;
  if (horizontal?.chosen) {
    y = horizontal.chosen.delta;
    guides.push(fullWorkspaceSnapGuide(drag.geometry, drag.target.horizontal, horizontal.chosen.center));
  }
  return { snapped: { x, y, guides }, disabled: false, vertical, horizontal };
}

function snapResizeDelta(drag: ResizeDragState, delta: { x: number; y: number }): { x: number; y: number; guides: ResizeSnapGuide[] } {
  return traceResizeSnap(drag, delta, false).snapped;
}

function snapGroupDelta(
  geometry: CanonicalLayoutGeometry,
  group: EdgeGroup,
  delta: number,
  grabOffset: number
): { delta: number; guide: ResizeSnapGuide | null } {
  const trace = traceGroupSnap(geometry, group, delta, grabOffset);
  if (!trace.chosen) {
    return { delta, guide: null };
  }
  return {
    delta: trace.chosen.delta,
    guide: fullWorkspaceSnapGuide(geometry, group, trace.chosen.center)
  };
}

function traceGroupSnap(
  geometry: CanonicalLayoutGeometry,
  group: EdgeGroup,
  delta: number,
  grabOffset: number
): AxisSnapTrace {
  const currentCenter = group.center + delta;
  const pointerCoordinate = currentCenter + grabOffset;
  const candidates = snapCandidates(geometry, group)
    .map((candidate) => {
      return {
        center: candidate.center,
        start: candidate.start,
        end: candidate.end,
        edgeCount: candidate.edgeCount,
        distance: Math.abs(candidate.center - currentCenter)
      };
    })
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.center - right.center ||
        left.start - right.start ||
        left.end - right.end
    );
  const nearest = candidates.slice(0, 8);
  const best = candidates[0];
  return {
    axis: group.axis,
    groupCenter: group.center,
    delta,
    currentCenter,
    pointerCoordinate,
    grabOffset,
    radius: RESIZE_SNAP_RADIUS,
    chosen:
      best && best.distance <= RESIZE_SNAP_RADIUS
        ? { center: best.center, start: best.start, end: best.end, distance: best.distance, delta: best.center - group.center }
        : null,
    nearest
  };
}

function fullWorkspaceSnapGuide(geometry: CanonicalLayoutGeometry, group: EdgeGroup, center: number): ResizeSnapGuide {
  return {
    axis: group.axis,
    center,
    start: group.axis === "vertical" ? geometry.rect.top : geometry.rect.left,
    end: group.axis === "vertical" ? geometry.rect.bottom : geometry.rect.right
  };
}

function snapCandidates(geometry: CanonicalLayoutGeometry, group: EdgeGroup): SnapCandidate[] {
  const candidates = new Map<string, SnapCandidate>();
  for (const candidate of completedEdgeGroups(geometry.primitiveEdges, geometry.leaves)) {
    if (candidate.axis !== group.axis || edgeGroupsOverlap(candidate, group)) {
      continue;
    }
    candidates.set(edgeGroupIdentity(candidate), {
      center: candidate.center,
      start: candidate.start,
      end: candidate.end,
      edgeCount: candidate.edges.length,
      key: edgeGroupIdentity(candidate)
    });
  }
  return [...candidates.values()];
}

function activeSnapGuides(
  target: ResizeTarget,
  guides: ResizeSnapGuide[],
  dx: number,
  dy: number,
  snapped: { x: number; y: number }
): ResizeSnapGuide[] {
  return guides.filter(
    (guide) =>
      (guide.axis === "vertical" && target.vertical && dx === snapped.x) ||
      (guide.axis === "horizontal" && target.horizontal && dy === snapped.y)
  );
}

function compensatedResizeRatios(
  drag: ResizeDragState,
  ratios: Record<string, number>,
  dx: number,
  dy: number,
  layoutSize: LayoutSize
): Record<string, number> {
  const nextRatios = { ...ratios };
  const previewLayout = applyRatioOverrides(drag.layout, nextRatios);
  const previewGeometry = computeCanonicalLayout(previewLayout, layoutSize);
  if (drag.target.vertical && dx !== 0) {
    addBranchCompensation(drag.geometry, previewGeometry, drag.target.vertical, nextRatios);
  }
  if (drag.target.horizontal && dy !== 0) {
    addBranchCompensation(drag.geometry, previewGeometry, drag.target.horizontal, nextRatios);
  }
  return nextRatios;
}

function requiresStructuralResize(geometry: CanonicalLayoutGeometry, target: ResizeTarget): boolean {
  return [target.vertical, target.horizontal]
    .filter((group): group is EdgeGroup => group !== null)
    .some((group) => groupRequiresStructuralResize(geometry, group));
}

function groupRequiresStructuralResize(geometry: CanonicalLayoutGeometry, group: EdgeGroup): boolean {
  const touchedBefore = new Set(group.edges.map((edge) => edge.beforeLeafId));
  const touchedAfter = new Set(group.edges.map((edge) => edge.afterLeafId));
  const splits = new Map(geometry.splits.map((split) => [split.id, split]));
  for (const splitId of new Set(group.edges.map((edge) => edge.splitId))) {
    const split = splits.get(splitId);
    if (!split) {
      continue;
    }
    const firstIds = new Set(split.firstLeafIds);
    const secondIds = new Set(split.secondLeafIds);
    if (!sameSet(firstIds, touchedBefore) || !sameSet(secondIds, touchedAfter)) {
      return true;
    }
  }
  return false;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function clampStructuralResize(drag: ResizeDragState, dx: number, dy: number): { dx: number; dy: number } {
  let nextDx = dx;
  let nextDy = dy;
  if (!validStructuralResize(drag, nextDx, nextDy)) {
    nextDx = clampStructuralAxis(drag, nextDx, nextDy, "x");
  }
  if (!validStructuralResize(drag, nextDx, nextDy)) {
    nextDy = clampStructuralAxis(drag, nextDx, nextDy, "y");
  }
  if (!validStructuralResize(drag, nextDx, nextDy)) {
    return { dx: 0, dy: 0 };
  }
  return { dx: nextDx, dy: nextDy };
}

function clampStructuralAxis(
  drag: ResizeDragState,
  dx: number,
  dy: number,
  axis: "x" | "y"
): number {
  const value = axis === "x" ? dx : dy;
  if (value === 0) {
    return 0;
  }
  let low = 0;
  let high = Math.abs(value);
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = Math.sign(value) * mid;
    const candidateDx = axis === "x" ? candidate : dx;
    const candidateDy = axis === "y" ? candidate : dy;
    if (validStructuralResize(drag, candidateDx, candidateDy)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function validStructuralResize(drag: ResizeDragState, dx: number, dy: number): boolean {
  try {
    const leaves = resizeLeafRectsForTarget(drag.geometry, drag.target, dx, dy);
    const affectedLeafIds = affectedResizeLeafIds(drag.target);
    if (
      !leaves.every(
        (leaf) => !affectedLeafIds.has(leaf.id) || resizeTargetLeafMeetsMinimum(drag.target, leaf.rect)
      )
    ) {
      return false;
    }
    const layout = rebuildLayoutFromLeafRects(drag.layout, leaves, drag.geometry.rect);
    const geometry = computeCanonicalLayout(layout, {
      width: drag.geometry.rect.right - drag.geometry.rect.left,
      height: drag.geometry.rect.bottom - drag.geometry.rect.top
    });
    return geometry.leaves.every(
      (leaf) => !affectedLeafIds.has(leaf.id) || resizeTargetLeafMeetsMinimum(drag.target, leaf.rect)
    );
  } catch {
    return false;
  }
}

function rectMeetsMinSize(rect: { left: number; top: number; right: number; bottom: number }): boolean {
  return rect.right - rect.left >= MIN_APPLET_SIZE && rect.bottom - rect.top >= MIN_APPLET_SIZE;
}

function resizeTargetMeetsMinimumSize(geometry: CanonicalLayoutGeometry, target: ResizeTarget): boolean {
  const leavesById = new Map(geometry.leaves.map((leaf) => [leaf.id, leaf]));
  for (const leafId of affectedResizeLeafIds(target)) {
    const leaf = leavesById.get(leafId);
    if (!leaf || !resizeTargetLeafMeetsMinimum(target, leaf.rect)) {
      return false;
    }
  }
  return true;
}

function resizeGroupMeetsMinimumSize(geometry: CanonicalLayoutGeometry, group: EdgeGroup): boolean {
  const leavesById = new Map(geometry.leaves.map((leaf) => [leaf.id, leaf]));
  for (const leafId of affectedGroupLeafIds(group)) {
    const leaf = leavesById.get(leafId);
    if (!leaf || !resizeGroupLeafMeetsMinimum(group, leaf.rect)) {
      return false;
    }
  }
  return true;
}

function resizeTargetLeafMeetsMinimum(
  target: ResizeTarget,
  rect: { left: number; top: number; right: number; bottom: number }
): boolean {
  return (
    (!target.vertical || rect.right - rect.left >= MIN_APPLET_SIZE) &&
    (!target.horizontal || rect.bottom - rect.top >= MIN_APPLET_SIZE)
  );
}

function resizeGroupLeafMeetsMinimum(
  group: EdgeGroup,
  rect: { left: number; top: number; right: number; bottom: number }
): boolean {
  return group.axis === "vertical"
    ? rect.right - rect.left >= MIN_APPLET_SIZE
    : rect.bottom - rect.top >= MIN_APPLET_SIZE;
}

function affectedResizeLeafIds(target: ResizeTarget): Set<string> {
  return new Set(
    [target.vertical, target.horizontal]
      .filter((group): group is EdgeGroup => group !== null)
      .flatMap((group) => [...affectedGroupLeafIds(group)])
  );
}

function affectedGroupLeafIds(group: EdgeGroup): Set<string> {
  return new Set(group.edges.flatMap((edge) => [edge.beforeLeafId, edge.afterLeafId]));
}

function addBranchCompensation(
  startGeometry: CanonicalLayoutGeometry,
  previewGeometry: CanonicalLayoutGeometry,
  group: EdgeGroup,
  ratios: Record<string, number>
): void {
  const direction = group.axis === "vertical" ? "row" : "column";
  const touchedLeafIds = new Set(group.edges.flatMap((edge) => [edge.beforeLeafId, edge.afterLeafId]));
  const startSplits = new Map(startGeometry.splits.map((split) => [split.id, split]));
  for (const previewSplit of previewGeometry.splits) {
    if (previewSplit.direction !== direction || previewSplit.availableSize <= 0) {
      continue;
    }
    const startSplit = startSplits.get(previewSplit.id);
    if (!startSplit) {
      continue;
    }
    const firstTouches = previewSplit.firstLeafIds.some((leafId) => touchedLeafIds.has(leafId));
    const secondTouches = previewSplit.secondLeafIds.some((leafId) => touchedLeafIds.has(leafId));
    if (firstTouches === secondTouches) {
      continue;
    }
    const firstSize = firstTouches ? previewSplit.availableSize - startSplit.secondSize : startSplit.firstSize;
    if (firstSize <= 0 || firstSize >= previewSplit.availableSize) {
      continue;
    }
    ratios[previewSplit.id] = firstSize / previewSplit.availableSize;
  }
}

function SplitterOverlay({
  completedGroups,
  activeGroups,
  snapGuides,
  onBeginResizeDrag
}: {
  completedGroups: EdgeGroup[];
  activeGroups: EdgeGroup[];
  snapGuides: ResizeSnapGuide[];
  onBeginResizeDrag: (event: ReactPointerEvent<HTMLElement>, target: ResizeTarget) => void;
}) {
  const activeKeys = new Set(activeGroups.map(edgeGroupKey));
  const verticalGroups = completedGroups.filter((group) => group.axis === "vertical");
  const horizontalGroups = completedGroups.filter((group) => group.axis === "horizontal");
  const junctions = junctionTargets(verticalGroups, horizontalGroups);
  return (
    <div className="splitter-layer" aria-hidden="true">
      {activeGroups.map((group) => (
        <div
          className={`splitter-highlight splitter-highlight-${group.axis}`}
          data-testid={`layout-splitter-highlight-${group.axis}`}
          key={`highlight-${edgeGroupKey(group)}`}
          style={groupStyle(group)}
        />
      ))}
      {snapGuides.map((guide) => (
        <div
          className={`splitter-snap-target splitter-snap-target-${guide.axis}`}
          data-testid={`layout-splitter-snap-${guide.axis}`}
          key={`snap-${guide.axis}-${guide.center}-${guide.start}-${guide.end}`}
          style={snapGuideStyle(guide)}
        />
      ))}
      {completedGroups.map((group) => (
        <div
          className={`splitter-handle splitter-handle-${group.axis} ${activeKeys.has(edgeGroupKey(group)) ? "active" : ""}`}
          data-testid={`layout-splitter-${group.axis}`}
          key={`handle-${edgeGroupKey(group)}`}
          onPointerDown={(event) =>
            onBeginResizeDrag(event, {
              type: "edge",
              vertical: group.axis === "vertical" ? group : null,
              horizontal: group.axis === "horizontal" ? group : null
            })
          }
          role="separator"
          style={groupStyle(group)}
        />
      ))}
      {junctions.map(({ vertical, horizontal }) => (
        <div
          className="splitter-junction"
          data-testid="layout-splitter-junction"
          key={`junction-${edgeGroupKey(vertical)}-${edgeGroupKey(horizontal)}`}
          onPointerDown={(event) => onBeginResizeDrag(event, { type: "junction", vertical, horizontal })}
          role="separator"
          style={{
            left: vertical.center - (TILE_GUTTER_SIZE * 3) / 2,
            top: horizontal.center - (TILE_GUTTER_SIZE * 3) / 2,
            width: TILE_GUTTER_SIZE * 3,
            height: TILE_GUTTER_SIZE * 3
          }}
        />
      ))}
    </div>
  );
}

function junctionTargets(verticalGroups: EdgeGroup[], horizontalGroups: EdgeGroup[]) {
  const targets = new Map<string, { vertical: EdgeGroup; horizontal: EdgeGroup }>();
  const radius = (TILE_GUTTER_SIZE * 3) / 2;
  for (const vertical of verticalGroups) {
    for (const horizontal of horizontalGroups) {
      if (
        horizontal.start > vertical.center + radius ||
        horizontal.end < vertical.center - radius ||
        vertical.start > horizontal.center + radius ||
        vertical.end < horizontal.center - radius
      ) {
        continue;
      }
      const incidentVertical = verticalGroups.filter(
        (group) =>
          group.center === vertical.center &&
          group.start <= horizontal.center + radius &&
          group.end >= horizontal.center - radius
      );
      const incidentHorizontal = horizontalGroups.filter(
        (group) =>
          group.center === horizontal.center &&
          group.start <= vertical.center + radius &&
          group.end >= vertical.center - radius
      );
      targets.set(`${vertical.center}:${horizontal.center}`, {
        vertical: combineDisplayGroups(incidentVertical),
        horizontal: combineDisplayGroups(incidentHorizontal)
      });
    }
  }
  return [...targets.values()];
}

function resizeGroupsForTarget(target: ResizeTarget | null, liveGroups: EdgeGroup[]): EdgeGroup[] {
  if (!target) {
    return [];
  }
  return [target.vertical, target.horizontal]
    .filter((group): group is EdgeGroup => group !== null)
    .map((group) => liveGroupForSnapshot(group, liveGroups) ?? group);
}

function liveGroupForSnapshot(snapshot: EdgeGroup, liveGroups: EdgeGroup[]): EdgeGroup | null {
  const snapshotEdges = new Set(snapshot.edges.map(edgeSignature));
  const matches = liveGroups.filter(
    (group) => group.axis === snapshot.axis && group.edges.some((edge) => snapshotEdges.has(edgeSignature(edge)))
  );
  if (matches.length === 0) {
    return null;
  }
  return combineDisplayGroups(matches);
}

function edgeGroupsOverlap(left: EdgeGroup, right: EdgeGroup): boolean {
  if (left.axis !== right.axis) {
    return false;
  }
  const rightEdges = new Set(right.edges.map(edgeSignature));
  return left.edges.some((edge) => rightEdges.has(edgeSignature(edge)));
}

function edgeGroupIdentity(group: EdgeGroup): string {
  return `${group.axis}:${group.edges.map(edgeSignature).sort().join("|")}`;
}

function edgeSignature(edge: EdgeGroup["edges"][number]): string {
  return `${edge.beforeLeafId}:${edge.afterLeafId}`;
}

function combineDisplayGroups(groups: EdgeGroup[]): EdgeGroup {
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

function edgeGroupKey(group: EdgeGroup): string {
  return `${group.axis}:${group.center}:${group.start}:${group.end}`;
}

function groupStyle(group: EdgeGroup): { left: number; top: number; width: number; height: number } {
  if (group.axis === "vertical") {
    return {
      left: group.center - TILE_GUTTER_SIZE / 2,
      top: group.start,
      width: TILE_GUTTER_SIZE,
      height: group.end - group.start
    };
  }
  return {
    left: group.start,
    top: group.center - TILE_GUTTER_SIZE / 2,
    width: group.end - group.start,
    height: TILE_GUTTER_SIZE
  };
}

function snapGuideStyle(guide: ResizeSnapGuide): { left: number; top: number; width: number; height: number } {
  if (guide.axis === "vertical") {
    return {
      left: guide.center - 1,
      top: guide.start,
      width: 2,
      height: guide.end - guide.start
    };
  }
  return {
    left: guide.start,
    top: guide.center - 1,
    width: guide.end - guide.start,
    height: 2
  };
}

function rectStyle(rect: { left: number; top: number; right: number; bottom: number }) {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}

function AppletFrame({
  session,
  instanceId,
  leafId,
  workspaceId,
  canSplitRow,
  canSplitColumn,
  onBeginAppletDrag,
  onUpdateAppletDrag,
  onFinishAppletDrag,
  onCancelAppletDrag
}: {
  session: AppletSession;
  instanceId: string;
  leafId: string;
  workspaceId: string;
  canSplitRow: boolean;
  canSplitColumn: boolean;
  onBeginAppletDrag: (drag: Omit<AppletDragState, "target">) => void;
  onUpdateAppletDrag: (clientX: number, clientY: number) => void;
  onFinishAppletDrag: () => void;
  onCancelAppletDrag: () => void;
}) {
  const Icon = iconByKind[session.kind];
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [changeMenuOpen, setChangeMenuOpen] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    dragging: boolean;
  } | null>(null);
  const canSplitAnyDirection = canSplitRow || canSplitColumn;
  const pickerSplitDirection = canSplitRow ? "row" : "column";
  const changeAppletKind = (kind: AppletKind) => {
    if (kind === session.kind) {
      return;
    }
    void window.unitApi.applets.changeAppletInstanceKind({
      workspaceId,
      appletInstanceId: instanceId,
      kind
    });
  };
  const createApplet = (kind: AppletKind, splitDirection: "row" | "column") => {
    if ((splitDirection === "row" && !canSplitRow) || (splitDirection === "column" && !canSplitColumn)) {
      return;
    }
    void window.unitApi.applets.createApplet({
      workspaceId,
      kind,
      targetLeafId: leafId,
      splitDirection
    });
  };
  useEffect(() => {
    if (!addMenuOpen && !changeMenuOpen) {
      return;
    }
    const closeMenu = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(`[data-applet-instance-id="${instanceId}"]`)) {
        return;
      }
      setAddMenuOpen(false);
      setChangeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAddMenuOpen(false);
        setChangeMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addMenuOpen, changeMenuOpen, instanceId]);
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const crossedThreshold = Math.abs(event.clientX - drag.startX) > 8 || Math.abs(event.clientY - drag.startY) > 8;
      if (!drag.dragging && crossedThreshold) {
        drag.dragging = true;
        onBeginAppletDrag({
          instanceId,
          title: session.title,
          kind: session.kind,
          pointerX: event.clientX,
          pointerY: event.clientY,
          offsetX: drag.offsetX,
          offsetY: drag.offsetY
        });
      }
      if (drag.dragging) {
        onUpdateAppletDrag(event.clientX, event.clientY);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      dragRef.current = null;
      if (drag.dragging) {
        onFinishAppletDrag();
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      dragRef.current = null;
      onCancelAppletDrag();
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [
    instanceId,
    onBeginAppletDrag,
    onCancelAppletDrag,
    onFinishAppletDrag,
    onUpdateAppletDrag,
    session.kind,
    session.title
  ]);
  return (
    <section className="applet-frame" data-testid={`applet-${session.kind}`} data-applet-instance-id={instanceId}>
      <header
        className="applet-header"
        onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            if (event.target instanceof Element && event.target.closest(".applet-actions")) {
              return;
            }
            const rect = event.currentTarget.closest(".applet-frame")?.getBoundingClientRect();
            const headerRect = event.currentTarget.getBoundingClientRect();
            if (event.clientX > headerRect.right - 8) {
              return;
            }
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              offsetX: rect ? event.clientX - rect.left : 12,
              offsetY: rect ? event.clientY - rect.top : 12,
              dragging: false
            };
          }}
      >
        <div className="applet-title">
          <Icon size={15} />
          <span>{session.title}</span>
        </div>
        <div className="applet-actions">
          <div className="applet-picker">
            <button
              className="icon-button"
              type="button"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              aria-label={`${session.title} add applet`}
              disabled={!canSplitAnyDirection}
              onClick={() => {
                setAddMenuOpen((open) => !open);
                setChangeMenuOpen(false);
              }}
            >
              <Plus size={16} />
            </button>
            {addMenuOpen ? (
              <div className="applet-picker-menu" role="menu">
                {appletCatalog.map((item) => {
                  const ItemIcon = iconByKind[item.kind];
                  return (
                    <button
                      key={item.kind}
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        createApplet(item.kind, pickerSplitDirection);
                        setAddMenuOpen(false);
                      }}
                    >
                      <ItemIcon size={14} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="applet-picker">
            <button
              className="icon-button"
              type="button"
              aria-haspopup="menu"
              aria-expanded={changeMenuOpen}
              aria-label={`${session.title} change applet type`}
              onClick={() => {
                setChangeMenuOpen((open) => !open);
                setAddMenuOpen(false);
              }}
            >
              <Replace size={16} />
            </button>
            {changeMenuOpen ? (
              <div className="applet-picker-menu" role="menu">
                {appletCatalog.map((item) => {
                  const ItemIcon = iconByKind[item.kind];
                  return (
                    <button
                      key={item.kind}
                      className={item.kind === session.kind ? "active" : undefined}
                      role="menuitemradio"
                      aria-checked={item.kind === session.kind}
                      type="button"
                      onClick={() => {
                        changeAppletKind(item.kind);
                        setChangeMenuOpen(false);
                      }}
                    >
                      <ItemIcon size={14} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={`${session.title} split right`}
            disabled={!canSplitRow}
            onClick={() => createApplet("terminal", "row")}
          >
            <PanelRight size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={`${session.title} split down`}
            disabled={!canSplitColumn}
            onClick={() => createApplet("terminal", "column")}
          >
            <PanelTop size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={`${session.title} close`}
            onClick={() => {
              void window.unitApi.applets.closeAppletInstance({ workspaceId, appletInstanceId: instanceId });
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>
      <div className="applet-body">{renderAppletBody(session)}</div>
    </section>
  );
}

function TerminalSurface({ session }: { session: AppletSession }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || (session.kind !== "terminal" && session.kind !== "wslTerminal")) {
      return;
    }
    const terminalKind = session.kind;

    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Mono", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: "#080c12",
        foreground: "#e8eef7",
        cursor: "#e8eef7",
        selectionBackground: "#29415f"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let terminalDimensions = fitTerminal(container, fit, terminal);
    let resizeFrame: number | null = null;
    const publishResize = () => {
      resizeFrame = null;
      const nextDimensions = fitTerminal(container, fit, terminal);
      if (nextDimensions.cols === terminalDimensions.cols && nextDimensions.rows === terminalDimensions.rows) {
        return;
      }
      terminalDimensions = nextDimensions;
      void window.unitApi.terminal.resize({
        sessionId: session.id,
        cols: nextDimensions.cols,
        rows: nextDimensions.rows
      });
    };
    const scheduleResize = () => {
      if (resizeFrame !== null) {
        return;
      }
      resizeFrame = window.requestAnimationFrame(publishResize);
    };
    const dataSubscription = terminal.onData((data) => {
      window.unitApi.terminal.input({ sessionId: session.id, data });
    });
    const removeDataListener = window.unitApi.terminal.onData((payload) => {
      if (payload.sessionId === session.id) {
        terminal.write(payload.data);
      }
    });
    void window.unitApi.terminal
      .start({
        sessionId: session.id,
        kind: terminalKind,
        cols: terminalDimensions.cols,
        rows: terminalDimensions.rows
      })
      .then((result) => {
        if (result.output) {
          terminal.write(result.output);
        }
      })
      .catch((error: unknown) => {
        terminal.write(`\r\nFailed to start ${session.title}: ${errorMessage(error)}\r\n`);
      });

    const resizeObserver = new ResizeObserver(() => {
      scheduleResize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      removeDataListener();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [session.id, session.kind, session.title]);

  return <div className="terminal-surface" ref={containerRef} />;
}

function fitTerminal(container: HTMLElement, fit: FitAddon, terminal: XTerm): { cols: number; rows: number } {
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    fit.fit();
  }
  return { cols: Math.max(2, terminal.cols), rows: Math.max(1, terminal.rows) };
}

function renderAppletBody(session: AppletSession) {
  const { kind } = session;
  if (kind === "terminal" || kind === "wslTerminal") {
    return <TerminalSurface session={session} />;
  }
  if (kind === "fileViewer") {
    return (
      <div className="file-viewer">
        <nav className="file-tree">
          <span>UNIT-0</span>
          <span>src</span>
          <span className="selected">App.tsx</span>
          <span>main.ts</span>
          <span>scope.md</span>
        </nav>
        <pre className="code-view">
          <code>{`export function App() {
  return <WorkspaceSurface />;
}

type AppletSession = {
  id: string;
  kind: AppletKind;
};`}</code>
        </pre>
      </div>
    );
  }
  if (kind === "browser") {
    return (
      <div className="browser-surface">
        <div className="browser-toolbar">
          <span>http://localhost:5173/</span>
          <Search size={14} />
        </div>
        <div className="browser-page">
          <h1>Atlas</h1>
          <p>Build faster. Ship sooner.</p>
          <div className="browser-row">
            <span>Home</span>
            <span>Docs</span>
            <span>Pricing</span>
          </div>
        </div>
      </div>
    );
  }
  if (kind === "chat") {
    return (
      <div className="chat-surface">
        <aside className="chat-list">
          <span className="active">Refactor auth flow</span>
          <span>API integration</span>
          <span>Database schema</span>
          <span>Error troubleshooting</span>
        </aside>
        <div className="chat-thread">
          <p className="user-message">I want to refactor the authentication flow.</p>
          <p className="assistant-message">Update schema, rotate refresh tokens, adjust API endpoints, and cover the client store.</p>
          <div className="composer">Message Assistant...</div>
        </div>
      </div>
    );
  }
  return (
    <div className="sandbox-surface">
      <div className="sandbox-topbar">
        <span>VM: Ubuntu 22.04</span>
        <Power size={16} />
      </div>
      <div className="sandbox-screen">
        <div className="sandbox-terminal">dev@ubuntu:~$ ls -la</div>
      </div>
    </div>
  );
}

function toScreenRect(rect: DOMRect): RectLike {
  return {
    left: window.screenX + rect.left,
    top: window.screenY + rect.top,
    right: window.screenX + rect.right,
    bottom: window.screenY + rect.bottom
  };
}

function toClientRect(rect: DOMRect): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom
  };
}

function relativeRect(
  target: DOMRect,
  container: DOMRect,
  edge: "left" | "right" | "top" | "bottom"
): { left: number; top: number; width: number; height: number } {
  const base = {
    left: target.left - container.left,
    top: target.top - container.top,
    width: target.width,
    height: target.height
  };
  if (edge === "left") {
    return { ...base, width: Math.max(72, target.width * 0.36) };
  }
  if (edge === "right") {
    const width = Math.max(72, target.width * 0.36);
    return { ...base, left: target.right - container.left - width, width };
  }
  if (edge === "top") {
    return { ...base, height: Math.max(72, target.height * 0.36) };
  }
  const height = Math.max(72, target.height * 0.36);
  return { ...base, top: target.bottom - container.top - height, height };
}
