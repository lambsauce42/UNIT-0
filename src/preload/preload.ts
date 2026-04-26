import { contextBridge, ipcRenderer } from "electron";
import type {
  ActivateTabPayload,
  BeginTabDragPayload,
  BootstrapPayload,
  CloseTabPayload,
  CloseAppletInstancePayload,
  CreateAppletPayload,
  CreateWorkspacePayload,
  FinishTabDragPayload,
  MoveAppletInstancePayload,
  OpenWorkspaceTabPayload,
  ReplaceWorkspaceLayoutPayload,
  RegisterStripBoundsPayload,
  RenameWorkspacePayload,
  TerminalDataPayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalStartPayload,
  UnitApi,
  UpdateLayoutRatiosPayload,
  UpdateTabDragPayload
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
    updateLayoutRatios: (payload: UpdateLayoutRatiosPayload) =>
      ipcRenderer.invoke("workspaces:updateLayoutRatios", payload),
    replaceLayout: (payload: ReplaceWorkspaceLayoutPayload) => ipcRenderer.invoke("workspaces:replaceLayout", payload)
  },
  applets: {
    createApplet: (payload: CreateAppletPayload) => ipcRenderer.invoke("applets:createApplet", payload),
    closeAppletInstance: (payload: CloseAppletInstancePayload) => ipcRenderer.invoke("applets:closeAppletInstance", payload),
    moveAppletInstance: (payload: MoveAppletInstancePayload) => ipcRenderer.invoke("applets:moveAppletInstance", payload)
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
  debug: {
    resizeLog: (payload: unknown) => ipcRenderer.send("debug:resizeLog", payload)
  }
};

contextBridge.exposeInMainWorld("unitApi", api);
