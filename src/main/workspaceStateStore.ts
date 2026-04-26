import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AppletKind,
  AppletInstance,
  AppletSession,
  TabHostSnapshot,
  Workspace,
  WorkspaceLayoutLeaf,
  WorkspaceLayoutNode,
  WorkspaceTab
} from "../shared/types.js";

export type WorkspaceStateModel = {
  appletSessions: Record<string, AppletSession>;
  workspaces: Record<string, Workspace>;
  tabs: Record<string, WorkspaceTab>;
  primaryHost: TabHostSnapshot;
};

export type CreateAppletOptions = {
  workspaceId: string;
  kind: AppletKind;
  targetLeafId?: string;
  splitDirection?: "row" | "column";
};

export type AppletMutationResult = {
  workspace: Workspace;
  appletSessions: Record<string, AppletSession>;
  instance?: AppletInstance;
  deletedSessionId?: string;
  changedSessionId?: string;
  previousKind?: AppletKind;
};

export type ChangeAppletKindOptions = {
  workspaceId: string;
  appletInstanceId: string;
  kind: AppletKind;
};

export type MoveAppletOptions = {
  workspaceId: string;
  appletInstanceId: string;
  targetLeafId?: string;
  splitDirection: "row" | "column";
  placement: "first" | "second";
};

export type UpdateLayoutRatiosOptions = {
  workspaceId: string;
  ratios: Record<string, number>;
};

export type ReplaceWorkspaceLayoutOptions = {
  workspaceId: string;
  layout: WorkspaceLayoutNode;
};

const DEFAULT_APPLET_SESSIONS: Record<string, AppletSession> = {
  "session-terminal": { id: "session-terminal", kind: "terminal", title: "Terminal" },
  "session-file-viewer": { id: "session-file-viewer", kind: "fileViewer", title: "File Viewer" },
  "session-browser": { id: "session-browser", kind: "browser", title: "Browser" },
  "session-chat": { id: "session-chat", kind: "chat", title: "Chat" },
  "session-sandbox": { id: "session-sandbox", kind: "sandbox", title: "Sandbox" }
};

type SeedWorkspace = Omit<Workspace, "applets"> & {
  applets: Array<{ id: string; sessionId: string; area: string }>;
};

const DEFAULT_WORKSPACES: Record<string, SeedWorkspace> = {
  manager: { id: "manager", title: "Workspace Manager", applets: [], layout: null },
  atlas: {
    id: "atlas",
    title: "Project Atlas",
    layout: null,
    applets: [
      { id: "atlas-terminal", sessionId: "session-terminal", area: "terminal" },
      { id: "atlas-browser", sessionId: "session-browser", area: "browser" },
      { id: "atlas-file-viewer", sessionId: "session-file-viewer", area: "fileViewer" },
      { id: "atlas-sandbox", sessionId: "session-sandbox", area: "sandbox" },
      { id: "atlas-chat", sessionId: "session-chat", area: "chat" }
    ]
  },
  redesign: {
    id: "redesign",
    title: "Website Redesign",
    layout: null,
    applets: [
      { id: "redesign-browser", sessionId: "session-browser", area: "browser" },
      { id: "redesign-chat", sessionId: "session-chat", area: "chat" },
      { id: "redesign-file-viewer", sessionId: "session-file-viewer", area: "fileViewer" }
    ]
  },
  lab: {
    id: "lab",
    title: "VM Lab",
    layout: null,
    applets: [
      { id: "lab-sandbox", sessionId: "session-sandbox", area: "sandbox" },
      { id: "lab-terminal", sessionId: "session-terminal", area: "terminal" }
    ]
  },
  research: {
    id: "research",
    title: "Research",
    layout: null,
    applets: [
      { id: "research-browser", sessionId: "session-browser", area: "browser" },
      { id: "research-chat", sessionId: "session-chat", area: "chat" }
    ]
  }
};

const DEFAULT_TABS: Record<string, WorkspaceTab> = {
  "tab-manager": {
    id: "tab-manager",
    title: "Workspace Manager",
    workspaceId: "manager",
    pinned: true,
    closable: false
  },
  "tab-atlas": { id: "tab-atlas", title: "Project Atlas", workspaceId: "atlas", pinned: false, closable: true },
  "tab-redesign": { id: "tab-redesign", title: "Website Redesign", workspaceId: "redesign", pinned: false, closable: true },
  "tab-lab": { id: "tab-lab", title: "VM Lab", workspaceId: "lab", pinned: false, closable: true },
  "tab-research": { id: "tab-research", title: "Research", workspaceId: "research", pinned: false, closable: true }
};

const DEFAULT_PRIMARY_HOST: TabHostSnapshot = {
  tabIds: ["tab-manager", "tab-atlas", "tab-redesign", "tab-lab", "tab-research"],
  activeTabId: "tab-atlas"
};

type AppletSessionRow = {
  id: string;
  kind: AppletKind;
  title: string;
};

