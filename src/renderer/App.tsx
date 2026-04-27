import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Brain,
  Bot,
  Bolt,
  ChevronRight,
  Code2,
  Database,
  File,
  FileText,
  FolderOpen,
  Globe,
  GitBranch,
  Grid2X2,
  Image,
  Layers3,
  LayoutDashboard,
  LayoutTemplate,
  LockOpen,
  Monitor,
  MoreHorizontal,
  PanelRight,
  PanelTop,
  Pencil,
  Paperclip,
  Plus,
  Power,
  RadioTower,
  RefreshCw,
  Replace,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Save,
  SlidersHorizontal,
  FolderPlus,
  SquareTerminal,
  Square,
  Trash2,
  X
} from "lucide-react";
import MarkdownIt from "markdown-it";
import markdownItFootnote from "markdown-it-footnote";
import markdownItTaskLists from "markdown-it-task-lists";
import katex from "katex";
import "katex/dist/katex.min.css";
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
  type ClipboardEvent as ReactClipboardEvent,
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
  ChatActionButton,
  ChatAppSettings,
  BrowserStatusPayload,
  ChatAttachment,
  ChatCodexApprovalMode,
  ChatGitState,
  ChatMessage,
  ChatPermissionMode,
  ChatProviderMode,
  ChatReasoningEffort,
  ChatTimelineBlock,
  ChatRuntimeSettings,
  ChatSettingsPreset,
  ChatState,
  ChatUsageIndicatorId,
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
  const hideChrome = false;
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
        hideChrome ? "applet-frame-chrome-hidden" : "",
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
      {hideChrome ? null : (
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
      )}
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

type ChatMenuAnchor = {
  left: number;
  top: number;
  placement: "above" | "below";
};

type ChatMenuState =
  | (ChatMenuAnchor & { kind: "model" })
  | (ChatMenuAnchor & { kind: "add" })
  | (ChatMenuAnchor & { kind: "settings" })
  | (ChatMenuAnchor & { kind: "quality" })
  | (ChatMenuAnchor & { kind: "permissions" })
  | (ChatMenuAnchor & { kind: "branch" })
  | (ChatMenuAnchor & { kind: "document" })
  | (ChatMenuAnchor & { kind: "thread"; threadId: string })
  | null;

type ChatDialogState =
  | { kind: "new-project" }
  | { kind: "project-settings"; projectId: string }
  | { kind: "project-actions"; projectId: string }
  | { kind: "thread-settings"; threadId: string }
  | { kind: "rename-project"; projectId: string; title: string }
  | { kind: "rename-thread"; threadId: string; title: string }
  | { kind: "delete-project"; projectId: string; title: string }
  | { kind: "delete-thread"; threadId: string; title: string }
  | { kind: "app-settings" }
  | { kind: "settings-preset"; presetId?: string }
  | { kind: "document-index"; projectId: string }
  | { kind: "create-branch"; projectId: string }
  | null;

const CHAT_REASONING_OPTIONS: Array<{ id: Exclude<ChatReasoningEffort, "xhigh">; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" }
];

const CHAT_PERMISSION_OPTIONS: Array<{ id: ChatPermissionMode; label: string }> = [
  { id: "default_permissions", label: "Default" },
  { id: "full_access", label: "Full access" }
];

const CHAT_CODEX_APPROVAL_OPTIONS: Array<{ id: ChatCodexApprovalMode; label: string }> = [
  { id: "default", label: "Default" },
  { id: "on-request", label: "On Request" },
  { id: "on-failure", label: "On Failure" },
  { id: "untrusted", label: "Untrusted" },
  { id: "never", label: "Never Ask" }
];

