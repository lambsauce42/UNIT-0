"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createRemoteInferenceServer, loadConfig, normalizeConfig, resolveBundledLlamaServerBinary, saveConfig } = require("./server.js");

let mainWindow = null;
let configPath = "";
let config = null;
let remoteServer = null;
let stateTimer = null;

function configPathFromArgs() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  if (configIndex >= 0 && args[configIndex + 1]) {
    return path.resolve(args[configIndex + 1]);
  }
  return path.join(app.getPath("userData"), "remote-inference-config.json");
}

function defaultConfig() {
  return {
    host: "0.0.0.0",
    port: 14555,
    pairingCode: "ABCD-1234",
    hostIdentity: require("node:os").hostname(),
    models: []
  };
}

function loadDesktopConfig() {
  if (!fs.existsSync(configPath)) {
    config = saveConfig(configPath, defaultConfig());
    return;
  }
  config = loadConfig(configPath, { allowEmptyModels: true });
}

function snapshot() {
  return {
    config,
    configPath,
    defaultLlamaServerBinaryPath: resolveBundledLlamaServerBinary(),
    server: remoteServer?.statusSnapshot() ?? {
      running: false,
      host: config.host,
      port: config.port,
      hostIdentity: config.hostIdentity,
      addresses: [],
      models: config.models,
      clients: [],
      activeRequests: [],
      preparedContexts: [],
      logs: []
    }
  };
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("remote:state", snapshot());
  }
}

async function restartServerWithConfig(nextConfig) {
  if (remoteServer?.isRunning()) {
    await remoteServer.stop();
  }
  remoteServer = createRemoteInferenceServer(nextConfig);
  await remoteServer.start();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    title: "Unit 0 Remote Inference Server",
    webPreferences: {
      preload: path.join(__dirname, "desktop-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "desktop-renderer.html"));
}

app.whenReady().then(() => {
  configPath = configPathFromArgs();
  loadDesktopConfig();
  ipcMain.handle("remote:getState", () => snapshot());
  ipcMain.handle("remote:saveConfig", async (_event, nextConfig) => {
    const normalized = saveConfig(configPath, nextConfig);
    config = normalized;
    if (remoteServer?.isRunning()) {
      await restartServerWithConfig(config);
    } else if (remoteServer) {
      remoteServer.updateConfig(config);
    }
    broadcastState();
    return snapshot();
  });
  ipcMain.handle("remote:start", async () => {
    config = normalizeConfig(config, { allowEmptyModels: false });
    if (!remoteServer) {
      remoteServer = createRemoteInferenceServer(config);
    } else {
      remoteServer.updateConfig(config);
    }
    await remoteServer.start();
    broadcastState();
    return snapshot();
  });
  ipcMain.handle("remote:stop", async () => {
    await remoteServer?.stop();
    broadcastState();
    return snapshot();
  });
  ipcMain.handle("remote:selectFile", async (_event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options?.title || "Select file",
      properties: ["openFile"],
      filters: Array.isArray(options?.filters) ? options.filters : []
    });
    return result.canceled ? "" : result.filePaths[0] || "";
  });
  createWindow();
  stateTimer = setInterval(broadcastState, 1000);
});

app.on("window-all-closed", () => {
  if (stateTimer) {
    clearInterval(stateTimer);
    stateTimer = null;
  }
  void remoteServer?.stop().finally(() => app.quit());
});