type WorkspaceRow = {
  id: string;
  title: string;
};

type AppletInstanceRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  area?: string;
};

type WorkspaceTabRow = {
  id: string;
  title: string;
  workspace_id: string;
  pinned: number;
  closable: number;
};

type PrimaryHostRow = {
  id: string;
  tab_ids_json: string;
  active_tab_id: string;
};

type WorkspaceLayoutRow = {
  workspace_id: string;
  layout_json: string;
};

export class WorkspaceStateStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.seedIfEmpty();
  }

  load(): WorkspaceStateModel {
    const appletSessions = Object.fromEntries(
      this.db
        .prepare("SELECT id, kind, title FROM applet_sessions ORDER BY id")
        .all()
        .map((row) => {
          const session = row as AppletSessionRow;
          return [session.id, session];
        })
    );
    const workspaces: Record<string, Workspace> = Object.fromEntries(
      this.db
        .prepare("SELECT id, title FROM workspaces ORDER BY sort_order")
        .all()
        .map((row) => {
          const workspace = row as WorkspaceRow;
          return [workspace.id, { id: workspace.id, title: workspace.title, applets: [], layout: null }];
        })
    );
    for (const row of this.db
      .prepare("SELECT id, workspace_id, session_id FROM applet_instances ORDER BY workspace_id, sort_order")
      .all() as AppletInstanceRow[]) {
      const workspace = workspaces[row.workspace_id];
      if (!workspace) {
        throw new Error(`Applet instance ${row.id} references missing workspace ${row.workspace_id}`);
      }
      workspace.applets.push({ id: row.id, sessionId: row.session_id });
    }
    for (const row of this.db
      .prepare("SELECT workspace_id, layout_json FROM workspace_layouts ORDER BY workspace_id")
      .all() as WorkspaceLayoutRow[]) {
      const workspace = workspaces[row.workspace_id];
      if (!workspace) {
        throw new Error(`Workspace layout references missing workspace ${row.workspace_id}`);
      }
      workspace.layout = parseWorkspaceLayout(row.layout_json, workspace);
    }
    const tabs = Object.fromEntries(
      (this.db
        .prepare("SELECT id, title, workspace_id, pinned, closable FROM workspace_tabs ORDER BY sort_order")
        .all() as WorkspaceTabRow[]).map((tab) => [
        tab.id,
        {
          id: tab.id,
          title: tab.title,
          workspaceId: tab.workspace_id,
          pinned: tab.pinned === 1,
          closable: tab.closable === 1
        }
      ])
    );
    const primaryHost = this.loadPrimaryHost(tabs);
    return { appletSessions, workspaces, tabs, primaryHost };
  }

  savePrimaryHost(host: TabHostSnapshot): void {
    const tabIdsJson = JSON.stringify(host.tabIds);
    this.db
      .prepare(
        `INSERT INTO primary_tab_host (id, tab_ids_json, active_tab_id)
         VALUES ('primary', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tab_ids_json = excluded.tab_ids_json,
           active_tab_id = excluded.active_tab_id`
      )
      .run(tabIdsJson, host.activeTabId);
  }

  createWorkspace(title?: string): { workspace: Workspace; tab: WorkspaceTab } {
    const workspaceId = `workspace-${randomUUID()}`;
    const tabId = `tab-${workspaceId}`;
    const resolvedTitle = title?.trim() || this.nextUntitledWorkspaceTitle();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const workspaceSortOrder = this.nextSortOrder("workspaces");
      const tabSortOrder = this.nextSortOrder("workspace_tabs");
      this.db
        .prepare("INSERT INTO workspaces (id, title, sort_order) VALUES (?, ?, ?)")
        .run(workspaceId, resolvedTitle, workspaceSortOrder);
      this.db
        .prepare(
          "INSERT INTO workspace_tabs (id, title, workspace_id, pinned, closable, sort_order) VALUES (?, ?, ?, 0, 1, ?)"
        )
        .run(tabId, resolvedTitle, workspaceId, tabSortOrder);
      this.db.prepare("INSERT INTO workspace_layouts (workspace_id, layout_json) VALUES (?, ?)").run(workspaceId, "null");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      workspace: { id: workspaceId, title: resolvedTitle, applets: [], layout: null },
      tab: { id: tabId, title: resolvedTitle, workspaceId, pinned: false, closable: true }
    };
  }

  openWorkspaceTab(workspaceId: string): WorkspaceTab {
    const workspace = this.db
      .prepare("SELECT id, title FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }
    const existingTab = this.db
      .prepare("SELECT id, title, workspace_id, pinned, closable FROM workspace_tabs WHERE workspace_id = ?")
      .get(workspaceId) as WorkspaceTabRow | undefined;
    if (existingTab) {
      return {
        id: existingTab.id,
        title: existingTab.title,
        workspaceId: existingTab.workspace_id,
        pinned: existingTab.pinned === 1,
        closable: existingTab.closable === 1
      };
    }
    const tab: WorkspaceTab = {
      id: `tab-${workspaceId}`,
      title: workspace.title,
      workspaceId,
      pinned: workspaceId === "manager",
      closable: workspaceId !== "manager"
    };
    this.db
      .prepare(
        "INSERT INTO workspace_tabs (id, title, workspace_id, pinned, closable, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        tab.id,
        tab.title,
        tab.workspaceId,
        tab.pinned ? 1 : 0,
        tab.closable ? 1 : 0,
        this.nextSortOrder("workspace_tabs")
      );
    return tab;
  }

  closeWorkspaceTab(host: TabHostSnapshot): void {
    this.savePrimaryHost(host);
  }

  renameWorkspace(workspaceId: string, title: string): Workspace {
    const resolvedTitle = title.trim();
    if (!resolvedTitle) {
      throw new Error("Workspace title cannot be empty");
    }
    const result = this.db
      .prepare("UPDATE workspaces SET title = ? WHERE id = ?")
      .run(resolvedTitle, workspaceId);
    if (result.changes === 0) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }
    this.db.prepare("UPDATE workspace_tabs SET title = ? WHERE workspace_id = ?").run(resolvedTitle, workspaceId);
    const workspace = this.db
      .prepare("SELECT id, title FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }
    return { id: workspace.id, title: workspace.title, applets: [], layout: null };
  }

  createApplet(options: CreateAppletOptions): AppletMutationResult {
    const model = this.load();
    const workspace = model.workspaces[options.workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${options.workspaceId} does not exist`);
    }
    const splitDirection = options.splitDirection ?? "row";
    const session: AppletSession = {
      id: `session-${options.kind}-${randomUUID()}`,
      kind: options.kind,
      title: titleForAppletKind(options.kind)
    };
    const instance: AppletInstance = {
      id: `${workspace.id}-${options.kind}-${randomUUID()}`,
      sessionId: session.id
    };
    const nextLayout = insertAppletLeaf(workspace.layout, instance.id, options.targetLeafId, splitDirection);
    const nextWorkspace = {
      ...workspace,
      applets: [...workspace.applets, instance],
      layout: nextLayout
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO applet_sessions (id, kind, title) VALUES (?, ?, ?)")
        .run(session.id, session.kind, session.title);
      this.db
        .prepare("INSERT INTO applet_instances (id, workspace_id, session_id, area, sort_order) VALUES (?, ?, ?, ?, ?)")
        .run(instance.id, workspace.id, instance.sessionId, session.kind, this.nextAppletSortOrder(workspace.id));
      this.saveWorkspaceLayoutInTransaction(workspace.id, nextLayout);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      workspace: nextWorkspace,
      appletSessions: { ...model.appletSessions, [session.id]: session },
      instance
    };
  }

  closeAppletInstance(workspaceId: string, appletInstanceId: string): AppletMutationResult {
    const model = this.load();
    const workspace = model.workspaces[workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }
    const instance = workspace.applets.find((item) => item.id === appletInstanceId);
    if (!instance) {
      throw new Error(`Applet instance ${appletInstanceId} does not exist in workspace ${workspaceId}`);
    }
    const nextLayout = removeAppletLeaf(workspace.layout, appletInstanceId);
    const nextWorkspace = {
      ...workspace,
      applets: workspace.applets.filter((item) => item.id !== appletInstanceId),
      layout: nextLayout
    };
    let deletedSessionId: string | undefined;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM applet_instances WHERE id = ? AND workspace_id = ?").run(appletInstanceId, workspaceId);
      this.saveWorkspaceLayoutInTransaction(workspaceId, nextLayout);
      const referenceCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM applet_instances WHERE session_id = ?")
        .get(instance.sessionId) as { count: number };
      if (referenceCount.count === 0) {
        this.db.prepare("DELETE FROM applet_sessions WHERE id = ?").run(instance.sessionId);
        deletedSessionId = instance.sessionId;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const appletSessions = { ...model.appletSessions };
    if (deletedSessionId) {
      delete appletSessions[deletedSessionId];
    }
    return { workspace: nextWorkspace, appletSessions, deletedSessionId };
  }

  changeAppletInstanceKind(options: ChangeAppletKindOptions): AppletMutationResult {
    const model = this.load();
    const workspace = model.workspaces[options.workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${options.workspaceId} does not exist`);
    }
    const instance = workspace.applets.find((item) => item.id === options.appletInstanceId);
    if (!instance) {
      throw new Error(`Applet instance ${options.appletInstanceId} does not exist in workspace ${options.workspaceId}`);
    }
    const currentSession = model.appletSessions[instance.sessionId];
    if (!currentSession) {
      throw new Error(`Applet instance ${options.appletInstanceId} references missing session ${instance.sessionId}`);
    }
    if (currentSession.kind === options.kind) {
      return { workspace, appletSessions: model.appletSessions, changedSessionId: currentSession.id, previousKind: currentSession.kind };
    }

    const nextSession: AppletSession = {
      ...currentSession,
      kind: options.kind,
      title: titleForAppletKind(options.kind)
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE applet_sessions SET kind = ?, title = ? WHERE id = ?")
        .run(nextSession.kind, nextSession.title, nextSession.id);
      this.db.prepare("UPDATE applet_instances SET area = ? WHERE id = ? AND workspace_id = ?").run(
        nextSession.kind,
        options.appletInstanceId,
        options.workspaceId
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      workspace,
      appletSessions: { ...model.appletSessions, [nextSession.id]: nextSession },
      changedSessionId: nextSession.id,
      previousKind: currentSession.kind
    };
  }

  moveAppletInstance(options: MoveAppletOptions): Workspace {
    const model = this.load();
    const workspace = model.workspaces[options.workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${options.workspaceId} does not exist`);
    }
    if (!workspace.applets.some((instance) => instance.id === options.appletInstanceId)) {
      throw new Error(`Applet instance ${options.appletInstanceId} does not exist in workspace ${options.workspaceId}`);
    }
    const nextLayout = moveAppletLeaf(workspace.layout, options);
    const nextWorkspace = { ...workspace, layout: nextLayout };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveWorkspaceLayoutInTransaction(workspace.id, nextLayout);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return nextWorkspace;
  }

  updateLayoutRatios(options: UpdateLayoutRatiosOptions): Workspace {
    const model = this.load();
    const workspace = model.workspaces[options.workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${options.workspaceId} does not exist`);
    }
    if (!workspace.layout) {
      throw new Error(`Workspace ${options.workspaceId} does not have a layout`);
    }
    const nextLayout = updateLayoutRatios(workspace.layout, options.ratios);
    validateWorkspaceLayoutForWorkspace(nextLayout, workspace);
    const nextWorkspace = { ...workspace, layout: nextLayout };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveWorkspaceLayoutInTransaction(workspace.id, nextLayout);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return nextWorkspace;
  }

  replaceWorkspaceLayout(options: ReplaceWorkspaceLayoutOptions): Workspace {
    const model = this.load();
    const workspace = model.workspaces[options.workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${options.workspaceId} does not exist`);
    }
    validateWorkspaceLayoutForWorkspace(options.layout, workspace);
    const nextWorkspace = { ...workspace, layout: options.layout };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveWorkspaceLayoutInTransaction(workspace.id, options.layout);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return nextWorkspace;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS unit_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS applet_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS applet_instances (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES applet_sessions(id) ON DELETE RESTRICT,
        area TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_tabs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
        closable INTEGER NOT NULL CHECK (closable IN (0, 1)),
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS primary_tab_host (
        id TEXT PRIMARY KEY CHECK (id = 'primary'),
        tab_ids_json TEXT NOT NULL,
        active_tab_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_layouts (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        layout_json TEXT NOT NULL
      );

      INSERT INTO unit_metadata (key, value)
      VALUES ('schema_version', '1')
      ON CONFLICT(key) DO NOTHING;
    `);
    this.backfillMissingWorkspaceLayouts();
  }

  private seedIfEmpty(): void {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM workspace_tabs").get() as { count: number };
    if (row.count > 0) {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertSession = this.db.prepare("INSERT INTO applet_sessions (id, kind, title) VALUES (?, ?, ?)");
      for (const session of Object.values(DEFAULT_APPLET_SESSIONS)) {
        insertSession.run(session.id, session.kind, session.title);
      }

      const insertWorkspace = this.db.prepare("INSERT INTO workspaces (id, title, sort_order) VALUES (?, ?, ?)");
      Object.values(DEFAULT_WORKSPACES).forEach((workspace, index) => {
        insertWorkspace.run(workspace.id, workspace.title, index);
      });

      const insertInstance = this.db.prepare(
        "INSERT INTO applet_instances (id, workspace_id, session_id, area, sort_order) VALUES (?, ?, ?, ?, ?)"
      );
      for (const workspace of Object.values(DEFAULT_WORKSPACES)) {
        workspace.applets.forEach((instance, index) => {
          insertInstance.run(instance.id, workspace.id, instance.sessionId, instance.area, index);
        });
      }

      const insertTab = this.db.prepare(
        "INSERT INTO workspace_tabs (id, title, workspace_id, pinned, closable, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
      );
      Object.values(DEFAULT_TABS).forEach((tab, index) => {
        insertTab.run(tab.id, tab.title, tab.workspaceId, tab.pinned ? 1 : 0, tab.closable ? 1 : 0, index);
      });

      this.db
        .prepare("INSERT INTO primary_tab_host (id, tab_ids_json, active_tab_id) VALUES ('primary', ?, ?)")
        .run(JSON.stringify(DEFAULT_PRIMARY_HOST.tabIds), DEFAULT_PRIMARY_HOST.activeTabId);
      const insertLayout = this.db.prepare("INSERT INTO workspace_layouts (workspace_id, layout_json) VALUES (?, ?)");
      for (const workspace of Object.values(DEFAULT_WORKSPACES)) {
        insertLayout.run(workspace.id, JSON.stringify(defaultLayoutForWorkspace(workspace)));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillMissingWorkspaceLayouts(): void {
    const missing = this.db
      .prepare(
        `SELECT id, title
         FROM workspaces
         WHERE id NOT IN (SELECT workspace_id FROM workspace_layouts)
         ORDER BY sort_order`
      )
      .all() as WorkspaceRow[];
    if (missing.length === 0) {
      return;
    }
    const instancesByWorkspace = new Map<string, AppletInstanceRow[]>();
    for (const row of this.db
      .prepare("SELECT id, workspace_id, session_id, area FROM applet_instances ORDER BY workspace_id, sort_order")
      .all() as AppletInstanceRow[]) {
      const instances = instancesByWorkspace.get(row.workspace_id) ?? [];
      instances.push(row);
      instancesByWorkspace.set(row.workspace_id, instances);
    }
    const insertLayout = this.db.prepare("INSERT INTO workspace_layouts (workspace_id, layout_json) VALUES (?, ?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const workspace of missing) {
        const applets = (instancesByWorkspace.get(workspace.id) ?? []).map((instance) => ({
          id: instance.id,
          sessionId: instance.session_id
        }));
        insertLayout.run(workspace.id, JSON.stringify(defaultLayoutForWorkspace({ ...workspace, applets, layout: null })));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private loadPrimaryHost(tabs: Record<string, WorkspaceTab>): TabHostSnapshot {
    const row = this.db.prepare("SELECT id, tab_ids_json, active_tab_id FROM primary_tab_host WHERE id = 'primary'").get() as
      | PrimaryHostRow
      | undefined;
    if (!row) {
      throw new Error("Missing primary tab host row");
    }
    const parsed = JSON.parse(row.tab_ids_json) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((tabId) => typeof tabId === "string")) {
      throw new Error("Primary tab host contains invalid tab order JSON");
    }
    const tabIds = parsed.filter((tabId) => tabs[tabId]);
    if (!tabIds.includes("tab-manager")) {
      tabIds.unshift("tab-manager");
    }
    const activeTabId = tabIds.includes(row.active_tab_id) ? row.active_tab_id : (tabIds[0] ?? "");
    return { tabIds, activeTabId };
  }

  private nextSortOrder(table: "workspaces" | "workspace_tabs"): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${table}`).get() as { next: number };
    return row.next;
  }

  private nextAppletSortOrder(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM applet_instances WHERE workspace_id = ?")
      .get(workspaceId) as { next: number };
    return row.next;
  }

  private saveWorkspaceLayoutInTransaction(workspaceId: string, layout: WorkspaceLayoutNode | null): void {
    this.db
      .prepare(
        `INSERT INTO workspace_layouts (workspace_id, layout_json)
         VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET layout_json = excluded.layout_json`
      )
      .run(workspaceId, JSON.stringify(layout));
  }

  private nextUntitledWorkspaceTitle(): string {
    const rows = this.db.prepare("SELECT title FROM workspaces WHERE title LIKE 'Untitled Workspace%'").all() as Array<{
      title: string;
    }>;
    const used = new Set(rows.map((row) => row.title));
    let index = 1;
    while (used.has(`Untitled Workspace ${index}`)) {
      index += 1;
    }
    return `Untitled Workspace ${index}`;
  }
}

function defaultLayoutForWorkspace(workspace: Workspace): WorkspaceLayoutNode | null {
  const byArea = new Map(
    workspace.applets.map((instance) => {
      const area = instance.id.startsWith(`${workspace.id}-`) ? instance.id.slice(workspace.id.length + 1) : instance.id;
      return [area, instance.id];
    })
  );
  if (workspace.id === "atlas") {
    return split(
      `${workspace.id}-layout-root`,
      "row",
      0.337,
      split(`${workspace.id}-layout-left`, "column", 0.5, leaf("terminal", byArea), leaf("file-viewer", byArea)),
      split(
        `${workspace.id}-layout-right`,
        "row",
        0.533,
        split(`${workspace.id}-layout-middle`, "column", 0.5, leaf("browser", byArea), leaf("sandbox", byArea)),
        leaf("chat", byArea)
      )
    );
  }
  if (workspace.id === "redesign") {
    return split(
      `${workspace.id}-layout-root`,
      "row",
      0.45,
      leaf("file-viewer", byArea),
      split(`${workspace.id}-layout-right`, "column", 0.52, leaf("browser", byArea), leaf("chat", byArea))
    );
  }
  if (workspace.id === "lab") {
    return split(`${workspace.id}-layout-root`, "row", 0.52, leaf("sandbox", byArea), leaf("terminal", byArea));
  }
  if (workspace.id === "research") {
    return split(`${workspace.id}-layout-root`, "row", 0.56, leaf("browser", byArea), leaf("chat", byArea));
  }
  return layoutFromAppletIds(workspace.id, workspace.applets.map((instance) => instance.id));
}

function titleForAppletKind(kind: AppletKind): string {
  if (kind === "fileViewer") {
    return "File Viewer";
  }
  if (kind === "wslTerminal") {
    return "WSL Terminal";
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function insertAppletLeaf(
  layout: WorkspaceLayoutNode | null,
  appletInstanceId: string,
  targetLeafId: string | undefined,
  splitDirection: "row" | "column"
): WorkspaceLayoutNode {
  const leafNode: WorkspaceLayoutNode = {
    id: `leaf-${appletInstanceId}`,
    type: "leaf",
    appletInstanceId
  };
  if (!layout) {
    if (targetLeafId) {
      throw new Error(`Cannot split missing layout leaf ${targetLeafId}`);
    }
    return leafNode;
  }
  if (!targetLeafId) {
    return {
      id: `split-root-${appletInstanceId}`,
      type: "split",
      direction: splitDirection,
      ratio: 0.5,
      first: layout,
      second: leafNode
    };
  }
  const result = replaceLayoutLeaf(layout, targetLeafId, (targetLeaf) => ({
    id: `split-${targetLeaf.id}-${appletInstanceId}`,
    type: "split",
    direction: splitDirection,
    ratio: 0.5,
    first: targetLeaf,
    second: leafNode
  }));
  if (!result.replaced) {
    throw new Error(`Layout leaf ${targetLeafId} does not exist`);
  }
  return result.node;
}

function replaceLayoutLeaf(
  node: WorkspaceLayoutNode,
  leafId: string,
  replace: (leaf: WorkspaceLayoutLeaf) => WorkspaceLayoutNode
): { node: WorkspaceLayoutNode; replaced: boolean } {
  if (node.type === "leaf") {
    return node.id === leafId ? { node: replace(node), replaced: true } : { node, replaced: false };
  }
  const first = replaceLayoutLeaf(node.first, leafId, replace);
  if (first.replaced) {
    return { node: { ...node, first: first.node }, replaced: true };
  }
  const second = replaceLayoutLeaf(node.second, leafId, replace);
  if (second.replaced) {
    return { node: { ...node, second: second.node }, replaced: true };
  }
  return { node, replaced: false };
}

function removeAppletLeaf(layout: WorkspaceLayoutNode | null, appletInstanceId: string): WorkspaceLayoutNode | null {
  if (!layout) {
    throw new Error(`Applet instance ${appletInstanceId} is not mounted in the workspace layout`);
  }
  const result = removeAppletLeafFromNode(layout, appletInstanceId);
  if (!result.removed) {
    throw new Error(`Applet instance ${appletInstanceId} is not mounted in the workspace layout`);
  }
  return result.node;
}

function removeAppletLeafFromNode(
  node: WorkspaceLayoutNode,
  appletInstanceId: string
): { node: WorkspaceLayoutNode | null; removed: boolean } {
  if (node.type === "leaf") {
    return node.appletInstanceId === appletInstanceId ? { node: null, removed: true } : { node, removed: false };
  }
  const first = removeAppletLeafFromNode(node.first, appletInstanceId);
  if (first.removed) {
    return { node: first.node ? { ...node, first: first.node } : node.second, removed: true };
  }
  const second = removeAppletLeafFromNode(node.second, appletInstanceId);
  if (second.removed) {
    return { node: second.node ? { ...node, second: second.node } : node.first, removed: true };
  }
  return { node, removed: false };
}

function moveAppletLeaf(layout: WorkspaceLayoutNode | null, options: MoveAppletOptions): WorkspaceLayoutNode {
  if (!layout) {
    throw new Error(`Applet instance ${options.appletInstanceId} is not mounted in the workspace layout`);
  }
  const sourceLeaf = findAppletLeaf(layout, options.appletInstanceId);
  if (!sourceLeaf) {
    throw new Error(`Applet instance ${options.appletInstanceId} is not mounted in the workspace layout`);
  }
  if (options.targetLeafId && sourceLeaf.id === options.targetLeafId) {
    return layout;
  }
  const removed = removeAppletLeafFromNode(layout, options.appletInstanceId);
  if (!removed.removed || !removed.node) {
    return layout;
  }
  const movedLeaf: WorkspaceLayoutNode = { ...sourceLeaf };
  if (!options.targetLeafId) {
    return splitWithPlacement(
      `split-root-${options.appletInstanceId}-${randomUUID()}`,
      options.splitDirection,
      0.5,
      movedLeaf,
      removed.node,
      options.placement
    );
  }
  const inserted = replaceLayoutLeaf(removed.node, options.targetLeafId, (targetLeaf) =>
    splitWithPlacement(
      `split-${targetLeaf.id}-${options.appletInstanceId}-${randomUUID()}`,
      options.splitDirection,
      0.5,
      movedLeaf,
      targetLeaf,
      options.placement
    )
  );
  if (!inserted.replaced) {
    throw new Error(`Layout leaf ${options.targetLeafId} does not exist`);
  }
  return inserted.node;
}

function updateLayoutRatios(layout: WorkspaceLayoutNode, ratios: Record<string, number>): WorkspaceLayoutNode {
  const remaining = new Set(Object.keys(ratios));
  if (remaining.size === 0) {
    return layout;
  }
  const visit = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === "leaf") {
      return node;
    }
    const nextRatio = ratios[node.id];
    const hasRatio = Object.prototype.hasOwnProperty.call(ratios, node.id);
    if (hasRatio) {
      remaining.delete(node.id);
      if (!Number.isFinite(nextRatio) || nextRatio <= 0 || nextRatio >= 1) {
        throw new Error(`Workspace layout split ${node.id} has an invalid ratio update`);
      }
    }
    return {
      ...node,
      ratio: hasRatio ? nextRatio : node.ratio,
      first: visit(node.first),
      second: visit(node.second)
    };
  };
  const nextLayout = visit(layout);
  if (remaining.size > 0) {
    throw new Error(`Workspace layout ratio update references missing split(s): ${[...remaining].join(", ")}`);
  }
  return nextLayout;
}

function splitWithPlacement(
  id: string,
  direction: "row" | "column",
  ratio: number,
  movedLeaf: WorkspaceLayoutNode,
  targetNode: WorkspaceLayoutNode,
  placement: "first" | "second"
): WorkspaceLayoutNode {
  return {
    id,
    type: "split",
    direction,
    ratio,
    first: placement === "first" ? movedLeaf : targetNode,
    second: placement === "first" ? targetNode : movedLeaf
  };
}

function findAppletLeaf(node: WorkspaceLayoutNode, appletInstanceId: string): WorkspaceLayoutLeaf | null {
  if (node.type === "leaf") {
    return node.appletInstanceId === appletInstanceId ? node : null;
  }
  return findAppletLeaf(node.first, appletInstanceId) ?? findAppletLeaf(node.second, appletInstanceId);
}

function layoutFromAppletIds(workspaceId: string, appletIds: string[]): WorkspaceLayoutNode | null {
  if (appletIds.length === 0) {
    return null;
  }
  if (appletIds.length === 1) {
    return { id: `${workspaceId}-layout-${appletIds[0]}`, type: "leaf", appletInstanceId: appletIds[0] };
  }
  const [first, ...rest] = appletIds;
  return {
    id: `${workspaceId}-layout-split-${appletIds.length}`,
    type: "split",
    direction: "row",
    ratio: 1 / appletIds.length,
    first: { id: `${workspaceId}-layout-${first}`, type: "leaf", appletInstanceId: first },
    second: layoutFromAppletIds(workspaceId, rest) ?? {
      id: `${workspaceId}-layout-empty`,
      type: "leaf",
      appletInstanceId: first
    }
  };
}

function split(
  id: string,
  direction: "row" | "column",
  ratio: number,
  first: WorkspaceLayoutNode | null,
  second: WorkspaceLayoutNode | null
): WorkspaceLayoutNode | null {
  if (!first || !second) {
    return first ?? second;
  }
  return { id, type: "split", direction, ratio, first, second };
}

function leaf(area: string, byArea: Map<string, string>): WorkspaceLayoutNode | null {
  const appletInstanceId = byArea.get(area);
  return appletInstanceId ? { id: `leaf-${appletInstanceId}`, type: "leaf", appletInstanceId } : null;
}

function parseWorkspaceLayout(layoutJson: string, workspace: Workspace): WorkspaceLayoutNode | null {
  const parsed = JSON.parse(layoutJson) as unknown;
  if (parsed === null) {
    if (workspace.applets.length > 0) {
      throw new Error(`Workspace ${workspace.id} layout does not mount applet instance(s): ${workspace.applets.map((instance) => instance.id).join(", ")}`);
    }
    return null;
  }
  const graphLayout = layoutFromRemovedGraphFormat(parsed, workspace);
  if (graphLayout) {
    validateWorkspaceLayoutForWorkspace(graphLayout, workspace);
    return graphLayout;
  }
  const layout = assertWorkspaceLayoutNode(parsed, workspace.id);
  validateWorkspaceLayoutForWorkspace(layout, workspace);
  return layout;
}

function layoutFromRemovedGraphFormat(value: unknown, workspace: Workspace): WorkspaceLayoutNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const graph = value as { type?: unknown; panes?: unknown };
  if (graph.type !== "graph" || !Array.isArray(graph.panes)) {
    return null;
  }
  const mountedAppletIds = workspace.applets.map((instance) => instance.id);
  const mountedAppletSet = new Set(mountedAppletIds);
  const orderedGraphAppletIds = graph.panes
    .map((pane): { appletInstanceId: string; centerX: number; centerY: number } | null => {
      if (!pane || typeof pane !== "object") {
        return null;
      }
      const item = pane as { appletInstanceId?: unknown; rect?: unknown };
      if (typeof item.appletInstanceId !== "string" || !mountedAppletSet.has(item.appletInstanceId)) {
        return null;
      }
      const rect = item.rect && typeof item.rect === "object" ? item.rect as Record<string, unknown> : {};
      const x = typeof rect.x === "number" ? rect.x : 0;
      const y = typeof rect.y === "number" ? rect.y : 0;
      const width = typeof rect.width === "number" ? rect.width : 0;
      const height = typeof rect.height === "number" ? rect.height : 0;
      return { appletInstanceId: item.appletInstanceId, centerX: x + width / 2, centerY: y + height / 2 };
    })
    .filter((item): item is { appletInstanceId: string; centerX: number; centerY: number } => item !== null)
    .sort((left, right) => left.centerY - right.centerY || left.centerX - right.centerX || left.appletInstanceId.localeCompare(right.appletInstanceId))
    .map((item) => item.appletInstanceId);
  const uniqueGraphAppletIds = [...new Set(orderedGraphAppletIds)];
  const missingAppletIds = mountedAppletIds.filter((appletId) => !uniqueGraphAppletIds.includes(appletId));
  return layoutFromAppletIds(workspace.id, [...uniqueGraphAppletIds, ...missingAppletIds]);
}

function assertWorkspaceLayoutNode(value: unknown, workspaceId: string): WorkspaceLayoutNode {
  if (!value || typeof value !== "object") {
    throw new Error(`Workspace ${workspaceId} layout node must be an object`);
  }
  const node = value as Record<string, unknown>;
  if (typeof node.id !== "string") {
    throw new Error(`Workspace ${workspaceId} layout node is missing an id`);
  }
  if (node.type === "leaf") {
    if (typeof node.appletInstanceId !== "string") {
      throw new Error(`Workspace ${workspaceId} layout leaf ${node.id} is missing an applet instance id`);
    }
    return { id: node.id, type: "leaf", appletInstanceId: node.appletInstanceId };
  }
  if (node.type === "split") {
    if (node.direction !== "row" && node.direction !== "column") {
      throw new Error(`Workspace ${workspaceId} layout split ${node.id} has an invalid direction`);
    }
    if (typeof node.ratio !== "number" || node.ratio <= 0 || node.ratio >= 1) {
      throw new Error(`Workspace ${workspaceId} layout split ${node.id} has an invalid ratio`);
    }
    return {
      id: node.id,
      type: "split",
      direction: node.direction,
      ratio: node.ratio,
      first: assertWorkspaceLayoutNode(node.first, workspaceId),
      second: assertWorkspaceLayoutNode(node.second, workspaceId)
    };
  }
  throw new Error(`Workspace ${workspaceId} layout node ${node.id} has an invalid type`);
}

function collectLayoutAppletIds(layout: WorkspaceLayoutNode): Set<string> {
  if (layout.type === "leaf") {
    return new Set([layout.appletInstanceId]);
  }
  return new Set([...collectLayoutAppletIds(layout.first), ...collectLayoutAppletIds(layout.second)]);
}

function validateWorkspaceLayoutForWorkspace(layout: WorkspaceLayoutNode, workspace: Workspace): void {
  const mountedAppletIds = new Set(workspace.applets.map((instance) => instance.id));
  const nodeIds = new Set<string>();
  const leafAppletIds = new Set<string>();
  const visit = (node: WorkspaceLayoutNode) => {
    if (!node.id || nodeIds.has(node.id)) {
      throw new Error(`Workspace ${workspace.id} layout contains duplicate node id ${node.id}`);
    }
    nodeIds.add(node.id);
    if (node.type === "leaf") {
      if (!mountedAppletIds.has(node.appletInstanceId)) {
        throw new Error(`Workspace ${workspace.id} layout references missing applet instance ${node.appletInstanceId}`);
      }
      if (leafAppletIds.has(node.appletInstanceId)) {
        throw new Error(`Workspace ${workspace.id} layout mounts applet instance ${node.appletInstanceId} more than once`);
      }
      leafAppletIds.add(node.appletInstanceId);
      return;
    }
    if (node.direction !== "row" && node.direction !== "column") {
      throw new Error(`Workspace ${workspace.id} layout split ${node.id} has an invalid direction`);
    }
    if (!Number.isFinite(node.ratio) || node.ratio <= 0 || node.ratio >= 1) {
      throw new Error(`Workspace ${workspace.id} layout split ${node.id} has an invalid ratio`);
    }
    visit(node.first);
    visit(node.second);
  };
  visit(layout);
  if (leafAppletIds.size !== mountedAppletIds.size) {
    const missing = [...mountedAppletIds].filter((appletId) => !leafAppletIds.has(appletId));
    throw new Error(`Workspace ${workspace.id} layout does not mount applet instance(s): ${missing.join(", ")}`);
  }
}
