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

export type ChatMessageRole = "user" | "assistant";
export type ChatMessageStatus = "complete" | "streaming" | "interrupted" | "error";
export type ChatProviderMode = "builtin" | "codex";
export type ChatReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ChatPermissionMode = "default_permissions" | "full_access";
export type ChatCodexApprovalMode = "default" | "on-request" | "on-failure" | "untrusted" | "never";
export type ChatBuiltinAgenticFramework = "chat" | "document_analysis";

export interface ChatActionButton {
  id: string;
  label: string;
  command: string;
  directory: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  kind: "file" | "image";
  dataUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type ChatTimelineBlock =
  | { kind: "tool"; id: string; toolName: string; status: string; summary?: string; command?: string; directory?: string; output?: string }
  | { kind: "approval"; id: string; status: string; title: string; decision?: string; details?: string; requestMethod?: string; toolCallId?: string }
  | { kind: "diff"; id: string; status?: string; summary: string; branchName?: string; preview?: string; addedLines?: number; deletedLines?: number }
  | { kind: "status"; id: string; level: string; message: string; code?: string }
  | { kind: "plan"; id: string; status: string; explanation?: string; markdown?: string; steps?: Array<{ status: string; text: string }> }
  | { kind: "question"; id: string; status: string; title: string; question?: string; questions?: Array<{ id: string; label: string; options?: string[]; allowsCustomAnswer?: boolean }>; answers?: Record<string, string> }
  | { kind: "delegated"; id: string; status: string; summary: string }
  | { kind: "compaction"; id: string; status: string };

export interface ChatProject {
  id: string;
  title: string;
  directory: string;
  actionButtons: ChatActionButton[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  providerMode: ChatProviderMode;
  selectedSettingsPresetId: string;
  builtinModelId: string;
  runtimeSettings: ChatRuntimeSettings;
  builtinAgenticFramework: ChatBuiltinAgenticFramework;
  documentAnalysisEmbeddingModelPath: string;
  codexModelId: string;
  codexReasoningEffort: ChatReasoningEffort;
  permissionMode: ChatPermissionMode;
  codexApprovalMode: ChatCodexApprovalMode;
  planModeEnabled: boolean;
  documentIndexId: string;
  codexLastSessionId: string;
  activeContextStartMessageIndex: number;
  contextRevision: number;
  contextMarkers: ChatContextMarker[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatContextMarker {
  kind: "trim" | "reset";
  boundaryMessageCount: number;
  timestamp: string;
}

export interface ChatDocumentIndex {
  id: string;
  projectId: string;
  title: string;
  sourcePath: string;
  state: "ready" | "building" | "error";
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatMessageRole;
  content: string;
  attachments: ChatAttachment[];
  label?: string;
  sourceLabel?: string;
  reasoning?: string;
  timelineBlocks?: ChatTimelineBlock[];
  metadata?: Record<string, unknown>;
  status: ChatMessageStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChatModel {
  id: string;
  label: string;
  path: string;
  providerId?: "local" | "remote";
  reference?: string;
  sourceLabel?: string;
  hostId?: string;
  createdAt: string;
}

export interface ChatCodexModel {
  id: string;
  label: string;
  isDefault: boolean;
  reasoningEfforts: ChatReasoningEffort[];
  supportsImageInput: boolean;
}

export interface ChatCodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface ChatCodexRateLimits {
  primary: ChatCodexRateLimitWindow | null;
  secondary: ChatCodexRateLimitWindow | null;
  rateLimitReachedType: string | null;
}

export type ChatCodexAccountState =
  | { status: "unknown" }
  | { status: "ready"; authMode: string | null; email: string; planType: string | null; requiresOpenaiAuth: boolean; rateLimits: ChatCodexRateLimits | null }
  | { status: "error"; error: string };

export interface ChatRuntimeSettings {
  nCtx: number;
  nGpuLayers: number;
  temperature: number;
  repeatPenalty: number;
  maxTokens: number;
  reasoningEffort: Exclude<ChatReasoningEffort, "xhigh">;
  permissionMode: ChatPermissionMode;
  trimReserveTokens: number;
  trimReservePercent: number;
  trimAmountTokens: number;
  trimAmountPercent: number;
  systemPrompt: string;
}

export type ChatUsageIndicatorId = "git_diff" | "context" | "week" | "five_hour";
export type ChatUsageIndicatorPlacement = "left" | "right" | "bottom" | "footer_right" | "hidden";
export type ChatUsageIndicatorDisplayMode = "bar" | "circle";

export interface ChatUsageIndicatorPreference {
  displayMode: ChatUsageIndicatorDisplayMode;
  placement: ChatUsageIndicatorPlacement;
  order: number;
}

export interface ChatAppSettings {
  usageIndicatorPlacement: "footer" | "composer";
  usageIndicatorOrder: string[];
  usageIndicatorPreferences: Record<ChatUsageIndicatorId, ChatUsageIndicatorPreference>;
  expandedProjectIds: string[];
  autoExpandCodexDisclosures: boolean;
  documentIndexLocation: "local" | "remote";
  documentToolExecutionLocation: "local" | "remote";
  tokenizerModelPath: string;
  remoteHostAddress: string;
  remoteHostPort: number;
  remotePairingCode: string;
  remoteHostId: string;
  remoteHostIdentity: string;
  remoteProtocolVersion: string;
}

export interface ChatSettingsPreset {
  id: string;
  label: string;
  runtimeSettings: ChatRuntimeSettings;
  providerMode: ChatProviderMode;
  iconName: string;
  builtinModelId: string;
  builtinAgenticFramework: ChatBuiltinAgenticFramework;
  documentAnalysisEmbeddingModelPath: string;
  codexModelId: string;
  codexReasoningEffort: ChatReasoningEffort;
  builtIn: boolean;
  editable: boolean;
  deletable: boolean;
}

export type ChatGenerationState =
  | { status: "idle"; error?: string }
  | { status: "running"; threadId: string; assistantMessageId: string }
  | { status: "error"; error: string };

export interface ChatState {
  projects: ChatProject[];
  threads: ChatThread[];
  messages: ChatMessage[];
  models: ChatModel[];
  codexModels: ChatCodexModel[];
  codexAccount: ChatCodexAccountState;
  settingsPresets: ChatSettingsPreset[];
  documentIndexes: ChatDocumentIndex[];
  selectedProjectId: string;
  selectedThreadId: string;
  selectedModelId: string;
  runtimeSettings: ChatRuntimeSettings;
  appSettings: ChatAppSettings;
  queuedSubmissions: ChatQueuedSubmission[];
  generation: ChatGenerationState;
}

export interface ChatQueuedSubmission {
  id: string;
  threadId: string;
  preview: string;
  attachmentCount: number;
  providerMode: ChatProviderMode;
  inputMode: "queue" | "steer";
  createdAt: string;
}

export interface ChatSubmitPayload {
  text: string;
  attachments?: ChatAttachment[];
  submitMode?: "normal" | "queue";
}

export interface ChatCreateThreadPayload {
  projectId?: string;
}

export interface ChatSelectProjectPayload {
  projectId: string;
}

export interface ChatSelectThreadPayload {
  threadId: string;
}

export interface ChatRenameProjectPayload {
  projectId: string;
  title: string;
}

export interface ChatUpdateProjectSettingsPayload {
  projectId: string;
  title: string;
  directory: string;
  actionButtons?: ChatActionButton[];
}

export interface ChatRenameThreadPayload {
  threadId: string;
  title: string;
}

export interface ChatMoveThreadPayload {
  threadId: string;
  projectId: string;
  targetThreadId?: string;
  position?: "before" | "after";
}

export interface ChatMoveProjectPayload {
  projectId: string;
  targetProjectId: string;
  position: "before" | "after";
}

export interface ChatDeleteProjectPayload {
  projectId: string;
}

export interface ChatDeleteThreadPayload {
  threadId: string;
}

export interface ChatSelectModelPayload {
  modelId: string;
}

export interface ChatAddLocalModelPayload {
  path?: string;
}

export interface ChatUpdateRuntimeSettingsPayload {
  settings: Partial<ChatRuntimeSettings>;
}

export interface ChatUpdateAppSettingsPayload {
  settings: Partial<ChatAppSettings>;
}

export interface ChatUpdateThreadSettingsPayload {
  threadId: string;
  providerMode?: ChatProviderMode;
  selectedSettingsPresetId?: string;
  builtinModelId?: string;
  runtimeSettings?: Partial<ChatRuntimeSettings>;
  builtinAgenticFramework?: ChatBuiltinAgenticFramework;
  documentAnalysisEmbeddingModelPath?: string;
  codexModelId?: string;
  codexReasoningEffort?: ChatReasoningEffort;
  permissionMode?: ChatPermissionMode;
  codexApprovalMode?: ChatCodexApprovalMode;
  planModeEnabled?: boolean;
  documentIndexId?: string;
  codexLastSessionId?: string;
}

export interface ChatApplySettingsPresetPayload {
  threadId: string;
  presetId: string;
}

export interface ChatSaveSettingsPresetPayload {
  presetId?: string;
  label: string;
  runtimeSettings: Partial<ChatRuntimeSettings>;
  providerMode: ChatProviderMode;
  iconName?: string;
  builtinModelId?: string;
  builtinAgenticFramework?: ChatBuiltinAgenticFramework;
  documentAnalysisEmbeddingModelPath?: string;
  codexModelId?: string;
  codexReasoningEffort?: ChatReasoningEffort;
}

export interface ChatDeleteSettingsPresetPayload {
  presetId: string;
}

export interface ChatRefreshCodexAccountPayload {
  force?: boolean;
}

export interface ChatCancelQueuedSubmissionPayload {
  submissionId: string;
}

export interface ChatGitStatePayload {
  projectId: string;
}

export type ChatGitState =
  | { status: "no_directory"; message: string }
  | { status: "no_repo"; message: string }
  | { status: "ready"; currentBranch: string; branches: string[]; dirty: boolean; ahead: number; behind: number; addedLines: number; deletedLines: number; hasCommits: boolean };

export interface ChatSwitchGitBranchPayload {
  projectId: string;
  branch: string;
}

export interface ChatCreateGitBranchPayload {
  projectId: string;
  branch: string;
}

export interface ChatRunProjectActionPayload {
  projectId: string;
  actionId: string;
}

export interface ChatCreateDocumentIndexPayload {
  projectId: string;
  title: string;
  sourcePath: string;
}

export interface ChatSelectDocumentIndexPayload {
  threadId: string;
  documentIndexId: string;
}

export interface ChatTimelineActionPayload {
  messageId: string;
  blockId: string;
  action: "approve" | "deny" | "answer" | "retry" | "retry_new_thread";
  answer?: string;
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

export interface SelectFilesPayload {
  currentPath?: string;
  kind?: "file" | "image";
  multiple?: boolean;
}

export interface SelectFilesResult {
  paths: string[];
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
    selectFiles: (payload: SelectFilesPayload) => Promise<SelectFilesResult>;
  };
  chat: {
    bootstrap: () => Promise<ChatState>;
    createProject: () => Promise<ChatState>;
    createThread: (payload?: ChatCreateThreadPayload) => Promise<ChatState>;
    selectProject: (payload: ChatSelectProjectPayload) => Promise<ChatState>;
    selectThread: (payload: ChatSelectThreadPayload) => Promise<ChatState>;
    renameProject: (payload: ChatRenameProjectPayload) => Promise<ChatState>;
    updateProjectSettings: (payload: ChatUpdateProjectSettingsPayload) => Promise<ChatState>;
    renameThread: (payload: ChatRenameThreadPayload) => Promise<ChatState>;
    updateThreadSettings: (payload: ChatUpdateThreadSettingsPayload) => Promise<ChatState>;
    applySettingsPreset: (payload: ChatApplySettingsPresetPayload) => Promise<ChatState>;
    saveSettingsPreset: (payload: ChatSaveSettingsPresetPayload) => Promise<ChatState>;
    deleteSettingsPreset: (payload: ChatDeleteSettingsPresetPayload) => Promise<ChatState>;
    refreshCodexAccount: (payload?: ChatRefreshCodexAccountPayload) => Promise<ChatState>;
    refreshLocalModels: () => Promise<ChatState>;
    cancelQueuedSubmission: (payload: ChatCancelQueuedSubmissionPayload) => Promise<ChatState>;
    moveThread: (payload: ChatMoveThreadPayload) => Promise<ChatState>;
    moveProject: (payload: ChatMoveProjectPayload) => Promise<ChatState>;
    deleteProject: (payload: ChatDeleteProjectPayload) => Promise<ChatState>;
    deleteThread: (payload: ChatDeleteThreadPayload) => Promise<ChatState>;
    submit: (payload: ChatSubmitPayload) => Promise<ChatState>;
    cancel: () => Promise<ChatState>;
    addLocalModel: (payload?: ChatAddLocalModelPayload) => Promise<ChatState>;
    selectModel: (payload: ChatSelectModelPayload) => Promise<ChatState>;
    updateRuntimeSettings: (payload: ChatUpdateRuntimeSettingsPayload) => Promise<ChatState>;
    updateAppSettings: (payload: ChatUpdateAppSettingsPayload) => Promise<ChatState>;
    gitState: (payload: ChatGitStatePayload) => Promise<ChatGitState>;
    switchGitBranch: (payload: ChatSwitchGitBranchPayload) => Promise<ChatGitState>;
    createGitBranch: (payload: ChatCreateGitBranchPayload) => Promise<ChatGitState>;
    runProjectAction: (payload: ChatRunProjectActionPayload) => Promise<void>;
    createDocumentIndex: (payload: ChatCreateDocumentIndexPayload) => Promise<ChatState>;
    selectDocumentIndex: (payload: ChatSelectDocumentIndexPayload) => Promise<ChatState>;
    timelineAction: (payload: ChatTimelineActionPayload) => Promise<ChatState>;
    onStateChanged: (callback: (payload: ChatState) => void) => () => void;
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
