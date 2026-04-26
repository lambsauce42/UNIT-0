import { BrowserWindow, WebContentsView } from "electron";
import { normalizeBrowserNavigationUrl } from "../shared/browserUrls.js";
import type {
  BrowserBoundsPayload,
  BrowserMountPayload,
  BrowserNavigatePayload,
  BrowserSessionPayload,
  BrowserStatusPayload,
  BrowserWindowVisibilityPayload,
  RectLike
} from "../shared/types.js";

type BrowserViewRecord = {
  key: string;
  windowId: number;
  sessionId: string;
  view: WebContentsView;
  attached: boolean;
  windowViewsVisible: boolean;
  hasDrawableBounds: boolean;
  loading: boolean;
  title: string;
  error?: string;
};

export class BrowserViewManager {
  private readonly records = new Map<string, BrowserViewRecord>();

  constructor(private readonly windowForId: (windowId: number) => BrowserWindow | undefined) {}

  mount(payload: BrowserMountPayload): BrowserStatusPayload {
    const record = this.recordFor(payload.windowId, payload.sessionId);
    const browserWindow = this.requireWindow(payload.windowId);
    if (!record.attached) {
      browserWindow.contentView.addChildView(record.view);
      record.attached = true;
    }
    this.applyBounds(record, payload.bounds);
    const targetUrl = normalizeBrowserNavigationUrl(payload.url);
    if (!record.view.webContents.getURL()) {
      void record.view.webContents.loadURL(targetUrl);
    }
    const status = this.statusFor(record);
    this.publishStatus(record);
    return status;
  }

  updateBounds(payload: BrowserBoundsPayload): void {
    const record = this.records.get(this.keyFor(payload.windowId, payload.sessionId));
    if (!record || !record.attached) {
      return;
    }
    this.applyBounds(record, payload.bounds);
  }