function UsageIndicatorSettingsRow({
  title,
  indicatorId,
  appSettings,
  displayOptions = [["Bar", "bar"], ["Circle", "circle"]],
  placementOptions = [["Bottom", "bottom"], ["Left Side", "left"], ["Right Side", "right"], ["Hidden", "hidden"]],
  onChange
}: {
  title: string;
  indicatorId: ChatUsageIndicatorId;
  appSettings: ChatAppSettings;
  displayOptions?: Array<[string, ChatAppSettings["usageIndicatorPreferences"][ChatUsageIndicatorId]["displayMode"]]>;
  placementOptions?: Array<[string, ChatAppSettings["usageIndicatorPreferences"][ChatUsageIndicatorId]["placement"]]>;
  onChange: (indicatorId: ChatUsageIndicatorId, patch: Partial<ChatAppSettings["usageIndicatorPreferences"][ChatUsageIndicatorId]>) => void;
}) {
  const preference = appSettings.usageIndicatorPreferences[indicatorId];
  return (
    <div className="chat-usage-settings-row">
      <span>{title}</span>
      <label>
        <small>Style</small>
        <select value={preference.displayMode} onChange={(event) => onChange(indicatorId, { displayMode: event.currentTarget.value as typeof preference.displayMode })}>
          {displayOptions.map(([label, value]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        <small>Placement</small>
        <select value={preference.placement} onChange={(event) => onChange(indicatorId, { placement: event.currentTarget.value as typeof preference.placement })}>
          {placementOptions.map(([label, value]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        <small>Order</small>
        <select value={String(preference.order)} onChange={(event) => onChange(indicatorId, { order: Number.parseInt(event.currentTarget.value, 10) || 1 })}>
          {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    </div>
  );
}

const chatMarkdown = MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: true
})
  .use(markdownItFootnote)
  .use(markdownItTaskLists, { enabled: true, label: true, labelAfter: true });

chatMarkdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const info = token.info.trim();
  const language = info.split(/\s+/)[0] || "";
  const escapedCode = chatMarkdown.utils.escapeHtml(token.content);
  const languageLabel = language ? `<figcaption>${chatMarkdown.utils.escapeHtml(language)}</figcaption>` : "";
  return `<figure class="chat-code-figure">${languageLabel}<pre class="chat-code-block"><code data-language="${chatMarkdown.utils.escapeHtml(language)}">${escapedCode}</code></pre></figure>`;
};

chatMarkdown.renderer.rules.table_open = () => '<div class="chat-markdown-table-wrap"><table class="chat-markdown-table">';
chatMarkdown.renderer.rules.table_close = () => "</table></div>";

const defaultLinkOpenRenderer = chatMarkdown.renderer.rules.link_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
chatMarkdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noreferrer");
  return defaultLinkOpenRenderer(tokens, index, options, env, self);
};

function ChatSurface() {
  const [chatState, setChatState] = useState<ChatState | null>(null);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [chatMenu, setChatMenu] = useState<ChatMenuState>(null);
  const [chatDialog, setChatDialog] = useState<ChatDialogState>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingThreadTitle, setEditingThreadTitle] = useState("");
  const [gitState, setGitState] = useState<ChatGitState | null>(null);
  const [projectActionStatuses, setProjectActionStatuses] = useState<Record<string, "running" | "completed" | "error">>({});
  const [draggedChatItem, setDraggedChatItem] = useState<{ kind: "project" | "thread"; id: string } | null>(null);
  const [chatDropTarget, setChatDropTarget] = useState<{ kind: "project" | "thread"; id: string; position: "before" | "after" | "inside" } | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.unitApi.chat.bootstrap().then((state) => {
      if (mounted) {
        setChatState(state);
        setExpandedProjectIds(new Set(state.appSettings.expandedProjectIds.length > 0 ? state.appSettings.expandedProjectIds : state.projects.map((project) => project.id)));
      }
    }).catch((error: unknown) => setLocalError(errorMessage(error)));
    const removeListener = window.unitApi.chat.onStateChanged((state) => {
      setChatState(state);
      setExpandedProjectIds((current) => {
        if (state.appSettings.expandedProjectIds.length > 0) {
          const saved = new Set(state.appSettings.expandedProjectIds);
          for (const project of state.projects) {
            if (!current.has(project.id) && !saved.has(project.id)) {
              saved.add(project.id);
            }
          }
          return saved;
        }
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
  const activeRuntimeSettings = selectedThread?.runtimeSettings ?? chatState?.runtimeSettings;
  const activeBuiltinModelId = selectedThread?.builtinModelId || chatState?.selectedModelId || "";
  const selectedModel = chatState?.models.find((model) => model.id === activeBuiltinModelId) ?? null;
  const threadUsesCodex = selectedThread?.providerMode === "codex";
  const selectedCodexModel = threadUsesCodex
    ? chatState?.codexModels.find((model) => model.id === selectedThread.codexModelId) ?? chatState?.codexModels.find((model) => model.isDefault) ?? null
    : null;
  const selectedSettingsPreset = selectedThread
    ? chatState?.settingsPresets.find((preset) => preset.id === selectedThread.selectedSettingsPresetId) ?? chatState?.settingsPresets[0] ?? null
    : null;
  const selectedBuiltinFramework = selectedThread?.builtinAgenticFramework ?? selectedSettingsPreset?.builtinAgenticFramework ?? "chat";
  const running = chatState?.generation.status === "running";
  const submitBlockedReason = !selectedThread
    ? "Create a new thread to start."
    : !threadUsesCodex && !selectedModel
      ? "Add and select a local GGUF model before sending."
      : "";
  const statusMessage = localError ?? (chatState?.generation.status === "error" ? chatState.generation.error : "");
  const activeProject = chatState?.projects.find((project) => project.id === chatState.selectedProjectId) ?? null;
  const selectedDocumentIndex = selectedThread
    ? chatState?.documentIndexes.find((index) => index.id === selectedThread.documentIndexId) ?? null
    : null;
  const documentControlsVisible = Boolean(selectedThread && !threadUsesCodex && selectedBuiltinFramework === "document_analysis");
  const canCreateDocumentIndex = Boolean(documentControlsVisible && selectedThread?.documentAnalysisEmbeddingModelPath.trim() && (chatState?.appSettings.tokenizerModelPath.trim() || selectedThread?.builtinModelId.trim()));
  const reasoningButtonLabel = selectedThread
    ? (threadUsesCodex ? reasoningLabel(selectedThread.codexReasoningEffort) : runtimeReasoningLabel(activeRuntimeSettings ?? chatState.runtimeSettings))
    : "Medium";
  const permissionButtonLabel = selectedThread
    ? (threadUsesCodex ? permissionLabel(codexAccessModeForApprovalMode(selectedThread.codexApprovalMode)) : permissionLabel((activeRuntimeSettings ?? chatState.runtimeSettings).permissionMode))
    : "Full access";
  const settingsPresetButtonLabel = selectedThread ? selectedSettingsPreset?.label ?? "Custom" : "Default";
  const modelButtonLabel = threadUsesCodex ? selectedCodexModel?.label ?? "Codex model" : selectedModel?.label ?? "No model";
  const branchButtonLabel = gitState?.status === "ready"
    ? `${gitState.currentBranch}${gitState.dirty ? "*" : ""}`
    : gitState?.status === "no_repo"
      ? "No repo"
      : "No project";
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
    setChatMenu(null);
    try {
      setChatState(await action());
    } catch (error: unknown) {
      setLocalError(errorMessage(error));
    }
  }, []);

  const refreshGitState = useCallback(async (projectId = activeProject?.id) => {
    if (!projectId) {
      setGitState(null);
      return;
    }
    try {
      setGitState(await window.unitApi.chat.gitState({ projectId }));
    } catch (error: unknown) {
      setLocalError(errorMessage(error));
    }
  }, [activeProject?.id]);

  const runProjectActionButton = useCallback(async (projectId: string, actionId: string) => {
    setLocalError(null);
    setProjectActionStatuses((current) => ({ ...current, [actionId]: "running" }));
    try {
      await window.unitApi.chat.runProjectAction({ projectId, actionId });
      setProjectActionStatuses((current) => ({ ...current, [actionId]: "completed" }));
      window.setTimeout(() => {
        setProjectActionStatuses((current) => {
          if (current[actionId] !== "completed") {
            return current;
          }
          const next = { ...current };
          delete next[actionId];
          return next;
        });
      }, 2000);
    } catch (error: unknown) {
      setProjectActionStatuses((current) => ({ ...current, [actionId]: "error" }));
      setLocalError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refreshGitState();
  }, [refreshGitState]);

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      void window.unitApi.chat.updateAppSettings({ settings: { expandedProjectIds: Array.from(next) } })
        .then(setChatState)
        .catch((error: unknown) => setLocalError(errorMessage(error)));
      return next;
    });
  }, []);

  const expandProject = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) {
        return current;
      }
      const next = new Set(current);
      next.add(projectId);
      void window.unitApi.chat.updateAppSettings({ settings: { expandedProjectIds: Array.from(next) } })
        .then(setChatState)
        .catch((error: unknown) => setLocalError(errorMessage(error)));
      return next;
    });
  }, []);

  const startInlineThreadRename = useCallback((thread: { id: string; title: string }) => {
    setChatMenu(null);
    setEditingThreadId(thread.id);
    setEditingThreadTitle(thread.title);
  }, []);

  const openChatMenu = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    menu: Omit<NonNullable<ChatMenuState>, keyof ChatMenuAnchor>,
    placement: ChatMenuAnchor["placement"] = "above"
  ) => {
    event.stopPropagation();
    const surface = surfaceRef.current;
    const targetRect = event.currentTarget.getBoundingClientRect();
    const surfaceRect = surface?.getBoundingClientRect();
    if (!surfaceRect) {
      setChatMenu({ ...menu, left: targetRect.left, top: targetRect.top, placement } as NonNullable<ChatMenuState>);
      return;
    }
    const menuWidth = menu.kind === "thread" ? 192 : 270;
    const left = Math.min(Math.max(8, targetRect.left - surfaceRect.left), Math.max(8, surfaceRect.width - menuWidth - 8));
    const top = placement === "above" ? targetRect.top - surfaceRect.top : targetRect.bottom - surfaceRect.top;
    setChatMenu({ ...menu, left, top, placement } as NonNullable<ChatMenuState>);
  }, []);

  const commitInlineThreadRename = useCallback(async () => {
    if (!editingThreadId) {
      return;
    }
    const threadId = editingThreadId;
    const title = editingThreadTitle.trim();
    setEditingThreadId(null);
    if (title) {
      await runChatAction(() => window.unitApi.chat.renameThread({ threadId, title }));
    }
  }, [editingThreadId, editingThreadTitle, runChatAction]);

  const attachFiles = useCallback(async (kind: ChatAttachment["kind"]) => {
    setLocalError(null);
    setChatMenu(null);
    if (kind === "image" && selectedThread?.providerMode !== "codex") {
      setLocalError("Image inputs are only available on Codex threads.");
      return;
    }
    if (kind === "image" && !selectedCodexModel?.supportsImageInput) {
      setLocalError("Selected Codex model does not support image input.");
      return;
    }
    try {
      const result = await window.unitApi.fileSystem.selectFiles({ kind, multiple: true });
      if (result.paths.length === 0) {
        return;
      }
      setPendingAttachments((current) => [
        ...current,
        ...result.paths.map((filePath) => ({
          id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: chatFileName(filePath),
          path: filePath,
          kind
        }))
      ]);
      setAttachmentStatus(`${result.paths.length} ${kind === "image" ? "image" : "file"}${result.paths.length === 1 ? "" : "s"} attached`);
    } catch (error: unknown) {
      setLocalError(errorMessage(error));
    }
  }, [selectedCodexModel?.supportsImageInput, selectedThread?.providerMode]);

  const handleComposerPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) {
      return;
    }
    event.preventDefault();
    if (selectedThread?.providerMode !== "codex") {
      setLocalError("Image inputs are only available on Codex threads.");
      return;
    }
    if (!selectedCodexModel?.supportsImageInput) {
      setLocalError("Selected Codex model does not support image input.");
      return;
    }
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setPendingAttachments((current) => [
          ...current,
          {
            id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: file.name || "Pasted image",
            path: "",
            dataUrl: typeof reader.result === "string" ? reader.result : undefined,
            kind: "image",
            mimeType: file.type,
            sizeBytes: file.size
          }
        ]);
        setAttachmentStatus("Image attached");
      };
      reader.readAsDataURL(file);
    }
  }, [selectedCodexModel?.supportsImageInput, selectedThread?.providerMode]);

  const submitDraft = useCallback(async (submitMode: "normal" | "queue" = "normal") => {
    const text = draft.trim();
    if ((!text && pendingAttachments.length === 0) || submitBlockedReason) {
      return;
    }
    setDraft("");
    setPendingAttachments([]);
    setAttachmentStatus("");
    await runChatAction(() => window.unitApi.chat.submit({ text, attachments: pendingAttachments, submitMode }));
  }, [draft, pendingAttachments, runChatAction, submitBlockedReason]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    composer.style.height = "44px";
    composer.style.height = `${Math.min(176, Math.max(44, composer.scrollHeight))}px`;
  }, [draft]);

  const usageIndicatorPreferences = chatState?.appSettings.usageIndicatorPreferences;
  const renderUsageIndicator = (indicatorId: string, displayMode: "bar" | "circle" = "bar") => {
    if (!chatState) {
      return null;
    }
    if (indicatorId === "context") {
      return (
        <div className={["chat-context-cluster", displayMode === "circle" ? "circle" : ""].join(" ")} key="context">
          <span className="chat-context-fill" style={{ width: `${contextUsagePercent(chatState)}%` }} aria-hidden="true" />
          <span>{displayMode === "circle" ? "Ctx" : "Context"}</span>
          <span>{formatContextLabel((activeRuntimeSettings ?? chatState.runtimeSettings).nCtx)}</span>
        </div>
      );
    }
    if (indicatorId === "git_diff") {
      return (
        <div className={["chat-git-diff-indicator", gitState?.status === "ready" ? "" : "inactive"].join(" ")} aria-label="Git diff" key="git_diff">
          <span className="added">+{gitState?.status === "ready" ? gitState.addedLines : 0}</span>
          <span className="deleted">-{gitState?.status === "ready" ? gitState.deletedLines : 0}</span>
        </div>
      );
    }
    if (indicatorId === "week") {
      return <div className={["chat-rate-limit-indicator inline", displayMode === "bar" ? "bar" : ""].join(" ")} aria-label="Weekly rate limit" key="week"><span>{rateLimitIndicatorLabel(chatState, "primary")}</span></div>;
    }
    if (indicatorId === "five_hour") {
      return <div className={["chat-rate-limit-indicator inline", displayMode === "bar" ? "bar" : ""].join(" ")} aria-label="Five hour rate limit" key="five_hour"><span>{rateLimitIndicatorLabel(chatState, "secondary")}</span></div>;
    }
    return null;
  };
  const usageItems = (["git_diff", "context", "week", "five_hour"] as const)
    .map((id) => ({ id, preference: usageIndicatorPreferences?.[id] }))
    .filter((item): item is { id: "git_diff" | "context" | "week" | "five_hour"; preference: NonNullable<typeof usageIndicatorPreferences>["git_diff"] } => Boolean(item.preference))
    .filter((item) => item.preference.placement !== "hidden")
    .sort((left, right) => left.preference.order - right.preference.order);
  const leftUsageIndicators = usageItems.filter((item) => item.preference.placement === "left").map((item) => renderUsageIndicator(item.id, item.preference.displayMode)).filter(Boolean);
  const rightUsageIndicators = usageItems.filter((item) => item.preference.placement === "right").map((item) => renderUsageIndicator(item.id, item.preference.displayMode)).filter(Boolean);
  const composerUsageIndicators = usageItems.filter((item) => item.preference.placement === "bottom").map((item) => renderUsageIndicator(item.id, item.preference.displayMode)).filter(Boolean);
  const footerRightUsageIndicators = usageItems.filter((item) => item.preference.placement === "footer_right").map((item) => renderUsageIndicator(item.id, item.preference.displayMode)).filter(Boolean);

  if (!chatState) {
    return <div className="chat-surface chat-loading" data-testid="chat-surface" />;
  }

  return (
    <div className="chat-surface" data-testid="chat-surface" ref={surfaceRef} onPointerDown={() => setChatMenu(null)}>
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
          <button
            className="chat-card-action"
            type="button"
            aria-label="New project"
            onClick={(event) => {
              event.stopPropagation();
              setChatDialog({ kind: "new-project" });
            }}
          >
            <FolderPlus size={14} />
          </button>
        </div>
          <div className="chat-project-scroll">
          <div className="chat-overlay-scrollbar chat-overlay-scrollbar-sidebar" aria-hidden="true"><span /></div>
          {chatState.projects.map((project) => {
            const projectThreads = chatState.threads.filter((thread) => thread.projectId === project.id);
            const expanded = expandedProjectIds.has(project.id);
            const active = project.id === chatState.selectedProjectId;
            return (
              <section className="chat-project-section" key={project.id}>
                <div
                  className={[
                    "chat-project-card",
                    active ? "active" : "",
                    chatDropTarget?.kind === "project" && chatDropTarget.id === project.id ? `drag-target drop-${chatDropTarget.position}` : ""
                  ].join(" ")}
                  data-testid={`chat-project-${project.id}`}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedChatItem({ kind: "project", id: project.id });
                  }}
                  onDragEnter={(event) => {
                    if (draggedChatItem) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const position = draggedChatItem.kind === "project"
                        ? (event.clientY > rect.top + rect.height / 2 ? "after" : "before")
                        : "inside";
                      setChatDropTarget({ kind: "project", id: project.id, position });
                    }
                  }}
                  onDragOver={(event) => {
                    if (draggedChatItem) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const position = draggedChatItem.kind === "project"
                        ? (event.clientY > rect.top + rect.height / 2 ? "after" : "before")
                        : "inside";
                      setChatDropTarget({ kind: "project", id: project.id, position });
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedChatItem?.kind === "project") {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const position = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
                      void runChatAction(() => window.unitApi.chat.moveProject({
                        projectId: draggedChatItem.id,
                        targetProjectId: project.id,
                        position
                      }));
                    } else if (draggedChatItem?.kind === "thread") {
                      void runChatAction(() => window.unitApi.chat.moveThread({ threadId: draggedChatItem.id, projectId: project.id }));
                    }
                    setDraggedChatItem(null);
                    setChatDropTarget(null);
                  }}
                  onDragEnd={() => {
                    setDraggedChatItem(null);
                    setChatDropTarget(null);
                  }}
                  onClick={() => {
                    expandProject(project.id);
                    void runChatAction(() => window.unitApi.chat.selectProject({ projectId: project.id }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      expandProject(project.id);
                      void runChatAction(() => window.unitApi.chat.selectProject({ projectId: project.id }));
                    }
                  }}
                >
                  <button
                    className="chat-project-toggle"
                    type="button"
                    aria-label={expanded ? `Collapse ${project.title}` : `Expand ${project.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleProject(project.id);
                    }}
                  >
                    <ChevronRight className={expanded ? "expanded" : ""} size={15} />
                  </button>
                  <span className="chat-project-title">{project.title}</span>
                  <span className="chat-project-actions">
                    <button
                      className="chat-project-action"
                      type="button"
                      aria-label={`New thread in ${project.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runChatAction(() => window.unitApi.chat.createThread({ projectId: project.id }));
                      }}
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      className="chat-project-action"
                      type="button"
                      aria-label={`Project settings for ${project.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setChatDialog({ kind: "project-settings", projectId: project.id });
                      }}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                    <button
                      className="chat-project-action destructive"
                      type="button"
                      aria-label={`Delete ${project.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setChatDialog({ kind: "delete-project", projectId: project.id, title: project.title });
                      }}
                    >
                      <X size={13} />
                    </button>
                  </span>
                </div>
                <div className={["chat-thread-list", expanded ? "expanded" : "collapsed"].join(" ")}>
                    {projectThreads.map((thread) => (
                      <div
                        className={[
                          thread.id === chatState.selectedThreadId ? "active" : "",
                          chatDropTarget?.kind === "thread" && chatDropTarget.id === thread.id ? `drag-target drop-${chatDropTarget.position}` : ""
                        ].join(" ")}
                        data-testid={`chat-thread-${thread.id}`}
                        key={thread.id}
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          setDraggedChatItem({ kind: "thread", id: thread.id });
                        }}
                        onDragEnter={(event) => {
                          if (draggedChatItem) {
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            const position = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
                            setChatDropTarget({ kind: "thread", id: thread.id, position });
                          }
                        }}
                        onDragOver={(event) => {
                          if (draggedChatItem) {
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            const position = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
                            setChatDropTarget({ kind: "thread", id: thread.id, position });
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (draggedChatItem?.kind === "thread") {
                            void runChatAction(() => window.unitApi.chat.moveThread({
                              threadId: draggedChatItem.id,
                              projectId: thread.projectId,
                              targetThreadId: thread.id,
                              position: chatDropTarget?.position === "after" ? "after" : "before"
                            }));
                          }
                          setDraggedChatItem(null);
                          setChatDropTarget(null);
                        }}
                        onDragEnd={() => {
                          setDraggedChatItem(null);
                          setChatDropTarget(null);
                        }}
                        onClick={() => void runChatAction(() => window.unitApi.chat.selectThread({ threadId: thread.id }))}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void runChatAction(() => window.unitApi.chat.selectThread({ threadId: thread.id }));
                          }
                        }}
                      >
                        <span
                          className={[
                            "chat-thread-state",
                            chatState.generation.status === "running" && chatState.generation.threadId === thread.id ? "loading" : "",
                            thread.id !== chatState.selectedThreadId && messagePreviewByThreadId.has(thread.id) ? "unread" : ""
                          ].join(" ")}
                          aria-hidden="true"
                        />
                        {editingThreadId === thread.id ? (
                          <input
                            className="chat-thread-title-editor"
                            autoFocus
                            value={editingThreadTitle}
                            onChange={(event) => setEditingThreadTitle(event.currentTarget.value)}
                            onBlur={() => void commitInlineThreadRename()}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void commitInlineThreadRename();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                setEditingThreadId(null);
                              }
                            }}
                          />
                        ) : (
                          <span className="chat-thread-title">{thread.title}</span>
                        )}
                        <span className="chat-thread-action-slot">
                          <span className="chat-thread-time">
                            {formatChatTimestamp(messagePreviewByThreadId.get(thread.id)?.updatedAt ?? thread.updatedAt)}
                          </span>
                          <span className="chat-thread-actions">
                            <button
                              className="chat-project-action"
                              type="button"
                              aria-label={`Rename ${thread.title}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                startInlineThreadRename(thread);
                              }}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              className="chat-project-action"
                              type="button"
                              aria-label={`More actions for ${thread.title}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                openChatMenu(event, { kind: "thread", threadId: thread.id }, "below");
                              }}
                            >
                              <MoreHorizontal size={13} />
                            </button>
                            <button
                              className="chat-project-action destructive"
                              type="button"
                              aria-label={`Delete ${thread.title}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setChatDialog({ kind: "delete-thread", threadId: thread.id, title: thread.title });
                              }}
                            >
                              <X size={13} />
                            </button>
                          </span>
                        </span>
                      </div>
                    ))}
                </div>
              </section>
            );
          })}
        </div>
        <button className="chat-settings-button" type="button" onClick={() => setChatDialog({ kind: "app-settings" })}>
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
            {activeProject?.actionButtons.map((action) => (
              <button
                className={["chat-action-manager", projectActionStatuses[action.id] ? `status-${projectActionStatuses[action.id]}` : ""].join(" ")}
                key={action.id}
                type="button"
                title={action.command}
                disabled={projectActionStatuses[action.id] === "running"}
                onClick={() => void runProjectActionButton(activeProject.id, action.id)}
              >
                <span>{action.label}</span>
                <span className="chat-action-indicator" aria-hidden="true" />
              </button>
            ))}
            <button
              className="chat-action-manager"
              type="button"
              aria-label="Chat actions"
              onPointerDown={(event) => {
                event.stopPropagation();
                if (activeProject) {
                  setChatDialog({ kind: "project-actions", projectId: activeProject.id });
                }
              }}
            >
              <Plus size={15} />
            </button>
          </div>
        </header>
        <div className="chat-top-fade" aria-hidden="true" />
        <div className="chat-thread" data-testid="chat-message-list">
          <div className="chat-overlay-scrollbar chat-overlay-scrollbar-thread" aria-hidden="true"><span /></div>
          <div className="chat-content-column">
            {!selectedThread ? (
              <div className="chat-empty">
                <h2>No Thread Selected</h2>
                <p>Make a new thread to start chatting, sketch ideas, or test prompts.</p>
              </div>
            ) : selectedMessages.length === 0 ? (
              <div className="chat-empty-transcript" aria-label="Empty thread" />
            ) : (
              selectedMessages.map((message) => (
                <ChatMessageBubble
                  key={message.id}
                  message={message}
                  onTimelineAction={(blockId, action, answer) => runChatAction(() => window.unitApi.chat.timelineAction({ messageId: message.id, blockId, action, answer }))}
                />
              ))
            )}
          </div>
        </div>
        <div className="chat-composer-section">
          <div className="chat-composer-main-row">
          <div className="chat-composer-side-dock left">{leftUsageIndicators}</div>
          <form
            className="chat-composer"
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitDraft();
            }}
            >
              <div className="chat-composer-input-wrap">
              <textarea
                ref={composerRef}
                aria-label="Chat message"
                readOnly={Boolean(statusMessage)}
                placeholder={selectedThread ? "Ask anything..." : "Create a new thread to start"}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onPaste={handleComposerPaste}
                onKeyDown={(event) => {
                  if (event.key === "Tab" && event.shiftKey && selectedThread && threadUsesCodex) {
                    event.preventDefault();
                    void runChatAction(() => window.unitApi.chat.updateThreadSettings({
                      threadId: selectedThread.id,
                      planModeEnabled: !selectedThread.planModeEnabled
                    }));
                    return;
                  }
                  if (event.key === "Enter" && event.ctrlKey && !running) {
                    event.preventDefault();
                    insertTextareaNewline(event.currentTarget, draft, setDraft);
                    return;
                  }
                  if (event.key === "Enter" && event.ctrlKey && running) {
                    event.preventDefault();
                    void submitDraft("queue");
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey) {
                    event.preventDefault();
                    void submitDraft();
                  }
                }}
              />
              {statusMessage ? (
                <div className="chat-status chat-status-overlay" data-testid="chat-status">
                  {statusMessage}
                </div>
              ) : null}
            </div>
            <ChatAttachmentStrip
              attachments={pendingAttachments}
              status={attachmentStatus}
              onRemove={(attachmentId) => setPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))}
            />
            <div className="chat-composer-control-row">
              <button
                className="chat-ghost-button"
                type="button"
                aria-label="More actions"
                onPointerDown={(event) => openChatMenu(event, { kind: "add" })}
              >
                <Plus size={18} />
              </button>
              {documentControlsVisible ? (
                <button className="chat-document-button composer-document-button" type="button" aria-label="Document" onPointerDown={(event) => openChatMenu(event, { kind: "document" })}>
                  <FileText size={13} />
                  <span>Document</span>
                </button>
              ) : null}
              <button
                className="chat-settings-menu-button"
                type="button"
                aria-label="Model settings"
                onPointerDown={(event) => openChatMenu(event, { kind: "settings" })}
              >
                <SlidersHorizontal size={15} />
                <span>{settingsPresetButtonLabel}</span>
                <ChevronRight className="chat-model-caret" size={12} />
              </button>
              <button
                className="chat-model-menu"
                type="button"
                aria-label="Open model menu"
                onPointerDown={(event) => openChatMenu(event, { kind: "model" })}
              >
                {threadUsesCodex ? <Code2 size={15} /> : <Bot size={15} />}
                <span>{modelButtonLabel}</span>
                <ChevronRight className="chat-model-caret" size={12} />
              </button>
              <select
                className="chat-hidden-select"
                aria-label="Local chat model"
                value={activeBuiltinModelId}
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
              <button
                className="chat-text-button"
                type="button"
                onPointerDown={(event) => openChatMenu(event, { kind: "quality" })}
              >
                {reasoningButtonLabel}
              </button>
              <span className={["chat-plan-separator", selectedThread?.planModeEnabled ? "" : "inactive"].join(" ")} aria-hidden="true">|</span>
              <button
                className={["chat-plan-indicator", selectedThread?.planModeEnabled ? "active" : "inactive"].join(" ")}
                type="button"
                aria-label="Plan mode"
                disabled={!selectedThread || !threadUsesCodex}
                onClick={() => {
                  if (selectedThread && threadUsesCodex) {
                    void runChatAction(() => window.unitApi.chat.updateThreadSettings({
                      threadId: selectedThread.id,
                      planModeEnabled: !selectedThread.planModeEnabled
                    }));
                  }
                }}
              >
                Plan
              </button>
              <div className="chat-composer-spacer" />
              {running ? (
                <button
                  className="chat-ghost-button chat-halt-button"
                  type="button"
                  aria-label="Cancel chat response"
                  onClick={() => void runChatAction(() => window.unitApi.chat.cancel())}
                >
                  <Square size={15} />
                </button>
              ) : null}
              <button
                className="chat-send-button"
                type="submit"
                aria-label="Send chat message"
                disabled={(!draft.trim() && pendingAttachments.length === 0) || Boolean(submitBlockedReason)}
              >
                <ArrowUp size={18} />
              </button>
            </div>
          </form>
          <div className="chat-composer-side-dock right">{rightUsageIndicators}</div>
          </div>
          <div className="chat-composer-footer">
            <button
              className="chat-footer-slot chat-footer-button"
              type="button"
              onPointerDown={(event) => openChatMenu(event, { kind: "permissions" })}
            >
              <LockOpen size={13} />
              <span>{permissionButtonLabel}</span>
            </button>
            <div className="chat-footer-usage-indicators">{composerUsageIndicators}</div>
            <div className="chat-footer-right-cluster">
              {footerRightUsageIndicators}
              <div className={["chat-document-progress", documentControlsVisible && selectedDocumentIndex ? "visible" : ""].join(" ")} aria-label="Document progress">
                <span style={{ width: `${Math.round((selectedDocumentIndex?.progress ?? 0) * 100)}%` }} />
              </div>
              <button
                className="chat-footer-slot chat-footer-button right"
                type="button"
                onPointerDown={(event) => openChatMenu(event, { kind: "branch" })}
              >
                <GitBranch size={13} />
                <span>{branchButtonLabel}</span>
              </button>
            </div>
          </div>
        </div>
        {chatMenu ? (
          <ChatDropUpMenu
            chatState={chatState}
            menu={chatMenu}
            onAttach={attachFiles}
            onClose={() => setChatMenu(null)}
            onDialog={setChatDialog}
            onRun={runChatAction}
            gitState={gitState}
            activeProjectId={activeProject?.id ?? ""}
            onRefreshGitState={refreshGitState}
            onError={setLocalError}
            onStartThreadRename={startInlineThreadRename}
          />
        ) : null}
        {chatDialog ? (
          <ChatDialog
            dialog={chatDialog}
            state={chatState}
            onClose={() => setChatDialog(null)}
            onDialog={setChatDialog}
            onRun={runChatAction}
          />
        ) : null}
      </section>
    </div>
  );
}

function ChatDropUpMenu({
  chatState,
  menu,
  onAttach,
  onClose,
  onDialog,
  onRun,
  gitState,
  activeProjectId,
  onRefreshGitState,
  onError,
  onStartThreadRename
}: {
  chatState: ChatState;
  menu: ChatMenuState;
  onAttach: (kind: ChatAttachment["kind"]) => Promise<void>;
  onClose: () => void;
  onDialog: (dialog: ChatDialogState) => void;
  onRun: (action: () => Promise<ChatState>) => Promise<void>;
  gitState: ChatGitState | null;
  activeProjectId: string;
  onRefreshGitState: (projectId?: string) => Promise<void>;
  onError: (message: string) => void;
  onStartThreadRename: (thread: { id: string; title: string }) => void;
}) {
  if (!menu) {
    return null;
  }
  const activeThread = chatState.threads.find((thread) => thread.id === chatState.selectedThreadId) ?? null;
  const activeUsesCodex = activeThread?.providerMode === "codex";
  const activeCodexModel = activeThread
    ? chatState.codexModels.find((model) => model.id === activeThread.codexModelId) ?? chatState.codexModels.find((model) => model.isDefault) ?? null
    : null;
  const activeRuntimeSettings = activeThread?.runtimeSettings ?? chatState.runtimeSettings;
  const activeBuiltinModelId = activeThread?.builtinModelId || chatState.selectedModelId;
  const activePermissionMode = activeRuntimeSettings.permissionMode;
  const activeAccessMode = activeUsesCodex && activeThread ? codexAccessModeForApprovalMode(activeThread.codexApprovalMode) : activePermissionMode;
  const activeReasoningEffort = activeUsesCodex ? activeThread?.codexReasoningEffort : activeRuntimeSettings.reasoningEffort;
  const selectedThread = menu.kind === "thread" ? chatState.threads.find((thread) => thread.id === menu.threadId) : null;
  return (
    <div
      className={["chat-dropup", `placement-${menu.placement}`, menu.kind === "thread" ? "sidebar-menu" : ""].join(" ")}
      style={{ left: menu.left, top: menu.top }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {menu.kind === "add" ? (
        activeUsesCodex && activeThread ? (
          <>
            <button
              className={activeThread.planModeEnabled ? "selected" : ""}
              type="button"
              role="menuitemcheckbox"
              aria-checked={activeThread.planModeEnabled}
              onClick={() => void onRun(() => window.unitApi.chat.updateThreadSettings({
                threadId: activeThread.id,
                planModeEnabled: !activeThread.planModeEnabled
              }))}
            >
              <Settings size={14} />
              <span>Plan mode</span>
            </button>
            <button type="button" role="menuitem" onClick={() => void onAttach("image")}>
              <Paperclip size={14} />
              <span>Upload image...</span>
            </button>
          </>
        ) : (
          <>
            <button type="button" role="menuitem" onClick={() => void onRun(() => window.unitApi.chat.addLocalModel())}>
              <Plus size={14} />
              <span>Add GGUF...</span>
            </button>
            <button type="button" role="menuitem" onClick={() => void onAttach("image")}>
              <Paperclip size={14} />
              <span>Upload image...</span>
            </button>
          </>
        )
      ) : null}
      {menu.kind === "model" ? (
        activeUsesCodex && activeThread ? (
          <>
            <div className="chat-dropup-section-label">Codex Agent</div>
            {chatState.codexModels.length === 0 ? <div className="chat-dropup-empty">No Codex models available</div> : null}
            {chatState.codexModels.map((model) => (
              <button
                className={model.id === activeThread.codexModelId ? "selected" : ""}
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={model.id === activeThread.codexModelId}
                onClick={() => void onRun(() => window.unitApi.chat.updateThreadSettings({ threadId: activeThread.id, codexModelId: model.id }))}
              >
                <Code2 size={14} />
                <span>{model.label}  [{model.isDefault ? "Default" : "Codex"}]</span>
              </button>
            ))}
            <div className="chat-dropup-divider" />
            <button type="button" role="menuitem" onClick={() => void onRun(() => window.unitApi.chat.refreshCodexAccount({ force: true }))}>
              <RefreshCw size={14} />
              <span>Refresh</span>
            </button>
            {chatState.codexAccount.status === "ready" ? (
              <div className="chat-dropup-empty">{chatState.codexAccount.email || chatState.codexAccount.planType || "Codex account ready"}</div>
            ) : chatState.codexAccount.status === "error" ? (
              <div className="chat-dropup-empty">{chatState.codexAccount.error}</div>
            ) : null}
          </>
        ) : (
          <>
            <div className="chat-dropup-section-label">Built-in</div>
            {chatState.models.length === 0 ? <div className="chat-dropup-empty">No models available</div> : null}
            {chatState.models.map((model) => (
              <button
                className={model.id === activeBuiltinModelId ? "selected" : ""}
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={model.id === activeBuiltinModelId}
                onClick={() => void onRun(() => window.unitApi.chat.selectModel({ modelId: model.id }))}
              >
                <Bot size={14} />
                <span>{model.label}  [Local GGUF]</span>
              </button>
            ))}
            <div className="chat-dropup-divider" />
            <button type="button" role="menuitem" onClick={() => void onRun(() => window.unitApi.chat.addLocalModel())}>
              <Plus size={14} />
              <span>Add GGUF model...</span>
            </button>
            <button type="button" role="menuitem" onClick={() => void onRun(() => window.unitApi.chat.refreshLocalModels())}>
              <RefreshCw size={14} />
              <span>Refresh</span>
            </button>
          </>
        )
      ) : null}
      {menu.kind === "quality" ? (
        (activeUsesCodex && activeThread && activeCodexModel
          ? activeCodexModel.reasoningEfforts.map((id) => ({ id, label: reasoningLabel(id) }))
          : CHAT_REASONING_OPTIONS
        ).map((option) => (
          <button
            className={option.id === activeReasoningEffort ? "selected" : ""}
            key={option.id}
            type="button"
            role="menuitemradio"
            aria-checked={option.id === activeReasoningEffort}
            onClick={() => {
              if (activeUsesCodex && activeThread) {
                void onRun(() => window.unitApi.chat.updateThreadSettings({
                  threadId: activeThread.id,
                  codexReasoningEffort: option.id as ChatReasoningEffort
                }));
              } else {
                void onRun(() => window.unitApi.chat.updateRuntimeSettings({
                  settings: { reasoningEffort: option.id as Exclude<ChatReasoningEffort, "xhigh"> }
                }));
              }
            }}
          >
            <Settings size={14} />
            <span>{option.label}</span>
          </button>
        ))
      ) : null}
      {menu.kind === "settings" ? (
        <>
          {chatState.settingsPresets.map((preset) => {
            const Icon = settingsPresetIcon(preset.iconName, preset.providerMode);
            const selected = activeThread?.selectedSettingsPresetId === preset.id;
            return (
              <div className="chat-dropup-action-row" key={preset.id}>
                <button
                  className={selected ? "selected" : ""}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={!activeThread}
                  onMouseEnter={() => undefined}
                  onClick={() => {
                    if (activeThread) {
                      void onRun(() => window.unitApi.chat.applySettingsPreset({ threadId: activeThread.id, presetId: preset.id }));
                    }
                  }}
                >
                  <Icon size={14} />
                  <span>{preset.label}</span>
                </button>
                {preset.editable ? (
                  <button
                    className="chat-dropup-inline-action"
                    type="button"
                    aria-label={`Edit ${preset.label}`}
                    onClick={() => {
                      onClose();
                      onDialog({ kind: "settings-preset", presetId: preset.id });
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                ) : null}
                {preset.deletable ? (
                  <button
                    className="chat-dropup-inline-action danger"
                    type="button"
                    aria-label={`Delete ${preset.label}`}
                    onClick={() => void onRun(() => window.unitApi.chat.deleteSettingsPreset({ presetId: preset.id }))}
                  >
                    <Trash2 size={12} />
                  </button>
                ) : null}
              </div>
            );
          })}
          <div className="chat-dropup-divider" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onDialog({ kind: "settings-preset" });
            }}
          >
            <Plus size={14} />
            <span>New preset...</span>
          </button>
        </>
      ) : null}
      {menu.kind === "permissions" ? (
        CHAT_PERMISSION_OPTIONS.map((option) => (
          <button
            className={option.id === activeAccessMode ? "selected" : ""}
            key={option.id}
            type="button"
            role="menuitemradio"
            aria-checked={option.id === activeAccessMode}
            onClick={() => {
              if (activeUsesCodex && activeThread) {
                void onRun(() => window.unitApi.chat.updateThreadSettings({
                  threadId: activeThread.id,
                  permissionMode: option.id,
                  codexApprovalMode: codexApprovalModeForAccessMode(option.id)
                }));
              } else {
                void onRun(async () => {
                  await window.unitApi.chat.updateRuntimeSettings({ settings: { permissionMode: option.id } });
                  return window.unitApi.chat.bootstrap();
                });
              }
            }}
          >
            <ShieldCheck size={14} />
            <span>{option.label}</span>
          </button>
        ))
      ) : null}
      {menu.kind === "branch" ? (
        gitState?.status === "ready" ? (
          <>
          {gitState.branches.map((branch) => (
            <button
              className={branch === gitState.currentBranch ? "selected" : ""}
              key={branch}
              type="button"
              role="menuitemradio"
              aria-checked={branch === gitState.currentBranch}
              disabled={branch === gitState.currentBranch}
              onClick={() => {
                window.unitApi.chat.switchGitBranch({ projectId: activeProjectId, branch })
                  .then(() => onRefreshGitState(activeProjectId))
                  .catch((error: unknown) => onError(errorMessage(error)));
                onClose();
              }}
            >
              <GitBranch size={14} />
              <span>{branch}{branch === gitState.currentBranch && gitState.dirty ? " *" : ""}</span>
            </button>
          ))}
          <div className="chat-dropup-divider" />
          {gitState.hasCommits ? <button type="button" role="menuitem" onClick={() => {
            onClose();
            onDialog({ kind: "create-branch", projectId: activeProjectId });
          }}>
            <Plus size={14} />
            <span>New branch...</span>
          </button> : null}
          <button type="button" role="menuitem" onClick={() => void onRefreshGitState(activeProjectId)}>
            <RefreshCw size={14} />
            <span>Refresh</span>
          </button>
          </>
        ) : (
          <>
            <div className="chat-dropup-empty">{gitState?.message ?? "Select a project to show git branches."}</div>
            <button type="button" role="menuitem" onClick={() => void onRefreshGitState(activeProjectId)}>
              <RefreshCw size={14} />
              <span>Refresh</span>
            </button>
          </>
        )
      ) : null}
      {menu.kind === "document" ? (
        <>
          <div className="chat-dropup-section-label">Document Analysis</div>
          {chatState.documentIndexes.filter((index) => index.projectId === activeThread?.projectId && (index.state === "ready" || index.state === "building")).length === 0 ? <div className="chat-dropup-empty">No document indexes</div> : null}
          {chatState.documentIndexes
            .filter((index) => index.projectId === activeThread?.projectId && (index.state === "ready" || index.state === "building"))
            .map((index) => (
              <button
                className={index.id === activeThread?.documentIndexId ? "selected" : ""}
                key={index.id}
                type="button"
                role="menuitemradio"
                aria-checked={index.id === activeThread?.documentIndexId}
                onClick={() => {
                  if (activeThread) {
                    void onRun(() => window.unitApi.chat.selectDocumentIndex({ threadId: activeThread.id, documentIndexId: index.id }));
                  }
                }}
              >
                <FileText size={14} />
                <span>{index.title}  [{formatTimelineStatus(index.state)}]</span>
              </button>
            ))}
          {activeThread?.documentIndexId ? (
            <button type="button" role="menuitem" onClick={() => void onRun(() => window.unitApi.chat.selectDocumentIndex({ threadId: activeThread.id, documentIndexId: "" }))}>
              <X size={14} />
              <span>Clear document index</span>
            </button>
          ) : null}
          <div className="chat-dropup-divider" />
          <button type="button" role="menuitem" disabled={!canCreateDocumentIndex} onClick={() => {
            onClose();
            if (activeProjectId) {
              onDialog({ kind: "document-index", projectId: activeProjectId });
            }
          }}>
            <Plus size={14} />
            <span>Create document index...</span>
          </button>
        </>
      ) : null}
      {menu.kind === "thread" && selectedThread ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onDialog({ kind: "thread-settings", threadId: selectedThread.id });
            }}
          >
            <Settings size={14} />
            <span>Thread Settings</span>
          </button>
          <div className="chat-dropup-divider" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onStartThreadRename(selectedThread);
            }}
          >
            <Pencil size={14} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onDialog({ kind: "delete-thread", threadId: selectedThread.id, title: selectedThread.title });
            }}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
        </>
      ) : null}
    </div>
  );
}

function ChatDialog({
  dialog,
  state,
  onClose,
  onDialog,
  onRun
}: {
  dialog: ChatDialogState;
  state: ChatState;
  onClose: () => void;
  onDialog: (dialog: ChatDialogState) => void;
  onRun: (action: () => Promise<ChatState>) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialChatDialogTitle(dialog, state));
  const [directory, setDirectory] = useState(initialChatDialogDirectory(dialog, state));
  const [settings, setSettings] = useState(() => initialRuntimeSettingsForm(dialog, state));
  const [appSettings, setAppSettings] = useState<ChatAppSettings>(() => state.appSettings);
  const [threadProviderMode, setThreadProviderMode] = useState<ChatProviderMode>(() => initialThreadProviderMode(dialog, state));
  const [threadBuiltinModelId, setThreadBuiltinModelId] = useState(() => initialThreadBuiltinModelId(dialog, state));
  const [threadCodexModelId, setThreadCodexModelId] = useState(() => initialThreadCodexModelId(dialog, state));
  const [threadCodexReasoningEffort, setThreadCodexReasoningEffort] = useState<ChatReasoningEffort>(() => initialThreadCodexReasoningEffort(dialog, state));
  const [threadPermissionMode, setThreadPermissionMode] = useState<ChatPermissionMode>(() => initialThreadPermissionMode(dialog, state));
  const [threadCodexApprovalMode, setThreadCodexApprovalMode] = useState<ChatCodexApprovalMode>(() => initialThreadCodexApprovalMode(dialog, state));
  const [threadPlanModeEnabled, setThreadPlanModeEnabled] = useState(() => initialThreadPlanModeEnabled(dialog, state));
  const [presetIconName, setPresetIconName] = useState(() => initialSettingsPresetIconName(dialog, state));
  const [presetBuiltinFramework, setPresetBuiltinFramework] = useState<"chat" | "document_analysis">(() => initialSettingsPresetBuiltinFramework(dialog, state));
  const [presetEmbeddingModelPath, setPresetEmbeddingModelPath] = useState(() => initialSettingsPresetEmbeddingModelPath(dialog, state));
  const [projectActionButtons, setProjectActionButtons] = useState<ChatActionButton[]>(() => initialProjectActionButtons(dialog, state));
  const [documentIndexPaths, setDocumentIndexPaths] = useState<string[]>([]);

  useEffect(() => {
    setTitle(initialChatDialogTitle(dialog, state));
    setDirectory(initialChatDialogDirectory(dialog, state));
    setSettings(initialRuntimeSettingsForm(dialog, state));
    setAppSettings(state.appSettings);
    setThreadProviderMode(initialThreadProviderMode(dialog, state));
    setThreadBuiltinModelId(initialThreadBuiltinModelId(dialog, state));
    setThreadCodexModelId(initialThreadCodexModelId(dialog, state));
    setThreadCodexReasoningEffort(initialThreadCodexReasoningEffort(dialog, state));
    setThreadPermissionMode(initialThreadPermissionMode(dialog, state));
    setThreadCodexApprovalMode(initialThreadCodexApprovalMode(dialog, state));
    setThreadPlanModeEnabled(initialThreadPlanModeEnabled(dialog, state));
    setPresetIconName(initialSettingsPresetIconName(dialog, state));
    setPresetBuiltinFramework(initialSettingsPresetBuiltinFramework(dialog, state));
    setPresetEmbeddingModelPath(initialSettingsPresetEmbeddingModelPath(dialog, state));
    setProjectActionButtons(initialProjectActionButtons(dialog, state));
    setDocumentIndexPaths([]);
  }, [dialog, state]);

  const updateUsageIndicatorPreference = (
    indicatorId: ChatUsageIndicatorId,
    patch: Partial<ChatAppSettings["usageIndicatorPreferences"][ChatUsageIndicatorId]>
  ) => {
    setAppSettings({
      ...appSettings,
      usageIndicatorPreferences: {
        ...appSettings.usageIndicatorPreferences,
        [indicatorId]: {
          ...appSettings.usageIndicatorPreferences[indicatorId],
          ...patch
        }
      }
    });
  };

  if (!dialog) {
    return null;
  }
  if (dialog.kind === "new-project") {
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog chat-project-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="New project"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(async () => {
              const created = await window.unitApi.chat.createProject();
              const projectId = created.selectedProjectId || created.projects.at(-1)?.id;
              if (!projectId) {
                return created;
              }
              return window.unitApi.chat.updateProjectSettings({ projectId, title, directory, actionButtons: projectActionButtons });
            }).then(onClose);
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Project Settings</strong>
              <span>New Project</span>
            </div>
            <button type="button" aria-label="Close new project" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <ProjectSettingsFields
            title={title}
            directory={directory}
            actionButtons={projectActionButtons}
            onTitleChange={setTitle}
            onDirectoryChange={setDirectory}
            onActionButtonsChange={setProjectActionButtons}
          />
          <div className="chat-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={!title.trim()}>Save</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "app-settings") {
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog chat-app-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="App settings"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(() => window.unitApi.chat.updateAppSettings({ settings: appSettings })).then(onClose);
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Settings</strong>
              <span>Interface</span>
            </div>
            <button type="button" aria-label="Close app settings" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <div className="chat-settings-body">
            <section className="chat-settings-section">
              <h3>Interface</h3>
              <label className="chat-settings-check">
                <input
                  type="checkbox"
                  checked={appSettings.autoExpandCodexDisclosures}
                  onChange={(event) => setAppSettings({ ...appSettings, autoExpandCodexDisclosures: event.currentTarget.checked })}
                />
                <span>Auto-expand reasoning, tools, and diffs</span>
              </label>
              <UsageIndicatorSettingsRow title="Git Diff" indicatorId="git_diff" appSettings={appSettings} displayOptions={[["Text", "bar"]]} placementOptions={[["Bottom", "bottom"], ["Next to Branch", "footer_right"], ["Left Side", "left"], ["Right Side", "right"], ["Hidden", "hidden"]]} onChange={updateUsageIndicatorPreference} />
              <UsageIndicatorSettingsRow title="Context" indicatorId="context" appSettings={appSettings} onChange={updateUsageIndicatorPreference} />
              <UsageIndicatorSettingsRow title="Week" indicatorId="week" appSettings={appSettings} onChange={updateUsageIndicatorPreference} />
              <UsageIndicatorSettingsRow title="5h" indicatorId="five_hour" appSettings={appSettings} onChange={updateUsageIndicatorPreference} />
            </section>
            <section className="chat-settings-section">
              <h3>Document Analysis</h3>
              <div className="chat-settings-row">
                <label className="chat-embedding-field">
                  <span>Tokenizer</span>
                  <div className="chat-directory-row">
                    <input
                      aria-label="Document tokenizer"
                      placeholder="Path to tokenizer GGUF"
                      value={appSettings.tokenizerModelPath}
                      onChange={(event) => setAppSettings({ ...appSettings, tokenizerModelPath: event.currentTarget.value })}
                    />
                    <button type="button" onClick={() => {
                      void window.unitApi.fileSystem.selectFiles({ kind: "file", multiple: false }).then((result) => {
                        if (result.paths[0]) {
                          setAppSettings({ ...appSettings, tokenizerModelPath: result.paths[0] });
                        }
                      });
                    }}>Browse...</button>
                  </div>
                </label>
                <label>
                  <span>Document Indexing</span>
                  <select
                    value={appSettings.documentIndexLocation}
                    aria-label="Document indexing"
                    onChange={(event) => setAppSettings({ ...appSettings, documentIndexLocation: event.currentTarget.value as ChatAppSettings["documentIndexLocation"] })}
                  >
                    <option value="local">Local laptop</option>
                    <option value="remote">Remote host</option>
                  </select>
                </label>
                <label>
                  <span>Document Tool Calls</span>
                  <select
                    value={appSettings.documentToolExecutionLocation}
                    aria-label="Document tool calls"
                    onChange={(event) => setAppSettings({ ...appSettings, documentToolExecutionLocation: event.currentTarget.value as ChatAppSettings["documentToolExecutionLocation"] })}
                  >
                    <option value="local">Local laptop</option>
                    <option value="remote">Remote host</option>
                  </select>
                </label>
              </div>
            </section>
            <section className="chat-settings-section">
              <h3>Remote Inference</h3>
              <label className="chat-settings-check">
                <input
                  type="checkbox"
                  checked={Boolean(appSettings.remoteHostAddress.trim() || appSettings.remotePairingCode.trim())}
                  onChange={(event) => {
                    if (event.currentTarget.checked) {
                      setAppSettings({ ...appSettings, remoteHostAddress: appSettings.remoteHostAddress || "127.0.0.1" });
                    } else {
                      setAppSettings({ ...appSettings, remoteHostAddress: "", remotePairingCode: "", remoteHostId: "", remoteHostIdentity: "", remoteProtocolVersion: "" });
                    }
                  }}
                />
                <span>Enable remote built-in host</span>
              </label>
              <p className="chat-settings-hint">
                {appSettings.remoteHostIdentity
                  ? `Connected to ${appSettings.remoteHostIdentity}${appSettings.remoteProtocolVersion ? `, protocol ${appSettings.remoteProtocolVersion}` : ""}.`
                  : "Remote host not connected."}
              </p>
              <div className="chat-settings-row">
                <label>
                  <span>Address</span>
                  <input value={appSettings.remoteHostAddress} onChange={(event) => setAppSettings({ ...appSettings, remoteHostAddress: event.currentTarget.value })} />
                </label>
                <label>
                  <span>Port</span>
                  <input value={String(appSettings.remoteHostPort)} onChange={(event) => setAppSettings({ ...appSettings, remoteHostPort: Number.parseInt(event.currentTarget.value, 10) || 0 })} />
                </label>
                <label>
                  <span>Pairing Code</span>
                  <input value={appSettings.remotePairingCode} onChange={(event) => setAppSettings({ ...appSettings, remotePairingCode: event.currentTarget.value })} />
                </label>
              </div>
            </section>
          </div>
          <div className="chat-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "settings-preset") {
    const preset = dialog.presetId ? state.settingsPresets.find((candidate) => candidate.id === dialog.presetId) : null;
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Settings preset"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(() => window.unitApi.chat.saveSettingsPreset({
              presetId: preset?.id,
              label: title,
              runtimeSettings: parseRuntimeSettingsForm(settings),
              providerMode: threadProviderMode,
              iconName: presetIconName,
              builtinModelId: state.selectedModelId,
              builtinAgenticFramework: presetBuiltinFramework,
              documentAnalysisEmbeddingModelPath: presetEmbeddingModelPath,
              codexModelId: threadCodexModelId,
              codexReasoningEffort: threadCodexReasoningEffort
            })).then(onClose);
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>{preset ? "Edit Preset" : "New Preset"}</strong>
              <span>{preset?.builtIn ? "Built-in preset override" : "Custom settings preset"}</span>
            </div>
            <button type="button" aria-label="Close settings preset" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <div className="chat-settings-body">
            <section className="chat-settings-section">
              <h3>Preset</h3>
              <div className="chat-settings-row">
                <label>
                  <span>Name</span>
                  <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
                </label>
                <label>
                  <span>Icon</span>
                  <select value={presetIconName} onChange={(event) => setPresetIconName(event.currentTarget.value)}>
                    <option value="sliders">Sliders</option>
                    <option value="bolt">Bolt</option>
                    <option value="brain">Brain</option>
                    <option value="code">Code</option>
                  </select>
                </label>
                <label>
                  <span>Provider</span>
                  <select value={threadProviderMode} onChange={(event) => setThreadProviderMode(event.currentTarget.value as ChatProviderMode)}>
                    <option value="builtin">Built-in</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
              </div>
            </section>
            <section className="chat-settings-section">
              <h3>Built-in</h3>
              <div className="chat-settings-row">
                <label>
                  <span>Agentic framework</span>
                  <select value={presetBuiltinFramework} onChange={(event) => setPresetBuiltinFramework(event.currentTarget.value as "chat" | "document_analysis")}>
                    <option value="chat">Chat</option>
                    <option value="document_analysis">Document analysis</option>
                  </select>
                </label>
                <label>
                  <span>Access</span>
                  <select value={settings.permissionMode} onChange={(event) => setSettings({ ...settings, permissionMode: event.currentTarget.value })}>
                    <option value="default_permissions">Default</option>
                    <option value="full_access">Full access</option>
                  </select>
                </label>
              </div>
              <label className="chat-embedding-field">
                <span>Embedding Model</span>
                <div className="chat-directory-row">
                  <input placeholder="Path to embedding GGUF" value={presetEmbeddingModelPath} onChange={(event) => setPresetEmbeddingModelPath(event.currentTarget.value)} />
                  <button type="button" onClick={() => {
                    void window.unitApi.fileSystem.selectFiles({ kind: "file", multiple: false }).then((result) => {
                      if (result.paths[0]) {
                        setPresetEmbeddingModelPath(result.paths[0]);
                      }
                    });
                  }}>Browse...</button>
                </div>
              </label>
            </section>
            <section className="chat-settings-section">
              <h3>Codex</h3>
              <div className="chat-settings-row">
                <label>
                  <span>Model</span>
                  <select value={threadCodexModelId} onChange={(event) => setThreadCodexModelId(event.currentTarget.value)}>
                    {state.codexModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                  </select>
                </label>
                <label>
                  <span>Reasoning</span>
                  <select value={threadCodexReasoningEffort} onChange={(event) => setThreadCodexReasoningEffort(event.currentTarget.value as ChatReasoningEffort)}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">XHigh</option>
                  </select>
                </label>
              </div>
            </section>
            <section className="chat-settings-section">
              <h3>Runtime</h3>
              <div className="chat-settings-row">
                <label>
                  <span>Context Window</span>
                  <select value={settings.nCtx} onChange={(event) => setSettings({ ...settings, nCtx: event.currentTarget.value })}>
                    <option value="4096">4K</option>
                    <option value="8192">8K</option>
                    <option value="16384">16K</option>
                    <option value="32768">32K</option>
                    <option value="65536">64K</option>
                    <option value="131072">128K</option>
                  </select>
                </label>
                <label>
                  <span>Reasoning</span>
                  <select value={settings.reasoningEffort} onChange={(event) => setSettings({ ...settings, reasoningEffort: event.currentTarget.value })}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  <span>Max Tokens</span>
                  <input value={settings.maxTokens} onChange={(event) => setSettings({ ...settings, maxTokens: event.currentTarget.value })} />
                </label>
              </div>
            </section>
          </div>
          <div className="chat-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={!title.trim()}>Save</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "document-index") {
    const addDocumentPaths = (paths: string[]) => {
      setDocumentIndexPaths((current) => {
        const seen = new Set(current.map((path) => path.toLocaleLowerCase()));
        const next = [...current];
        for (const path of paths) {
          if (!path.trim() || seen.has(path.toLocaleLowerCase())) {
            continue;
          }
          seen.add(path.toLocaleLowerCase());
          next.push(path);
        }
        if (!title.trim() && next.length > 0) {
          setTitle(next.length === 1 ? chatFileName(next[0]) : `${chatFileName(next[0])} + ${next.length - 1} more`);
        }
        return next;
      });
    };
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog chat-document-index-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Create document index"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(() => window.unitApi.chat.createDocumentIndex({
              projectId: dialog.projectId,
              title,
              sourcePath: documentIndexPaths.join("\n")
            })).then(onClose);
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Create Document Index</strong>
              <span>{state.projects.find((project) => project.id === dialog.projectId)?.title ?? "Project"}</span>
            </div>
            <button type="button" aria-label="Close document index" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <div className="chat-settings-body">
            <section className="chat-settings-section">
              <h3>Index</h3>
              <label>
                <span>Name</span>
                <input name="document-index-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
              </label>
            </section>
            <section className="chat-settings-section">
              <h3>PDFs</h3>
              <div className="chat-document-index-toolbar">
                <button type="button" onClick={() => {
                  void window.unitApi.fileSystem.selectFiles({
                    currentPath: state.projects.find((project) => project.id === dialog.projectId)?.directory,
                    kind: "file",
                    multiple: true
                  }).then((result) => addDocumentPaths(result.paths.filter((path) => path.toLocaleLowerCase().endsWith(".pdf"))));
                }}>Add PDFs</button>
                <button type="button" disabled={documentIndexPaths.length === 0} onClick={() => setDocumentIndexPaths([])}>Clear</button>
              </div>
              <div className="chat-document-index-file-list">
                {documentIndexPaths.length === 0 ? (
                  <div className="chat-document-index-empty">No PDFs selected.</div>
                ) : documentIndexPaths.map((path) => (
                  <div className="chat-document-index-file-row" key={path}>
                    <input type="checkbox" aria-label={`Select ${chatFileName(path)}`} readOnly />
                    <div>
                      <strong>{chatFileName(path)}</strong>
                      <span>{path}</span>
                    </div>
                    <button type="button" aria-label={`Remove ${chatFileName(path)}`} onClick={() => setDocumentIndexPaths((current) => current.filter((item) => item !== path))}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>
          <div className="chat-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={!title.trim() || documentIndexPaths.length === 0}>Create</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "create-branch") {
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog chat-branch-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Create Branch"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void window.unitApi.chat.createGitBranch({ projectId: dialog.projectId, branch: title.trim() })
              .then(() => onClose())
              .catch((error: unknown) => {
                void onRun(() => Promise.reject(error));
              });
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Create Branch</strong>
              <span>Branch name:</span>
            </div>
            <button type="button" aria-label="Close create branch" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <div className="chat-settings-body">
            <section className="chat-settings-section">
              <label>
                <span>Branch name</span>
                <input autoFocus name="branch-name" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
              </label>
            </section>
          </div>
          <div className="chat-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={!title.trim()}>Create</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "project-settings") {
    const project = state.projects.find((item) => item.id === dialog.projectId);
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Project settings"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(() => window.unitApi.chat.updateProjectSettings({ projectId: dialog.projectId, title, directory, actionButtons: projectActionButtons })).then(onClose);
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Project Settings</strong>
              <span>{project?.title ?? "Project"}</span>
            </div>
            <button type="button" aria-label="Close project settings" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <ProjectSettingsFields
            title={title}
            directory={directory}
            actionButtons={projectActionButtons}
            onTitleChange={setTitle}
            onDirectoryChange={setDirectory}
            onActionButtonsChange={setProjectActionButtons}
          />
          <div className="chat-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={!title.trim()}>Save</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "project-actions") {
    const project = state.projects.find((item) => item.id === dialog.projectId);
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog chat-action-buttons-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Action buttons"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            const project = state.projects.find((item) => item.id === dialog.projectId);
            if (project) {
              void onRun(() => window.unitApi.chat.updateProjectSettings({
                projectId: dialog.projectId,
                title: project.title,
                directory: project.directory,
                actionButtons: projectActionButtons
              })).then(onClose);
            } else {
              onClose();
            }
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Action Buttons</strong>
              <span>{project?.title ?? "Project"}</span>
            </div>
            <button type="button" aria-label="Close action buttons" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <div className="chat-settings-body">
            <section className="chat-settings-section">
              <h3>Action Buttons</h3>
              <ProjectActionEditor rows={projectActionButtons} onRowsChange={setProjectActionButtons} />
            </section>
          </div>
          <div className="chat-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "thread-settings") {
    const thread = state.threads.find((item) => item.id === dialog.threadId);
    return (
      <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
        <form
          className="chat-settings-dialog chat-conversation-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Thread settings"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(async () => {
              if (thread && title.trim() && title.trim() !== thread.title) {
                await window.unitApi.chat.renameThread({ threadId: dialog.threadId, title: title.trim() });
              }
              return window.unitApi.chat.updateThreadSettings({
                threadId: dialog.threadId,
                providerMode: threadProviderMode,
                builtinModelId: threadBuiltinModelId,
                runtimeSettings: threadProviderMode === "builtin" ? parseRuntimeSettingsForm(settings) : undefined,
                builtinAgenticFramework: presetBuiltinFramework,
                documentAnalysisEmbeddingModelPath: presetEmbeddingModelPath,
                codexModelId: threadCodexModelId,
                codexReasoningEffort: threadCodexReasoningEffort,
                permissionMode: threadPermissionMode,
                codexApprovalMode: threadCodexApprovalMode,
                planModeEnabled: threadPlanModeEnabled
              });
            }).then(onClose);
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Thread Settings</strong>
              <span>{thread?.title ?? "Thread"}</span>
            </div>
            <button type="button" aria-label="Close thread settings" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <div className="chat-settings-body">
            <section className="chat-settings-section">
              <h3>Thread</h3>
              <label>
                <span>Title</span>
                <input name="thread-title" value={title || thread?.title || ""} onChange={(event) => setTitle(event.currentTarget.value)} />
              </label>
              <label>
                <span>Runtime</span>
                <select
                  value={threadProviderMode}
                  aria-label="Thread runtime"
                  onChange={(event) => setThreadProviderMode(event.currentTarget.value as ChatProviderMode)}
                >
                  <option value="builtin">Built-in model</option>
                  <option value="codex">Codex agent</option>
                </select>
              </label>
            </section>
            {threadProviderMode === "codex" ? (
            <section className="chat-settings-section">
              <h3>Codex Agent</h3>
              <div className="chat-settings-row">
                <label>
                  <span>Model</span>
                  <select value={threadCodexModelId} aria-label="Thread Codex model" onChange={(event) => setThreadCodexModelId(event.currentTarget.value)}>
                    {state.codexModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.label}  [{model.isDefault ? "Default" : "Codex"}]</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Reasoning</span>
                  <select value={threadCodexReasoningEffort} aria-label="Thread Codex reasoning" onChange={(event) => setThreadCodexReasoningEffort(event.currentTarget.value as ChatReasoningEffort)}>
                    {(state.codexModels.find((model) => model.id === threadCodexModelId)?.reasoningEfforts ?? ["low", "medium", "high"]).map((effort) => (
                      <option key={effort} value={effort}>{reasoningLabel(effort)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="chat-settings-row">
                <label>
                  <span>Connected Account</span>
                  <input readOnly value={state.codexAccount.status === "ready" ? state.codexAccount.email : state.codexAccount.status === "error" ? state.codexAccount.error : "Not connected"} />
                </label>
              </div>
              <div className="chat-settings-row">
                <label>
                  <span>Access</span>
                  <select
                    value={codexAccessModeForApprovalMode(threadCodexApprovalMode)}
                    aria-label="Thread Codex access"
                    onChange={(event) => {
                      const nextAccess = event.currentTarget.value as ChatPermissionMode;
                      setThreadPermissionMode(nextAccess);
                      setThreadCodexApprovalMode(codexApprovalModeForAccessMode(nextAccess));
                    }}
                  >
                    {CHAT_PERMISSION_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="chat-settings-check">
                  <input type="checkbox" checked={threadPlanModeEnabled} onChange={(event) => setThreadPlanModeEnabled(event.currentTarget.checked)} />
                  <span>Plan mode</span>
                </label>
              </div>
            </section>
            ) : (
            <section className="chat-settings-section">
              <h3>Runtime Settings</h3>
              <label>
                <span>Model</span>
                <select value={threadBuiltinModelId} aria-label="Thread built-in model" onChange={(event) => setThreadBuiltinModelId(event.currentTarget.value)}>
                  {state.models.length === 0 ? <option value="">No built-in model available</option> : null}
                  {state.models.map((model) => (
                    <option key={model.id} value={model.id}>{model.label}  [Local GGUF]</option>
                  ))}
                </select>
              </label>
              <div className="chat-settings-row">
                <label>
                  <span>Agentic framework</span>
                  <select value={presetBuiltinFramework} aria-label="Thread agentic framework" onChange={(event) => setPresetBuiltinFramework(event.currentTarget.value as "chat" | "document_analysis")}>
                    <option value="chat">Chat</option>
                    <option value="document_analysis">Document analysis</option>
                  </select>
                </label>
                <label>
                  <span>Context Window</span>
                  <select value={settings.nCtx} aria-label="Thread context window" onChange={(event) => setSettings({ ...settings, nCtx: event.currentTarget.value })}>
                    <option value="32768">Default</option>
                    <option value="4096">4K</option>
                    <option value="8192">8K</option>
                    <option value="16384">16K</option>
                    <option value="32768">32K</option>
                    <option value="65536">64K</option>
                    <option value="131072">128K</option>
                  </select>
                </label>
                <label>
                  <span>GPU Layers</span>
                  <select value={settings.nGpuLayers} aria-label="Thread GPU layers" onChange={(event) => setSettings({ ...settings, nGpuLayers: event.currentTarget.value })}>
                    <option value="-1">Auto</option>
                    <option value="0">CPU only</option>
                    <option value="20">20 layers</option>
                    <option value="40">40 layers</option>
                    <option value="80">80 layers</option>
                  </select>
                </label>
              </div>
              <div className="chat-settings-row">
                <label>
                  <span>Reasoning</span>
                  <select value={settings.reasoningEffort} aria-label="Thread reasoning" onChange={(event) => setSettings({ ...settings, reasoningEffort: event.currentTarget.value })}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  <span>Access</span>
                  <select value={settings.permissionMode} aria-label="Thread permissions" onChange={(event) => setSettings({ ...settings, permissionMode: event.currentTarget.value })}>
                    <option value="default_permissions">Default</option>
                    <option value="full_access">Full access</option>
                  </select>
                </label>
              </div>
              <div className="chat-settings-row">
                <label>
                  <span>Temperature</span>
                  <input value={settings.temperature} onChange={(event) => setSettings({ ...settings, temperature: event.currentTarget.value })} />
                </label>
                <label>
                  <span>Repeat Penalty</span>
                  <input value={settings.repeatPenalty} onChange={(event) => setSettings({ ...settings, repeatPenalty: event.currentTarget.value })} />
                </label>
              </div>
              <div className="chat-settings-row chat-settings-row-four">
                <label>
                  <span>Trim Reserve Tokens</span>
                  <input value={settings.trimReserveTokens} onChange={(event) => setSettings({ ...settings, trimReserveTokens: event.currentTarget.value })} />
                </label>
                <label>
                  <span>Trim Reserve %</span>
                  <input value={settings.trimReservePercent} onChange={(event) => setSettings({ ...settings, trimReservePercent: event.currentTarget.value })} />
                </label>
                <label>
                  <span>Trim Amount Tokens</span>
                  <input value={settings.trimAmountTokens} onChange={(event) => setSettings({ ...settings, trimAmountTokens: event.currentTarget.value })} />
                </label>
                <label>
                  <span>Trim Amount %</span>
                  <input value={settings.trimAmountPercent} onChange={(event) => setSettings({ ...settings, trimAmountPercent: event.currentTarget.value })} />
                </label>
              </div>
              <section className="chat-settings-section chat-nested-settings-section">
                <h3>System Prompt</h3>
                <textarea className="chat-settings-prompt" value={settings.systemPrompt} onChange={(event) => setSettings({ ...settings, systemPrompt: event.currentTarget.value })} />
              </section>
            </section>
            )}
            <section className="chat-settings-section">
              <h3>Workspace</h3>
              <label>
                <span>Project</span>
                <input readOnly value={state.projects.find((project) => project.id === thread?.projectId)?.title ?? ""} />
              </label>
              <label>
                <span>Effective Working Directory</span>
                <input readOnly placeholder="No project directory set" value={state.projects.find((project) => project.id === thread?.projectId)?.directory ?? ""} />
              </label>
              <p className="chat-settings-hint">Codex will run commands in this directory. Confirm it is the intended workspace before starting agent work.</p>
            </section>
          </div>
          <div className="chat-dialog-actions chat-dialog-actions-split">
            {thread ? (
              <button
                type="button"
                onClick={() => {
                  onDialog({ kind: "project-settings", projectId: thread.projectId });
                }}
              >
                Project Settings
              </button>
            ) : null}
            <span />
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={!title.trim()}>Save</button>
          </div>
        </form>
      </div>
    );
  }
  const isDelete = dialog.kind.startsWith("delete");
  const subject = dialog.kind.includes("project") ? "project" : "thread";
  return (
    <div className="chat-dialog-backdrop" role="presentation" onPointerDown={onClose}>
      <form
        className="chat-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isDelete ? `Delete ${subject}` : `Rename ${subject}`}
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (dialog.kind === "rename-project") {
            void onRun(() => window.unitApi.chat.renameProject({ projectId: dialog.projectId, title })).then(onClose);
          } else if (dialog.kind === "rename-thread") {
            void onRun(() => window.unitApi.chat.renameThread({ threadId: dialog.threadId, title })).then(onClose);
          } else if (dialog.kind === "delete-project") {
            void onRun(() => window.unitApi.chat.deleteProject({ projectId: dialog.projectId })).then(onClose);
          } else {
            void onRun(() => window.unitApi.chat.deleteThread({ threadId: dialog.threadId })).then(onClose);
          }
        }}
      >
        <header>
          <strong>{isDelete ? `Delete ${subject}` : `Rename ${subject}`}</strong>
          <button type="button" aria-label="Close dialog" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        {isDelete ? (
          <p>{dialog.title}</p>
        ) : (
          <label>
            <span>Name</span>
            <input autoFocus value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          </label>
        )}
        <div className="chat-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className={isDelete ? "destructive" : ""} type="submit" disabled={!isDelete && !title.trim()}>
            {isDelete ? "Delete" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function initialChatDialogTitle(dialog: ChatDialogState, state: ChatState) {
  if (!dialog) {
    return "";
  }
  if (dialog.kind === "new-project") {
    return "New Project";
  }
  if (dialog.kind === "rename-project" || dialog.kind === "rename-thread" || dialog.kind === "delete-project" || dialog.kind === "delete-thread") {
    return dialog.title;
  }
  if (dialog.kind === "project-settings") {
    return state.projects.find((project) => project.id === dialog.projectId)?.title ?? "";
  }
  if (dialog.kind === "project-actions") {
    return state.projects.find((project) => project.id === dialog.projectId)?.title ?? "";
  }
  if (dialog.kind === "thread-settings") {
    return state.threads.find((thread) => thread.id === dialog.threadId)?.title ?? "";
  }
  if (dialog.kind === "settings-preset") {
    return dialog.presetId
      ? state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.label ?? ""
      : "Untitled settings";
  }
  return "";
}

function ProjectSettingsFields({
  title,
  directory,
  actionButtons,
  onTitleChange,
  onDirectoryChange,
  onActionButtonsChange
}: {
  title: string;
  directory: string;
  actionButtons: ChatActionButton[];
  onTitleChange: (title: string) => void;
  onDirectoryChange: (directory: string) => void;
  onActionButtonsChange: (actionButtons: ChatActionButton[]) => void;
}) {
  const chooseDirectory = useCallback(async () => {
    const result = await window.unitApi.fileSystem.selectDirectory({ currentPath: directory });
    if (result.rootPath) {
      onDirectoryChange(result.rootPath);
    }
  }, [directory, onDirectoryChange]);

  return (
    <div className="chat-settings-body">
      <section className="chat-settings-section">
        <h3>Project</h3>
        <label>
          <span>Name</span>
          <input autoFocus name="project-title" placeholder="Project name" value={title} onChange={(event) => onTitleChange(event.currentTarget.value)} />
        </label>
        <label>
          <span>Directory</span>
          <div className="chat-directory-row">
            <input name="project-directory" placeholder="Optional" value={directory} onChange={(event) => onDirectoryChange(event.currentTarget.value)} />
            <button type="button" onClick={() => void chooseDirectory()}>Browse</button>
          </div>
        </label>
      </section>
      <section className="chat-settings-section">
        <h3>Action Buttons</h3>
        <ProjectActionEditor rows={actionButtons} onRowsChange={onActionButtonsChange} />
      </section>
    </div>
  );
}

function ChatAttachmentStrip({
  attachments,
  status,
  onRemove,
}: {
  attachments: ChatAttachment[];
  status: string;
  onRemove: (attachmentId: string) => void;
}) {
  if (attachments.length === 0 && !status) {
    return null;
  }
  return (
    <div className="chat-attachment-strip visible" aria-label="Pending attachments">
      <div className="chat-attachment-tile-row">
        {attachments.map((attachment) => (
          <div className="chat-attachment-tile" key={attachment.id}>
            {attachment.kind === "image" ? <Image size={14} /> : <Paperclip size={14} />}
            <span>{attachment.name}</span>
            <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)}>
              <X size={12} />
            </button>
            {attachment.kind === "image" ? (
              <div className="chat-attachment-hover-preview" aria-hidden="true">
                <img src={attachment.dataUrl ?? attachmentPreviewSrc(attachment.path)} alt="" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {status ? <span className="chat-attachment-status">{status}</span> : null}
    </div>
  );
}

function ProjectActionEditor({ rows, onRowsChange }: { rows: ChatActionButton[]; onRowsChange: (rows: ChatActionButton[]) => void }) {
  return (
    <div className="chat-action-editor">
      <div className="chat-action-editor-header">
        <span>Label</span>
        <span>Command</span>
        <span>Directory</span>
        <span />
      </div>
      <div className="chat-action-editor-rows">
        {rows.map((row) => (
          <div className="chat-action-editor-row" key={row.id}>
            <input aria-label="Action label" value={row.label} onChange={(event) => onRowsChange(rows.map((item) => item.id === row.id ? { ...item, label: event.currentTarget.value } : item))} />
            <input aria-label="Action command" value={row.command} onChange={(event) => onRowsChange(rows.map((item) => item.id === row.id ? { ...item, command: event.currentTarget.value } : item))} />
            <input aria-label="Action directory" value={row.directory} onChange={(event) => onRowsChange(rows.map((item) => item.id === row.id ? { ...item, directory: event.currentTarget.value } : item))} />
            <button aria-label="Remove action button" type="button" onClick={() => onRowsChange(rows.filter((item) => item.id !== row.id))}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="chat-action-editor-add"
        type="button"
        onClick={() => onRowsChange([...rows, { id: `action-${Date.now()}-${rows.length}`, label: "", command: "", directory: "" }])}
      >
        <Plus size={14} />
        <span>Add action button</span>
      </button>
    </div>
  );
}

function initialChatDialogDirectory(dialog: ChatDialogState, state: ChatState) {
  if (dialog?.kind !== "project-settings" && dialog?.kind !== "project-actions") {
    return "";
  }
  return state.projects.find((project) => project.id === dialog.projectId)?.directory ?? "";
}

function initialRuntimeSettingsForm(dialog: ChatDialogState, state: ChatState): Record<keyof ChatRuntimeSettings, string> {
  if (dialog?.kind === "thread-settings") {
    const thread = state.threads.find((candidate) => candidate.id === dialog.threadId);
    if (thread) {
      return runtimeSettingsToForm(thread.runtimeSettings);
    }
  }
  if (dialog?.kind === "settings-preset" && dialog.presetId) {
    const preset = state.settingsPresets.find((candidate) => candidate.id === dialog.presetId);
    if (preset) {
      return runtimeSettingsToForm(preset.runtimeSettings);
    }
  }
  return runtimeSettingsToForm(state.runtimeSettings);
}

function initialThreadProviderMode(dialog: ChatDialogState, state: ChatState): ChatProviderMode {
  if (dialog?.kind === "thread-settings") {
    return state.threads.find((thread) => thread.id === dialog.threadId)?.providerMode ?? "builtin";
  }
  if (dialog?.kind === "settings-preset" && dialog.presetId) {
    return state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.providerMode ?? "builtin";
  }
  return "builtin";
}

function initialThreadBuiltinModelId(dialog: ChatDialogState, state: ChatState) {
  if (dialog?.kind === "thread-settings") {
    return state.threads.find((thread) => thread.id === dialog.threadId)?.builtinModelId || state.selectedModelId || state.models[0]?.id || "";
  }
  return state.selectedModelId || state.models[0]?.id || "";
}

function initialThreadCodexModelId(dialog: ChatDialogState, state: ChatState) {
  const defaultModelId = state.codexModels.find((model) => model.isDefault)?.id ?? state.codexModels[0]?.id ?? "";
  if (dialog?.kind === "thread-settings") {
    return state.threads.find((thread) => thread.id === dialog.threadId)?.codexModelId ?? defaultModelId;
  }
  if (dialog?.kind === "settings-preset" && dialog.presetId) {
    return state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.codexModelId ?? defaultModelId;
  }
  return defaultModelId;
}

function initialThreadCodexReasoningEffort(dialog: ChatDialogState, state: ChatState): ChatReasoningEffort {
  if (dialog?.kind === "thread-settings") {
    return state.threads.find((thread) => thread.id === dialog.threadId)?.codexReasoningEffort ?? "medium";
  }
  if (dialog?.kind === "settings-preset" && dialog.presetId) {
    return state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.codexReasoningEffort ?? "medium";
  }
  return "medium";
}

function initialThreadPermissionMode(dialog: ChatDialogState, state: ChatState): ChatPermissionMode {
  return dialog?.kind === "thread-settings"
    ? state.threads.find((thread) => thread.id === dialog.threadId)?.permissionMode ?? state.runtimeSettings.permissionMode
    : state.runtimeSettings.permissionMode;
}

function initialThreadCodexApprovalMode(dialog: ChatDialogState, state: ChatState): ChatCodexApprovalMode {
  return dialog?.kind === "thread-settings"
    ? state.threads.find((thread) => thread.id === dialog.threadId)?.codexApprovalMode ?? "default"
    : "default";
}

function initialThreadPlanModeEnabled(dialog: ChatDialogState, state: ChatState) {
  return dialog?.kind === "thread-settings"
    ? state.threads.find((thread) => thread.id === dialog.threadId)?.planModeEnabled ?? false
    : false;
}

function initialSettingsPresetIconName(dialog: ChatDialogState, state: ChatState) {
  return dialog?.kind === "settings-preset" && dialog.presetId
    ? state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.iconName ?? "sliders"
    : "sliders";
}

function initialSettingsPresetBuiltinFramework(dialog: ChatDialogState, state: ChatState): "chat" | "document_analysis" {
  if (dialog?.kind === "thread-settings") {
    return state.threads.find((thread) => thread.id === dialog.threadId)?.builtinAgenticFramework ?? "chat";
  }
  return dialog?.kind === "settings-preset" && dialog.presetId
    ? state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.builtinAgenticFramework ?? "chat"
    : "chat";
}

function initialSettingsPresetEmbeddingModelPath(dialog: ChatDialogState, state: ChatState) {
  if (dialog?.kind === "thread-settings") {
    return state.threads.find((thread) => thread.id === dialog.threadId)?.documentAnalysisEmbeddingModelPath ?? "";
  }
  return dialog?.kind === "settings-preset" && dialog.presetId
    ? state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.documentAnalysisEmbeddingModelPath ?? ""
    : "";
}

function initialProjectActionButtons(dialog: ChatDialogState, state: ChatState): ChatActionButton[] {
  if (dialog?.kind !== "project-settings" && dialog?.kind !== "project-actions") {
    return [];
  }
  return state.projects.find((project) => project.id === dialog.projectId)?.actionButtons ?? [];
}

type ChatTimelineActionHandler = (blockId: string, action: "approve" | "deny" | "answer" | "retry" | "retry_new_thread", answer?: string) => Promise<void>;

function ChatMessageBubble({ message, onTimelineAction }: { message: ChatMessage; onTimelineAction: ChatTimelineActionHandler }) {
  const displayContent = message.content || (message.status === "streaming" ? "..." : "");
  const html = message.role === "user" ? renderChatUserPromptHtml(displayContent, message.attachments) : renderChatMarkdownHtml(displayContent, message.id);
  return (
    <article
      className={[
        "chat-message",
        message.role,
        message.status,
        "chat-message-row",
        message.role === "user" ? "chat-message-row-user" : "chat-message-row-assistant"
      ].join(" ")}
      data-testid={`chat-message-${message.role}`}
    >
      {message.role === "assistant" ? (
        <section className="chat-message-label assistant-turn-meta">
          <span className="chat-assistant-pill assistant-turn-badge">{message.label || "UNIT-0"}</span>
          <small className="assistant-turn-source">{message.sourceLabel || "Built-in"}</small>
        </section>
      ) : null}
      {message.role === "assistant" && message.reasoning ? (
        <details className="assistant-turn-reasoning-shell">
          <summary>Reasoning</summary>
          <div dangerouslySetInnerHTML={{ __html: renderChatMarkdownHtml(message.reasoning, `${message.id}-reasoning`) }} />
        </details>
      ) : null}
      <div
        className={[
          "chat-message-body",
          message.role === "user" ? "chat-message-bubble chat-message-bubble-user" : "chat-formatted-view assistant-content-block"
        ].join(" ")}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {message.role === "assistant" && message.timelineBlocks?.length ? (
        <ChatTimeline blocks={message.timelineBlocks} messageId={message.id} onTimelineAction={onTimelineAction} />
      ) : null}
      {message.status === "interrupted" ? <small>Interrupted</small> : message.status === "error" ? <small>Error</small> : null}
    </article>
  );
}

function ChatTimeline({ blocks, messageId, onTimelineAction }: { blocks: ChatTimelineBlock[]; messageId: string; onTimelineAction: ChatTimelineActionHandler }) {
  return (
    <div className="codex-event-stack" aria-label="Assistant timeline">
      {blocks.map((block, index) => <ChatTimelineBlockView block={block} key={`${messageId}-${block.kind}-${block.id || index}`} onTimelineAction={onTimelineAction} />)}
    </div>
  );
}

function ChatTimelineBlockView({ block, onTimelineAction }: { block: ChatTimelineBlock; onTimelineAction: ChatTimelineActionHandler }) {
  const [answer, setAnswer] = useState("");
  if (block.kind === "tool") {
    const title = block.command || block.summary || formatTimelineTitle(block.toolName || "Tool Call");
    return (
      <details className="codex-event-card codex-tool-card" open={block.status === "started"}>
        <summary>
          <span className="codex-event-title">{title}</span>
          <span className="codex-event-badge" data-status={block.status}>{formatTimelineStatus(block.status)}</span>
        </summary>
        {block.directory ? <div className="codex-event-meta">Directory: {block.directory}</div> : null}
        {block.output ? <pre className="codex-event-pre">{block.output}</pre> : null}
      </details>
    );
  }
  if (block.kind === "diff") {
    return (
      <details className="codex-event-card codex-diff-card">
        <summary>
          <span className="codex-event-title">{block.summary}</span>
          <span className="codex-diff-counts codex-diff-counts-compact">
            <span className="codex-diff-count codex-diff-count-added">+{block.addedLines ?? 0}</span>
            <span className="codex-diff-count codex-diff-count-deleted">-{block.deletedLines ?? 0}</span>
          </span>
        </summary>
        {block.branchName ? <div className="codex-event-meta">Branch: {block.branchName}</div> : null}
        {block.preview ? <pre className="codex-event-pre codex-diff-preview">{block.preview}</pre> : null}
      </details>
    );
  }
  if (block.kind === "plan") {
    return (
      <div className="codex-event-card codex-plan-card">
        <div className="codex-event-card-header">
          <span className="codex-event-title">Plan</span>
          <span className="codex-event-badge" data-status={block.status}>{formatTimelineStatus(block.status)}</span>
        </div>
        {block.explanation ? <div className="codex-event-text">{block.explanation}</div> : null}
        {block.steps?.length ? (
          <ol className="codex-plan-steps">
            {block.steps.map((step, index) => (
              <li key={`${block.id}-step-${index}`} data-status={step.status}>
                <span>{formatTimelineStatus(step.status)}</span>
                <strong>{step.text}</strong>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    );
  }
  if (block.kind === "approval" || block.kind === "question") {
    return (
      <div className="codex-event-card codex-approval-card">
        <div className="codex-event-card-header">
          <span className="codex-event-title">{block.kind === "approval" ? block.title : block.title}</span>
          <span className="codex-event-badge" data-status={block.status}>{formatTimelineStatus(block.status)}</span>
        </div>
        {"question" in block && block.question ? <div className="codex-event-text">{block.question}</div> : null}
        {"details" in block && block.details ? <div className="codex-event-text">{block.details}</div> : null}
        {block.kind === "approval" && block.status === "requested" ? (
          <div className="codex-event-actions">
            <button type="button" className="codex-event-action" onClick={() => void onTimelineAction(block.id, "approve")}>Approve</button>
            <button type="button" className="codex-event-action" data-variant="danger" onClick={() => void onTimelineAction(block.id, "deny")}>Deny</button>
          </div>
        ) : null}
        {block.kind === "question" && block.status === "requested" ? (
          <div className="codex-event-answer-form">
            <textarea
              aria-label="Question answer"
              value={answer}
              onChange={(event) => setAnswer(event.currentTarget.value)}
            />
            <div className="codex-event-actions">
              <button
                type="button"
                className="codex-event-action"
                disabled={!answer.trim()}
                onClick={() => void onTimelineAction(block.id, "answer", answer.trim())}
              >
                Answer
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  const title = block.kind === "delegated"
    ? "Delegated Work"
    : block.kind === "compaction"
      ? "Context Compaction"
      : formatTimelineTitle("level" in block ? block.level : "Status");
  const message = "summary" in block ? block.summary : "message" in block ? block.message : block.status;
  const status = "status" in block ? block.status : "info";
  return (
    <div className="codex-event-card codex-status-card">
      <div className="codex-event-card-header">
        <span className="codex-event-title">{title}</span>
        <span className="codex-event-badge" data-status={status}>{formatTimelineStatus(status)}</span>
      </div>
      <div className="codex-event-text">{message}</div>
      {"code" in block && block.code ? <pre className="codex-event-pre">{block.code}</pre> : null}
      {block.kind === "status" && block.level === "error" ? (
        <div className="codex-event-actions">
          <button type="button" className="codex-event-action" onClick={() => void onTimelineAction(block.id, "retry")}>Retry</button>
          <button type="button" className="codex-event-action" onClick={() => void onTimelineAction(block.id, "retry_new_thread")}>Retry in new thread</button>
        </div>
      ) : null}
    </div>
  );
}

function formatTimelineTitle(value: string) {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  return normalized ? normalized.replace(/\b\w/g, (char) => char.toUpperCase()) : "Status";
}

function formatTimelineStatus(value: string) {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  if (!normalized) {
    return "Pending";
  }
  if (normalized.toLowerCase() === "in progress") {
    return "In Progress";
  }
  if (normalized.toLowerCase() === "started") {
    return "Running";
  }
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatChatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function reasoningLabel(value: ChatReasoningEffort) {
  return value === "xhigh" ? "XHigh" : value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function permissionLabel(value: ChatPermissionMode) {
  return CHAT_PERMISSION_OPTIONS.find((option) => option.id === value)?.label ?? "Default";
}

function codexApprovalLabel(value: ChatCodexApprovalMode) {
  return CHAT_CODEX_APPROVAL_OPTIONS.find((option) => option.id === value)?.label ?? "Default";
}

function codexApprovalModeForAccessMode(value: ChatPermissionMode): ChatCodexApprovalMode {
  return value === "full_access" ? "never" : "default";
}

function codexAccessModeForApprovalMode(value: ChatCodexApprovalMode): ChatPermissionMode {
  return value === "never" ? "full_access" : "default_permissions";
}

function settingsPresetIcon(iconName: string, providerMode: ChatSettingsPreset["providerMode"]) {
  if (providerMode === "codex" || iconName === "code") {
    return Code2;
  }
  if (iconName === "bolt") {
    return Bolt;
  }
  if (iconName === "brain") {
    return Brain;
  }
  return SlidersHorizontal;
}

function runtimeReasoningLabel(settings: ChatRuntimeSettings) {
  return reasoningLabel(settings.reasoningEffort);
}

function formatContextLabel(tokens: number) {
  if (tokens >= 1024) {
    const value = tokens / 1024;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}K`;
  }
  return String(tokens);
}

