import {
  Bot,
  Code2,
  Columns2,
  PanelRight,
  PanelTop,
  Globe,
  Grid2X2,
  Monitor,
  MoreHorizontal,
  Plus,
  Power,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { closeHitRectForTab, closeRectForTab, insertionIndexForX, titleRectForTab } from "./tabGeometry";

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
  fileViewer: Code2,
  browser: Globe,
  chat: Bot,
  sandbox: Monitor
};

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
      const width = tab.pinned ? 206 : Math.min(224, Math.max(166, 118 + tab.title.length * 8));
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
  return (
    <section className="workspace-surface" data-testid="workspace-surface">
      {workspace.layout ? (
        <WorkspaceLayout node={workspace.layout} appletsById={appletsById} workspaceId={workspace.id} root />
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
    </section>
  );
}

function WorkspaceLayout({
  node,
  appletsById,
  workspaceId,
  root = false
}: {
  node: WorkspaceLayoutNode;
  appletsById: Map<string, { instance: Workspace["applets"][number]; session: AppletSession | undefined }>;
  workspaceId: string;
  root?: boolean;
}) {
  if (node.type === "leaf") {
    const applet = appletsById.get(node.appletInstanceId);
    if (!applet?.session) {
      throw new Error(`Layout leaf references missing applet instance ${node.appletInstanceId}`);
    }
    return (
      <div className="layout-leaf" data-testid={`layout-leaf-${node.appletInstanceId}`}>
        <AppletFrame session={applet.session} instanceId={applet.instance.id} leafId={node.id} workspaceId={workspaceId} />
      </div>
    );
  }
  const firstBasis = `${node.ratio * 100}%`;
  const secondBasis = `${(1 - node.ratio) * 100}%`;
  return (
    <div
      className={`workspace-layout layout-split layout-${node.direction} ${root ? "layout-root" : ""}`}
      data-testid={root ? "workspace-layout" : undefined}
      data-layout-direction={node.direction}
    >
      <div className="layout-branch" style={{ flex: `${node.ratio} 1 ${firstBasis}` }}>
        <WorkspaceLayout node={node.first} appletsById={appletsById} workspaceId={workspaceId} />
      </div>
      <div className="layout-branch" style={{ flex: `${1 - node.ratio} 1 ${secondBasis}` }}>
        <WorkspaceLayout node={node.second} appletsById={appletsById} workspaceId={workspaceId} />
      </div>
    </div>
  );
}

function AppletFrame({
  session,
  instanceId,
  leafId,
  workspaceId
}: {
  session: AppletSession;
  instanceId: string;
  leafId: string;
  workspaceId: string;
}) {
  const Icon = iconByKind[session.kind];
  const createTerminal = (splitDirection: "row" | "column") => {
    void window.unitApi.applets.createApplet({
      workspaceId,
      kind: "terminal",
      targetLeafId: leafId,
      splitDirection
    });
  };
  return (
    <section className="applet-frame" data-testid={`applet-${session.kind}`} data-applet-instance-id={instanceId}>
      <header className="applet-header">
        <div className="applet-title">
          <Icon size={15} />
          <span>{session.title}</span>
        </div>
        <div className="applet-actions">
          <button
            className="icon-button"
            type="button"
            aria-label={`${session.title} add terminal`}
            onClick={() => createTerminal("row")}
          >
            <Plus size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={`${session.title} split right`}
            onClick={() => createTerminal("row")}
          >
            <PanelRight size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={`${session.title} split down`}
            onClick={() => createTerminal("column")}
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
          <button className="icon-button" type="button" aria-label={`${session.title} menu`}>
            <MoreHorizontal size={17} />
          </button>
        </div>
      </header>
      <div className="applet-body">{renderAppletBody(session.kind)}</div>
    </section>
  );
}

function renderAppletBody(kind: AppletKind) {
  if (kind === "terminal") {
    return (
      <pre className="terminal-surface">
        <span className="prompt">dev@unit-0</span> ~/projects/unit-0 (main) $ npm run dev{"\n"}
        <span className="muted">vite</span> ready in 418 ms{"\n\n"}
        <span className="prompt">dev@unit-0</span> ~/projects/unit-0 (main) $ git status{"\n"}
        On branch main{"\n"}
        nothing to commit, working tree clean
      </pre>
    );
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

export const __tabGeometryForTests = {
  closeHitRectForTab,
  closeRectForTab,
  insertionIndexForX,
  titleRectForTab
};
