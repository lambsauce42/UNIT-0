import { contextBridge, ipcRenderer } from "electron";
import type {
  ActivateTabPayload,
  ApplyWorkspaceTemplatePayload,
  BrowserBoundsPayload,
  BrowserMountPayload,
  BrowserNavigatePayload,
  BrowserSessionPayload,
  BrowserStatusPayload,
  BrowserWindowVisibilityPayload,
  BeginTabDragPayload,
  BootstrapPayload,
  ChatAddLocalModelPayload,
  ChatApplySettingsPresetPayload,
  ChatCancelQueuedSubmissionPayload,
  ChatCreateDocumentIndexPayload,
  ChatCreateThreadPayload,
  ChatCreateGitBranchPayload,
  ChatDeleteProjectPayload,
  ChatDeleteSettingsPresetPayload,
  ChatDeleteThreadPayload,
  ChatGitState,
  ChatGitStatePayload,
  ChatMoveProjectPayload,
  ChatMoveThreadPayload,
  ChatRenameProjectPayload,
  ChatRenameThreadPayload,
  ChatRunProjectActionPayload,
  ChatSaveSettingsPresetPayload,
  ChatRefreshCodexAccountPayload,
  ChatSelectModelPayload,
  ChatSelectDocumentIndexPayload,
  ChatSelectProjectPayload,
  ChatSelectThreadPayload,
  ChatSwitchGitBranchPayload,
  ChatState,
  ChatSubmitPayload,
  ChatTimelineActionPayload,
  ChatUpdateAppSettingsPayload,
  ChatUpdateProjectSettingsPayload,
  ChatUpdateRuntimeSettingsPayload,
  ChatUpdateThreadSettingsPayload,
  ChangeAppletInstanceKindPayload,
  CloseWorkspacePayload,
  CloseTabPayload,
  CloseAppletInstancePayload,
  CreateAppletPayload,
  CreateWorkspacePayload,
  FinishTabDragPayload,
  ListDirectoryPayload,
  MoveAppletInstancePayload,
  OpenWorkspaceTabPayload,
  ReadFilePayload,
  ReplaceWorkspaceLayoutPayload,
  RegisterStripBoundsPayload,
  RenameWorkspacePayload,
  TerminalDataPayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalStartPayload,
  UnitApi,
  SelectDirectoryPayload,
  SelectFilesPayload,
  UpdateLayoutRatiosPayload,
  UpdateAppletSessionStatePayload,
  UpdateTabDragPayload,
  WriteFilePayload
} from "../shared/types.js";