function contextUsagePercent(state: ChatState) {
  const selectedMessages = state.messages.filter((message) => message.threadId === state.selectedThreadId);
  const usedCharacters = selectedMessages.reduce((total, message) => total + message.content.length + (message.reasoning?.length ?? 0), 0);
  const approximateTokens = Math.ceil(usedCharacters / 4);
  return Math.max(0, Math.min(100, Math.round((approximateTokens / Math.max(1, state.runtimeSettings.nCtx)) * 100)));
}

function rateLimitIndicatorLabel(state: ChatState, slot: "primary" | "secondary") {
  if (state.codexAccount.status === "error") {
    return "Error";
  }
  if (state.codexAccount.status !== "ready") {
    return slot === "primary" ? "Week" : "5h";
  }
  const window = state.codexAccount.rateLimits?.[slot];
  if (!window) {
    return slot === "primary" ? "Week" : "5h";
  }
  return `${Math.round(window.usedPercent)}%`;
}

function runtimeSettingsToForm(settings: ChatRuntimeSettings): Record<keyof ChatRuntimeSettings, string> {
  return {
    nCtx: String(settings.nCtx),
    nGpuLayers: String(settings.nGpuLayers),
    temperature: String(settings.temperature),
    repeatPenalty: String(settings.repeatPenalty),
    maxTokens: String(settings.maxTokens),
    reasoningEffort: settings.reasoningEffort,
    permissionMode: settings.permissionMode,
    trimReserveTokens: String(settings.trimReserveTokens),
    trimReservePercent: String(settings.trimReservePercent),
    trimAmountTokens: String(settings.trimAmountTokens),
    trimAmountPercent: String(settings.trimAmountPercent),
    systemPrompt: settings.systemPrompt
  };
}

