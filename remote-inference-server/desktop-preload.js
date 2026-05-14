"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("remoteInferenceApi", {
  getState: () => ipcRenderer.invoke("remote:getState"),
  saveConfig: (config) => ipcRenderer.invoke("remote:saveConfig", config),
  start: () => ipcRenderer.invoke("remote:start"),
  stop: () => ipcRenderer.invoke("remote:stop"),
  selectFile: (options) => ipcRenderer.invoke("remote:selectFile", options),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("remote:state", handler);
    return () => ipcRenderer.off("remote:state", handler);
  }
});
