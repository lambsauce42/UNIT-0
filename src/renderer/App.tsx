import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Brain,
  Bot,
  Bolt,
  Check,
  ChevronDown,
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
  List,
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
  X,
  type LucideIcon
} from "lucide-react";
import MarkdownIt from "markdown-it";
import markdownItFootnote from "markdown-it-footnote";
import markdownItTaskLists from "markdown-it-task-lists";
import katex from "katex";
import "katex/dist/katex.min.css";
import CodeMirror from "@uiw/react-codemirror";
import { defaultHighlightStyle, HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { type Extension } from "@codemirror/state";
import { oneDarkHighlightStyle, oneDarkTheme } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { tags } from "@lezer/highlight";
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
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
  type WheelEvent as ReactWheelEvent
} from "react";
import { createPortal } from "react-dom";
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
  ChatBuiltinAgenticFramework,
  ChatCodexApprovalMode,
  ChatCodexRateLimitWindow,
  ChatDocumentIndex,
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
  FileViewerSyntaxHighlighting,
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
import { extractShellWrappedCommand } from "./timelineDisplay";

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

function CodexToolShellIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: string | number }) {
  return (
    <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M11.4194 15.1694L17.25 21C18.2855 22.0355 19.9645 22.0355 21 21C22.0355 19.9645 22.0355 18.2855 21 17.25L15.1233 11.3733M11.4194 15.1694L13.9155 12.1383C14.2315 11.7546 14.6542 11.5132 15.1233 11.3733M11.4194 15.1694L6.76432 20.8219C6.28037 21.4096 5.55897 21.75 4.79768 21.75C3.39064 21.75 2.25 20.6094 2.25 19.2023C2.25 18.441 2.59044 17.7196 3.1781 17.2357L10.0146 11.6056M15.1233 11.3733C15.6727 11.2094 16.2858 11.1848 16.8659 11.2338C16.9925 11.2445 17.1206 11.25 17.25 11.25C19.7353 11.25 21.75 9.23528 21.75 6.75C21.75 6.08973 21.6078 5.46268 21.3523 4.89779L18.0762 8.17397C16.9605 7.91785 16.0823 7.03963 15.8262 5.92397L19.1024 2.64774C18.5375 2.39223 17.9103 2.25 17.25 2.25C14.7647 2.25 12.75 4.26472 12.75 6.75C12.75 6.87938 12.7555 7.00749 12.7662 7.13411C12.8571 8.20956 12.6948 9.39841 11.8617 10.0845L11.7596 10.1686M10.0146 11.6056L5.90901 7.5H4.5L2.25 3.75L3.75 2.25L7.5 4.5V5.90901L11.7596 10.1686M10.0146 11.6056L11.7596 10.1686M18.375 18.375L15.75 15.75M4.86723 19.125H4.87473V19.1325H4.86723V19.125Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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

const BrandPresetIcon = (({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: string | number }) => (
  <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
    <path d="M12 6l1.7 3.7L18 11.4l-3.2 3 0.8 4.4L12 16.8 8.4 18.8l0.8-4.4-3.2-3 4.3-1.7L12 6z" fill="#fffaf2" />
  </svg>
)) as LucideIcon;

const OpenAIPresetIcon = (({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: string | number }) => (
  <svg {...props} width={size} height={size} viewBox="136 217 288 286" fill="none" aria-hidden="true">
    <path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z" fill="currentColor" />
  </svg>
)) as LucideIcon;

const SETTINGS_PRESET_ICON_OPTIONS = [
  { value: "sliders", label: "Sliders" },
  { value: "openai", label: "OpenAI" },
  { value: "bolt", label: "Bolt" },
  { value: "brain", label: "Brain" },
  { value: "brand", label: "Brand" },
  { value: "settings", label: "Gear" },
  { value: "list", label: "List" },
  { value: "folder", label: "Folder" },
  { value: "git_branch", label: "Branch" }
] as const;

type SettingsPresetIconName = typeof SETTINGS_PRESET_ICON_OPTIONS[number]["value"];

const SETTINGS_PRESET_ICONS: Record<SettingsPresetIconName, LucideIcon> = {
  sliders: SlidersHorizontal,
  openai: OpenAIPresetIcon,
  bolt: Bolt,
  brain: Brain,
  brand: BrandPresetIcon,
  settings: Settings,
  list: List,
  folder: FolderOpen,
  git_branch: GitBranch
};

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
          <div className="empty-spawn-grid" aria-label="Create applet">
            {appletCatalog.map((item) => {
              const Icon = iconByKind[item.kind];
              const label = item.kind === "wslTerminal" ? "New WSL terminal" : `New ${item.label.toLowerCase()}`;
              return (
                <button
                  key={item.kind}
                  className="empty-spawn-button"
                  type="button"
                  onClick={() => {
                    void window.unitApi.applets.createApplet({ workspaceId: workspace.id, kind: item.kind });
                  }}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
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

const FILE_VIEWER_SYNTAX_OPTIONS: Array<{ value: FileViewerSyntaxHighlighting; label: string }> = [
  { value: "one-dark", label: "One Dark" },
  { value: "vscode-dark", label: "VS Code Dark" },
  { value: "muted", label: "Muted" },
  { value: "codemirror", label: "CodeMirror Classic" }
];

const fileViewerVsCodeDarkHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.character], color: "#ff7b72" },
  { tag: [tags.atom, tags.bool, tags.number, tags.constant(tags.name), tags.standard(tags.name)], color: "#79c0ff" },
  { tag: [tags.variableName, tags.definition(tags.variableName), tags.propertyName, tags.labelName], color: "#ffa657" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.propertyName)], color: "#d2a8ff" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#79c0ff" },
  { tag: [tags.tagName, tags.attributeName], color: "#7ee787" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], color: "#a5d6ff" },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.brace], color: "#c9d1d9" },
  { tag: [tags.comment, tags.meta], color: "#8b949e" },
  { tag: tags.heading, color: "#79c0ff", fontWeight: "bold" },
  { tag: tags.link, color: "#a5d6ff", textDecoration: "underline" },
  { tag: tags.quote, color: "#7ee787" },
  { tag: tags.strong, color: "#c9d1d9", fontWeight: "bold" },
  { tag: tags.emphasis, color: "#c9d1d9", fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.invalid, color: "#ffa198", fontStyle: "italic" },
  { tag: [tags.deleted], color: "#ffa198" },
  { tag: [tags.inserted], color: "#7ee787" },
  { tag: [tags.changed], color: "#ffa657" }
]);

const fileViewerMutedHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#c9a7ff" },
  { tag: [tags.name, tags.propertyName, tags.labelName], color: "#d9e3ee" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.propertyName)], color: "#8cc8ff" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#ffd38a" },
  { tag: [tags.number, tags.bool, tags.atom], color: "#f2c57c" },
  { tag: [tags.string, tags.special(tags.string), tags.inserted], color: "#95d5a6" },
  { tag: [tags.operator, tags.operatorKeyword, tags.regexp, tags.escape], color: "#9dc5d6" },
  { tag: [tags.comment, tags.meta], color: "#7f8a99" },
  { tag: tags.heading, color: "#f0b7c2", fontWeight: "bold" },
  { tag: tags.link, color: "#8cc8ff", textDecoration: "underline" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "#ff8a8a" }
]);

const FILE_VIEWER_HIGHLIGHT_STYLES: Record<FileViewerSyntaxHighlighting, HighlightStyle> = {
  "one-dark": oneDarkHighlightStyle,
  "vscode-dark": fileViewerVsCodeDarkHighlightStyle,
  muted: fileViewerMutedHighlightStyle,
  codemirror: defaultHighlightStyle
};

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localSyntaxHighlightingMode, setLocalSyntaxHighlightingMode] = useState<FileViewerSyntaxHighlighting | null>(null);
  const [discardRequest, setDiscardRequest] = useState<FileViewerDiscardRequest | null>(null);
  const [status, setStatus] = useState<FileViewerStatus>({ state: "loading", label: "Loading files" });
  const configuredRootPath = session.state.fileViewer?.rootPath ?? "";
  const persistedSyntaxHighlightingMode = session.state.fileViewer?.syntaxHighlighting ?? "one-dark";
  const syntaxHighlightingMode = localSyntaxHighlightingMode ?? persistedSyntaxHighlightingMode;

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

  useEffect(() => {
    setLocalSyntaxHighlightingMode(null);
  }, [persistedSyntaxHighlightingMode]);

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
      oneDarkTheme,
      syntaxHighlighting(FILE_VIEWER_HIGHLIGHT_STYLES[syntaxHighlightingMode]),
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
    [editorLanguageExtensions, saveSelectedFile, syntaxHighlightingMode]
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
        fileViewer: { ...session.state.fileViewer, rootPath: nextRootPath }
      }
    });
  }, [session.id, session.state]);

  const updateSyntaxHighlighting = useCallback(async (nextSyntaxHighlighting: FileViewerSyntaxHighlighting) => {
    setLocalSyntaxHighlightingMode(nextSyntaxHighlighting);
    await window.unitApi.applets.updateAppletSessionState({
      sessionId: session.id,
      state: {
        ...session.state,
        fileViewer: { ...session.state.fileViewer, syntaxHighlighting: nextSyntaxHighlighting }
      }
    });
  }, [session.id, session.state]);

  const selectRootDirectory = useCallback(async () => {
    const result = await window.unitApi.fileSystem.selectDirectory({ currentPath: rootPath || configuredRootPath });
    if (!result.rootPath) {
      return;
    }
    setSettingsOpen(false);
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
          <button className="icon-button" type="button" aria-label="File viewer settings" onClick={() => setSettingsOpen(true)}>
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
            basicSetup={{ syntaxHighlighting: false }}
            className="code-editor"
            editable
            extensions={editorExtensions}
            height="100%"
            key={`${selectedFile.id}:${syntaxHighlightingMode}`}
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
      {settingsOpen ? (
        <div className="file-settings-backdrop" role="presentation" onPointerDown={() => setSettingsOpen(false)}>
          <section
            className="file-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-settings-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="file-settings-header">
              <h2 id="file-settings-title">File Viewer Settings</h2>
              <button className="icon-button" type="button" aria-label="Close file viewer settings" onClick={() => setSettingsOpen(false)}>
                <X size={14} />
              </button>
            </header>
            <div className="file-settings-body">
              <label className="file-settings-field">
                <span>Syntax highlighting</span>
                <select
                  value={syntaxHighlightingMode}
                  onChange={(event) => {
                    void updateSyntaxHighlighting(event.currentTarget.value as FileViewerSyntaxHighlighting)
                      .catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }));
                  }}
                >
                  {FILE_VIEWER_SYNTAX_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="file-settings-field">
                <span>Directory</span>
                <div className="file-settings-directory">
                  <span title={rootPath}>{rootPath || "Workspace"}</span>
                  <button
                    type="button"
                    onClick={() => void selectRootDirectory().catch((error: unknown) => setStatus({ state: "error", message: errorMessage(error) }))}
                  >
                    <FolderOpen size={14} />
                    <span>Choose</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}
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

type ChatMenuTarget =
  | { kind: "model" }
  | { kind: "add" }
  | { kind: "settings" }
  | { kind: "quality" }
  | { kind: "permissions" }
  | { kind: "branch" }
  | { kind: "document" }
  | { kind: "thread"; threadId: string };

type ChatMenuState = (ChatMenuAnchor & ChatMenuTarget) | null;

type ChatDialogState =
  | { kind: "new-project" }
  | { kind: "project-settings"; projectId: string }
  | { kind: "project-actions"; projectId: string }
  | { kind: "thread-settings"; threadId: string }
  | { kind: "rename-project"; projectId: string; title: string }
  | { kind: "rename-thread"; threadId: string; title: string }
  | { kind: "delete-project"; projectId: string; title: string }
  | { kind: "app-settings" }
  | { kind: "settings-preset"; presetId?: string }
  | { kind: "document-index"; projectId: string; documentIndexId?: string }
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
      <ChatSettingSelect
        label="Style"
        labelElement="small"
        value={preference.displayMode}
        options={displayOptions.map(([label, value]) => ({ label, value }))}
        onChange={(value) => onChange(indicatorId, { displayMode: value as typeof preference.displayMode })}
      />
      <ChatSettingSelect
        label="Placement"
        labelElement="small"
        value={preference.placement}
        options={placementOptions.map(([label, value]) => ({ label, value }))}
        onChange={(value) => onChange(indicatorId, { placement: value as typeof preference.placement })}
      />
      <ChatSettingSelect
        label="Order"
        labelElement="small"
        value={String(preference.order)}
        options={[1, 2, 3, 4].map((value) => ({ label: String(value), value: String(value) }))}
        onChange={(value) => onChange(indicatorId, { order: Number.parseInt(value, 10) || 1 })}
      />
    </div>
  );
}

type ChatSettingSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
};

function contextWindowOptions(includeDefault: boolean): ChatSettingSelectOption[] {
  const base = [
    { value: "4096", label: "4K" },
    { value: "8192", label: "8K" },
    { value: "16384", label: "16K" },
    { value: "32768", label: "32K" },
    { value: "65536", label: "64K" },
    { value: "131072", label: "128K" }
  ];
  return includeDefault ? [{ value: "32768", label: "Default" }, ...base] : base;
}

function reasoningOptions(efforts: ChatReasoningEffort[]): ChatSettingSelectOption[] {
  return efforts.map((effort) => ({ value: effort, label: reasoningLabel(effort) }));
}

function ChatSettingSelect({
  label,
  labelElement = "span",
  value,
  options,
  ariaLabel,
  onChange
}: {
  label: string;
  labelElement?: "span" | "small";
  value: string;
  options: ChatSettingSelectOption[];
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value && !option.disabled) ?? options.find((option) => option.value === value);
  const LabelTag = labelElement;

  const positionMenu = useCallback(() => {
    const button = buttonRef.current;
    if (!button) {
      return;
    }
    const rect = button.getBoundingClientRect();
    setMenuRect({
      left: rect.left,
      top: rect.bottom + 4,
      width: rect.width
    });
  }, []);

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    positionMenu();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (buttonRef.current?.contains(target) || menuRef.current?.contains(target))) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onWindowChange = () => setOpen(false);
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("scroll", onWindowChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("scroll", onWindowChange, true);
    };
  }, [open]);

  return (
    <label className="chat-setting-select-field">
      <LabelTag>{label}</LabelTag>
      <button
        ref={buttonRef}
        type="button"
        className="chat-setting-select-button"
        aria-label={ariaLabel ?? label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggleMenu}
      >
        <span className={["chat-setting-select-value", selected?.icon ? "has-icon" : ""].filter(Boolean).join(" ")}>
          {selected?.icon ? <span className="chat-setting-select-option-icon">{selected.icon}</span> : null}
          <span>{selected?.label ?? value}</span>
        </span>
        <ChevronDown className="chat-setting-select-caret" size={15} />
      </button>
      {open && menuRect ? createPortal(
        <div
          ref={menuRef}
          className="chat-setting-select-menu"
          role="listbox"
          aria-label={ariaLabel ?? label}
          style={{ left: menuRect.left, top: menuRect.top, width: menuRect.width }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.icon ? "has-icon" : undefined}
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) {
                  return;
                }
                onChange(option.value);
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              {option.icon ? <span className="chat-setting-select-option-icon">{option.icon}</span> : null}
              <span>{option.label}</span>
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </label>
  );
}