function parseRuntimeSettingsForm(settings: Record<keyof ChatRuntimeSettings, string>): Partial<ChatRuntimeSettings> {
  return {
    nCtx: Number.parseInt(settings.nCtx, 10),
    nGpuLayers: Number.parseInt(settings.nGpuLayers, 10),
    temperature: Number.parseFloat(settings.temperature),
    repeatPenalty: Number.parseFloat(settings.repeatPenalty),
    maxTokens: Number.parseInt(settings.maxTokens, 10),
    reasoningEffort: settings.reasoningEffort as Exclude<ChatReasoningEffort, "xhigh">,
    permissionMode: settings.permissionMode as ChatPermissionMode,
    trimReserveTokens: Number.parseInt(settings.trimReserveTokens, 10),
    trimReservePercent: Number.parseFloat(settings.trimReservePercent),
    trimAmountTokens: Number.parseInt(settings.trimAmountTokens, 10),
    trimAmountPercent: Number.parseFloat(settings.trimAmountPercent),
    systemPrompt: settings.systemPrompt
  };
}

type ChatMathReplacement = {
  html: string;
  kind: "display" | "inline";
  token: string;
};

function renderChatUserPromptHtml(text: string, attachments: ChatAttachment[] = []) {
  const normalized = text.trim();
  const textHtml = normalized ? `<div class="chat-message-text">${escapeHtml(normalized).replace(/\r?\n/g, "<br />")}</div>` : "";
  const attachmentsHtml = attachments.length > 0
    ? `<div class="chat-message-attachments">${attachments.map((attachment) => `
        <div class="chat-message-attachment ${attachment.kind === "image" ? "image" : ""}">
          ${attachment.kind === "image" ? `<img src="${escapeHtml(attachment.dataUrl ?? attachmentPreviewSrc(attachment.path))}" alt="${escapeHtml(attachment.name)}" />` : `<span>File</span>`}
          <strong>${escapeHtml(attachment.name)}</strong>
        </div>
      `).join("")}</div>`
    : "";
  return `${textHtml}${attachmentsHtml}`;
}

