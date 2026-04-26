import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronRight,
  Code2,
  Database,
  File,
  FolderOpen,
  Globe,
  GitBranch,
  Grid2X2,
  Layers3,
  LayoutDashboard,
  LayoutTemplate,
  Monitor,
  PanelRight,
  PanelTop,
  Plus,
  Power,
  RadioTower,
  RefreshCw,
  Replace,
  Search,
  Server,
  Settings,
  Save,
  Send,
  SquareTerminal,
  Square,
  Trash2,
  X
} from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Tree, type NodeRendererProps } from "react-arborist";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type SVGProps
} from "react";
import { THIRD_PARTY_LICENSES } from "./thirdPartyLicenses";
import { DEFAULT_BROWSER_URL, normalizeBrowserNavigationUrl } from "../shared/browserUrls";
import type {
  AppletKind,
  AppletSession,
  ApplyWorkspaceTemplatePayload,
  BootstrapPayload,
  BrowserStatusPayload,
  ChatMessage,
  ChatState,
  FileTreeEntry,
  ReadFileResult,
  RectLike,
  TabHostState,
  TemplateCellAssignment,
  UnitState,
  Workspace,
  WorkspaceLayoutNode,
  WorkspaceTemplateLayoutNode,
  WorkspaceTemplateId,
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
import { planWorkspaceTemplate } from "../shared/templatePlanner";
import { workspaceTemplateById, workspaceTemplates } from "../shared/workspaceTemplates";
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
const TERMINAL_PTY_RESIZE_SETTLE_MS = 90;

function TabCloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 14 14" {...props}>
      <path d="M3.65 3.65 10.35 10.35M10.35 3.65 3.65 10.35" />
    </svg>
  );
}