type ChatMarkdownRenderEnv = {
  copiedCodeBlockIds?: ReadonlySet<string>;
  footnoteScope: string;
};

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
  const renderEnv = env as ChatMarkdownRenderEnv;
  const info = token.info.trim();
  const language = info.split(/\s+/)[0] || "";
  const escapedCode = chatMarkdown.utils.escapeHtml(token.content);
  const languageLabel = language ? `<figcaption>${chatMarkdown.utils.escapeHtml(language)}</figcaption>` : "<figcaption></figcaption>";
  const codeBlockId = `${renderEnv.footnoteScope}:code:${index}`;
  const copied = renderEnv.copiedCodeBlockIds?.has(codeBlockId) ?? false;
  return `<figure class="chat-code-figure"><div class="chat-code-header">${languageLabel}<button class="chat-code-copy-button" type="button" aria-label="Copy code" data-code-block-id="${chatMarkdown.utils.escapeHtml(codeBlockId)}" data-copied="${copied ? "1" : "0"}">${copied ? "Copied" : "Copy"}</button></div><pre class="chat-code-block"><code data-language="${chatMarkdown.utils.escapeHtml(language)}">${escapedCode}</code></pre></figure>`;
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
  const [sidebarScrollable, setSidebarScrollable] = useState(false);
  const [threadAtBottom, setThreadAtBottom] = useState(true);
  const [chatLayout, setChatLayout] = useState({ compact: false, contentWidth: 864, composerInset: 204 });
  const [threadScrollbar, setThreadScrollbar] = useState({ scrollable: false, thumbTop: 0, thumbHeight: 42 });
  const [manualEndSlack, setManualEndSlack] = useState(0);
  const [copiedCodeBlockIds, setCopiedCodeBlockIds] = useState<Set<string>>(() => new Set());
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const chatMainRef = useRef<HTMLElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const threadScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const threadContentRef = useRef<HTMLDivElement | null>(null);
  const manualEndSpacerRef = useRef<HTMLDivElement | null>(null);
  const composerSectionRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const projectScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowThreadBottomRef = useRef(true);
  const threadBottomFollowActiveRef = useRef(false);
  const threadScrollbarDragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);
  const manualEndSlackRef = useRef(0);
  const threadOverscrollAnchorRef = useRef<number | null>(null);
  const copiedCodeBlockTimersRef = useRef<Map<string, number>>(new Map());

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

  useEffect(() => {
    if (chatState?.codexAccount.status !== "unknown") {
      return;
    }
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (cancelled || running) {
        return;
      }
      running = true;
      try {
        await window.unitApi.chat.refreshCodexAccount();
      } catch {
        // The main process stores Codex account errors in chat state; keep retrying until ready.
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [chatState?.codexAccount.status]);

  useEffect(() => {
    return () => {
      for (const timerId of copiedCodeBlockTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      copiedCodeBlockTimersRef.current.clear();
    };
  }, []);

  const selectedThread = chatState?.threads.find((thread) => thread.id === chatState.selectedThreadId) ?? null;
  const selectedMessages = chatState
    ? chatState.messages.filter((message) => message.threadId === chatState.selectedThreadId)
    : [];
  const activeRuntimeSettings = selectedThread?.runtimeSettings ?? chatState?.runtimeSettings;
  const activeBuiltinModelId = selectedThread?.providerMode === "builtin" && selectedThread.builtinAgenticFramework === "opencode"
    ? selectedThread.builtinModelId
    : selectedThread?.builtinModelId || chatState?.selectedModelId || "";
  const selectedModel = chatState?.models.find((model) => model.id === activeBuiltinModelId) ?? null;
  const threadUsesCodex = selectedThread?.providerMode === "codex";
  const selectedCodexModel = threadUsesCodex
    ? chatState?.codexModels.find((model) => model.id === selectedThread.codexModelId) ?? chatState?.codexModels.find((model) => model.isDefault) ?? null
    : null;
  const selectedSettingsPreset = selectedThread
    ? chatState?.settingsPresets.find((preset) => preset.id === selectedThread.selectedSettingsPresetId) ?? chatState?.settingsPresets[0] ?? null
    : null;
  const selectedBuiltinFramework = selectedThread?.builtinAgenticFramework ?? selectedSettingsPreset?.builtinAgenticFramework ?? "chat";
  const selectableBuiltinModels = selectedBuiltinFramework === "opencode"
    ? chatState?.models.filter((model) => model.providerId !== "remote") ?? []
    : chatState?.models ?? [];
  const selectableBuiltinModelId = selectableBuiltinModels.some((model) => model.id === activeBuiltinModelId) ? activeBuiltinModelId : "";
  const running = chatState?.generation.status === "running";
  const submitBlockedReason = !selectedThread
    ? "Create a new thread to start."
    : !threadUsesCodex && selectedBuiltinFramework === "opencode" && selectedModel?.providerId === "remote"
      ? "Select a local GGUF model before using OpenCode."
    : !threadUsesCodex && !selectedModel
      ? "Add and select a local GGUF model before sending."
      : "";
  const latestSelectedMessage = selectedMessages.at(-1) ?? null;
  const generationErrorMessage = chatState?.generation.status === "error" ? chatState.generation.error : "";
  const generationErrorBelongsToTranscript = Boolean(
    generationErrorMessage
    && latestSelectedMessage?.role === "assistant"
    && latestSelectedMessage.status === "error"
  );
  const statusMessage = localError ?? (generationErrorBelongsToTranscript ? "" : generationErrorMessage);
  const activeProject = chatState?.projects.find((project) => project.id === chatState.selectedProjectId) ?? null;
  const selectedDocumentIndex = selectedThread
    ? chatState?.documentIndexes.find((index) => index.id === selectedThread.documentIndexId) ?? null
    : null;
  const documentControlsVisible = Boolean(selectedThread && !threadUsesCodex && selectedBuiltinFramework === "document_analysis");
  const fallbackRuntimeSettings = activeRuntimeSettings ?? chatState?.runtimeSettings;
  const reasoningButtonLabel = selectedThread && fallbackRuntimeSettings
    ? (threadUsesCodex ? reasoningLabel(selectedThread.codexReasoningEffort) : runtimeReasoningLabel(fallbackRuntimeSettings))
    : "Medium";
  const permissionButtonLabel = selectedThread && fallbackRuntimeSettings
    ? (threadUsesCodex ? permissionLabel(codexAccessModeForApprovalMode(selectedThread.codexApprovalMode)) : permissionLabel(fallbackRuntimeSettings.permissionMode))
    : "Full access";
  const permissionButtonTone = permissionButtonLabel === "Full access" ? "full-access" : "default-access";
  const PermissionButtonIcon = permissionButtonLabel === "Full access" ? LockOpen : ShieldCheck;
  const settingsPresetButtonLabel = selectedThread ? selectedSettingsPreset?.label ?? "Custom" : "Default";
  const settingsPresetButtonIconName = selectedSettingsPreset?.iconName ?? "";
  const settingsPresetButtonProviderMode = selectedSettingsPreset?.providerMode ?? selectedThread?.providerMode ?? "builtin";
  const documentButtonLabel = selectedDocumentIndex?.title ?? "Documents";
  const documentStatusLabel = selectedDocumentIndex ? documentIndexStatusLabel(selectedDocumentIndex) : "No document group selected";
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
  const selectedMessageSignature = useMemo(() => selectedMessages.map((message) => [
    message.id,
    message.status,
    message.updatedAt,
    message.content.length,
    message.reasoning?.length ?? 0,
    message.timelineBlocks?.map((block) => [
      block.kind,
      "id" in block ? block.id : "",
      "status" in block ? block.status ?? "" : "",
      "level" in block ? block.level ?? "" : "",
      "summary" in block ? block.summary ?? "" : "",
      "command" in block ? block.command ?? "" : "",
      "output" in block ? block.output?.length ?? 0 : "",
      "text" in block ? block.text?.length ?? 0 : "",
      "message" in block ? block.message?.length ?? 0 : "",
      "details" in block ? block.details?.length ?? 0 : "",
      "preview" in block ? block.preview?.length ?? 0 : ""
    ].join("~")).join(",") ?? ""
  ].join(":")).join("|"), [selectedMessages]);
  const chatLayoutStyle = {
    "--chat-content-width": `${chatLayout.contentWidth}px`,
    "--chat-composer-inset": `${chatLayout.composerInset}px`
  } as CSSProperties;

  const runChatAction = useCallback(async (action: () => Promise<ChatState>, options?: { closeMenu?: boolean }) => {
    setLocalError(null);
    if (options?.closeMenu !== false) {
      setChatMenu(null);
    }
    try {
      const nextState = await action();
      setChatState(nextState);
      return nextState;
    } catch (error: unknown) {
      setLocalError(errorMessage(error));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!chatMenu) {
      return;
    }
    const closeOpenChatMenu = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".chat-dropup")) {
        return;
      }
      setChatMenu(null);
    };
    document.addEventListener("pointerdown", closeOpenChatMenu, true);
    return () => document.removeEventListener("pointerdown", closeOpenChatMenu, true);
  }, [chatMenu]);

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
    menu: ChatMenuTarget,
    placement: ChatMenuAnchor["placement"] = "above"
  ) => {
    event.stopPropagation();
    const surface = surfaceRef.current;
    const targetRect = event.currentTarget.getBoundingClientRect();
    const surfaceRect = surface?.getBoundingClientRect();
    if (!surfaceRect) {
      return;
    }
    const menuWidth = menu.kind === "thread" ? 192 : 270;
    const targetLeft = targetRect.left - surfaceRect.left;
    const targetRight = targetRect.right - surfaceRect.left;
    const alignedLeft = targetRight + menuWidth > surfaceRect.width - 8 ? targetRight - menuWidth : targetLeft;
    const left = Math.min(Math.max(8, alignedLeft), Math.max(8, surfaceRect.width - menuWidth - 8));
    const top = (placement === "above" ? targetRect.top : targetRect.bottom) - surfaceRect.top;
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

  const handleChatSurfaceClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".chat-code-copy-button");
    if (!button || !event.currentTarget.contains(button)) {
      return;
    }
    const figure = button.closest<HTMLElement>(".chat-code-figure");
    const code = figure?.querySelector<HTMLElement>(".chat-code-block code");
    const text = code?.textContent ?? "";
    if (!text) {
      return;
    }
    const codeBlockId = button.dataset.codeBlockId;
    if (!codeBlockId) {
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      const existingTimer = copiedCodeBlockTimersRef.current.get(codeBlockId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
      setCopiedCodeBlockIds((current) => {
        const next = new Set(current);
        next.add(codeBlockId);
        return next;
      });
      const timerId = window.setTimeout(() => {
        copiedCodeBlockTimersRef.current.delete(codeBlockId);
        setCopiedCodeBlockIds((current) => {
          if (!current.has(codeBlockId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(codeBlockId);
          return next;
        });
      }, 2200);
      copiedCodeBlockTimersRef.current.set(codeBlockId, timerId);
    });
  }, []);

  const computeBaseManualEndSlackHeight = useCallback(() => {
    const scrollHost = threadScrollRef.current;
    const clientHeight = scrollHost?.clientHeight ?? 0;
    const viewportReserve = Math.max(120, Math.min(320, Math.round(clientHeight * 0.24)));
    return chatLayout.composerInset + viewportReserve;
  }, [chatLayout.composerInset]);

  const readThreadScrollMetrics = useCallback(() => {
    const scrollHost = threadScrollRef.current;
    if (!scrollHost) {
      return null;
    }
    const spacer = manualEndSpacerRef.current;
    const scrollTop = scrollHost.scrollTop;
    const scrollHeight = scrollHost.scrollHeight;
    const clientHeight = scrollHost.clientHeight;
    const composerHeight = Math.max(0, Math.ceil(composerSectionRef.current?.getBoundingClientRect().height ?? 0));
    const effectiveClientHeight = Math.max(1, clientHeight - composerHeight);
    let contentScrollHeight = scrollHeight;
    if (spacer) {
      const hostRect = scrollHost.getBoundingClientRect();
      const spacerRect = spacer.getBoundingClientRect();
      const spacerTop = scrollTop + spacerRect.top - hostRect.top;
      const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(scrollHost).paddingBottom) || 0));
      contentScrollHeight = Math.min(scrollHeight, Math.max(0, spacerTop + hostPaddingBottom));
    }
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      effectiveClientHeight,
      viewportBottomOcclusion: composerHeight,
      contentScrollHeight,
      contentOverflowScroll: contentScrollHeight - clientHeight,
      maxScroll: Math.max(0, scrollHeight - clientHeight),
      contentMaxScroll: Math.max(0, contentScrollHeight - effectiveClientHeight)
    };
  }, []);

  const applyManualEndSlackHeight = useCallback((nextHeight: number) => {
    const normalizedHeight = Math.max(0, Math.round(nextHeight || 0));
    manualEndSlackRef.current = normalizedHeight;
    if (manualEndSpacerRef.current) {
      manualEndSpacerRef.current.style.height = `${normalizedHeight}px`;
    }
    setManualEndSlack((current) => current === normalizedHeight ? current : normalizedHeight);
    return normalizedHeight;
  }, []);

  const ensureManualEndSlackForScrollTop = useCallback((targetScrollTop: number, extraBuffer = 24) => {
    const metrics = readThreadScrollMetrics();
    const baseHeight = computeBaseManualEndSlackHeight();
    if (!metrics) {
      return applyManualEndSlackHeight(baseHeight);
    }
    const requiredHeight = Math.max(
      baseHeight,
      Math.ceil(Math.max(0, Number(targetScrollTop) - Number(metrics.contentOverflowScroll || 0)) + Math.max(0, extraBuffer))
    );
    return applyManualEndSlackHeight(requiredHeight);
  }, [applyManualEndSlackHeight, computeBaseManualEndSlackHeight, readThreadScrollMetrics]);

  const syncManualEndSlackHeight = useCallback(() => {
    const metrics = readThreadScrollMetrics();
    const baseHeight = computeBaseManualEndSlackHeight();
    if (!metrics) {
      return applyManualEndSlackHeight(baseHeight);
    }
    const tailReserve = metrics.scrollTop >= metrics.maxScroll - 2 && metrics.scrollTop >= metrics.contentMaxScroll - 6
      ? Math.max(560, Math.round(metrics.clientHeight * 1.2))
      : 24;
    const overscrollReserve = Math.max(0, Math.ceil(metrics.scrollTop - Number(metrics.contentOverflowScroll || 0)) + tailReserve);
    return applyManualEndSlackHeight(Math.max(baseHeight, overscrollReserve));
  }, [applyManualEndSlackHeight, computeBaseManualEndSlackHeight, readThreadScrollMetrics]);

  const classifyThreadBottomState = useCallback((metrics: NonNullable<ReturnType<typeof readThreadScrollMetrics>>) => {
    const bottomDistance = metrics.contentMaxScroll - metrics.scrollTop;
    const atContentBottom = Math.abs(bottomDistance) <= 8;
    const aboveContentBottom = bottomDistance > 8;
    const overscrolledPastContentBottom = bottomDistance < -8;
    return {
      atContentBottom,
      overscrolledPastContentBottom,
      overscrollAnchor: metrics.scrollTop,
      showBottomButton: aboveContentBottom,
      shouldFollowBottom: atContentBottom
    };
  }, []);

  const syncThreadFollowState = useCallback(() => {
    const metrics = readThreadScrollMetrics();
    if (!metrics) {
      shouldFollowThreadBottomRef.current = true;
      setThreadAtBottom((current) => current ? current : true);
      return;
    }
    const bottomState = classifyThreadBottomState(metrics);
    const nextThreadAtBottom = !bottomState.showBottomButton;
    if (threadBottomFollowActiveRef.current) {
      if (bottomState.atContentBottom) {
        threadBottomFollowActiveRef.current = false;
      } else {
        shouldFollowThreadBottomRef.current = true;
        setThreadAtBottom((current) => current ? current : true);
        syncManualEndSlackHeight();
        return;
      }
    }
    shouldFollowThreadBottomRef.current = bottomState.shouldFollowBottom;
    threadOverscrollAnchorRef.current = bottomState.overscrolledPastContentBottom ? bottomState.overscrollAnchor : null;
    setThreadAtBottom((current) => current === nextThreadAtBottom ? current : nextThreadAtBottom);
    syncManualEndSlackHeight();
  }, [classifyThreadBottomState, readThreadScrollMetrics, syncManualEndSlackHeight]);

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollHost = threadScrollRef.current;
    if (!scrollHost) {
      return;
    }
    const metrics = readThreadScrollMetrics();
    const targetTop = metrics ? metrics.contentMaxScroll : Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
    if (behavior === "smooth") {
      scrollHost.scrollTo({ top: targetTop, behavior });
    } else {
      scrollHost.scrollTop = targetTop;
    }
    shouldFollowThreadBottomRef.current = true;
    setThreadAtBottom((current) => current ? current : true);
  }, [readThreadScrollMetrics]);

  const resumeThreadTailFollow = useCallback(() => {
    threadBottomFollowActiveRef.current = true;
    shouldFollowThreadBottomRef.current = true;
    setThreadAtBottom((current) => current ? current : true);
    scrollThreadToBottom("smooth");
  }, [scrollThreadToBottom]);

  const updateThreadScrollbar = useCallback(() => {
    const scrollHost = threadScrollRef.current;
    const track = threadScrollbarTrackRef.current;
    if (!scrollHost || !track) {
      setThreadScrollbar((current) => current.scrollable ? { scrollable: false, thumbTop: 0, thumbHeight: 42 } : current);
      return;
    }
    const metrics = readThreadScrollMetrics();
    const scrollMax = Math.max(0, metrics?.contentMaxScroll ?? scrollHost.scrollHeight - scrollHost.clientHeight);
    const trackHeight = Math.max(0, track.clientHeight);
    const scrollable = scrollMax > 1 && trackHeight > 0;
    if (!scrollable) {
      setThreadScrollbar((current) => current.scrollable ? { scrollable: false, thumbTop: 0, thumbHeight: 42 } : current);
      return;
    }
    const pageSize = Math.max(1, metrics?.effectiveClientHeight ?? scrollHost.clientHeight);
    const thumbHeight = Math.max(42, Math.min(trackHeight, Math.round((pageSize / (scrollMax + pageSize)) * trackHeight)));
    const thumbTravel = Math.max(0, trackHeight - thumbHeight);
    const displayScrollTop = Math.min(Math.max(0, scrollHost.scrollTop), scrollMax);
    const thumbTop = thumbTravel <= 0 ? 0 : Math.round((displayScrollTop / scrollMax) * thumbTravel);
    setThreadScrollbar((current) => (
      current.scrollable === scrollable &&
      current.thumbTop === thumbTop &&
      current.thumbHeight === thumbHeight
        ? current
        : { scrollable, thumbTop, thumbHeight }
    ));
  }, [readThreadScrollMetrics]);

  const handleThreadWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      threadBottomFollowActiveRef.current = false;
    }
    if (event.deltaY <= 0) {
      return;
    }
    const metrics = readThreadScrollMetrics();
    if (!metrics) {
      return;
    }
    if (metrics.scrollTop >= metrics.contentMaxScroll - 6 || metrics.scrollTop >= metrics.maxScroll - 6) {
      ensureManualEndSlackForScrollTop(metrics.scrollTop + event.deltaY + 32);
    }
  }, [ensureManualEndSlackForScrollTop, readThreadScrollMetrics]);

  useLayoutEffect(() => {
    const main = chatMainRef.current;
    const composerSection = composerSectionRef.current;
    if (!main || !composerSection) {
      return;
    }
    const updateChatLayout = () => {
      const mainWidth = Math.max(0, Math.floor(main.getBoundingClientRect().width));
      const compact = mainWidth < 720;
      const sideDockReserve = compact ? 0 : 100;
      const contentWidth = Math.max(0, Math.min(864, mainWidth - sideDockReserve - 36));
      const composerInset = Math.max(128, Math.ceil(composerSection.getBoundingClientRect().height) + 22);
      setChatLayout((current) => (
        current.compact === compact &&
        current.contentWidth === contentWidth &&
        current.composerInset === composerInset
          ? current
          : { compact, contentWidth, composerInset }
      ));
    };
    updateChatLayout();
    const resizeObserver = new ResizeObserver(updateChatLayout);
    resizeObserver.observe(main);
    resizeObserver.observe(composerSection);
    return () => resizeObserver.disconnect();
  }, [chatState, draft, pendingAttachments.length, attachmentStatus]);

  useLayoutEffect(() => {
    shouldFollowThreadBottomRef.current = true;
    requestAnimationFrame(() => scrollThreadToBottom());
  }, [selectedThread?.id, scrollThreadToBottom]);

  useLayoutEffect(() => {
    if (!shouldFollowThreadBottomRef.current) {
      const metrics = readThreadScrollMetrics();
      const bottomState = metrics ? classifyThreadBottomState(metrics) : null;
      const overscrollAnchor = threadOverscrollAnchorRef.current;
      if (metrics && overscrollAnchor !== null && metrics.contentMaxScroll < overscrollAnchor - 8) {
        ensureManualEndSlackForScrollTop(overscrollAnchor);
        threadScrollRef.current!.scrollTop = overscrollAnchor;
        return;
      }
      if (bottomState?.atContentBottom || (metrics && overscrollAnchor !== null && metrics.contentMaxScroll >= overscrollAnchor - 8)) {
        shouldFollowThreadBottomRef.current = true;
        threadOverscrollAnchorRef.current = null;
        scrollThreadToBottom();
        return;
      }
      return;
    }
    threadOverscrollAnchorRef.current = null;
    scrollThreadToBottom();
    const frameId = requestAnimationFrame(() => scrollThreadToBottom());
    return () => cancelAnimationFrame(frameId);
  }, [classifyThreadBottomState, ensureManualEndSlackForScrollTop, readThreadScrollMetrics, selectedMessageSignature, chatLayout.composerInset, scrollThreadToBottom]);

  useLayoutEffect(() => {
    const scrollHost = threadScrollRef.current;
    if (!scrollHost) {
      return;
    }
    updateThreadScrollbar();
    const resizeObserver = new ResizeObserver(updateThreadScrollbar);
    resizeObserver.observe(scrollHost);
    if (threadContentRef.current) {
      resizeObserver.observe(threadContentRef.current);
    }
    if (manualEndSpacerRef.current) {
      resizeObserver.observe(manualEndSpacerRef.current);
    }
    scrollHost.addEventListener("scroll", updateThreadScrollbar, { passive: true });
    return () => {
      resizeObserver.disconnect();
      scrollHost.removeEventListener("scroll", updateThreadScrollbar);
    };
  }, [chatLayout.composerInset, selectedMessageSignature, updateThreadScrollbar]);

  useLayoutEffect(() => {
    syncManualEndSlackHeight();
  }, [chatLayout.composerInset, selectedMessageSignature, syncManualEndSlackHeight]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = threadScrollbarDragRef.current;
      const scrollHost = threadScrollRef.current;
      const track = threadScrollbarTrackRef.current;
      if (!drag || !scrollHost || !track || event.pointerId !== drag.pointerId) {
        return;
      }
      const scrollMax = Math.max(0, readThreadScrollMetrics()?.contentMaxScroll ?? scrollHost.scrollHeight - scrollHost.clientHeight);
      const thumbTravel = Math.max(1, track.clientHeight - threadScrollbar.thumbHeight);
      scrollHost.scrollTop = Math.min(scrollMax, Math.max(0, drag.startScrollTop + ((event.clientY - drag.startY) / thumbTravel) * scrollMax));
      updateThreadScrollbar();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (threadScrollbarDragRef.current?.pointerId === event.pointerId) {
        threadScrollbarDragRef.current = null;
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [readThreadScrollMetrics, threadScrollbar.thumbHeight, updateThreadScrollbar]);

  const beginThreadScrollbarDrag = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const scrollHost = threadScrollRef.current;
    if (!scrollHost || !threadScrollbar.scrollable) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    threadBottomFollowActiveRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    threadScrollbarDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollHost.scrollTop
    };
  }, [threadScrollbar.scrollable]);

  const jumpThreadScrollbar = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const scrollHost = threadScrollRef.current;
    const track = threadScrollbarTrackRef.current;
    if (!scrollHost || !track || !threadScrollbar.scrollable || event.target !== event.currentTarget) {
      return;
    }
    threadBottomFollowActiveRef.current = false;
    const rect = track.getBoundingClientRect();
    const thumbTravel = Math.max(1, track.clientHeight - threadScrollbar.thumbHeight);
    const targetTop = Math.min(Math.max(0, event.clientY - rect.top - threadScrollbar.thumbHeight / 2), thumbTravel);
    const scrollMax = Math.max(0, readThreadScrollMetrics()?.contentMaxScroll ?? scrollHost.scrollHeight - scrollHost.clientHeight);
    scrollHost.scrollTop = (targetTop / thumbTravel) * scrollMax;
    updateThreadScrollbar();
  }, [readThreadScrollMetrics, threadScrollbar.scrollable, threadScrollbar.thumbHeight, updateThreadScrollbar]);

  const updateSidebarScrollable = useCallback(() => {
    const scrollHost = projectScrollRef.current;
    const nextScrollable = scrollHost ? scrollHost.scrollHeight > scrollHost.clientHeight + 1 : false;
    setSidebarScrollable((current) => current === nextScrollable ? current : nextScrollable);
  }, []);

  useLayoutEffect(() => {
    updateSidebarScrollable();
    const scrollHost = projectScrollRef.current;
    if (!scrollHost) {
      return;
    }
    const resizeObserver = new ResizeObserver(updateSidebarScrollable);
    resizeObserver.observe(scrollHost);
    Array.from(scrollHost.children).forEach((child) => resizeObserver.observe(child));
    scrollHost.addEventListener("transitionend", updateSidebarScrollable);
    return () => {
      resizeObserver.disconnect();
      scrollHost.removeEventListener("transitionend", updateSidebarScrollable);
    };
  }, [chatState, expandedProjectIds, updateSidebarScrollable]);

  if (!chatState) {
    return <div className="chat-surface chat-loading" data-testid="chat-surface" />;
  }

  const usageIndicatorPreferences = chatState.appSettings.usageIndicatorPreferences;
  const renderUsageIndicator = (indicatorId: string) => {
    if (indicatorId === "git_diff") {
      return (
        <div className={["chat-git-diff-indicator", gitState?.status === "ready" ? "" : "inactive"].join(" ")} aria-label="Git diff" key="git_diff">
          <span className="added">+{gitState?.status === "ready" ? gitState.addedLines : 0}</span>
          <span className="deleted">-{gitState?.status === "ready" ? gitState.deletedLines : 0}</span>
        </div>
      );
    }
    return null;
  };
  const usageItems = (["git_diff"] as const)
    .map((id) => ({ id, preference: usageIndicatorPreferences?.[id] }))
    .filter((item): item is { id: "git_diff"; preference: NonNullable<typeof usageIndicatorPreferences>["git_diff"] } => Boolean(item.preference))
    .filter((item) => item.preference.placement !== "hidden")
    .sort((left, right) => left.preference.order - right.preference.order);
  const leftUsageIndicators = usageItems.filter((item) => item.preference.placement === "left").map((item) => renderUsageIndicator(item.id)).filter(Boolean);
  const rightUsageIndicators = usageItems.filter((item) => item.preference.placement === "right").map((item) => renderUsageIndicator(item.id)).filter(Boolean);
  const composerUsageIndicators = usageItems.filter((item) => item.preference.placement === "bottom").map((item) => renderUsageIndicator(item.id)).filter(Boolean);
  const footerRightUsageIndicators = usageItems.filter((item) => item.preference.placement === "footer_right").map((item) => renderUsageIndicator(item.id)).filter(Boolean);
  const contextPercent = contextUsagePercent(chatState, (activeRuntimeSettings ?? chatState.runtimeSettings).nCtx);

  return (
    <div
      className={["chat-surface", chatLayout.compact ? "chat-surface-compact" : ""].join(" ")}
      data-testid="chat-surface"
      ref={surfaceRef}
      onClick={handleChatSurfaceClick}
      onPointerDown={() => setChatMenu(null)}
    >
      <aside className="chat-list" aria-label="Chat projects and threads">
        <button
          className="chat-new-thread-button"
          type="button"
          aria-label="New chat thread"
          onClick={() => void runChatAction(() => window.unitApi.chat.createThread())}
        >
          <span className="chat-sidebar-leading-icon" data-testid="chat-new-thread-icon">
            <Plus size={16} />
          </span>
          <span data-testid="chat-new-thread-label">New thread</span>
        </button>
        <div className="chat-list-section-title">
          <span data-testid="chat-section-threads-label">Threads</span>
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
        <div className="chat-project-scroll-shell">
          <div className="chat-project-scroll" ref={projectScrollRef}>
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
                    <span className="chat-sidebar-leading-icon" data-testid={`chat-project-caret-${project.id}`}>
                      <ChevronRight className={expanded ? "expanded" : ""} size={16} />
                    </span>
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
                            chatState.generation.status === "running" && chatState.generation.threadId === thread.id ? "loading" : ""
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
                              onPointerDown={(event) => {
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
                                void runChatAction(() => window.unitApi.chat.deleteThread({ threadId: thread.id }));
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
          <div className={["chat-overlay-scrollbar chat-overlay-scrollbar-sidebar", sidebarScrollable ? "scrollable" : ""].join(" ")} aria-hidden="true"><span /></div>
        </div>
        <ChatSidebarLimitBars state={chatState} />
        <button className="chat-settings-button" type="button" onClick={() => setChatDialog({ kind: "app-settings" })}>
          <span className="chat-sidebar-leading-icon" data-testid="chat-settings-icon">
            <Settings size={16} />
          </span>
          <span data-testid="chat-settings-label">Settings</span>
        </button>
      </aside>
      <section className="chat-main" ref={chatMainRef} style={chatLayoutStyle}>
        <header className="chat-toolbar">
          <div className="chat-title">
            <strong>{activeProject?.title ?? "Project"}</strong>
          </div>
          <div className="chat-action-strip">
            {activeProject ? chatState.appSettings.actionButtons.map((action) => (
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
            )) : null}
            <button
              className="chat-action-manager chat-action-add-button"
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
              <span className="chat-action-add-divider" aria-hidden="true" />
              <span className="chat-action-add-label">Add action</span>
            </button>
          </div>
        </header>
        <div className="chat-top-fade" aria-hidden="true" />
        <div className="chat-thread" data-testid="chat-message-list" ref={threadScrollRef} onScroll={syncThreadFollowState} onWheel={handleThreadWheel}>
          <div className="chat-content-column" ref={threadContentRef}>
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
                  autoExpandDisclosures={chatState.appSettings.autoExpandCodexDisclosures}
                  copiedCodeBlockIds={copiedCodeBlockIds}
                  message={message}
                  onTimelineAction={async (blockId, action, answer) => {
                    await runChatAction(() => window.unitApi.chat.timelineAction({ messageId: message.id, blockId, action, answer }));
                  }}
                />
              ))
            )}
            <div
              className="chat-manual-end-spacer"
              ref={manualEndSpacerRef}
              aria-hidden="true"
              style={{ height: `${manualEndSlack}px` }}
            />
          </div>
        </div>
        <div
          className={["chat-overlay-scrollbar chat-overlay-scrollbar-thread", threadScrollbar.scrollable ? "scrollable" : ""].join(" ")}
          ref={threadScrollbarTrackRef}
          aria-hidden="true"
          onPointerDown={jumpThreadScrollbar}
        >
          <span
            style={{ height: `${threadScrollbar.thumbHeight}px`, transform: `translateY(${threadScrollbar.thumbTop}px)` }}
            onPointerDown={beginThreadScrollbarDrag}
          />
        </div>
        <button
          className={["chat-scroll-bottom-button", !threadAtBottom && selectedMessages.length > 0 ? "visible" : ""].join(" ")}
          type="button"
          aria-label="Scroll to latest message"
          onClick={resumeThreadTailFollow}
        >
          <ArrowDown size={16} />
        </button>
        <div className="chat-composer-section" ref={composerSectionRef}>
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
              <button
                className="chat-settings-menu-button"
                type="button"
                aria-label="Model settings"
                onPointerDown={(event) => openChatMenu(event, { kind: "settings" })}
              >
                <SettingsPresetIcon iconName={settingsPresetButtonIconName} providerMode={settingsPresetButtonProviderMode} size={15} />
                <span>{settingsPresetButtonLabel}</span>
                <ChevronRight className="chat-model-caret" size={12} />
              </button>
              {documentControlsVisible ? (
                <button className="chat-document-menu composer-document-button" type="button" aria-label="Document groups" title={documentStatusLabel} onPointerDown={(event) => openChatMenu(event, { kind: "document" })}>
                  <FileText size={13} />
                  <span className="chat-document-menu-label">{documentButtonLabel}</span>
                  <DocumentIndexStatusMark index={selectedDocumentIndex} />
                  <ChevronRight className="chat-model-caret" size={12} />
                </button>
              ) : null}
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
                value={selectableBuiltinModelId}
                onChange={(event) => void runChatAction(() => window.unitApi.chat.selectModel({ modelId: event.currentTarget.value }))}
              >
                <option value="" disabled>
                  No model
                </option>
                {selectableBuiltinModels.map((model) => (
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
                <span>{reasoningButtonLabel}</span>
                <ChevronRight className="chat-model-caret" size={12} />
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
            <div className="chat-footer-left-cluster">
              <button
                className={["chat-footer-slot chat-footer-button", `permission-${permissionButtonTone}`].join(" ")}
                type="button"
                onPointerDown={(event) => openChatMenu(event, { kind: "permissions" })}
              >
                <PermissionButtonIcon size={13} />
                <span>{permissionButtonLabel}</span>
                <ChevronRight className="chat-model-caret" size={12} />
              </button>
              <button
                className="chat-footer-slot chat-footer-button"
                type="button"
                onPointerDown={(event) => openChatMenu(event, { kind: "branch" })}
              >
                <GitBranch size={13} />
                <span>{branchButtonLabel}</span>
                <ChevronRight className="chat-model-caret" size={12} />
              </button>
            </div>
            <div className="chat-footer-usage-indicators">{composerUsageIndicators}</div>
            <div className="chat-footer-right-cluster">
              {footerRightUsageIndicators}
              <span className="chat-context-tile-label">Context:</span>
              <ChatContextTileBar usedPercent={contextPercent} nCtx={(activeRuntimeSettings ?? chatState.runtimeSettings).nCtx} />
            </div>
          </div>
        </div>
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
    </div>
  );
}

function ChatSidebarLimitBars({ state }: { state: ChatState }) {
  const windows = codexLimitWindows(state);
  return (
    <div className="chat-sidebar-limit-bars" aria-label="Codex limits">
      {windows.map((window) => (
        <ChatSidebarLimitBar
          key={window.id}
          label={`${window.label}:`}
          percent={window.leftPercent}
          title={rateLimitTitle(window)}
        />
      ))}
    </div>
  );
}

function ChatSidebarLimitBar({ label, percent, title }: { label: string; percent: number | null; title: string }) {
  const fillPercent = percent ?? 0;
  const fillStyle: CSSProperties = {
    width: `${fillPercent}%`,
    backgroundSize: fillPercent > 0 ? `${10000 / fillPercent}% 100%` : "100% 100%"
  };
  return (
    <div className="chat-sidebar-limit-row" title={title} aria-label={title || label}>
      <span className="chat-sidebar-limit-label">{label}</span>
      <span className="chat-sidebar-limit-track" aria-hidden="true">
        <span className="chat-sidebar-limit-fill" style={fillStyle} />
      </span>
    </div>
  );
}

function ChatContextTileBar({ usedPercent, nCtx }: { usedPercent: number; nCtx: number }) {
  const stripCount = 20;
  const leftPercent = Math.max(0, 100 - usedPercent);
  const label = `${leftPercent}% context left (${usedPercent}% used of ${formatContextLabel(nCtx)})`;
  return (
    <div className="chat-context-tile-bar" title={label} aria-label={label}>
      {Array.from({ length: stripCount }, (_, index) => {
        const stripStartPercent = (index / stripCount) * 100;
        const stripPercent = Math.max(0, Math.min(100, ((usedPercent - stripStartPercent) / (100 / stripCount)) * 100));
        const stripStyle = { "--chat-context-strip-fill": `${stripPercent}%` } as CSSProperties;
        return <span key={index} style={stripStyle} />;
      })}
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
  onRun: (action: () => Promise<ChatState>, options?: { closeMenu?: boolean }) => Promise<ChatState | null>;
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
  const activeBuiltinModelId = activeThread?.providerMode === "builtin" && activeThread.builtinAgenticFramework === "opencode"
    ? activeThread.builtinModelId
    : activeThread?.builtinModelId || chatState.selectedModelId;
  const activeBuiltinFramework = activeThread?.builtinAgenticFramework ?? "chat";
  const activeBuiltinModels = activeBuiltinFramework === "opencode"
    ? chatState.models.filter((model) => model.providerId !== "remote")
    : chatState.models;
  const activePermissionMode = activeRuntimeSettings.permissionMode;
  const activeAccessMode = activeUsesCodex && activeThread ? codexAccessModeForApprovalMode(activeThread.codexApprovalMode) : activePermissionMode;
  const activeReasoningEffort = activeUsesCodex ? activeThread?.codexReasoningEffort : activeRuntimeSettings.reasoningEffort;
  const selectedThread = menu.kind === "thread" ? chatState.threads.find((thread) => thread.id === menu.threadId) : null;
  const projectDocumentIndexes = chatState.documentIndexes.filter((index) => index.projectId === activeThread?.projectId);
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
            {activeBuiltinModels.length === 0 ? <div className="chat-dropup-empty">{activeBuiltinFramework === "opencode" ? "No local models available" : "No models available"}</div> : null}
            {activeBuiltinModels.map((model) => (
              <button
                className={model.id === activeBuiltinModelId ? "selected" : ""}
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={model.id === activeBuiltinModelId}
                onClick={() => void onRun(() => window.unitApi.chat.selectModel({ modelId: model.id }))}
              >
                <Bot size={14} />
                <span>{model.label}  [{model.providerId === "remote" ? "Remote" : "Local GGUF"}]</span>
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
                {preset.editable || preset.deletable ? (
                  <span className="chat-dropup-action-controls">
                    {preset.editable ? (
                      <button
                        className="chat-dropup-inline-action"
                        type="button"
                        aria-label={`Edit ${preset.label}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
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
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onRun(() => window.unitApi.chat.deleteSettingsPreset({ presetId: preset.id }), { closeMenu: false });
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    ) : null}
                  </span>
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
        CHAT_PERMISSION_OPTIONS.map((option) => {
          const Icon = option.id === "full_access" ? LockOpen : ShieldCheck;
          return (
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
              <Icon size={14} />
              <span>{option.label}</span>
            </button>
          );
        })
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
          <div className="chat-dropup-section-label">Document Groups</div>
          {projectDocumentIndexes.length === 0 ? <div className="chat-dropup-empty">No document groups</div> : null}
          {projectDocumentIndexes.map((index) => {
            const localEditableIndex = chatState.appSettings.documentIndexLocation === "local" && !index.id.startsWith("remote-doc::");
            const statusLabel = documentIndexStatusLabel(index);
            const progressPercent = documentIndexProgressPercent(index);
            return (
              <div className="chat-dropup-action-row" key={index.id}>
                <button
                  className={index.id === activeThread?.documentIndexId ? "selected" : ""}
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
                  <span className="chat-document-index-menu-copy">
                    <span className="chat-document-index-menu-title">
                      <span>{index.title}</span>
                      <DocumentIndexStatusMark index={index} />
                    </span>
                    {index.state === "ready" ? null : <span className="chat-document-index-menu-status">{statusLabel}</span>}
                    {index.state === "building" ? (
                      <span className="chat-document-index-menu-progress" aria-hidden="true">
                        <span style={{ width: `${progressPercent}%` }} />
                      </span>
                    ) : null}
                  </span>
                </button>
                <span className="chat-dropup-action-controls">
                  {localEditableIndex ? (
                    <button
                      className="chat-dropup-inline-action"
                      type="button"
                      aria-label={`Edit ${index.title}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onClose();
                        onDialog({ kind: "document-index", projectId: index.projectId, documentIndexId: index.id });
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                  ) : null}
                  <button
                    className="chat-dropup-inline-action danger"
                    type="button"
                    aria-label={`Delete ${index.title}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onRun(() => window.unitApi.chat.deleteDocumentIndex({ documentIndexId: index.id }), { closeMenu: false });
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            );
          })}
          {activeThread?.documentIndexId ? (
            <button type="button" role="menuitem" onClick={() => void onRun(() => window.unitApi.chat.selectDocumentIndex({ threadId: activeThread.id, documentIndexId: "" }))}>
              <X size={14} />
              <span>Clear selected group</span>
            </button>
          ) : null}
          <div className="chat-dropup-divider" />
          <button type="button" role="menuitem" onClick={() => {
            onClose();
            if (activeProjectId) {
              onDialog({ kind: "document-index", projectId: activeProjectId });
            }
          }}>
            <Plus size={14} />
            <span>New group...</span>
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
              void onRun(() => window.unitApi.chat.deleteThread({ threadId: selectedThread.id }));
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
  onRun: (action: () => Promise<ChatState>) => Promise<ChatState | null>;
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
  const [presetIconName, setPresetIconName] = useState<string>(() => initialSettingsPresetIconName(dialog, state));
  const [presetBuiltinFramework, setPresetBuiltinFramework] = useState<ChatBuiltinAgenticFramework>(() => initialSettingsPresetBuiltinFramework(dialog, state));
  const [presetEmbeddingModelPath, setPresetEmbeddingModelPath] = useState(() => initialSettingsPresetEmbeddingModelPath(dialog, state));
  const [documentIndexPaths, setDocumentIndexPaths] = useState<string[]>(() => initialDocumentIndexPaths(dialog, state));
  const dialogKey = chatDialogKey(dialog);

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
    setDocumentIndexPaths(initialDocumentIndexPaths(dialog, state));
  }, [dialogKey]);

  useEffect(() => {
    if (presetBuiltinFramework !== "opencode") {
      return;
    }
    const selectedModel = state.models.find((model) => model.id === threadBuiltinModelId);
    if (selectedModel?.providerId === "remote") {
      setThreadBuiltinModelId("");
    }
  }, [presetBuiltinFramework, state.models, threadBuiltinModelId]);

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
  const applyBuiltinFramework = (value: ChatBuiltinAgenticFramework) => {
    setPresetBuiltinFramework(value);
    if (value !== "opencode") {
      return;
    }
    const selectedModel = state.models.find((model) => model.id === threadBuiltinModelId);
    if (selectedModel?.providerId === "remote") {
      setThreadBuiltinModelId("");
    }
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
              return window.unitApi.chat.updateProjectSettings({ projectId, title, directory });
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
            onTitleChange={setTitle}
            onDirectoryChange={setDirectory}
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
            </section>
            <section className="chat-settings-section">
              <h3>Action Buttons</h3>
              <ProjectActionEditor rows={appSettings.actionButtons} onRowsChange={(actionButtons) => setAppSettings({ ...appSettings, actionButtons })} />
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
                <ChatSettingSelect
                  label="Document Indexing"
                  ariaLabel="Document indexing"
                  value={appSettings.documentIndexLocation}
                  options={[{ value: "local", label: "Local laptop" }, { value: "remote", label: "Remote host" }]}
                  onChange={(value) => setAppSettings({ ...appSettings, documentIndexLocation: value as ChatAppSettings["documentIndexLocation"] })}
                />
                <ChatSettingSelect
                  label="Document Tool Calls"
                  ariaLabel="Document tool calls"
                  value={appSettings.documentToolExecutionLocation}
                  options={[{ value: "local", label: "Local laptop" }, { value: "remote", label: "Remote host" }]}
                  onChange={(value) => setAppSettings({ ...appSettings, documentToolExecutionLocation: value as ChatAppSettings["documentToolExecutionLocation"] })}
                />
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
    const builtinModelsForHarness = presetBuiltinFramework === "opencode"
      ? state.models.filter((model) => model.providerId !== "remote")
      : state.models;
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
              builtinModelId: threadBuiltinModelId,
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
                <ChatSettingSelect
                  label="Icon"
                  value={normalizeSettingsPresetIconName(presetIconName, threadProviderMode)}
                  options={SETTINGS_PRESET_ICON_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    icon: <SettingsPresetIcon iconName={option.value} providerMode={threadProviderMode} size={14} />
                  }))}
                  onChange={setPresetIconName}
                />
              </div>
            </section>
            <section className="chat-settings-section">
              <h3>Provider</h3>
              <ChatSettingSelect
                label="Provider"
                value={threadProviderMode}
                options={[{ value: "builtin", label: "Built-in model" }, { value: "codex", label: "Codex" }]}
                onChange={(value) => setThreadProviderMode(value as ChatProviderMode)}
              />
            </section>
            <section className="chat-settings-section">
              <h3>Harness</h3>
              {threadProviderMode === "codex" ? (
                <label>
                  <span>Harness</span>
                  <input readOnly value="Codex" />
                </label>
              ) : (
                <ChatSettingSelect
                  label="Harness"
                  value={presetBuiltinFramework}
                  options={[
                    { value: "chat", label: "Chat" },
                    { value: "document_analysis", label: "Document analysis" },
                    { value: "opencode", label: "OpenCode" }
                  ]}
                  onChange={(value) => applyBuiltinFramework(value as ChatBuiltinAgenticFramework)}
                />
              )}
            </section>
            {threadProviderMode === "codex" ? (
            <section className="chat-settings-section">
              <h3>Defaults</h3>
              <div className="chat-settings-row">
                <ChatSettingSelect
                  label="Model"
                  value={threadCodexModelId}
                  options={state.codexModels.map((model) => ({ value: model.id, label: model.label }))}
                  onChange={setThreadCodexModelId}
                />
                <ChatSettingSelect
                  label="Reasoning"
                  value={threadCodexReasoningEffort}
                  options={reasoningOptions(state.codexModels.find((model) => model.id === threadCodexModelId)?.reasoningEfforts ?? ["low", "medium", "high"])}
                  onChange={(value) => setThreadCodexReasoningEffort(value as ChatReasoningEffort)}
                />
                <ChatSettingSelect
                  label="Access"
                  value={codexAccessModeForApprovalMode(threadCodexApprovalMode)}
                  options={CHAT_PERMISSION_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
                  onChange={(value) => {
                    const nextAccess = value as ChatPermissionMode;
                    setThreadPermissionMode(nextAccess);
                    setThreadCodexApprovalMode(codexApprovalModeForAccessMode(nextAccess));
                    setSettings({ ...settings, permissionMode: nextAccess });
                  }}
                />
              </div>
            </section>
            ) : (
            <>
            <section className="chat-settings-section">
              <h3>Defaults</h3>
              <ChatSettingSelect
                label="Model"
                value={threadBuiltinModelId}
                options={builtinModelsForHarness.length === 0
                  ? [{ value: "", label: "No local model available", disabled: true }]
                  : builtinModelsForHarness.map((model) => ({ value: model.id, label: `${model.label}  [${model.providerId === "remote" ? "Remote" : "Local GGUF"}]` }))}
                onChange={setThreadBuiltinModelId}
              />
              {presetBuiltinFramework === "document_analysis" ? (
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
              ) : null}
              <div className="chat-settings-row">
                <ChatSettingSelect
                  label="Context Window"
                  value={settings.nCtx}
                  options={contextWindowOptions(false)}
                  onChange={(value) => setSettings({ ...settings, nCtx: value })}
                />
                <ChatSettingSelect
                  label="Reasoning"
                  value={settings.reasoningEffort}
                  options={reasoningOptions(["low", "medium", "high"])}
                  onChange={(value) => setSettings({ ...settings, reasoningEffort: value })}
                />
                <ChatSettingSelect
                  label="Access"
                  value={settings.permissionMode}
                  options={[{ value: "default_permissions", label: "Default" }, { value: "full_access", label: "Full access" }]}
                  onChange={(value) => setSettings({ ...settings, permissionMode: value })}
                />
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
                <label>
                  <span>Max Tokens</span>
                  <input value={settings.maxTokens} onChange={(event) => setSettings({ ...settings, maxTokens: event.currentTarget.value })} />
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
            </section>
            <section className="chat-settings-section">
              <h3>System Prompt</h3>
              <textarea className="chat-settings-prompt" value={settings.systemPrompt} onChange={(event) => setSettings({ ...settings, systemPrompt: event.currentTarget.value })} />
            </section>
            </>
            )}
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
    const editingDocumentIndex = dialog.documentIndexId
      ? state.documentIndexes.find((index) => index.id === dialog.documentIndexId) ?? null
      : null;
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
          aria-label="Document group"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            const sourcePath = documentIndexPaths.join("\n");
            void onRun(() => editingDocumentIndex
              ? window.unitApi.chat.updateDocumentIndex({
                documentIndexId: editingDocumentIndex.id,
                title,
                sourcePath
              })
              : window.unitApi.chat.createDocumentIndex({
                projectId: dialog.projectId,
                title,
                sourcePath
              })).then((nextState) => {
                if (nextState?.generation.status !== "error") {
                  onClose();
                }
              });
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>{editingDocumentIndex ? "Edit Document Group" : "New Document Group"}</strong>
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
              <h3>Documents</h3>
              <div className="chat-document-index-toolbar">
                <button type="button" onClick={() => {
                  void window.unitApi.fileSystem.selectFiles({
                    currentPath: state.projects.find((project) => project.id === dialog.projectId)?.directory,
                    kind: "file",
                    multiple: true
                  }).then((result) => addDocumentPaths(result.paths));
                }}>Add Documents</button>
                <button type="button" disabled={documentIndexPaths.length === 0} onClick={() => setDocumentIndexPaths([])}>Clear</button>
              </div>
              <div className="chat-document-index-file-list">
                {documentIndexPaths.length === 0 ? (
                  <div className="chat-document-index-empty">No documents selected.</div>
                ) : documentIndexPaths.map((path) => (
                  <div className="chat-document-index-file-row" key={path}>
                    <input type="checkbox" aria-label={`${chatFileName(path)} included`} checked readOnly />
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
            <button type="submit" disabled={!title.trim() || documentIndexPaths.length === 0}>{editingDocumentIndex ? "Save" : "Create"}</button>
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
            void onRun(() => window.unitApi.chat.updateProjectSettings({ projectId: dialog.projectId, title, directory })).then(onClose);
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
            onTitleChange={setTitle}
            onDirectoryChange={setDirectory}
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
            void onRun(() => window.unitApi.chat.updateAppSettings({ settings: appSettings })).then(onClose);
          }}
        >
          <header className="chat-settings-header">
            <div>
              <strong>Action Buttons</strong>
              <span>Global</span>
            </div>
            <button type="button" aria-label="Close action buttons" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <div className="chat-settings-body">
            <section className="chat-settings-section">
              <h3>Action Buttons</h3>
              <ProjectActionEditor rows={appSettings.actionButtons} onRowsChange={(actionButtons) => setAppSettings({ ...appSettings, actionButtons })} />
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
    const builtinModelsForHarness = presetBuiltinFramework === "opencode"
      ? state.models.filter((model) => model.providerId !== "remote")
      : state.models;
    const workspaceHint = threadProviderMode === "codex"
      ? "Codex will run commands in this directory. Confirm it is the intended workspace before starting agent work."
      : presetBuiltinFramework === "opencode"
        ? "OpenCode shell tools will run in this directory."
        : "Local model requests use this project directory for project context.";
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
              <ChatSettingSelect
                label="Provider"
                ariaLabel="Thread provider"
                value={threadProviderMode}
                options={[{ value: "builtin", label: "Built-in model" }, { value: "codex", label: "Codex" }]}
                onChange={(value) => setThreadProviderMode(value as ChatProviderMode)}
              />
            </section>
            {threadProviderMode === "codex" ? (
            <>
            <section className="chat-settings-section">
              <h3>Harness</h3>
              <label>
                <span>Harness</span>
                <input readOnly value="Codex" />
              </label>
            </section>
            <section className="chat-settings-section">
              <h3>Defaults</h3>
              <div className="chat-settings-row">
                <ChatSettingSelect
                  label="Model"
                  ariaLabel="Thread Codex model"
                  value={threadCodexModelId}
                  options={state.codexModels.map((model) => ({ value: model.id, label: `${model.label}  [${model.isDefault ? "Default" : "Codex"}]` }))}
                  onChange={setThreadCodexModelId}
                />
                <ChatSettingSelect
                  label="Reasoning"
                  ariaLabel="Thread Codex reasoning"
                  value={threadCodexReasoningEffort}
                  options={reasoningOptions(state.codexModels.find((model) => model.id === threadCodexModelId)?.reasoningEfforts ?? ["low", "medium", "high"])}
                  onChange={(value) => setThreadCodexReasoningEffort(value as ChatReasoningEffort)}
                />
              </div>
              <div className="chat-settings-row">
                <label>
                  <span>Connected Account</span>
                  <input readOnly value={state.codexAccount.status === "ready" ? state.codexAccount.email : state.codexAccount.status === "error" ? state.codexAccount.error : "Not connected"} />
                </label>
              </div>
              <div className="chat-settings-row">
                <ChatSettingSelect
                  label="Access"
                  ariaLabel="Thread Codex access"
                  value={codexAccessModeForApprovalMode(threadCodexApprovalMode)}
                  options={CHAT_PERMISSION_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
                  onChange={(value) => {
                    const nextAccess = value as ChatPermissionMode;
                    setThreadPermissionMode(nextAccess);
                    setThreadCodexApprovalMode(codexApprovalModeForAccessMode(nextAccess));
                  }}
                />
                <label className="chat-settings-check">
                  <input type="checkbox" checked={threadPlanModeEnabled} onChange={(event) => setThreadPlanModeEnabled(event.currentTarget.checked)} />
                  <span>Plan mode</span>
                </label>
              </div>
            </section>
            </>
            ) : (
            <>
            <section className="chat-settings-section">
              <h3>Harness</h3>
              <ChatSettingSelect
                label="Harness"
                ariaLabel="Thread harness"
                value={presetBuiltinFramework}
                options={[
                  { value: "chat", label: "Chat" },
                  { value: "document_analysis", label: "Document analysis" },
                  { value: "opencode", label: "OpenCode" }
                ]}
                onChange={(value) => applyBuiltinFramework(value as ChatBuiltinAgenticFramework)}
              />
              {presetBuiltinFramework === "document_analysis" ? (
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
              ) : null}
            </section>
            <section className="chat-settings-section">
              <h3>Defaults</h3>
              <ChatSettingSelect
                label="Model"
                ariaLabel="Thread built-in model"
                value={threadBuiltinModelId}
                options={builtinModelsForHarness.length === 0
                  ? [{ value: "", label: "No built-in model available", disabled: true }]
                  : builtinModelsForHarness.map((model) => ({ value: model.id, label: `${model.label}  [${model.providerId === "remote" ? "Remote" : "Local GGUF"}]` }))}
                onChange={setThreadBuiltinModelId}
              />
              <div className="chat-settings-row">
                <ChatSettingSelect
                  label="Context Window"
                  ariaLabel="Thread context window"
                  value={settings.nCtx}
                  options={contextWindowOptions(true)}
                  onChange={(value) => setSettings({ ...settings, nCtx: value })}
                />
                <ChatSettingSelect
                  label="GPU Layers"
                  ariaLabel="Thread GPU layers"
                  value={settings.nGpuLayers}
                  options={[
                    { value: "-1", label: "Auto" },
                    { value: "0", label: "CPU only" },
                    { value: "20", label: "20 layers" },
                    { value: "40", label: "40 layers" },
                    { value: "80", label: "80 layers" }
                  ]}
                  onChange={(value) => setSettings({ ...settings, nGpuLayers: value })}
                />
              </div>
              <div className="chat-settings-row">
                <ChatSettingSelect
                  label="Reasoning"
                  ariaLabel="Thread reasoning"
                  value={settings.reasoningEffort}
                  options={reasoningOptions(["low", "medium", "high"])}
                  onChange={(value) => setSettings({ ...settings, reasoningEffort: value })}
                />
                <ChatSettingSelect
                  label="Access"
                  ariaLabel="Thread permissions"
                  value={settings.permissionMode}
                  options={[{ value: "default_permissions", label: "Default" }, { value: "full_access", label: "Full access" }]}
                  onChange={(value) => setSettings({ ...settings, permissionMode: value })}
                />
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
                <label>
                  <span>Max Tokens</span>
                  <input value={settings.maxTokens} onChange={(event) => setSettings({ ...settings, maxTokens: event.currentTarget.value })} />
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
            </section>
            <section className="chat-settings-section">
              <h3>System Prompt</h3>
              <textarea className="chat-settings-prompt" value={settings.systemPrompt} onChange={(event) => setSettings({ ...settings, systemPrompt: event.currentTarget.value })} />
            </section>
            </>
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
              <p className="chat-settings-hint">{workspaceHint}</p>
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
          } else {
            void onRun(() => window.unitApi.chat.deleteProject({ projectId: dialog.projectId })).then(onClose);
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

function chatDialogKey(dialog: ChatDialogState) {
  if (!dialog) {
    return "closed";
  }
  if ("projectId" in dialog && typeof dialog.projectId === "string") {
    return `${dialog.kind}:${dialog.projectId}`;
  }
  if ("threadId" in dialog && typeof dialog.threadId === "string") {
    return `${dialog.kind}:${dialog.threadId}`;
  }
  if ("presetId" in dialog && typeof dialog.presetId === "string") {
    return `${dialog.kind}:${dialog.presetId}`;
  }
  if ("documentIndexId" in dialog && typeof dialog.documentIndexId === "string") {
    return `${dialog.kind}:${dialog.documentIndexId}`;
  }
  return dialog.kind;
}

function initialChatDialogTitle(dialog: ChatDialogState, state: ChatState) {
  if (!dialog) {
    return "";
  }
  if (dialog.kind === "new-project") {
    return "New Project";
  }
  if (dialog.kind === "rename-project" || dialog.kind === "rename-thread" || dialog.kind === "delete-project") {
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
  if (dialog.kind === "document-index") {
    return dialog.documentIndexId
      ? state.documentIndexes.find((index) => index.id === dialog.documentIndexId)?.title ?? ""
      : "Untitled documents";
  }
  return "";
}

function ProjectSettingsFields({
  title,
  directory,
  onTitleChange,
  onDirectoryChange
}: {
  title: string;
  directory: string;
  onTitleChange: (title: string) => void;
  onDirectoryChange: (directory: string) => void;
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

function initialDocumentIndexPaths(dialog: ChatDialogState, state: ChatState): string[] {
  if (dialog?.kind !== "document-index" || !dialog.documentIndexId) {
    return [];
  }
  const index = state.documentIndexes.find((candidate) => candidate.id === dialog.documentIndexId);
  return index?.sourcePath.split(/\r?\n/g).map((item) => item.trim()).filter(Boolean) ?? [];
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
  const providerMode = initialThreadProviderMode(dialog, state);
  const builtinFramework = initialSettingsPresetBuiltinFramework(dialog, state);
  if (dialog?.kind === "thread-settings") {
    const explicitModelId = state.threads.find((thread) => thread.id === dialog.threadId)?.builtinModelId ?? "";
    if (providerMode === "builtin" && builtinFramework === "opencode") {
      const explicitModel = state.models.find((model) => model.id === explicitModelId);
      return explicitModel && explicitModel.providerId !== "remote" ? explicitModelId : "";
    }
    return explicitModelId || state.selectedModelId || state.models[0]?.id || "";
  }
  if (dialog?.kind === "settings-preset" && dialog.presetId) {
    const explicitModelId = state.settingsPresets.find((preset) => preset.id === dialog.presetId)?.builtinModelId ?? "";
    if (providerMode === "builtin" && builtinFramework === "opencode") {
      const explicitModel = state.models.find((model) => model.id === explicitModelId);
      return explicitModel && explicitModel.providerId !== "remote" ? explicitModelId : "";
    }
    return explicitModelId || state.selectedModelId || state.models[0]?.id || "";
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
  if (dialog?.kind === "settings-preset" && dialog.presetId) {
    const preset = state.settingsPresets.find((candidate) => candidate.id === dialog.presetId);
    return normalizeSettingsPresetIconName(preset?.iconName ?? "", preset?.providerMode ?? "builtin");
  }
  const selectedThread = state.threads.find((thread) => thread.id === state.selectedThreadId);
  return selectedThread?.providerMode === "codex" ? "openai" : "sliders";
}

function initialSettingsPresetBuiltinFramework(dialog: ChatDialogState, state: ChatState): ChatBuiltinAgenticFramework {
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

type ChatTimelineActionHandler = (blockId: string, action: "approve" | "deny" | "answer" | "retry" | "retry_new_thread", answer?: string) => Promise<void>;

function preserveClosestChatScroll(origin: HTMLElement, mutate: () => void) {
  const scrollHost = origin.closest(".chat-thread") as HTMLElement | null;
  if (!scrollHost) {
    mutate();
    return;
  }
  const readOverscrollMetrics = () => {
    const spacer = scrollHost.querySelector<HTMLElement>(".chat-manual-end-spacer");
    const composer = scrollHost.parentElement?.querySelector<HTMLElement>(".chat-composer-section") ?? document.querySelector<HTMLElement>(".chat-composer-section");
    if (!spacer || !composer) {
      return null;
    }
    const hostRect = scrollHost.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const composerHeight = Math.max(0, Math.ceil(composer.getBoundingClientRect().height));
    const effectiveClientHeight = Math.max(1, scrollHost.clientHeight - composerHeight);
    const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(scrollHost).paddingBottom) || 0));
    const spacerTop = scrollHost.scrollTop + spacerRect.top - hostRect.top;
    const contentScrollHeight = Math.min(scrollHost.scrollHeight, Math.max(0, spacerTop + hostPaddingBottom));
    return {
      spacer,
      contentOverflowScroll: contentScrollHeight - scrollHost.clientHeight,
      contentMaxScroll: Math.max(0, contentScrollHeight - effectiveClientHeight)
    };
  };
  const overscrollMetrics = readOverscrollMetrics();
  const beforeScrollTop = scrollHost.scrollTop;
  const shouldHoldOverscroll = Boolean(overscrollMetrics && beforeScrollTop > overscrollMetrics.contentMaxScroll + 2);
  if (shouldHoldOverscroll && overscrollMetrics) {
    const currentSpacerHeight = Math.max(0, Math.round(parseFloat(overscrollMetrics.spacer.style.height || "") || overscrollMetrics.spacer.getBoundingClientRect().height || 0));
    const requiredSpacerHeight = Math.max(
      currentSpacerHeight,
      Math.ceil(Math.max(0, beforeScrollTop - overscrollMetrics.contentOverflowScroll) + 48)
    );
    overscrollMetrics.spacer.style.height = `${requiredSpacerHeight}px`;
  }
  if (shouldHoldOverscroll) {
    mutate();
    requestAnimationFrame(() => {
      const nextMetrics = readOverscrollMetrics();
      if (nextMetrics) {
        const currentSpacerHeight = Math.max(0, Math.round(parseFloat(nextMetrics.spacer.style.height || "") || nextMetrics.spacer.getBoundingClientRect().height || 0));
        const requiredSpacerHeight = Math.max(
          currentSpacerHeight,
          Math.ceil(Math.max(0, beforeScrollTop - nextMetrics.contentOverflowScroll) + 48)
        );
        nextMetrics.spacer.style.height = `${requiredSpacerHeight}px`;
      }
      scrollHost.scrollTop = beforeScrollTop;
    });
    return;
  }
  const hostRect = scrollHost.getBoundingClientRect();
  const anchorSelector = ".chat-message, .reasoning-shell, .codex-event-card, .chat-message-body";
  const pointAnchor = document
    .elementFromPoint(hostRect.left + Math.min(32, Math.max(1, hostRect.width - 1)), hostRect.top + Math.min(32, Math.max(1, hostRect.height - 1)))
    ?.closest<HTMLElement>(anchorSelector);
  const candidates = Array.from(scrollHost.querySelectorAll<HTMLElement>(anchorSelector));
  const anchor = pointAnchor && scrollHost.contains(pointAnchor) ? pointAnchor : candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.top >= hostRect.top + 1 && rect.top < hostRect.bottom - 1;
  }) ?? candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > hostRect.top + 1 && rect.top < hostRect.bottom - 1;
  }) ?? origin;
  const anchorTop = anchor.getBoundingClientRect().top;
  mutate();
  requestAnimationFrame(() => {
    if (!anchor.isConnected) {
      return;
    }
    scrollHost.scrollTop = beforeScrollTop + (anchor.getBoundingClientRect().top - anchorTop);
  });
}

function ChatMessageBubble({
  message,
  autoExpandDisclosures,
  copiedCodeBlockIds,
  onTimelineAction
}: {
  message: ChatMessage;
  autoExpandDisclosures: boolean;
  copiedCodeBlockIds: ReadonlySet<string>;
  onTimelineAction: ChatTimelineActionHandler;
}) {
  const displayContent = message.content;
  const html = message.role === "user" ? renderChatUserPromptHtml(displayContent, message.attachments) : renderChatMarkdownHtml(displayContent, message.id, copiedCodeBlockIds);
  const timelineReasoning = message.role === "assistant" ? chatTimelineReasoningText(message.timelineBlocks) : "";
  const standaloneReasoning = message.role === "assistant" && message.reasoning
    ? remainingAssistantReasoning(message.reasoning, timelineReasoning)
    : "";
  const standaloneReasoningStatus = message.status === "streaming" && !displayContent.trim() ? message.status : "complete";
  const codexTimelineOwnsAssistantContent = message.role === "assistant" && message.timelineBlocks?.some((block) => block.kind === "assistant_message");
  const shouldRenderMessageBody = message.role === "user" || (!codexTimelineOwnsAssistantContent && Boolean(html));
  const hasVisibleAssistantContent = Boolean(message.timelineBlocks?.length || standaloneReasoning || shouldRenderMessageBody);
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
      {message.role === "assistant" && message.timelineBlocks?.length ? (
        <ChatTimeline
          blocks={message.timelineBlocks}
          messageId={message.id}
          autoExpandDisclosures={autoExpandDisclosures}
          copiedCodeBlockIds={copiedCodeBlockIds}
          onTimelineAction={onTimelineAction}
        />
      ) : null}
      {message.role === "assistant" && standaloneReasoning ? (
        <ChatReasoningDisclosure
          disclosureId={`${message.id}-reasoning`}
          status={standaloneReasoningStatus}
          reasoning={standaloneReasoning}
          initiallyExpanded={reasoningInitialExpansion(message)}
          autoExpandDisclosures={autoExpandDisclosures}
          copiedCodeBlockIds={copiedCodeBlockIds}
        />
      ) : null}
      {shouldRenderMessageBody ? (
        <div
          className={[
            "chat-message-body",
            message.role === "user" ? "chat-message-bubble chat-message-bubble-user" : "chat-formatted-view assistant-content-block"
          ].join(" ")}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : null}
      {message.status === "interrupted" ? <small>Interrupted</small> : message.status === "error" && !hasVisibleAssistantContent ? <small>Error</small> : null}
    </article>
  );
}

function chatTimelineReasoningText(blocks?: ChatTimelineBlock[]) {
  return (blocks ?? [])
    .filter((block): block is Extract<ChatTimelineBlock, { kind: "reasoning" }> => block.kind === "reasoning")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function remainingAssistantReasoning(assistantReasoning: string, timelineReasoning: string) {
  const normalizedAssistant = assistantReasoning.trim();
  const normalizedTimeline = timelineReasoning.trim();
  if (!normalizedAssistant || !normalizedTimeline) {
    return assistantReasoning;
  }
  if (normalizedAssistant === normalizedTimeline) {
    return "";
  }
  const compactAssistant = normalizedAssistant.replace(/\s+/g, " ");
  const compactTimeline = normalizedTimeline.replace(/\s+/g, " ");
  if (compactAssistant === compactTimeline) {
    return "";
  }
  const tightAssistant = normalizedAssistant.replace(/\s+/g, "");
  const tightTimeline = normalizedTimeline.replace(/\s+/g, "");
  if (tightAssistant === tightTimeline) {
    return "";
  }
  if (!normalizedAssistant.startsWith(normalizedTimeline)) {
    return assistantReasoning;
  }
  return normalizedAssistant.slice(normalizedTimeline.length).trimStart();
}

function reasoningInitialExpansion(message: ChatMessage) {
  const metadataValue = message.metadata?.reasoningInitiallyExpanded;
  return typeof metadataValue === "boolean" ? metadataValue : true;
}

function ChatReasoningDisclosure({
  disclosureId,
  status,
  reasoning,
  initiallyExpanded,
  autoExpandDisclosures,
  copiedCodeBlockIds
}: {
  disclosureId: string;
  status: ChatMessage["status"] | string;
  reasoning: string;
  initiallyExpanded?: boolean;
  autoExpandDisclosures: boolean;
  copiedCodeBlockIds: ReadonlySet<string>;
}) {
  const autoOpen = initiallyExpanded ?? autoExpandDisclosures;
  const [expanded, setExpanded] = useState(autoOpen);
  const [panelShouldFollow, setPanelShouldFollow] = useState(true);
  const disclosureIdRef = useRef(disclosureId);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const reasoningHtml = renderChatMarkdownHtml(reasoning, disclosureId, copiedCodeBlockIds);

  useEffect(() => {
    if (disclosureIdRef.current !== disclosureId) {
      disclosureIdRef.current = disclosureId;
      setExpanded(autoOpen);
      setPanelShouldFollow(true);
    }
  }, [autoOpen, disclosureId]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !expanded || !panelShouldFollow) {
      return;
    }
    panel.scrollTop = panel.scrollHeight;
  }, [expanded, panelShouldFollow, reasoning.length]);

  const toggleExpanded = useCallback((event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const details = detailsRef.current;
    if (!details) {
      setExpanded((current) => !current);
      return;
    }
    preserveClosestChatScroll(details, () => setExpanded((current) => !current));
  }, []);

  return (
    <details
      ref={detailsRef}
      className="reasoning-shell assistant-turn-reasoning-shell mathjax_ignore"
      data-collapsed={expanded ? "0" : "1"}
      data-streaming={status === "streaming" || status === "started" || status === "updated" ? "1" : "0"}
      open={expanded}
    >
      <summary className="reasoning-toggle" aria-expanded={expanded} onClick={toggleExpanded}>
        <span className="reasoning-toggle-label">
          <Brain className="reasoning-toggle-icon" size={16} />
          <span className="reasoning-toggle-text-group">
            <span className="reasoning-toggle-text">Reasoning</span>
            <span className="reasoning-toggle-ellipsis" aria-hidden="true">
              <span className="assistant-turn-status-dots">
                <span className="assistant-turn-status-dot">.</span>
                <span className="assistant-turn-status-dot">.</span>
                <span className="assistant-turn-status-dot">.</span>
              </span>
            </span>
          </span>
        </span>
        <ChevronDown className="reasoning-toggle-caret" size={14} />
      </summary>
      <div
        className="reasoning-panel mathjax_ignore"
        ref={panelRef}
        onScroll={(event) => {
          const panel = event.currentTarget;
          setPanelShouldFollow(panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 8);
        }}
      >
        <div className="reasoning-content reasoning-content-stream" dangerouslySetInnerHTML={{ __html: reasoningHtml }} />
      </div>
    </details>
  );
}

function ChatTimeline({
  blocks,
  messageId,
  autoExpandDisclosures,
  copiedCodeBlockIds,
  onTimelineAction
}: {
  blocks: ChatTimelineBlock[];
  messageId: string;
  autoExpandDisclosures: boolean;
  copiedCodeBlockIds: ReadonlySet<string>;
  onTimelineAction: ChatTimelineActionHandler;
}) {
  return (
    <div className="codex-event-stack" aria-label="Assistant timeline">
      {blocks.map((block, index) => (
        <ChatTimelineBlockView
          block={block}
          key={`${messageId}-${block.kind}-${block.id || index}`}
          autoExpandDisclosures={autoExpandDisclosures}
          copiedCodeBlockIds={copiedCodeBlockIds}
          onTimelineAction={onTimelineAction}
        />
      ))}
    </div>
  );
}

function ChatDisclosure({
  blockKey,
  className,
  title,
  status,
  initiallyExpanded,
  autoExpandDisclosures,
  outerCard = true,
  summaryStatus = true,
  children
}: {
  blockKey: string;
  className: string;
  title: ReactNode;
  status?: string;
  initiallyExpanded?: boolean;
  autoExpandDisclosures: boolean;
  outerCard?: boolean;
  summaryStatus?: boolean;
  children: ReactNode;
}) {
  const shouldOpen = initiallyExpanded ?? autoExpandDisclosures;
  const [expanded, setExpanded] = useState(shouldOpen);
  const blockKeyRef = useRef(blockKey);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    if (blockKeyRef.current !== blockKey) {
      blockKeyRef.current = blockKey;
      setExpanded(shouldOpen);
      return;
    }
  }, [blockKey, shouldOpen]);

  const toggleExpanded = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const details = detailsRef.current;
    if (!details) {
      setExpanded((current) => !current);
      return;
    }
    preserveClosestChatScroll(details, () => setExpanded((current) => !current));
  }, []);

  return (
    <details
      ref={detailsRef}
      className={[
        outerCard ? "codex-event-card" : "reasoning-shell",
        "codex-event-disclosure",
        "codex-tool-shell",
        className
      ].join(" ")}
      data-collapsed={expanded ? "0" : "1"}
      data-summary-status={summaryStatus ? "1" : "0"}
      open={expanded}
    >
      <summary className="reasoning-toggle codex-tool-shell-toggle" onClick={toggleExpanded}>
        <span className="reasoning-toggle-label codex-tool-shell-label">
          <CodexToolShellIcon className="codex-tool-shell-icon" size={16} />
          <span className="reasoning-toggle-text-group">{title}</span>
        </span>
        {summaryStatus ? <span className="codex-event-badge" data-status={status}>{formatTimelineStatus(status ?? "")}</span> : null}
        <svg className="reasoning-toggle-caret codex-tool-shell-caret" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className={["codex-event-disclosure-body-shell", outerCard ? "" : "codex-tool-shell-panel"].filter(Boolean).join(" ")}>
        <div className="codex-event-disclosure-body codex-tool-shell-panel-inner">
          {children}
        </div>
      </div>
    </details>
  );
}

function ChatNestedDisclosure({
  blockKey,
  title,
  children
}: {
  blockKey: string;
  title: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockKeyRef = useRef(blockKey);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    if (blockKeyRef.current !== blockKey) {
      blockKeyRef.current = blockKey;
      setExpanded(false);
    }
  }, [blockKey]);

  const toggleExpanded = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const details = detailsRef.current;
    if (!details) {
      setExpanded((current) => !current);
      return;
    }
    preserveClosestChatScroll(details, () => setExpanded((current) => !current));
  }, []);

  return (
    <details
      ref={detailsRef}
      className="codex-event-disclosure"
      data-collapsed={expanded ? "0" : "1"}
      open={expanded}
    >
      <summary className="codex-event-disclosure-toggle" onClick={toggleExpanded}>
        <span className="codex-event-disclosure-label">{title}</span>
        <svg className="codex-event-disclosure-caret" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="codex-event-disclosure-body-shell">
        <div className="codex-event-disclosure-body">
          {children}
        </div>
      </div>
    </details>
  );
}

function ChatTimelineBlockView({
  block,
  autoExpandDisclosures,
  copiedCodeBlockIds,
  onTimelineAction
}: {
  block: ChatTimelineBlock;
  autoExpandDisclosures: boolean;
  copiedCodeBlockIds: ReadonlySet<string>;
  onTimelineAction: ChatTimelineActionHandler;
}) {
  const [answer, setAnswer] = useState("");
  if (block.kind === "assistant_message") {
    const html = renderChatMarkdownHtml(block.text, block.id, copiedCodeBlockIds);
    return html ? (
      <div
        className="chat-message-body chat-formatted-view assistant-content-block codex-assistant-message-block"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    ) : null;
  }
  if (block.kind === "reasoning") {
    return block.text.trim() ? (
      <section className="codex-reasoning-block">
        <ChatReasoningDisclosure
          disclosureId={block.id}
          status={block.status}
          reasoning={block.text}
          initiallyExpanded={block.initiallyExpanded ?? true}
          autoExpandDisclosures={autoExpandDisclosures}
          copiedCodeBlockIds={copiedCodeBlockIds}
        />
      </section>
    ) : null;
  }
  if (block.kind === "tool") {
    const normalizedToolName = block.toolName.trim().toLowerCase();
    const formattedToolName = formatTimelineTitle(block.toolName || "Tool Call");
    const isFailedTool = block.status.trim().toLowerCase() === "failed";
    const isSearchTool = normalizedToolName === "search" || normalizedToolName === "web_search";
    const isCommandTool = normalizedToolName === "command" || normalizedToolName === "command_execution";
    const titlePrefix = isSearchTool
      ? "Search"
      : isCommandTool
        ? "Command"
        : "";
    const rawBodyTitle = block.command || block.summary || formattedToolName;
    const bodyTitle = isCommandTool ? extractShellWrappedCommand(rawBodyTitle) : rawBodyTitle;
    const bodySubtitle = !isSearchTool && !isCommandTool ? formattedToolName : "";
    const showCommandMeta = Boolean(block.command && block.command !== bodyTitle && !isSearchTool && !isCommandTool);
    return (
      <ChatDisclosure
        blockKey={block.id}
        className="codex-tool-card"
        title={<span className="reasoning-toggle-text">{isFailedTool ? "Failed Tool Call" : "Tool Call"}</span>}
        status={block.status}
        initiallyExpanded={block.initiallyExpanded}
        autoExpandDisclosures={autoExpandDisclosures}
        outerCard={false}
        summaryStatus={false}
      >
        <section className="codex-event-card" data-kind="tool">
          <div className="codex-event-header">
            <div className="codex-event-title-group">
              <div className="codex-event-title">
                {titlePrefix ? <span className="codex-event-title-prefix">{titlePrefix}: </span> : null}
                <span className="codex-event-title-text">{bodyTitle}</span>
              </div>
              {bodySubtitle ? <div className="codex-event-subtitle">{bodySubtitle}</div> : null}
            </div>
            <div className="codex-event-badges">
              <span className="codex-event-badge" data-status={block.status}>{formatTimelineStatus(block.status)}</span>
            </div>
          </div>
          {showCommandMeta || block.directory ? (
            <div className="codex-event-meta">
              {showCommandMeta ? <span className="codex-event-meta-line">Command: {block.command}</span> : null}
              {block.directory ? <span className="codex-event-meta-line">Directory: {block.directory}</span> : null}
            </div>
          ) : null}
          {block.output ? (
            <ChatNestedDisclosure blockKey={`${block.id}:output`} title="Output">
              <pre className="codex-event-pre">{block.output}</pre>
            </ChatNestedDisclosure>
          ) : null}
        </section>
      </ChatDisclosure>
    );
  }
  if (block.kind === "diff") {
    return (
      <ChatDisclosure
        blockKey={block.id}
        className="codex-diff-card codex-diff-shell"
        title={(
          <span className="codex-event-title codex-diff-header-inline">
            <span>{block.summary}</span>
            <span className="codex-diff-counts codex-diff-counts-compact">
              <span className="codex-diff-count codex-diff-count-added">+{block.addedLines ?? 0}</span>
              <span className="codex-diff-count codex-diff-count-deleted">-{block.deletedLines ?? 0}</span>
            </span>
          </span>
        )}
        status={block.status ?? "completed"}
        initiallyExpanded={block.initiallyExpanded}
        autoExpandDisclosures={autoExpandDisclosures}
      >
        {block.branchName ? <div className="codex-event-meta">Branch: {block.branchName}</div> : null}
        {block.preview ? <pre className="codex-event-pre codex-diff-preview">{block.preview}</pre> : null}
      </ChatDisclosure>
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
  const level = "level" in block ? block.level : undefined;
  return (
    <div className="codex-event-card codex-status-card" data-kind={block.kind} data-level={level}>
      <div className="codex-event-card-header">
        <span className="codex-event-title">{title}</span>
        <span className="codex-event-badge" data-status={status} data-level={level}>{formatTimelineStatus(level ?? status)}</span>
      </div>
      <div className="codex-event-text">{message}</div>
      {"code" in block && block.code ? <pre className="codex-event-pre">{block.code}</pre> : null}
      {"details" in block && block.details ? (
        <ChatNestedDisclosure blockKey={`${block.id}:details`} title="Details">
          <pre className="codex-event-pre">{block.details}</pre>
        </ChatNestedDisclosure>
      ) : null}
      {block.kind === "status" && block.level === "error" && block.code === "codex_turn_failed" ? (
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

function documentIndexProgressPercent(index: ChatDocumentIndex) {
  if (index.state === "building") {
    const countMatch = index.message.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    const completed = countMatch ? Number(countMatch[1]) : NaN;
    const total = countMatch ? Number(countMatch[2]) : NaN;
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
      return Math.round(Math.min(1, Math.max(0, completed / total)) * 100);
    }
  }
  return Math.round(Math.min(1, Math.max(0, index.progress)) * 100);
}

function documentIndexStatusLabel(index: ChatDocumentIndex) {
  if (index.state === "ready") {
    return "Ready";
  }
  if (index.state === "building") {
    return `${index.message || "Indexing"} ${documentIndexProgressPercent(index)}%`;
  }
  return index.message || formatTimelineStatus(index.state);
}

function DocumentIndexStatusMark({ index }: { index: ChatDocumentIndex | null }) {
  if (!index) {
    return null;
  }
  if (index.state === "ready") {
    return (
      <span className="chat-document-status-mark ready" aria-hidden="true">
        <Check size={12} />
      </span>
    );
  }
  if (index.state === "building") {
    return <span className="chat-document-status-mark building" aria-hidden="true" />;
  }
  return <span className="chat-document-status-mark error" aria-hidden="true">!</span>;
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

function SettingsPresetIcon({
  iconName,
  providerMode,
  size = 14,
  className
}: {
  iconName: string;
  providerMode: ChatSettingsPreset["providerMode"];
  size?: number;
  className?: string;
}) {
  const Icon = settingsPresetIcon(iconName, providerMode);
  return <Icon className={className} size={size} />;
}

function normalizeSettingsPresetIconName(iconName: string, providerMode: ChatSettingsPreset["providerMode"]): SettingsPresetIconName {
  const normalized = iconName.trim();
  if (normalized === "code") {
    return "openai";
  }
  if (SETTINGS_PRESET_ICON_OPTIONS.some((option) => option.value === normalized)) {
    return normalized as SettingsPresetIconName;
  }
  return providerMode === "codex" ? "openai" : "sliders";
}

function settingsPresetIcon(iconName: string, providerMode: ChatSettingsPreset["providerMode"]): LucideIcon {
  return SETTINGS_PRESET_ICONS[normalizeSettingsPresetIconName(iconName, providerMode)];
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

function contextUsagePercent(state: ChatState, nCtx: number) {
  const selectedMessages = state.messages.filter((message) => message.threadId === state.selectedThreadId);
  const usedCharacters = selectedMessages.reduce((total, message) => total + message.content.length + (message.reasoning?.length ?? 0), 0);
  const approximateTokens = Math.ceil(usedCharacters / 4);
  return Math.max(0, Math.min(100, Math.round((approximateTokens / Math.max(1, nCtx)) * 1000) / 10));
}

type CodexLimitWindowView = {
  id: "weekly" | "five_hour";
  label: "Weekly" | "5h";
  leftPercent: number | null;
  usedPercent: number | null;
};

function codexLimitWindows(state: ChatState): CodexLimitWindowView[] {
  const windows = state.codexAccount.status === "ready" && state.codexAccount.rateLimits
    ? [state.codexAccount.rateLimits.primary, state.codexAccount.rateLimits.secondary].filter((window): window is NonNullable<typeof window> => Boolean(window))
    : [];
  const weekly = windows.find((window) => window.windowDurationMins === 10080);
  const fiveHour = windows.find((window) => window.windowDurationMins === 300);
  return [
    rateLimitWindowView("weekly", "Weekly", weekly),
    rateLimitWindowView("five_hour", "5h", fiveHour)
  ];
}

function rateLimitWindowView(id: CodexLimitWindowView["id"], label: CodexLimitWindowView["label"], window: ChatCodexRateLimitWindow | undefined): CodexLimitWindowView {
  const usedPercent = rateLimitWindowUsedPercent(window);
  return {
    id,
    label,
    usedPercent,
    leftPercent: usedPercent === null ? null : 100 - usedPercent
  };
}

function rateLimitWindowUsedPercent(window: ChatCodexRateLimitWindow | undefined): number | null {
  return window ? Math.max(0, Math.min(100, Math.round(window.usedPercent))) : null;
}

function rateLimitTitle(window: CodexLimitWindowView) {
  if (window.leftPercent === null || window.usedPercent === null) {
    return `${window.label} limit unavailable`;
  }
  return `${window.label} limit: ${window.leftPercent}% left, ${window.usedPercent}% used`;
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

function renderChatMarkdownHtml(markdown: string, footnoteScope: string, copiedCodeBlockIds?: ReadonlySet<string>) {
  if (!markdown.trim()) {
    return "";
  }
  const { source, replacements } = extractChatMath(markdown);
  let html = chatMarkdown.render(source, { copiedCodeBlockIds, footnoteScope } satisfies ChatMarkdownRenderEnv);
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
