export type AppletKind = "terminal" | "fileViewer" | "browser" | "chat" | "sandbox";

export interface AppletSession {
  id: string;
  kind: AppletKind;
  title: string;
}

export interface AppletInstance {
  id: string;
  sessionId: string;
}

export type WorkspaceLayoutNode = WorkspaceLayoutSplit | WorkspaceLayoutLeaf;

export interface WorkspaceLayoutSplit {
  id: string;
  type: "split";
  direction: "row" | "column";
  ratio: number;
  first: WorkspaceLayoutNode;
  second: WorkspaceLayoutNode;
}

export interface WorkspaceLayoutLeaf {
  id: string;
  type: "leaf";
  appletInstanceId: string;
}

export interface Workspace {
  id: string;
  title: string;
  applets: AppletInstance[];
  layout: WorkspaceLayoutNode | null;
}

export interface WorkspaceTab {
  id: string;
  title: string;
  workspaceId: string;
  pinned: boolean;
  closable: boolean;
}

export interface TabHostState {
  windowId: number;
  tabIds: string[];
  activeTabId: string;
  isPrimary: boolean;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TabDropTarget {
  windowId: number;
  insertionIndex: number;
  screenRect: RectLike;
}

export interface TabHostSnapshot {
  tabIds: string[];
  activeTabId: string;
}

export interface TabDragSession {
  tabId: string;
  sourceWindowId: number;
  originalIndex: number;
  ownerWindowId: number | null;
  touchedHostSnapshots: Record<number, TabHostSnapshot>;
  previousActiveByWindow: Record<number, string>;
  hotSpot: { x: number; y: number };
  currentScreen: { x: number; y: number };
  currentTarget: TabDropTarget | null;
  floating: boolean;
  finishing: boolean;
}

export interface UnitState {
  workspaces: Record<string, Workspace>;
  appletSessions: Record<string, AppletSession>;
  tabs: Record<string, WorkspaceTab>;
  hosts: Record<number, TabHostState>;
  primaryWindowId: number;
  dragSession: TabDragSession | null;
}

export interface BootstrapPayload {
  windowId: number;
  state: UnitState;
}

export interface TabBootstrapPayload {
  windowId: number;
  state: UnitState;
}

export interface RegisterStripBoundsPayload {
  windowId: number;
  bounds: RectLike;
  tabMetrics: Array<{ tabId: string; left: number; width: number }>;
}

export interface BeginTabDragPayload {
  tabId: string;
  sourceWindowId: number;
  screenX: number;
  screenY: number;
  hotSpotX: number;
  hotSpotY: number;
}

export interface BeginTabDragResult {
  captureOwned: boolean;
}

export interface UpdateTabDragPayload {
  screenX: number;
  screenY: number;
}

export interface FinishTabDragPayload {
  screenX: number;
  screenY: number;
}

export interface ActivateTabPayload {
  windowId: number;
  tabId: string;
}

export interface CloseTabPayload {
  windowId: number;
  tabId: string;
}

export interface CreateWorkspacePayload {
  windowId: number;
  title: string;
}

export interface OpenWorkspaceTabPayload {
  windowId: number;
  workspaceId: string;
}

export interface RenameWorkspacePayload {
  workspaceId: string;
  title: string;
}

export interface CreateAppletPayload {
  workspaceId: string;
  kind: AppletKind;
  targetLeafId?: string;
  splitDirection?: "row" | "column";
}

export interface CloseAppletInstancePayload {
  workspaceId: string;
  appletInstanceId: string;
}

export interface UnitApi {
  bootstrap: () => Promise<BootstrapPayload>;
  onStateChanged: (callback: (payload: BootstrapPayload) => void) => () => void;
  onWindowRegistered: (callback: (windowId: number) => void) => () => void;
  tabs: {
    bootstrap: () => Promise<TabBootstrapPayload>;
    activate: (payload: ActivateTabPayload) => Promise<void>;
    beginDrag: (payload: BeginTabDragPayload) => Promise<BeginTabDragResult>;
    updateDrag: (payload: UpdateTabDragPayload) => Promise<void>;
    updateDragFast: (payload: UpdateTabDragPayload) => void;
    finishDrag: (payload: FinishTabDragPayload) => Promise<void>;
    finishDragFast: (payload: FinishTabDragPayload) => void;
    cancelDrag: () => Promise<void>;
    closeTab: (payload: CloseTabPayload) => Promise<void>;
    registerStripBounds: (payload: RegisterStripBoundsPayload) => Promise<void>;
    windowClosing: (windowId: number) => Promise<void>;
  };
  workspaces: {
    createWorkspace: (payload: CreateWorkspacePayload) => Promise<Workspace>;
    openWorkspaceTab: (payload: OpenWorkspaceTabPayload) => Promise<void>;
    renameWorkspace: (payload: RenameWorkspacePayload) => Promise<void>;
  };
  applets: {
    createApplet: (payload: CreateAppletPayload) => Promise<AppletInstance>;
    closeAppletInstance: (payload: CloseAppletInstancePayload) => Promise<void>;
  };
}