export function App() {
  const [payload, setPayload] = useState<BootstrapPayload | null>(null);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openTemplateDrawer = useCallback(() => setTemplateDrawerOpen(true), []);

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

  const browserViewsVisible = Boolean(payload && !settingsOpen && !templateDrawerOpen && !payload.state.dragSession);

  useEffect(() => {
    if (!payload) {
      return;
    }
    void window.unitApi.browser.setWindowViewsVisible({
      windowId: payload.windowId,
      visible: browserViewsVisible
    });
  }, [browserViewsVisible, payload?.windowId]);

  if (!payload) {
    return <div className="boot-screen" />;
  }

  const host = payload.state.hosts[payload.windowId];
  const activeTab = host ? payload.state.tabs[host.activeTabId] : null;
  const activeWorkspace = activeTab ? payload.state.workspaces[activeTab.workspaceId] : null;
  const initialTemplateWorkspaceId = activeWorkspace?.id !== "manager" ? activeWorkspace?.id : firstNonManagerWorkspaceId(payload.state);

  return (
    <main className="app-shell">
      <header className="workspace-bar">
        {host ? <WorkspaceTabStrip host={host} state={payload.state} windowId={payload.windowId} /> : <div />}
        <div className="window-tools">
          <button
            className="template-toolbar-button"
            type="button"
            aria-label="Templates"
            aria-pressed={templateDrawerOpen}
            onClick={() => {
              if (templateDrawerOpen) {
                setTemplateDrawerOpen(false);
              } else {
                openTemplateDrawer();
              }
            }}
          >
            <LayoutTemplate size={16} />
            <span>Templates</span>
          </button>
          <button className="icon-button" type="button" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} />
          </button>
        </div>
      </header>
      {activeWorkspace?.id === "manager" ? (
        <WorkspaceManagerSurface state={payload.state} onOpenTemplates={openTemplateDrawer} />
      ) : activeWorkspace ? (
        <WorkspaceSurface state={payload.state} windowId={payload.windowId} workspace={activeWorkspace} />
      ) : (
        <div />
      )}
      {templateDrawerOpen ? (
        <TemplateDrawer
          activeWorkspaceId={initialTemplateWorkspaceId}
          state={payload.state}
          onClose={() => setTemplateDrawerOpen(false)}
        />
      ) : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </main>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="settings-backdrop" role="presentation" onPointerDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-button" type="button" aria-label="Close settings" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            <button className="active" type="button" aria-current="page">
              About
            </button>
          </nav>
          <section className="settings-panel" aria-label="About">
            <div className="about-product">
              <strong>UNIT-0</strong>
              <span>Version 0.1.0</span>
            </div>
            <pre className="license-notices">{THIRD_PARTY_LICENSES}</pre>
          </section>
        </div>
      </section>
    </div>
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
          <TabCloseIcon
            className="tab-close"
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
            <span>Cancel</span>
          </button>
          <button disabled={!trimmedTitle} type="submit">
            <span>{mode === "create" ? "Create" : "Rename"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkspaceManagerSurface({ state, onOpenTemplates }: { state: UnitState; onOpenTemplates: () => void }) {
  const workspaces = Object.values(state.workspaces).filter((workspace) => workspace.id !== "manager");
  const primaryHost = state.hosts[state.primaryWindowId];
  const sessions = Object.values(state.appletSessions);
  const mountedSessionCounts = workspaces.reduce<Record<string, number>>((counts, workspace) => {
    for (const applet of workspace.applets) {
      counts[applet.sessionId] = (counts[applet.sessionId] ?? 0) + 1;
    }
    return counts;
  }, {});
  const activeHostCount = Object.values(state.hosts).filter((host) => host.tabIds.length > 0).length;
  const activeWorkspaceCount = new Set(
    Object.values(state.hosts)
      .flatMap((host) => host.tabIds)
      .map((tabId) => state.tabs[tabId]?.workspaceId)
      .filter((workspaceId): workspaceId is string => Boolean(workspaceId) && workspaceId !== "manager")
  ).size;
  const appletCount = workspaces.reduce((count, workspace) => count + workspace.applets.length, 0);
  const sharedSessionCount = Object.values(mountedSessionCounts).filter((count) => count > 1).length;
  const kindCounts = sessions.reduce<Record<AppletKind, number>>(
    (counts, session) => ({ ...counts, [session.kind]: counts[session.kind] + 1 }),
    { terminal: 0, wslTerminal: 0, fileViewer: 0, browser: 0, chat: 0, sandbox: 0 }
  );
  const runtimeRows = [
    { icon: SquareTerminal, label: "Terminals", value: kindCounts.terminal + kindCounts.wslTerminal, tone: "green" },
    { icon: Globe, label: "Browsers", value: kindCounts.browser, tone: "blue" },
    { icon: Bot, label: "Chats", value: kindCounts.chat, tone: "violet" },
    { icon: Monitor, label: "Sandboxes", value: kindCounts.sandbox, tone: "amber" }
  ];
  return (
    <section className="workspace-manager" data-testid="workspace-manager">
      <div className="manager-command">
        <div className="manager-title-block">
          <span className="manager-kicker">UNIT-0</span>
          <h1>Workspace Manager</h1>
        </div>
        <label className="manager-search">
          <Search size={16} />
          <input aria-label="Search workspaces" placeholder="Search workspaces, sessions, files, chats" />
        </label>
        <div className="manager-actions">
          <button className="manager-action-button primary" type="button">
            <Plus size={16} />
            <span>Workspace</span>
          </button>
          <button className="manager-action-button" type="button" onClick={onOpenTemplates}>
            <LayoutDashboard size={16} />
            <span>Template</span>
          </button>
        </div>
      </div>

      <div className="manager-metrics" aria-label="Workspace summary">
        <div>
          <span>{workspaces.length}</span>
          <small>Workspaces</small>
        </div>
        <div>
          <span>{activeWorkspaceCount}</span>
          <small>Open</small>
        </div>
        <div>
          <span>{sessions.length}</span>
          <small>Sessions</small>
        </div>
        <div>
          <span>{sharedSessionCount}</span>
          <small>Shared</small>
        </div>
        <div>
          <span>{appletCount}</span>
          <small>Applets</small>
        </div>
        <div>
          <span>{activeHostCount}</span>
          <small>Windows</small>
        </div>
      </div>

      <div className="manager-grid">
        <section className="manager-panel manager-library">
          <div className="manager-panel-header">
            <div>
              <h2>Workspace Library</h2>
              <span>Project context, layout, sessions, runtime state</span>
            </div>
            <button className="icon-button" type="button" aria-label="Workspace library settings">
              <Settings size={16} />
            </button>
          </div>
          <div className="manager-table">
            <div className="manager-table-head">
              <span>Workspace</span>
              <span>Mounted</span>
              <span>Runtime</span>
              <span>Status</span>
              <span aria-hidden="true" />
            </div>
            {workspaces.map((workspace, index) => {
              const open = Object.values(state.hosts).some((host) =>
                host.tabIds.some((tabId) => state.tabs[tabId]?.workspaceId === workspace.id)
              );
              const primaryKinds = workspace.applets
                .slice(0, 3)
                .map((applet) => state.appletSessions[applet.sessionId]?.kind)
                .filter((kind): kind is AppletKind => Boolean(kind));
              return (
                <div className="manager-workspace-row" key={workspace.id}>
                  <button
                    className="manager-workspace-open"
                    data-testid={`workspace-manager-row-${workspace.id}`}
                    onClick={() => {
                      if (primaryHost) {
                        void window.unitApi.workspaces.openWorkspaceTab({
                          windowId: primaryHost.windowId,
                          workspaceId: workspace.id
                        });
                      }
                    }}
                    type="button"
                  >
                    <span className="manager-workspace-main">
                      <FolderOpen size={17} />
                      <span>
                        <strong>{workspace.title}</strong>
                        <small>{index === 0 ? "C:\\Users\\Max\\Desktop\\Code\\Unit-0" : "No project root linked"}</small>
                      </span>
                    </span>
                    <span className="manager-kind-stack">
                      {primaryKinds.map((kind, kindIndex) => {
                        const Icon = iconByKind[kind];
                        return <Icon key={`${workspace.id}-${kind}-${kindIndex}`} size={15} />;
                      })}
                      <small>{workspace.applets.length}</small>
                    </span>
                    <span className={`manager-runtime ${open ? "online" : ""}`}>
                      <Activity size={14} />
                      {open ? "Live" : "Idle"}
                    </span>
                    <span className="manager-status">
                      <GitBranch size={14} />
                      {index === 0 ? "main" : "clean"}
                    </span>
                  </button>
                  <button
                    className="manager-workspace-close"
                    type="button"
                    aria-label={`Close ${workspace.title}`}
                    data-testid={`workspace-manager-close-${workspace.id}`}
                    onClick={() => {
                      void window.unitApi.workspaces.closeWorkspace({ workspaceId: workspace.id });
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="manager-side">
          <section className="manager-panel">
            <div className="manager-panel-header compact">
              <div>
                <h2>Runtime</h2>
                <span>Active service surface</span>
              </div>
              <RadioTower size={17} />
            </div>
            <div className="manager-runtime-list">
              {runtimeRows.map((row) => {
                const Icon = row.icon;
                return (
                  <div className={`manager-runtime-row ${row.tone}`} key={row.label}>
                    <Icon size={16} />
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="manager-panel">
            <div className="manager-panel-header compact">
              <div>
                <h2>Templates</h2>
                <span>Workspace launch shapes</span>
              </div>
              <Layers3 size={17} />
            </div>
            <div className="manager-template-list">
              <button type="button" onClick={onOpenTemplates}>
                <Code2 size={16} />
                <span>2 x 2 Grid</span>
              </button>
              <button type="button" onClick={onOpenTemplates}>
                <Bot size={16} />
                <span>3 x 3 Grid</span>
              </button>
              <button type="button" onClick={onOpenTemplates}>
                <Server size={16} />
                <span>Sidebar + Grid</span>
              </button>
            </div>
          </section>
        </aside>

        <section className="manager-panel manager-sessions">
          <div className="manager-panel-header">
            <div>
              <h2>Shared Sessions</h2>
              <span>Mountable applet runtime graph</span>
            </div>
            <Database size={17} />
          </div>
          <div className="manager-session-strip">
            {sessions.slice(0, 6).map((session) => {
              const Icon = iconByKind[session.kind];
              const mountCount = mountedSessionCounts[session.id] ?? 0;
              return (
                <div className="manager-session-item" key={session.id}>
                  <Icon size={17} />
                  <span>
                    <strong>{session.title}</strong>
                    <small>
                      {mountCount} mount{mountCount === 1 ? "" : "s"}
                    </small>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </section>
  );
}

function TemplateDrawer({
  activeWorkspaceId,
  state,
  onClose
}: {
  activeWorkspaceId: string | undefined;
  state: UnitState;
  onClose: () => void;
}) {
  const workspaceOptions = useMemo(
    () => Object.values(state.workspaces).filter((workspace) => workspace.id !== "manager"),
    [state.workspaces]
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(activeWorkspaceId ?? workspaceOptions[0]?.id ?? "");
  const [selectedTemplateId, setSelectedTemplateId] = useState<WorkspaceTemplateId>("grid-2x2");
  const [assignments, setAssignments] = useState<Record<string, TemplateCellAssignment>>({});
  const [applyError, setApplyError] = useState<string | null>(null);
  const selectedWorkspace = state.workspaces[selectedWorkspaceId];
  const selectedTemplate = workspaceTemplateById(selectedTemplateId);

  useEffect(() => {
    if (selectedWorkspaceId && state.workspaces[selectedWorkspaceId]) {
      return;
    }
    setSelectedWorkspaceId(activeWorkspaceId ?? workspaceOptions[0]?.id ?? "");
  }, [activeWorkspaceId, selectedWorkspaceId, state.workspaces, workspaceOptions]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setAssignments({});
      return;
    }
    setAssignments(planWorkspaceTemplate(selectedWorkspace, state.appletSessions, selectedTemplate).assignments);
    setApplyError(null);
  }, [selectedTemplate, selectedWorkspace, state.appletSessions]);

  const assignmentStats = useMemo(() => {
    if (!selectedWorkspace) {
      return { reused: 0, created: 0, shelved: 0, invalid: true };
    }
    const usedAppletIds = new Set<string>();
    let reused = 0;
    let created = 0;
    let invalid = false;
    for (const cell of selectedTemplate.cells) {
      const assignment = assignments[cell.id];
      if (!assignment) {
        invalid = true;
        continue;
      }
      if (assignment.mode === "create") {
        created += 1;
        if (!cell.acceptedKinds.includes(assignment.kind)) {
          invalid = true;
        }
        continue;
      }
      const instance = selectedWorkspace.applets.find((item) => item.id === assignment.appletInstanceId);
      const session = instance ? state.appletSessions[instance.sessionId] : null;
      if (!instance || !session || usedAppletIds.has(instance.id) || !cell.acceptedKinds.includes(session.kind)) {
        invalid = true;
        continue;
      }
      reused += 1;
      usedAppletIds.add(instance.id);
    }
    return {
      reused,
      created,
      shelved: selectedWorkspace.applets.filter((instance) => !usedAppletIds.has(instance.id)).length,
      invalid
    };
  }, [assignments, selectedTemplate, selectedWorkspace, state.appletSessions]);

  const orderedAppletOptions = useMemo(() => {
    if (!selectedWorkspace) {
      return [];
    }
    const visualIds = selectedWorkspace.layout ? collectLayoutAppletIds(selectedWorkspace.layout) : [];
    const byId = new Map(selectedWorkspace.applets.map((instance) => [instance.id, instance]));
    const orderedIds = [...visualIds, ...selectedWorkspace.shelfAppletIds, ...selectedWorkspace.applets.map((instance) => instance.id)];
    const seen = new Set<string>();
    return orderedIds
      .map((id) => byId.get(id))
      .filter((instance): instance is Workspace["applets"][number] => {
        if (!instance || seen.has(instance.id)) {
          return false;
        }
        seen.add(instance.id);
        return true;
      });
  }, [selectedWorkspace]);

  const applyTemplate = () => {
    if (!selectedWorkspace || assignmentStats.invalid) {
      return;
    }
    const payload: ApplyWorkspaceTemplatePayload = {
      workspaceId: selectedWorkspace.id,
      templateId: selectedTemplate.id,
      assignments
    };
    setApplyError(null);
    void window.unitApi.workspaces
      .applyTemplate(payload)
      .then(() => onClose())
      .catch((error: unknown) => setApplyError(errorMessage(error)));
  };

  return (
    <div className="template-drawer-backdrop" data-testid="template-drawer" role="presentation">
      <section className="template-drawer" aria-label="Workspace templates">
        <header className="template-drawer-header">
          <div>
            <span className="manager-kicker">Templates</span>
            <h2>Apply Workspace Template</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close templates" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="template-drawer-body">
          <aside className="template-catalog" aria-label="Template catalog">
            {workspaceTemplates.map((template) => (
              <button
                className={template.id === selectedTemplateId ? "template-option active" : "template-option"}
                data-testid={`template-option-${template.id}`}
                key={template.id}
                type="button"
                onClick={() => setSelectedTemplateId(template.id)}
              >
                <TemplateMiniPreview layout={template.layout} />
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                </span>
              </button>
            ))}
          </aside>

          <section className="template-preview-panel">
            <div className="template-target-row">
              <label>
                <span>Workspace</span>
                <select
                  data-testid="template-workspace-select"
                  value={selectedWorkspaceId}
                  onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                >
                  {workspaceOptions.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="template-impact">
                <span>{assignmentStats.reused} reused</span>
                <span>{assignmentStats.created} created</span>
                <span>{assignmentStats.shelved} shelved</span>
              </div>
            </div>
            <div className="template-large-preview">
              <TemplateCellPreview layout={selectedTemplate.layout} assignments={assignments} state={state} />
            </div>
          </section>

          <aside className="template-assignment-panel">
            <h3>Cells</h3>
            {selectedTemplate.cells.map((cell) => {
              const assignment = assignments[cell.id];
              const usedElsewhere = assignedReuseIds(assignments, cell.id);
              const reusedInstance =
                assignment?.mode === "reuse" ? selectedWorkspace?.applets.find((instance) => instance.id === assignment.appletInstanceId) : null;
              const reusedSession = reusedInstance ? state.appletSessions[reusedInstance.sessionId] : null;
              const mismatched = Boolean(reusedSession && reusedSession.kind !== cell.preferredKind);
              return (
                <label className={mismatched ? "template-cell-row mismatched" : "template-cell-row"} data-testid={`template-cell-${cell.id}`} key={cell.id}>
                  <span className="template-cell-title">
                    {(() => {
                      const Icon = iconByKind[cell.preferredKind];
                      return <Icon size={15} />;
                    })()}
                    <strong>{cell.label}</strong>
                  </span>
                  <select
                    value={assignmentValue(assignment)}
                    onChange={(event) =>
                      setAssignments((current) => ({ ...current, [cell.id]: parseAssignmentValue(event.target.value) }))
                    }
                  >
                    {cell.acceptedKinds.map((kind) => (
                      <option key={`create-${kind}`} value={`create:${kind}`}>
                        Create {labelForAppletKind(kind)}
                      </option>
                    ))}
                    {orderedAppletOptions
                      .filter((instance) => {
                        const session = state.appletSessions[instance.sessionId];
                        return Boolean(session && cell.acceptedKinds.includes(session.kind));
                      })
                      .map((instance) => {
                        const session = state.appletSessions[instance.sessionId];
                        return (
                          <option
                            disabled={usedElsewhere.has(instance.id)}
                            key={`reuse-${instance.id}`}
                            value={`reuse:${instance.id}`}
                          >
                            Reuse {session?.title ?? instance.id}
                          </option>
                        );
                      })}
                  </select>
                  {mismatched ? <small>Compatible {labelForAppletKind(reusedSession!.kind)}</small> : null}
                </label>
              );
            })}
            <div className="template-overflow-preview">
              <span>Overflow shelf</span>
              <div>
                {selectedWorkspace?.applets
                  .filter((instance) => !assignedReuseIds(assignments).has(instance.id))
                  .map((instance) => {
                    const session = state.appletSessions[instance.sessionId];
                    const Icon = session ? iconByKind[session.kind] : SquareTerminal;
                    return (
                      <span className="template-overflow-item" key={instance.id}>
                        <Icon size={14} />
                        {session?.title ?? instance.id}
                      </span>
                    );
                  })}
              </div>
            </div>
          </aside>
        </div>

        <footer className="template-drawer-footer">
          {applyError ? <span className="template-error">{applyError}</span> : <span />}
          <button className="manager-action-button" type="button" onClick={onClose}>
            <span>Cancel</span>
          </button>
          <button
            className="manager-action-button primary"
            data-testid="template-apply"
            disabled={!selectedWorkspace || assignmentStats.invalid}
            type="button"
            onClick={applyTemplate}
          >
            <span>
              Apply template: {assignmentStats.reused} reused, {assignmentStats.created} created, {assignmentStats.shelved} shelved
            </span>
          </button>
        </footer>
      </section>
    </div>
  );
}

function WorkspaceSurface({ state, windowId, workspace }: { state: UnitState; windowId: number; workspace: Workspace }) {
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
  const [switchSourceInstanceId, setSwitchSourceInstanceId] = useState<string | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
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
  const workspaceAppletIdList = useMemo(() => workspace.applets.map((instance) => instance.id), [workspace.applets]);
  const workspaceShelfAppletIds = useMemo(() => new Set(workspace.shelfAppletIds), [workspace.shelfAppletIds]);
  const visibleWorkspaceAppletIdList = useMemo(
    () => workspace.applets.map((instance) => instance.id).filter((appletId) => !workspaceShelfAppletIds.has(appletId)),
    [workspace.applets, workspaceShelfAppletIds]
  );
  const workspaceAppletIds = useMemo(() => new Set(workspaceAppletIdList), [workspaceAppletIdList]);
  const layoutOverrideAppletIds = useMemo(
    () => (layoutOverride ? collectLayoutAppletIds(layoutOverride) : []),
    [layoutOverride]
  );
  const layoutOverrideMatchesWorkspace =
    layoutOverride !== null && sameStringMembers(layoutOverrideAppletIds, visibleWorkspaceAppletIdList);
  if (layoutOverride && !layoutOverrideMatchesWorkspace) {
    console.error("[unit0:layout-integrity] stale layout override ignored", {
      workspaceId: workspace.id,
      workspaceAppletIds: workspaceAppletIdList,
      visibleWorkspaceAppletIds: visibleWorkspaceAppletIdList,
      shelfAppletIds: workspace.shelfAppletIds,
      workspaceLayoutAppletIds: workspace.layout ? collectLayoutAppletIds(workspace.layout) : [],
      overrideLayoutAppletIds: layoutOverrideAppletIds,
      ratioOverrideIds: Object.keys(ratioOverrides)
    });
  }
  const activeLayoutOverride = layoutOverrideMatchesWorkspace ? layoutOverride : null;
  const effectiveLayout = useMemo(
    () => activeLayoutOverride ?? (workspace.layout ? applyRatioOverrides(workspace.layout, ratioOverrides) : null),
    [activeLayoutOverride, workspace.layout, ratioOverrideKey]
  );
  const layoutSource = activeLayoutOverride ? "override" : "workspace";
  const effectiveLayoutAppletIds = useMemo(
    () => (effectiveLayout ? collectLayoutAppletIds(effectiveLayout) : []),
    [effectiveLayout]
  );
  const missingEffectiveLayoutAppletIds = effectiveLayoutAppletIds.filter((appletId) => !workspaceAppletIds.has(appletId));
  if (missingEffectiveLayoutAppletIds.length > 0) {
    console.error("[unit0:layout-integrity] effective layout references missing applet(s)", {
      workspaceId: workspace.id,
      layoutSource,
      missingAppletIds: missingEffectiveLayoutAppletIds,
      workspaceAppletIds: workspace.applets.map((instance) => instance.id),
      workspaceLayoutAppletIds: workspace.layout ? collectLayoutAppletIds(workspace.layout) : [],
      overrideLayoutAppletIds: layoutOverride ? collectLayoutAppletIds(layoutOverride) : [],
      ratioOverrideIds: Object.keys(ratioOverrides)
    });
  }
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
  useEffect(() => {
    if (layoutOverride && !layoutOverrideMatchesWorkspace) {
      setLayoutOverride(null);
    }
  }, [layoutOverride, layoutOverrideMatchesWorkspace]);
  useEffect(() => {
    if (switchSourceInstanceId && !workspace.applets.some((instance) => instance.id === switchSourceInstanceId)) {
      setSwitchSourceInstanceId(null);
    }
  }, [switchSourceInstanceId, workspace.applets]);
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
  const beginAppletSwitch = useCallback((instanceId: string) => {
    setSwitchSourceInstanceId((current) => (current === instanceId ? null : instanceId));
  }, []);
  const selectAppletSwitchTarget = useCallback(
    (targetInstanceId: string) => {
      if (!switchSourceInstanceId || !workspace.layout) {
        return;
      }
      if (targetInstanceId === switchSourceInstanceId) {
        setSwitchSourceInstanceId(null);
        return;
      }
      const nextLayout = swapLayoutAppletInstances(workspace.layout, switchSourceInstanceId, targetInstanceId);
      setSwitchSourceInstanceId(null);
      setRatioOverrides({});
      setLayoutOverride(nextLayout);
      void window.unitApi.workspaces
        .replaceLayout({ workspaceId: workspace.id, layout: nextLayout })
        .catch((error) => console.error("Failed to switch applet positions", error));
    },
    [switchSourceInstanceId, workspace.id, workspace.layout]
  );
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
          windowId={windowId}
          workspaceId={workspace.id}
          onBeginAppletDrag={beginAppletDrag}
          onUpdateAppletDrag={updateAppletDrag}
          onFinishAppletDrag={finishAppletDrag}
          onCancelAppletDrag={cancelAppletDrag}
          switchSourceInstanceId={switchSourceInstanceId}
          onBeginAppletSwitch={beginAppletSwitch}
          onSelectAppletSwitchTarget={selectAppletSwitchTarget}
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
      {workspace.shelfAppletIds.length > 0 ? (
        <div className={shelfOpen ? "workspace-shelf open" : "workspace-shelf"} data-testid="workspace-shelf">
          <button className="workspace-shelf-toggle" type="button" onClick={() => setShelfOpen((open) => !open)}>
            <Layers3 size={15} />
            <span>{workspace.shelfAppletIds.length} shelved</span>
          </button>
          {shelfOpen ? (
            <div className="workspace-shelf-items">
              {workspace.shelfAppletIds.map((appletId) => {
                const applet = appletByInstanceId.get(appletId);
                const Icon = applet?.session ? iconByKind[applet.session.kind] : Grid2X2;
                return (
                  <div className="workspace-shelf-item" key={appletId}>
                    <Icon size={14} />
                    <span>{applet?.session?.title ?? appletId}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceLayout({
  geometry,
  appletsById,
  windowId,
  workspaceId,
  onBeginAppletDrag,
  onUpdateAppletDrag,
  onFinishAppletDrag,
  onCancelAppletDrag,
  switchSourceInstanceId,
  onBeginAppletSwitch,
  onSelectAppletSwitchTarget,
  onHoverResizeTarget,
  onLeaveResizeTarget,
  completedGroups,
  activeGroups,
  snapGuides,
  onBeginResizeDrag
}: {
  geometry: CanonicalLayoutGeometry;
  appletsById: Map<string, { instance: Workspace["applets"][number]; session: AppletSession | undefined }>;
  windowId: number;
  workspaceId: string;
  onBeginAppletDrag: (drag: Omit<AppletDragState, "target">) => void;
  onUpdateAppletDrag: (clientX: number, clientY: number) => void;
  onFinishAppletDrag: () => void;
  onCancelAppletDrag: () => void;
  switchSourceInstanceId: string | null;
  onBeginAppletSwitch: (instanceId: string) => void;
  onSelectAppletSwitchTarget: (instanceId: string) => void;
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
          console.error("[unit0:layout-render] layout leaf references missing applet instance", {
            workspaceId,
            leafId: leaf.id,
            missingAppletId: leaf.appletInstanceId,
            mountedAppletIds: [...appletsById.keys()],
            geometryLeafAppletIds: geometry.leaves.map((geometryLeaf) => geometryLeaf.appletInstanceId)
          });
          throw new Error(`Layout leaf references missing applet instance ${leaf.appletInstanceId}`);
        }
        return (
          <div
            className={[
              "layout-leaf",
              switchSourceInstanceId === leaf.appletInstanceId ? "layout-leaf-switch-source" : "",
              switchSourceInstanceId && switchSourceInstanceId !== leaf.appletInstanceId ? "layout-leaf-switch-target" : ""
            ]
              .filter(Boolean)
              .join(" ")}
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
              windowId={windowId}
              workspaceId={workspaceId}
              canSplitRow={leaf.rect.right - leaf.rect.left >= MIN_APPLET_SIZE * 2 + TILE_GUTTER_SIZE}
              canSplitColumn={leaf.rect.bottom - leaf.rect.top >= MIN_APPLET_SIZE * 2 + TILE_GUTTER_SIZE}
              onBeginAppletDrag={onBeginAppletDrag}
              onUpdateAppletDrag={onUpdateAppletDrag}
              onFinishAppletDrag={onFinishAppletDrag}
              onCancelAppletDrag={onCancelAppletDrag}
              switchSourceInstanceId={switchSourceInstanceId}
              onBeginAppletSwitch={onBeginAppletSwitch}
              onSelectAppletSwitchTarget={onSelectAppletSwitchTarget}
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

function firstNonManagerWorkspaceId(state: UnitState): string | undefined {
  const openWorkspaceId = Object.values(state.hosts)
    .flatMap((host) => host.tabIds)
    .map((tabId) => state.tabs[tabId]?.workspaceId)
    .find((workspaceId) => workspaceId && workspaceId !== "manager");
  return openWorkspaceId ?? Object.values(state.workspaces).find((workspace) => workspace.id !== "manager")?.id;
}

function labelForAppletKind(kind: AppletKind): string {
  return appletCatalog.find((item) => item.kind === kind)?.label ?? kind;
}

function assignmentValue(assignment: TemplateCellAssignment | undefined): string {
  if (!assignment) {
    return "";
  }
  return assignment.mode === "reuse" ? `reuse:${assignment.appletInstanceId}` : `create:${assignment.kind}`;
}

function parseAssignmentValue(value: string): TemplateCellAssignment {
  const [mode, id] = value.split(":", 2);
  if (mode === "reuse") {
    return { mode: "reuse", appletInstanceId: id };
  }
  return { mode: "create", kind: id as AppletKind };
}

function assignedReuseIds(assignments: Record<string, TemplateCellAssignment>, exceptCellId?: string): Set<string> {
  const appletIds = new Set<string>();
  for (const [cellId, assignment] of Object.entries(assignments)) {
    if (cellId === exceptCellId || assignment.mode !== "reuse") {
      continue;
    }
    appletIds.add(assignment.appletInstanceId);
  }
  return appletIds;
}

function TemplateMiniPreview({ layout }: { layout: WorkspaceTemplateLayoutNode }) {
  return <div className="template-mini-preview">{renderTemplatePreviewNode(layout)}</div>;
}

function TemplateCellPreview({
  layout,
  assignments,
  state
}: {
  layout: WorkspaceTemplateLayoutNode;
  assignments: Record<string, TemplateCellAssignment>;
  state: UnitState;
}) {
  return <div className="template-cell-preview-root">{renderTemplatePreviewNode(layout, assignments, state)}</div>;
}

function renderTemplatePreviewNode(
  node: WorkspaceTemplateLayoutNode,
  assignments?: Record<string, TemplateCellAssignment>,
  state?: UnitState
) {
  if (node.type === "leaf") {
    const assignment = assignments?.[node.cellId];
    let label = node.cellId;
    let kind: AppletKind | null = null;
    if (assignment?.mode === "create") {
      kind = assignment.kind;
      label = `Create ${labelForAppletKind(assignment.kind)}`;
    }
    if (assignment?.mode === "reuse" && state) {
      const instance = Object.values(state.workspaces)
        .flatMap((workspace) => workspace.applets)
        .find((item) => item.id === assignment.appletInstanceId);
      const session = instance ? state.appletSessions[instance.sessionId] : null;
      kind = session?.kind ?? null;
      label = session ? `Reuse ${session.title}` : assignment.appletInstanceId;
    }
    const Icon = kind ? iconByKind[kind] : Grid2X2;
    return (
      <div className="template-preview-leaf">
        <Icon size={15} />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div className={`template-preview-split ${node.direction}`} style={{ "--template-ratio": node.ratio } as CSSProperties}>
      {renderTemplatePreviewNode(node.first, assignments, state)}
      {renderTemplatePreviewNode(node.second, assignments, state)}
    </div>
  );
}

function swapLayoutAppletInstances(
  node: WorkspaceLayoutNode,
  firstInstanceId: string,
  secondInstanceId: string
): WorkspaceLayoutNode {
  if (node.type === "leaf") {
    if (node.appletInstanceId === firstInstanceId) {
      return { ...node, appletInstanceId: secondInstanceId };
    }
    if (node.appletInstanceId === secondInstanceId) {
      return { ...node, appletInstanceId: firstInstanceId };
    }
    return { ...node };
  }
  return {
    ...node,
    first: swapLayoutAppletInstances(node.first, firstInstanceId, secondInstanceId),
    second: swapLayoutAppletInstances(node.second, firstInstanceId, secondInstanceId)
  };
}

function collectLayoutAppletIds(node: WorkspaceLayoutNode): string[] {
  if (node.type === "leaf") {
    return [node.appletInstanceId];
  }
  return [...collectLayoutAppletIds(node.first), ...collectLayoutAppletIds(node.second)];
}

function sameStringMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
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
  const verticalGroup = drag.target.vertical;
  const vertical = verticalGroup ? traceGroupSnap(drag.geometry, verticalGroup, x, drag.grabOffsetX) : null;
  if (verticalGroup && vertical?.chosen) {
    x = vertical.chosen.delta;
    guides.push(fullWorkspaceSnapGuide(drag.geometry, verticalGroup, vertical.chosen.center));
  }
  const horizontalGroup = drag.target.horizontal;
  const horizontal = horizontalGroup ? traceGroupSnap(drag.geometry, horizontalGroup, y, drag.grabOffsetY) : null;
  if (horizontalGroup && horizontal?.chosen) {
    y = horizontal.chosen.delta;
    guides.push(fullWorkspaceSnapGuide(drag.geometry, horizontalGroup, horizontal.chosen.center));
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
  windowId,
  workspaceId,
  canSplitRow,
  canSplitColumn,
  onBeginAppletDrag,
  onUpdateAppletDrag,
  onFinishAppletDrag,
  onCancelAppletDrag,
  switchSourceInstanceId,
  onBeginAppletSwitch,
  onSelectAppletSwitchTarget
}: {
  session: AppletSession;
  instanceId: string;
  leafId: string;
  windowId: number;
  workspaceId: string;
  canSplitRow: boolean;
  canSplitColumn: boolean;
  onBeginAppletDrag: (drag: Omit<AppletDragState, "target">) => void;
  onUpdateAppletDrag: (clientX: number, clientY: number) => void;
  onFinishAppletDrag: () => void;
  onCancelAppletDrag: () => void;
  switchSourceInstanceId: string | null;
  onBeginAppletSwitch: (instanceId: string) => void;
  onSelectAppletSwitchTarget: (instanceId: string) => void;
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
  const toggleAppletMenu = (targetMenu: "add" | "change") => {
    if ((targetMenu === "add" && addMenuOpen) || (targetMenu === "change" && changeMenuOpen)) {
      setAddMenuOpen(false);
      setChangeMenuOpen(false);
      return;
    }
    setAddMenuOpen(targetMenu === "add");
    setChangeMenuOpen(targetMenu === "change");
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
    <section
      className={[
        "applet-frame",
        switchSourceInstanceId === instanceId ? "applet-frame-switch-source" : "",
        switchSourceInstanceId && switchSourceInstanceId !== instanceId ? "applet-frame-switch-target" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={`applet-${session.kind}`}
      data-applet-instance-id={instanceId}
      onClick={(event) => {
        if (!switchSourceInstanceId) {
          return;
        }
        if (event.target instanceof Element && event.target.closest(".applet-actions")) {
          return;
        }
        onSelectAppletSwitchTarget(instanceId);
      }}
    >
      <header
        className="applet-header"
        onPointerDown={(event) => {
            if (switchSourceInstanceId) {
              return;
            }
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
              onClick={() => toggleAppletMenu("add")}
            >
              <Plus size={16} />
            </button>
            {addMenuOpen ? (
              <div className="applet-picker-menu" role="menu">
                {appletCatalog.map((item) => {
                  const ItemIcon = iconByKind[item.kind];
                  return (
                    <div className="applet-picker-menu-item" key={item.kind} role="none">
                      <span className="applet-picker-menu-label">
                        <ItemIcon size={14} />
                        <span>{item.label}</span>
                      </span>
                      <span className="applet-picker-split-controls">
                        <button
                          aria-label={`Add ${item.label} split right`}
                          disabled={!canSplitRow}
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            createApplet(item.kind, "row");
                            setAddMenuOpen(false);
                          }}
                        >
                          <PanelRight size={15} />
                        </button>
                        <button
                          aria-label={`Add ${item.label} split down`}
                          disabled={!canSplitColumn}
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            createApplet(item.kind, "column");
                            setAddMenuOpen(false);
                          }}
                        >
                          <PanelTop size={15} />
                        </button>
                      </span>
                    </div>
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
              onClick={() => toggleAppletMenu("change")}
            >
              <RefreshCw size={16} />
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
            className={switchSourceInstanceId === instanceId ? "icon-button active" : "icon-button"}
            type="button"
            aria-label={`${session.title} switch places`}
            aria-pressed={switchSourceInstanceId === instanceId}
            onClick={() => {
              setAddMenuOpen(false);
              setChangeMenuOpen(false);
              onBeginAppletSwitch(instanceId);
            }}
          >
            <Replace size={16} />
          </button>
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
              console.info("[unit0:applet-close] renderer close requested", {
                workspaceId,
                appletInstanceId: instanceId,
                sessionId: session.id,
                kind: session.kind
              });
              void window.unitApi.applets
                .closeAppletInstance({ workspaceId, appletInstanceId: instanceId })
                .catch((error) => console.error("[unit0:applet-close] renderer close failed", error));
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>
      <div className="applet-body">{renderAppletBody(session, windowId)}</div>
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
    let ptyResizeTimer: number | null = null;
    let pendingPtyDimensions: { cols: number; rows: number } | null = null;
    const publishPtyResize = () => {
      ptyResizeTimer = null;
      if (!pendingPtyDimensions) {
        return;
      }
      const dimensions = pendingPtyDimensions;
      pendingPtyDimensions = null;
      void window.unitApi.terminal.resize({
        sessionId: session.id,
        cols: dimensions.cols,
        rows: dimensions.rows
      });
    };
    const schedulePtyResize = (dimensions: { cols: number; rows: number }) => {
      pendingPtyDimensions = dimensions;
      if (ptyResizeTimer !== null) {
        window.clearTimeout(ptyResizeTimer);
      }
      ptyResizeTimer = window.setTimeout(publishPtyResize, TERMINAL_PTY_RESIZE_SETTLE_MS);
    };
    const publishResize = () => {
      resizeFrame = null;
      const nextDimensions = proposedTerminalDimensions(container, fit, terminal);
      if (nextDimensions.cols === terminalDimensions.cols && nextDimensions.rows === terminalDimensions.rows) {
        return;
      }
      terminal.resize(nextDimensions.cols, nextDimensions.rows);
      terminalDimensions = nextDimensions;
      schedulePtyResize(nextDimensions);
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
      if (ptyResizeTimer !== null) {
        window.clearTimeout(ptyResizeTimer);
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
  const dimensions = proposedTerminalDimensions(container, fit, terminal);
  terminal.resize(dimensions.cols, dimensions.rows);
  return dimensions;
}

function proposedTerminalDimensions(container: HTMLElement, fit: FitAddon, terminal: XTerm): { cols: number; rows: number } {
  if (container.clientWidth <= 0 || container.clientHeight <= 0) {
    return { cols: Math.max(2, terminal.cols), rows: Math.max(1, terminal.rows) };
  }
  const dimensions = fit.proposeDimensions();
  if (!dimensions) {
    return { cols: Math.max(2, terminal.cols), rows: Math.max(1, terminal.rows) };
  }
  return { cols: Math.max(2, dimensions.cols), rows: Math.max(1, dimensions.rows) };
}

type FileViewerStatus =
  | { state: "idle" }
  | { state: "loading"; label: string }
  | { state: "error"; message: string };

type FileViewerDiscardRequest =
  | { kind: "file"; fileId: string }
  | { kind: "root"; rootPath: string };

const FILE_TREE_ROOT_ID = "__workspace_root__";

function FileViewerSurface({ session }: { session: AppletSession }) {
  const treeHostRef = useRef<HTMLDivElement | null>(null);
  const treeMotionTimerRef = useRef<number | null>(null);
  const selectedFileRef = useRef<ReadFileResult | null>(null);
  const editorContentRef = useRef("");
  const dirtyRef = useRef(false);
  const configuredRootPathRef = useRef("");
  const [treeHeight, setTreeHeight] = useState(0);
  const [treeMotionActive, setTreeMotionActive] = useState(false);
  const [treeData, setTreeData] = useState<FileTreeEntry[]>([]);
  const [rootPath, setRootPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<ReadFileResult | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorLanguageExtensions, setEditorLanguageExtensions] = useState<Extension[]>([]);
  const [dirty, setDirty] = useState(false);
  const [discardRequest, setDiscardRequest] = useState<FileViewerDiscardRequest | null>(null);
  const [status, setStatus] = useState<FileViewerStatus>({ state: "loading", label: "Loading files" });
  const configuredRootPath = session.state.fileViewer?.rootPath ?? "";

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    editorContentRef.current = editorContent;
  }, [editorContent]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    configuredRootPathRef.current = configuredRootPath;
  }, [configuredRootPath]);

  const loadDirectory = useCallback(async (directoryId: string) => {
    setStatus({ state: "loading", label: directoryId ? `Loading ${directoryId}` : "Loading files" });
    const result = await window.unitApi.fileSystem.listDirectory({ rootPath: configuredRootPath, directoryId });
    const rootNode: FileTreeEntry = {
      id: result.rootId,
      name: result.rootName,
      kind: "directory",
      children: result.entries,
      loaded: true
    };
    setRootPath(result.rootPath);
    setTreeData((current) => {
      if (directoryId === "") {
        return [rootNode];
      }
      return replaceFileTreeChildren(current, directoryId, result.entries);
    });
    setStatus({ state: "idle" });
  }, [configuredRootPath]);

  useEffect(() => {
    setTreeData([]);
    setSelectedFile(null);
    setEditorContent("");
    setDirty(false);
    void loadDirectory("").catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }));
  }, [loadDirectory]);

  useEffect(() => {
    const element = treeHostRef.current;
    if (!element) {
      return;
    }
    const resizeObserver = new ResizeObserver(() => {
      setTreeHeight(Math.max(160, Math.floor(element.getBoundingClientRect().height)));
    });
    resizeObserver.observe(element);
    setTreeHeight(Math.max(160, Math.floor(element.getBoundingClientRect().height)));
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (treeMotionTimerRef.current !== null) {
        window.clearTimeout(treeMotionTimerRef.current);
      }
    };
  }, []);

  const animateTreeMotion = useCallback(() => {
    if (treeMotionTimerRef.current !== null) {
      window.clearTimeout(treeMotionTimerRef.current);
    }
    setTreeMotionActive(true);
    treeMotionTimerRef.current = window.setTimeout(() => {
      treeMotionTimerRef.current = null;
      setTreeMotionActive(false);
    }, 180);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFile) {
      setEditorContent("");
      setEditorLanguageExtensions([]);
      setDirty(false);
      return;
    }
    setEditorContent(selectedFile.content);
    editorContentRef.current = selectedFile.content;
    setDirty(false);
    dirtyRef.current = false;
    setStatus({ state: "idle" });
    const languageDescription = LanguageDescription.matchFilename(languages, selectedFile.name);
    if (!languageDescription) {
      setEditorLanguageExtensions([]);
      return;
    }
    void languageDescription
      .load()
      .then((languageSupport) => {
        if (!cancelled) {
          setEditorLanguageExtensions([languageSupport]);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus({ state: "error", message: errorMessage(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  const saveSelectedFile = useCallback(async () => {
    const file = selectedFileRef.current;
    if (!file || !dirtyRef.current) {
      return;
    }
    setStatus({ state: "loading", label: `Saving ${file.name}` });
    const savedFile = await window.unitApi.fileSystem.writeFile({
      rootPath: configuredRootPathRef.current,
      fileId: file.id,
      content: editorContentRef.current
    });
    setSelectedFile(savedFile);
    setEditorContent(savedFile.content);
    editorContentRef.current = savedFile.content;
    setDirty(false);
    dirtyRef.current = false;
    setStatus({ state: "idle" });
  }, []);

  const editorExtensions = useMemo(
    () => [
      oneDark,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            void saveSelectedFile().catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }));
            return true;
          }
        }
      ]),
      ...editorLanguageExtensions
    ],
    [editorLanguageExtensions, saveSelectedFile]
  );

  const readFileIntoEditor = useCallback(async (fileId: string) => {
    setStatus({ state: "loading", label: `Reading ${fileId}` });
    const file = await window.unitApi.fileSystem.readFile({ rootPath: configuredRootPath, fileId });
    setSelectedFile(file);
    setStatus({ state: "idle" });
  }, [configuredRootPath]);

  const openFile = useCallback(async (fileId: string) => {
    if (selectedFile?.id === fileId) {
      return;
    }
    if (dirtyRef.current) {
      setDiscardRequest({ kind: "file", fileId });
      return;
    }
    await readFileIntoEditor(fileId);
  }, [readFileIntoEditor, selectedFile?.id]);

  const applyRootDirectory = useCallback(async (nextRootPath: string) => {
    await window.unitApi.applets.updateAppletSessionState({
      sessionId: session.id,
      state: {
        ...session.state,
        fileViewer: { rootPath: nextRootPath }
      }
    });
  }, [session.id, session.state]);

  const selectRootDirectory = useCallback(async () => {
    const result = await window.unitApi.fileSystem.selectDirectory({ currentPath: rootPath || configuredRootPath });
    if (!result.rootPath) {
      return;
    }
    if (dirtyRef.current) {
      setDiscardRequest({ kind: "root", rootPath: result.rootPath });
      return;
    }
    await applyRootDirectory(result.rootPath);
  }, [applyRootDirectory, configuredRootPath, rootPath]);

  const confirmDiscardRequest = useCallback(async () => {
    const request = discardRequest;
    if (!request) {
      return;
    }
    setDiscardRequest(null);
    setDirty(false);
    dirtyRef.current = false;
    if (request.kind === "file") {
      await readFileIntoEditor(request.fileId);
      return;
    }
    await applyRootDirectory(request.rootPath);
  }, [applyRootDirectory, discardRequest, readFileIntoEditor]);

  const openTreeNode = useCallback(
    (entry: FileTreeEntry, isOpen: boolean, toggle: () => void) => {
      if (entry.kind === "directory") {
        void isOpen;
        animateTreeMotion();
        toggle();
        if (!entry.loaded) {
          const directoryId = entry.id === FILE_TREE_ROOT_ID ? "" : entry.id;
          void loadDirectory(directoryId).catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }));
        }
        return;
      }
      void openFile(entry.id).catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }));
    },
    [animateTreeMotion, loadDirectory, openFile]
  );

  return (
    <div className="file-viewer">
      <aside className="file-tree-panel">
        <div className="file-tree-root">
          <span title={rootPath}>{rootPath || "Workspace"}</span>
          <button className="icon-button" type="button" aria-label="Change file root" onClick={selectRootDirectory}>
            <Settings size={14} />
          </button>
        </div>
        <div className={["file-tree-host", treeMotionActive ? "animating-tree" : ""].filter(Boolean).join(" ")} ref={treeHostRef}>
          {treeHeight > 0 ? (
            <Tree<FileTreeEntry>
              data={treeData}
              disableDrag
              disableDrop
              disableEdit
              height={treeHeight}
              indent={16}
              initialOpenState={{ [FILE_TREE_ROOT_ID]: true }}
              openByDefault={false}
              overscanCount={8}
              rowClassName="file-tree-row-shell"
              rowHeight={28}
              selection={selectedFile?.id}
              width="100%"
            >
              {(props) => <FileTreeNode {...props} onOpen={openTreeNode} />}
            </Tree>
          ) : null}
        </div>
      </aside>
      <section className="file-code-panel">
        <header className="file-code-header">
          <span>{selectedFile?.name ?? "No file selected"}</span>
          <div className="file-code-actions">
            {dirty ? <small>Unsaved</small> : status.state === "loading" ? <small>{status.label}</small> : null}
            <button
              className="icon-button"
              type="button"
              aria-label="Save file"
              disabled={!selectedFile || !dirty}
              onClick={() => void saveSelectedFile().catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }))}
            >
              <Save size={14} />
            </button>
          </div>
        </header>
        {status.state === "error" ? <div className="file-viewer-message">{status.message}</div> : null}
        {selectedFile ? (
          <CodeMirror
            basicSetup
            className="code-editor"
            editable
            extensions={editorExtensions}
            height="100%"
            key={selectedFile.id}
            readOnly={false}
            value={editorContent}
            onChange={(value) => {
              setEditorContent(value);
              editorContentRef.current = value;
              dirtyRef.current = value !== selectedFile.content;
              setDirty(value !== selectedFile.content);
            }}
          />
        ) : status.state !== "error" ? (
          <div className="file-viewer-message">Select a file</div>
        ) : null}
      </section>
      {discardRequest ? (
        <div className="discard-backdrop" role="presentation" onPointerDown={() => setDiscardRequest(null)}>
          <section
            className="discard-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <h2 id="discard-title">Discard unsaved changes?</h2>
            <p>The current file has edits that have not been saved.</p>
            <div className="discard-actions">
              <button type="button" onClick={() => setDiscardRequest(null)}>
                Cancel
              </button>
              <button
                className="danger"
                type="button"
                onClick={() => void confirmDiscardRequest().catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }))}
              >
                Discard
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function FileTreeNode({
  node,
  style,
  onOpen
}: NodeRendererProps<FileTreeEntry> & {
  onOpen: (entry: FileTreeEntry, isOpen: boolean, toggle: () => void) => void;
}) {
  const Icon = node.data.kind === "directory" ? FolderOpen : File;
  return (
    <button
      className={["file-tree-row", node.isSelected ? "selected" : ""].filter(Boolean).join(" ")}
      style={style}
      type="button"
      title={node.data.name}
      onClick={() => onOpen(node.data, node.isOpen, () => node.toggle())}
    >
      {node.data.kind === "directory" ? (
        <ChevronRight className={node.isOpen ? "open" : ""} size={14} />
      ) : (
        <span className="file-tree-caret-placeholder" aria-hidden="true" />
      )}
      <Icon size={14} />
      <span>{node.data.name}</span>
    </button>
  );
}

function replaceFileTreeChildren(nodes: FileTreeEntry[], directoryId: string, children: FileTreeEntry[]): FileTreeEntry[] {
  return nodes.map((node) => {
    if (node.id === directoryId) {
      return { ...node, children, loaded: true };
    }
    if (!node.children) {
      return node;
    }
    return { ...node, children: replaceFileTreeChildren(node.children, directoryId, children) };
  });
}

function ChatSurface() {
  const [chatState, setChatState] = useState<ChatState | null>(null);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.unitApi.chat.bootstrap().then((state) => {
      if (mounted) {
        setChatState(state);
        setExpandedProjectIds(new Set(state.projects.map((project) => project.id)));
      }
    }).catch((error: unknown) => setLocalError(errorMessage(error)));
    const removeListener = window.unitApi.chat.onStateChanged((state) => {
      setChatState(state);
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        for (const project of state.projects) {
          if (!next.has(project.id)) {
            next.add(project.id);
          }
        }
        return next;
      });
    });
    return () => {
      mounted = false;
      removeListener();
    };
  }, []);

  const selectedThread = chatState?.threads.find((thread) => thread.id === chatState.selectedThreadId) ?? null;
  const selectedMessages = chatState
    ? chatState.messages.filter((message) => message.threadId === chatState.selectedThreadId)
    : [];
  const selectedModel = chatState?.models.find((model) => model.id === chatState.selectedModelId) ?? null;
  const running = chatState?.generation.status === "running";
  const blockedReason = !selectedModel ? "Add a local GGUF model before sending." : "";
  const statusMessage = localError ?? (chatState?.generation.status === "error" ? chatState.generation.error : blockedReason);
  const activeProject = chatState?.projects.find((project) => project.id === chatState.selectedProjectId) ?? null;
  const messagePreviewByThreadId = useMemo(() => {
    const previews = new Map<string, ChatMessage>();
    if (!chatState) {
      return previews;
    }
    for (const message of chatState.messages) {
      previews.set(message.threadId, message);
    }
    return previews;
  }, [chatState]);

  const runChatAction = useCallback(async (action: () => Promise<ChatState>) => {
    setLocalError(null);
    try {
      setChatState(await action());
    } catch (error: unknown) {
      setLocalError(errorMessage(error));
    }
  }, []);

  const submitDraft = useCallback(async () => {
    const text = draft.trim();
    if (!text || running || blockedReason) {
      return;
    }
    setDraft("");
    await runChatAction(() => window.unitApi.chat.submit({ text }));
  }, [blockedReason, draft, runChatAction, running]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    composer.style.height = "44px";
    composer.style.height = `${Math.min(176, Math.max(44, composer.scrollHeight))}px`;
  }, [draft]);

  if (!chatState) {
    return <div className="chat-surface chat-loading" data-testid="chat-surface" />;
  }

  return (
    <div className="chat-surface" data-testid="chat-surface">
      <aside className="chat-list" aria-label="Chat projects and threads">
        <button
          className="chat-new-thread-button"
          type="button"
          aria-label="New chat thread"
          onClick={() => void runChatAction(() => window.unitApi.chat.createThread())}
        >
          <Plus size={15} />
          <span>New thread</span>
        </button>
        <div className="chat-list-section-title">
          <span>Threads</span>
          <button className="chat-card-action" type="button" aria-label="Project settings">
            <Settings size={14} />
          </button>
        </div>
        <div className="chat-project-scroll">
          {chatState.projects.map((project) => {
            const projectThreads = chatState.threads.filter((thread) => thread.projectId === project.id);
            const expanded = expandedProjectIds.has(project.id);
            const active = project.id === chatState.selectedProjectId;
            return (
              <section className="chat-project-section" key={project.id}>
                <button
                  className={["chat-project-card", active ? "active" : ""].join(" ")}
                  type="button"
                  onClick={() => setExpandedProjectIds((current) => {
                    const next = new Set(current);
                    if (next.has(project.id)) {
                      next.delete(project.id);
                    } else {
                      next.add(project.id);
                    }
                    return next;
                  })}
                >
                  <ChevronRight className={expanded ? "expanded" : ""} size={15} />
                  <span className="chat-project-title">{project.title}</span>
                  <span className="chat-project-actions">
                    <span
                      className="chat-project-action"
                      role="button"
                      tabIndex={0}
                      aria-label={`New thread in ${project.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runChatAction(() => window.unitApi.chat.createThread());
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          void runChatAction(() => window.unitApi.chat.createThread());
                        }
                      }}
                    >
                      <Plus size={13} />
                    </span>
                    <span className="chat-project-action placeholder" aria-hidden="true">
                      <Settings size={13} />
                    </span>
                    <span className="chat-project-action placeholder destructive" aria-hidden="true">
                      <X size={13} />
                    </span>
                  </span>
                </button>
                {expanded ? (
                  <div className="chat-thread-list">
                    {projectThreads.map((thread) => (
                      <button
                        className={thread.id === chatState.selectedThreadId ? "active" : ""}
                        data-testid={`chat-thread-${thread.id}`}
                        key={thread.id}
                        type="button"
                        onClick={() => void runChatAction(() => window.unitApi.chat.selectThread({ threadId: thread.id }))}
                      >
                        <span className="chat-thread-title">{thread.title}</span>
                        <span className="chat-thread-time">
                          {formatChatTimestamp(messagePreviewByThreadId.get(thread.id)?.updatedAt ?? thread.updatedAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
        <button className="chat-settings-button" type="button">
          <Settings size={15} />
          <span>Settings</span>
        </button>
      </aside>
      <section className="chat-main">
        <header className="chat-toolbar">
          <div className="chat-title">
            <strong>{activeProject?.title ?? "Project"}</strong>
          </div>
          <div className="chat-action-strip">
            <button className="chat-action-button" type="button">Chat</button>
            <button className="chat-action-manager" type="button" aria-label="Chat actions">
              <Settings size={15} />
            </button>
          </div>
        </header>
        <div className="chat-thread" data-testid="chat-message-list">
          <div className="chat-content-column">
            {selectedMessages.length === 0 ? (
              <div className="chat-empty">Start a thread with a local GGUF model.</div>
            ) : (
              selectedMessages.map((message) => <ChatMessageBubble key={message.id} message={message} />)
            )}
          </div>
        </div>
        <div className="chat-composer-section">
          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDraft();
            }}
          >
            <div className="chat-composer-input-wrap">
              <textarea
                ref={composerRef}
                aria-label="Chat message"
                disabled={running || Boolean(statusMessage)}
                placeholder="Ask anything..."
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitDraft();
                  }
                }}
              />
              {statusMessage ? (
                <div className="chat-status" data-testid="chat-status">
                  {statusMessage}
                </div>
              ) : null}
            </div>
            <div className="chat-composer-control-row">
              <button
                className="chat-ghost-button"
                type="button"
                aria-label="Add local model"
                onClick={() => void runChatAction(() => window.unitApi.chat.addLocalModel())}
              >
                <Plus size={18} />
              </button>
              <button className="chat-ghost-button" type="button" aria-label="Model settings">
                <Settings size={17} />
              </button>
              <label className="chat-model-menu">
                <Bot size={15} />
                <span>{selectedModel?.label ?? "No model"}</span>
                <ChevronRight className="chat-model-caret" size={12} />
                <select
                  aria-label="Local chat model"
                  value={chatState.selectedModelId}
                  onChange={(event) => void runChatAction(() => window.unitApi.chat.selectModel({ modelId: event.currentTarget.value }))}
                >
                  <option value="" disabled>
                    No model
                  </option>
                  {chatState.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="chat-text-button" type="button">Medium</button>
              <div className="chat-composer-spacer" />
              {running ? (
                <button
                  className="chat-send-button halting"
                  type="button"
                  aria-label="Cancel chat response"
                  onClick={() => void runChatAction(() => window.unitApi.chat.cancel())}
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  className="chat-send-button"
                  type="submit"
                  aria-label="Send chat message"
                  disabled={!draft.trim() || Boolean(blockedReason)}
                >
                  <Send size={15} />
                </button>
              )}
            </div>
          </form>
          <div className="chat-composer-footer">
            <div className="chat-footer-slot">Full access</div>
            <div className="chat-context-cluster">
              <span>32K</span>
              <GitBranch size={13} />
              <span>0</span>
            </div>
            <div className="chat-footer-slot right">main</div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const displayContent = message.content || (message.status === "streaming" ? "..." : "");
  return (
    <article className={["chat-message", message.role, message.status].join(" ")} data-testid={`chat-message-${message.role}`}>
      {message.role === "assistant" ? <div className="chat-message-label">Assistant</div> : null}
      <div className="chat-message-body">{renderMarkdownBlocks(displayContent)}</div>
      {message.status === "interrupted" ? <small>Interrupted</small> : message.status === "error" ? <small>Error</small> : null}
    </article>
  );
}

function formatChatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMarkdownBlocks(markdown: string) {
  const blocks: JSX.Element[] = [];
  const segments = markdown.split(/```/g);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index % 2 === 1) {
      const [firstLine, ...rest] = segment.split(/\r?\n/);
      const language = firstLine.trim();
      const code = rest.length > 0 ? rest.join("\n") : segment;
      blocks.push(
        <pre className="chat-code-block" key={`code-${index}`}>
          <code data-language={language}>{code}</code>
        </pre>
      );
      continue;
    }
    const paragraphs = segment.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
    for (const paragraph of paragraphs) {
      blocks.push(<p key={`text-${index}-${blocks.length}`}>{paragraph}</p>);
    }
  }
  return blocks.length > 0 ? blocks : null;
}

function BrowserSurface({ session, windowId }: { session: AppletSession; windowId: number }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const initialUrl = session.state.browser?.url ?? DEFAULT_BROWSER_URL;
  const initialUrlRef = useRef(initialUrl);
  const [addressValue, setAddressValue] = useState(initialUrl);
  const [status, setStatus] = useState<BrowserStatusPayload | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  useEffect(() => {
    const nextUrl = session.state.browser?.url;
    if (nextUrl) {
      setAddressValue(nextUrl);
    }
  }, [session.state.browser?.url]);

  useEffect(() => {
    const removeStatusListener = window.unitApi.browser.onStatus((payload) => {
      if (payload.windowId !== windowId || payload.sessionId !== session.id) {
        return;
      }
      setStatus(payload);
      if (payload.url) {
        setAddressValue(payload.url);
      }
      setNavigationError(payload.error ?? null);
    });
    return removeStatusListener;
  }, [session.id, windowId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    let frame: number | null = null;
    let disposed = false;
    const publishBounds = () => {
      frame = null;
      if (disposed) {
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const bounds = toClientRect(rect);
      void window.unitApi.browser.mount({
        windowId,
        sessionId: session.id,
        bounds,
        url: initialUrlRef.current
      }).then((nextStatus) => {
        if (disposed) {
          return;
        }
        setStatus(nextStatus);
        if (nextStatus.url) {
          setAddressValue(nextStatus.url);
        }
      }).catch((error: unknown) => {
        if (!disposed) {
          setNavigationError(errorMessage(error));
        }
      });
    };
    const scheduleBounds = () => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(publishBounds);
    };
    const resizeObserver = new ResizeObserver(scheduleBounds);
    resizeObserver.observe(viewport);
    window.addEventListener("resize", scheduleBounds);
    scheduleBounds();
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      void window.unitApi.browser.detach({ windowId, sessionId: session.id });
    };
  }, [session.id, windowId]);

  const publishViewportBounds = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    void window.unitApi.browser.updateBounds({
      windowId,
      sessionId: session.id,
      bounds: toClientRect(viewport.getBoundingClientRect())
    });
  }, [session.id, windowId]);

  useLayoutEffect(() => {
    publishViewportBounds();
  });

  const navigate = useCallback(async () => {
    setNavigationError(null);
    const url = normalizeBrowserNavigationUrl(addressValue);
    setAddressValue(url);
    await window.unitApi.applets.updateAppletSessionState({
      sessionId: session.id,
      state: {
        ...session.state,
        browser: { url }
      }
    });
    const nextStatus = await window.unitApi.browser.navigate({ windowId, sessionId: session.id, url });
    setStatus(nextStatus);
  }, [addressValue, session.id, session.state, windowId]);

  const runBrowserAction = useCallback(
    async (action: "back" | "forward" | "reload" | "stop") => {
      setNavigationError(null);
      const payload = { windowId, sessionId: session.id };
      const nextStatus =
        action === "back"
          ? await window.unitApi.browser.goBack(payload)
          : action === "forward"
            ? await window.unitApi.browser.goForward(payload)
            : action === "reload"
              ? await window.unitApi.browser.reload(payload)
              : await window.unitApi.browser.stop(payload);
      setStatus(nextStatus);
    },
    [session.id, windowId]
  );

  return (
    <div className="browser-surface">
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate().catch((error: unknown) => setNavigationError(errorMessage(error)));
        }}
      >
        <button
          className="icon-button"
          type="button"
          aria-label="Go back"
          disabled={!status?.canGoBack}
          onClick={() => void runBrowserAction("back").catch((error: unknown) => setNavigationError(errorMessage(error)))}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Go forward"
          disabled={!status?.canGoForward}
          onClick={() => void runBrowserAction("forward").catch((error: unknown) => setNavigationError(errorMessage(error)))}
        >
          <ArrowRight size={15} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label={status?.loading ? "Stop loading" : "Reload"}
          onClick={() => void runBrowserAction(status?.loading ? "stop" : "reload").catch((error: unknown) => setNavigationError(errorMessage(error)))}
        >
          {status?.loading ? <X size={15} /> : <RefreshCw size={15} />}
        </button>
        <input
          aria-label="Browser address"
          spellCheck={false}
          value={addressValue}
          onChange={(event) => setAddressValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
      </form>
      <div className="browser-viewport-shell">
        <div className="browser-native-viewport" ref={viewportRef} />
        {navigationError ? <div className="browser-status-line">{navigationError}</div> : null}
      </div>
    </div>
  );
}

function renderAppletBody(session: AppletSession, windowId: number) {
  const { kind } = session;
  if (kind === "terminal" || kind === "wslTerminal") {
    return <TerminalSurface session={session} />;
  }
  if (kind === "fileViewer") {
    return <FileViewerSurface session={session} />;
  }
  if (kind === "browser") {
    return <BrowserSurface session={session} windowId={windowId} />;
  }
  if (kind === "chat") {
    return <ChatSurface />;
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