const api: UnitApi = {
  bootstrap: () => ipcRenderer.invoke("unit:bootstrap"),
  onStateChanged: (callback: (payload: BootstrapPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BootstrapPayload) => callback(payload);
    ipcRenderer.on("unit:state-changed", handler);
    return () => ipcRenderer.off("unit:state-changed", handler);
  },
  onWindowRegistered: (callback: (windowId: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, windowId: number) => callback(windowId);
    ipcRenderer.on("unit:window-registered", handler);
    return () => ipcRenderer.off("unit:window-registered", handler);
  },
  tabs: {
    bootstrap: () => ipcRenderer.invoke("tabs:bootstrap"),
    activate: (payload: ActivateTabPayload) => ipcRenderer.invoke("tabs:activate", payload),
    beginDrag: (payload: BeginTabDragPayload) => ipcRenderer.invoke("tabs:beginDrag", payload),
    updateDrag: (payload: UpdateTabDragPayload) => ipcRenderer.invoke("tabs:updateDrag", payload),
    updateDragFast: (payload: UpdateTabDragPayload) => ipcRenderer.send("tabs:updateDragFast", payload),
    finishDrag: (payload: FinishTabDragPayload) => ipcRenderer.invoke("tabs:finishDrag", payload),
    finishDragFast: (payload: FinishTabDragPayload) => ipcRenderer.send("tabs:finishDragFast", payload),
    cancelDrag: () => ipcRenderer.invoke("tabs:cancelDrag"),
    closeTab: (payload: CloseTabPayload) => ipcRenderer.invoke("tabs:closeTab", payload),
    registerStripBounds: (payload: RegisterStripBoundsPayload) =>
      ipcRenderer.invoke("tabs:registerStripBounds", payload),
    windowClosing: (windowId: number) => ipcRenderer.invoke("tabs:windowClosing", windowId)
  },
  workspaces: {
    createWorkspace: (payload: CreateWorkspacePayload) => ipcRenderer.invoke("workspaces:createWorkspace", payload),
    openWorkspaceTab: (payload: OpenWorkspaceTabPayload) => ipcRenderer.invoke("workspaces:openWorkspaceTab", payload),
    renameWorkspace: (payload: RenameWorkspacePayload) => ipcRenderer.invoke("workspaces:renameWorkspace", payload),
    closeWorkspace: (payload: CloseWorkspacePayload) => ipcRenderer.invoke("workspaces:closeWorkspace", payload),
    updateLayoutRatios: (payload: UpdateLayoutRatiosPayload) =>
      ipcRenderer.invoke("workspaces:updateLayoutRatios", payload),
    replaceLayout: (payload: ReplaceWorkspaceLayoutPayload) => ipcRenderer.invoke("workspaces:replaceLayout", payload),
    applyTemplate: (payload: ApplyWorkspaceTemplatePayload) => ipcRenderer.invoke("workspaces:applyTemplate", payload)
  },
  applets: {
    createApplet: (payload: CreateAppletPayload) => ipcRenderer.invoke("applets:createApplet", payload),
    closeAppletInstance: (payload: CloseAppletInstancePayload) => ipcRenderer.invoke("applets:closeAppletInstance", payload),
    changeAppletInstanceKind: (payload: ChangeAppletInstanceKindPayload) =>
      ipcRenderer.invoke("applets:changeAppletInstanceKind", payload),
    moveAppletInstance: (payload: MoveAppletInstancePayload) => ipcRenderer.invoke("applets:moveAppletInstance", payload),
    updateAppletSessionState: (payload: UpdateAppletSessionStatePayload) =>
      ipcRenderer.invoke("applets:updateAppletSessionState", payload)
  },
  terminal: {
    start: (payload: TerminalStartPayload) => ipcRenderer.invoke("terminal:start", payload),
    input: (payload: TerminalInputPayload) => ipcRenderer.send("terminal:input", payload),
    resize: (payload: TerminalResizePayload) => ipcRenderer.invoke("terminal:resize", payload),
    onData: (callback: (payload: TerminalDataPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataPayload) => callback(payload);
      ipcRenderer.on("terminal:data", handler);
      return () => ipcRenderer.off("terminal:data", handler);
    }
  },
  fileSystem: {
    listDirectory: (payload: ListDirectoryPayload) => ipcRenderer.invoke("fileSystem:listDirectory", payload),
    readFile: (payload: ReadFilePayload) => ipcRenderer.invoke("fileSystem:readFile", payload),
    writeFile: (payload: WriteFilePayload) => ipcRenderer.invoke("fileSystem:writeFile", payload),
    selectDirectory: (payload: SelectDirectoryPayload) => ipcRenderer.invoke("fileSystem:selectDirectory", payload),
    selectFiles: (payload: SelectFilesPayload) => ipcRenderer.invoke("fileSystem:selectFiles", payload)
  },
  chat: {
    bootstrap: () => ipcRenderer.invoke("chat:bootstrap"),
    createProject: () => ipcRenderer.invoke("chat:createProject"),
    createThread: (payload?: ChatCreateThreadPayload) => ipcRenderer.invoke("chat:createThread", payload),
    selectProject: (payload: ChatSelectProjectPayload) => ipcRenderer.invoke("chat:selectProject", payload),
    selectThread: (payload: ChatSelectThreadPayload) => ipcRenderer.invoke("chat:selectThread", payload),
    renameProject: (payload: ChatRenameProjectPayload) => ipcRenderer.invoke("chat:renameProject", payload),
    updateProjectSettings: (payload: ChatUpdateProjectSettingsPayload) => ipcRenderer.invoke("chat:updateProjectSettings", payload),
    renameThread: (payload: ChatRenameThreadPayload) => ipcRenderer.invoke("chat:renameThread", payload),
    updateThreadSettings: (payload: ChatUpdateThreadSettingsPayload) => ipcRenderer.invoke("chat:updateThreadSettings", payload),
    applySettingsPreset: (payload: ChatApplySettingsPresetPayload) => ipcRenderer.invoke("chat:applySettingsPreset", payload),
    saveSettingsPreset: (payload: ChatSaveSettingsPresetPayload) => ipcRenderer.invoke("chat:saveSettingsPreset", payload),
    deleteSettingsPreset: (payload: ChatDeleteSettingsPresetPayload) => ipcRenderer.invoke("chat:deleteSettingsPreset", payload),
    refreshCodexAccount: (payload?: ChatRefreshCodexAccountPayload) => ipcRenderer.invoke("chat:refreshCodexAccount", payload),
    refreshLocalModels: () => ipcRenderer.invoke("chat:refreshLocalModels"),
    cancelQueuedSubmission: (payload: ChatCancelQueuedSubmissionPayload) => ipcRenderer.invoke("chat:cancelQueuedSubmission", payload),
    moveThread: (payload: ChatMoveThreadPayload) => ipcRenderer.invoke("chat:moveThread", payload),
    moveProject: (payload: ChatMoveProjectPayload) => ipcRenderer.invoke("chat:moveProject", payload),
    deleteProject: (payload: ChatDeleteProjectPayload) => ipcRenderer.invoke("chat:deleteProject", payload),
    deleteThread: (payload: ChatDeleteThreadPayload) => ipcRenderer.invoke("chat:deleteThread", payload),
    submit: (payload: ChatSubmitPayload) => ipcRenderer.invoke("chat:submit", payload),
    cancel: () => ipcRenderer.invoke("chat:cancel"),
    addLocalModel: (payload?: ChatAddLocalModelPayload) => ipcRenderer.invoke("chat:addLocalModel", payload),
    selectModel: (payload: ChatSelectModelPayload) => ipcRenderer.invoke("chat:selectModel", payload),
    updateRuntimeSettings: (payload: ChatUpdateRuntimeSettingsPayload) => ipcRenderer.invoke("chat:updateRuntimeSettings", payload),
    updateAppSettings: (payload: ChatUpdateAppSettingsPayload) => ipcRenderer.invoke("chat:updateAppSettings", payload),
    gitState: (payload: ChatGitStatePayload) => ipcRenderer.invoke("chat:gitState", payload) as Promise<ChatGitState>,
    switchGitBranch: (payload: ChatSwitchGitBranchPayload) => ipcRenderer.invoke("chat:switchGitBranch", payload) as Promise<ChatGitState>,
    createGitBranch: (payload: ChatCreateGitBranchPayload) => ipcRenderer.invoke("chat:createGitBranch", payload) as Promise<ChatGitState>,
    runProjectAction: (payload: ChatRunProjectActionPayload) => ipcRenderer.invoke("chat:runProjectAction", payload),
    createDocumentIndex: (payload: ChatCreateDocumentIndexPayload) => ipcRenderer.invoke("chat:createDocumentIndex", payload),
    selectDocumentIndex: (payload: ChatSelectDocumentIndexPayload) => ipcRenderer.invoke("chat:selectDocumentIndex", payload),
    timelineAction: (payload: ChatTimelineActionPayload) => ipcRenderer.invoke("chat:timelineAction", payload),
    onStateChanged: (callback: (payload: ChatState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatState) => callback(payload);
      ipcRenderer.on("chat:state-changed", handler);
      return () => ipcRenderer.off("chat:state-changed", handler);
    }
  },
  browser: {
    mount: (payload: BrowserMountPayload) => ipcRenderer.invoke("browser:mount", payload),
    updateBounds: (payload: BrowserBoundsPayload) => ipcRenderer.invoke("browser:updateBounds", payload),
    detach: (payload: BrowserSessionPayload) => ipcRenderer.invoke("browser:detach", payload),
    navigate: (payload: BrowserNavigatePayload) => ipcRenderer.invoke("browser:navigate", payload),
    goBack: (payload: BrowserSessionPayload) => ipcRenderer.invoke("browser:goBack", payload),
    goForward: (payload: BrowserSessionPayload) => ipcRenderer.invoke("browser:goForward", payload),
    reload: (payload: BrowserSessionPayload) => ipcRenderer.invoke("browser:reload", payload),
    stop: (payload: BrowserSessionPayload) => ipcRenderer.invoke("browser:stop", payload),
    setWindowViewsVisible: (payload: BrowserWindowVisibilityPayload) =>
      ipcRenderer.invoke("browser:setWindowViewsVisible", payload),
    onStatus: (callback: (payload: BrowserStatusPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: BrowserStatusPayload) => callback(payload);
      ipcRenderer.on("browser:status", handler);
      return () => ipcRenderer.off("browser:status", handler);
    }
  }
};

contextBridge.exposeInMainWorld("unitApi", api);