  detach(payload: BrowserSessionPayload): void {
    const record = this.records.get(this.keyFor(payload.windowId, payload.sessionId));
    if (!record || !record.attached) {
      return;
    }
    const browserWindow = this.windowForId(payload.windowId);
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.contentView.removeChildView(record.view);
    }
    record.attached = false;
    record.view.setVisible(false);
  }

  navigate(payload: BrowserNavigatePayload): BrowserStatusPayload {
    const record = this.requireRecord(payload);
    const targetUrl = normalizeBrowserNavigationUrl(payload.url);
    record.error = undefined;
    void record.view.webContents.loadURL(targetUrl).catch((error: unknown) => {
      record.error = errorMessage(error);
      this.publishStatus(record);
    });
    return this.statusFor(record);
  }

  goBack(payload: BrowserSessionPayload): BrowserStatusPayload {
    const record = this.requireRecord(payload);
    if (record.view.webContents.navigationHistory.canGoBack()) {
      record.error = undefined;
      record.view.webContents.navigationHistory.goBack();
    }
    return this.statusFor(record);
  }

  goForward(payload: BrowserSessionPayload): BrowserStatusPayload {
    const record = this.requireRecord(payload);
    if (record.view.webContents.navigationHistory.canGoForward()) {
      record.error = undefined;
      record.view.webContents.navigationHistory.goForward();
    }
    return this.statusFor(record);
  }

  reload(payload: BrowserSessionPayload): BrowserStatusPayload {
    const record = this.requireRecord(payload);
    record.error = undefined;
    record.view.webContents.reload();
    return this.statusFor(record);
  }

  stop(payload: BrowserSessionPayload): BrowserStatusPayload {
    const record = this.requireRecord(payload);
    record.view.webContents.stop();
    return this.statusFor(record);
  }

  setWindowViewsVisible(payload: BrowserWindowVisibilityPayload): void {
    for (const record of this.records.values()) {
      if (record.windowId !== payload.windowId) {
        continue;
      }
      record.windowViewsVisible = payload.visible;
      if (record.attached) {
        record.view.setVisible(payload.visible && record.hasDrawableBounds);
      }
    }
  }

  disposeSession(sessionId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.sessionId === sessionId) {
        this.disposeRecord(record);
      }
    }
  }

  disposeWindow(windowId: number): void {
    for (const record of [...this.records.values()]) {
      if (record.windowId === windowId) {
        this.disposeRecord(record);
      }
    }
  }

  disposeAll(): void {
    for (const record of [...this.records.values()]) {
      this.disposeRecord(record);
    }
  }

  private recordFor(windowId: number, sessionId: string): BrowserViewRecord {
    const key = this.keyFor(windowId, sessionId);
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }
    this.requireWindow(windowId);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    view.setBackgroundColor("#ffffff");
    const record: BrowserViewRecord = {
      key,
      windowId,
      sessionId,
      view,
      attached: false,
      windowViewsVisible: true,
      hasDrawableBounds: false,
      loading: false,
      title: ""
    };
    view.webContents.setWindowOpenHandler((details) => {
      const targetUrl = normalizeBrowserNavigationUrl(details.url);
      record.error = undefined;
      void view.webContents.loadURL(targetUrl);
      return { action: "deny" };
    });
    view.webContents.on("did-start-loading", () => {
      record.loading = true;
      record.error = undefined;
      this.publishStatus(record);
    });
    view.webContents.on("did-stop-loading", () => {
      record.loading = false;
      this.publishStatus(record);
    });
    view.webContents.on("did-navigate", () => {
      record.error = undefined;
      this.publishStatus(record);
    });
    view.webContents.on("did-navigate-in-page", () => {
      record.error = undefined;
      this.publishStatus(record);
    });
    view.webContents.on("page-title-updated", (_event, title) => {
      record.title = title;
      this.publishStatus(record);
    });
    view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) {
        return;
      }
      record.loading = false;
      record.error = `${errorDescription}: ${validatedURL}`;
      this.publishStatus(record);
    });
    this.records.set(key, record);
    return record;
  }

  private requireRecord(payload: BrowserSessionPayload): BrowserViewRecord {
    const record = this.records.get(this.keyFor(payload.windowId, payload.sessionId));
    if (!record) {
      throw new Error(`Browser view is not mounted for session ${payload.sessionId}`);
    }
    return record;
  }

  private requireWindow(windowId: number): BrowserWindow {
    const browserWindow = this.windowForId(windowId);
    if (!browserWindow || browserWindow.isDestroyed()) {
      throw new Error(`Browser window ${windowId} is not available`);
    }
    return browserWindow;
  }

  private applyBounds(record: BrowserViewRecord, rect: RectLike): void {
    const x = Math.max(0, Math.round(rect.left));
    const y = Math.max(0, Math.round(rect.top));
    const width = Math.max(0, Math.round(rect.right - rect.left));
    const height = Math.max(0, Math.round(rect.bottom - rect.top));
    record.hasDrawableBounds = width > 1 && height > 1;
    record.view.setBounds({ x, y, width, height });
    record.view.setVisible(record.windowViewsVisible && record.hasDrawableBounds);
  }

  private statusFor(record: BrowserViewRecord): BrowserStatusPayload {
    const webContents = record.view.webContents;
    return {
      windowId: record.windowId,
      sessionId: record.sessionId,
      url: webContents.getURL(),
      title: record.title,
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
      loading: record.loading,
      error: record.error
    };
  }

  private publishStatus(record: BrowserViewRecord): void {
    const browserWindow = this.windowForId(record.windowId);
    if (!browserWindow || browserWindow.isDestroyed()) {
      return;
    }
    browserWindow.webContents.send("browser:status", this.statusFor(record));
  }

  private disposeRecord(record: BrowserViewRecord): void {
    this.detach(record);
    if (!record.view.webContents.isDestroyed()) {
      record.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.records.delete(record.key);
  }

  private keyFor(windowId: number, sessionId: string): string {
    return `${windowId}:${sessionId}`;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