function insertTextareaNewline(textarea: HTMLTextAreaElement, value: string, setValue: (next: string) => void): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = `${value.slice(0, start)}\n${value.slice(end)}`;
  setValue(next);
  window.requestAnimationFrame(() => {
    textarea.selectionStart = start + 1;
    textarea.selectionEnd = start + 1;
  });
}

function chatFileName(filePath: string) {
  return filePath.split(/[\\/]/g).filter(Boolean).at(-1) ?? filePath;
}

function attachmentPreviewSrc(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

function renderChatMarkdownHtml(markdown: string, footnoteScope: string) {
  if (!markdown.trim()) {
    return "";
  }
  const { source, replacements } = extractChatMath(markdown);
  let html = chatMarkdown.render(source);
  html = scopeChatFootnotes(html, footnoteScope);
  for (const replacement of replacements) {
    if (replacement.kind === "display") {
      html = html.replace(new RegExp(`<p>\\s*${escapeRegExp(replacement.token)}\\s*</p>`, "g"), replacement.html);
    }
    html = html.replace(new RegExp(escapeRegExp(replacement.token), "g"), replacement.html);
  }
  return html;
}

function extractChatMath(markdown: string) {
  const replacements: ChatMathReplacement[] = [];
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  let mathIndex = 0;
  const source = parts.map((part, partIndex) => {
    if (partIndex % 2 === 1) {
      return part;
    }
    return part
      .replace(/\$\$([\s\S]+?)\$\$/g, (_match, expression: string) => {
        const token = `UNIT0_DISPLAY_MATH_${mathIndex++}`;
        replacements.push({
          token,
          kind: "display",
          html: renderMathExpression(expression, true)
        });
        return token;
      })
      .replace(/\\\[([\s\S]+?)\\\]/g, (_match, expression: string) => {
        const token = `UNIT0_DISPLAY_MATH_${mathIndex++}`;
        replacements.push({
          token,
          kind: "display",
          html: renderMathExpression(expression, true)
        });
        return token;
      })
      .replace(/\\\(([\s\S]+?)\\\)/g, (_match, expression: string) => {
        const token = `UNIT0_INLINE_MATH_${mathIndex++}`;
        replacements.push({
          token,
          kind: "inline",
          html: renderMathExpression(expression, false)
        });
        return token;
      })
      .replace(/(^|[^$])\$([^$\n]+?)\$(?!\$)/g, (_match, prefix: string, expression: string) => {
        const token = `UNIT0_INLINE_MATH_${mathIndex++}`;
        replacements.push({
          token,
          kind: "inline",
          html: renderMathExpression(expression, false)
        });
        return `${prefix}${token}`;
      });
  }).join("");
  return { source, replacements };
}

function renderMathExpression(expression: string, display: boolean) {
  try {
    const rendered = katex.renderToString(expression.trim(), {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: false
    });
    return display ? `<div class="chat-math-block">${rendered}</div>` : `<span class="chat-math-inline">${rendered}</span>`;
  } catch (error: unknown) {
    const message = escapeHtml(errorMessage(error));
    return display ? `<div class="chat-math-block chat-math-error">${message}</div>` : `<span class="chat-math-inline chat-math-error">${message}</span>`;
  }
}

function scopeChatFootnotes(html: string, footnoteScope: string) {
  const scope = footnoteScope.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
  if (!scope || !html.includes("fn")) {
    return html;
  }
  return html
    .replace(/\bid="(fnref|fn)([^"]*)"/g, (_match, kind: string, suffix: string) => `id="${kind}-${scope}-${suffix}"`)
    .replace(/\bhref="#(fnref|fn)([^"]*)"/g, (_match, kind: string, suffix: string) => `href="#${kind}-${scope}-${suffix}"`);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
