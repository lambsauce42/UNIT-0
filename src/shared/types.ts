export type AppletKind = "terminal" | "wslTerminal" | "fileViewer" | "browser" | "chat" | "sandbox";
export type TerminalAppletKind = Extract<AppletKind, "terminal" | "wslTerminal">;

export interface AppletSession {
  id: string;
  kind: AppletKind;
  title: string;
  state: AppletSessionState;
}

export interface AppletSessionState {
  fileViewer?: FileViewerSessionState;
  browser?: BrowserSessionState;
}

export interface FileViewerSessionState {
  rootPath?: string;
}

export interface BrowserSessionState {
  url?: string;
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
  shelfAppletIds: string[];
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

export interface CloseWorkspacePayload {
  workspaceId: string;
}

export interface UpdateLayoutRatiosPayload {
  workspaceId: string;
  ratios: Record<string, number>;
}

export interface ReplaceWorkspaceLayoutPayload {
  workspaceId: string;
  layout: WorkspaceLayoutNode;
}

export type WorkspaceTemplateId =
  | "grid-2x2"
  | "grid-3x3"
  | "grid-4x4"
  | "left-sidebar-3x3"
  | "right-sidebar-3x3"
  | "top-row-3x3"
  | "bottom-row-3x3";

export type WorkspaceTemplateLayoutNode = WorkspaceTemplateLayoutSplit | WorkspaceTemplateLayoutLeaf;

export interface WorkspaceTemplateLayoutSplit {
  id: string;
  type: "split";
  direction: "row" | "column";
  ratio: number;
  first: WorkspaceTemplateLayoutNode;
  second: WorkspaceTemplateLayoutNode;
}

export interface WorkspaceTemplateLayoutLeaf {
  id: string;
  type: "leaf";
  cellId: string;
}

export interface WorkspaceTemplateCell {
  id: string;
  label: string;
  preferredKind: AppletKind;
  acceptedKinds: AppletKind[];
}

export interface WorkspaceTemplate {
  id: WorkspaceTemplateId;
  name: string;
  description: string;
  cells: WorkspaceTemplateCell[];
  layout: WorkspaceTemplateLayoutNode;
}

export type TemplateCellAssignment =
  | { mode: "reuse"; appletInstanceId: string }
  | { mode: "create"; kind: AppletKind };

export interface ApplyWorkspaceTemplatePayload {
  workspaceId: string;
  templateId: WorkspaceTemplateId;
  assignments: Record<string, TemplateCellAssignment>;
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

export interface ChangeAppletInstanceKindPayload {
  workspaceId: string;
  appletInstanceId: string;
  kind: AppletKind;
}

export interface MoveAppletInstancePayload {
  workspaceId: string;
  appletInstanceId: string;
  targetLeafId?: string;
  splitDirection: "row" | "column";
  placement: "first" | "second";
}

export interface UpdateAppletSessionStatePayload {
  sessionId: string;
  state: AppletSessionState;
}

export interface TerminalStartPayload {
  sessionId: string;
  kind: TerminalAppletKind;
  cols: number;
  rows: number;
}

export interface TerminalStartResult {
  sessionId: string;
  output: string;
}

export interface TerminalInputPayload {
  sessionId: string;
  data: string;
}

export interface TerminalResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface FileTreeEntry {
  id: string;
  name: string;
  kind: "directory" | "file";
  children?: FileTreeEntry[];
  loaded?: boolean;
}

export interface ListDirectoryPayload {
  rootPath: string;
  directoryId: string;
}

export interface ListDirectoryResult {
  rootId: string;
  rootName: string;
  rootPath: string;
  directoryId: string;
  entries: FileTreeEntry[];
}

export interface ReadFilePayload {
  rootPath: string;
  fileId: string;
}

export interface ReadFileResult {
  id: string;
  name: string;
  content: string;
}

export interface WriteFilePayload {
  rootPath: string;
  fileId: string;
  content: string;
}

export interface WriteFileResult {
  id: string;
  name: string;
  content: string;
}

export interface SelectDirectoryPayload {
  currentPath?: string;
}

export interface SelectDirectoryResult {
  rootPath: string | null;
}

export interface BrowserMountPayload {
  windowId: number;
  sessionId: string;
  bounds: RectLike;
  url: string;
}

export interface BrowserBoundsPayload {
  windowId: number;
  sessionId: string;
  bounds: RectLike;
}

export interface BrowserSessionPayload {
  windowId: number;
  sessionId: string;
}

export interface BrowserNavigatePayload extends BrowserSessionPayload {
  url: string;
}

export interface BrowserWindowVisibilityPayload {
  windowId: number;
  visible: boolean;
}

export interface BrowserStatusPayload {
  windowId: number;
  sessionId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error?: string;
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
    closeWorkspace: (payload: CloseWorkspacePayload) => Promise<void>;
    updateLayoutRatios: (payload: UpdateLayoutRatiosPayload) => Promise<void>;
    replaceLayout: (payload: ReplaceWorkspaceLayoutPayload) => Promise<void>;
    applyTemplate: (payload: ApplyWorkspaceTemplatePayload) => Promise<Workspace>;
  };
  applets: {
    createApplet: (payload: CreateAppletPayload) => Promise<AppletInstance>;
    closeAppletInstance: (payload: CloseAppletInstancePayload) => Promise<void>;
    changeAppletInstanceKind: (payload: ChangeAppletInstanceKindPayload) => Promise<void>;
    moveAppletInstance: (payload: MoveAppletInstancePayload) => Promise<void>;
    updateAppletSessionState: (payload: UpdateAppletSessionStatePayload) => Promise<void>;
  };
  terminal: {
    start: (payload: TerminalStartPayload) => Promise<TerminalStartResult>;
    input: (payload: TerminalInputPayload) => void;
    resize: (payload: TerminalResizePayload) => Promise<void>;
    onData: (callback: (payload: TerminalDataPayload) => void) => () => void;
  };
  fileSystem: {
    listDirectory: (payload: ListDirectoryPayload) => Promise<ListDirectoryResult>;
    readFile: (payload: ReadFilePayload) => Promise<ReadFileResult>;
    writeFile: (payload: WriteFilePayload) => Promise<WriteFileResult>;
    selectDirectory: (payload: SelectDirectoryPayload) => Promise<SelectDirectoryResult>;
  };
  browser: {
    mount: (payload: BrowserMountPayload) => Promise<BrowserStatusPayload>;
    updateBounds: (payload: BrowserBoundsPayload) => Promise<void>;
    detach: (payload: BrowserSessionPayload) => Promise<void>;
    navigate: (payload: BrowserNavigatePayload) => Promise<BrowserStatusPayload>;
    goBack: (payload: BrowserSessionPayload) => Promise<BrowserStatusPayload>;
    goForward: (payload: BrowserSessionPayload) => Promise<BrowserStatusPayload>;
    reload: (payload: BrowserSessionPayload) => Promise<BrowserStatusPayload>;
    stop: (payload: BrowserSessionPayload) => Promise<BrowserStatusPayload>;
    setWindowViewsVisible: (payload: BrowserWindowVisibilityPayload) => Promise<void>;
    onStatus: (callback: (payload: BrowserStatusPayload) => void) => () => void;
  };
}
