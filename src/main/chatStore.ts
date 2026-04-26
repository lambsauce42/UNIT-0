import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  ChatMessageRole,
  ChatMessageStatus,
  ChatModel,
  ChatProject,
  ChatRuntimeSettings,
  ChatState,
  ChatThread
} from "../shared/types.js";

type ChatProjectRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type ChatThreadRow = ChatProjectRow & {
  project_id: string;
};

type ChatMessageRow = {
  id: string;
  thread_id: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  created_at: string;
  updated_at: string;
};

type ChatModelRow = {
  id: string;
  label: string;
  path: string;
  created_at: string;
};

const DEFAULT_RUNTIME_SETTINGS: ChatRuntimeSettings = {
  nCtx: 4096,
  nGpuLayers: -1,
  temperature: 0.7,
  repeatPenalty: 1.1,
  maxTokens: 1024
};

export class ChatStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.seedIfEmpty();
  }

  loadState(): Omit<ChatState, "generation"> {
    this.seedIfEmpty();
    const projects = (this.db
      .prepare("SELECT id, title, created_at, updated_at FROM chat_projects ORDER BY sort_order")
      .all() as ChatProjectRow[]).map(projectFromRow);
    const threads = (this.db
      .prepare("SELECT id, project_id, title, created_at, updated_at FROM chat_threads ORDER BY sort_order")
      .all() as ChatThreadRow[]).map(threadFromRow);
    const messages = (this.db
      .prepare("SELECT id, thread_id, role, content, status, created_at, updated_at FROM chat_messages ORDER BY sort_order")
      .all() as ChatMessageRow[]).map(messageFromRow);
    const models = (this.db
      .prepare("SELECT id, label, path, created_at FROM chat_models ORDER BY sort_order")
      .all() as ChatModelRow[]).map(modelFromRow);
    const selectedProjectId = this.setting("selected_project_id") || projects[0]?.id || "";
    const selectedThreadId = this.setting("selected_thread_id") || threads.find((thread) => thread.projectId === selectedProjectId)?.id || threads[0]?.id || "";
    const selectedModelId = this.setting("selected_model_id");
    return {
      projects,
      threads,
      messages,
      models,
      selectedProjectId,
      selectedThreadId,
      selectedModelId,
      runtimeSettings: this.runtimeSettings()
    };
  }

  createThread(): ChatThread {
    const state = this.loadState();
    const projectId = state.selectedProjectId || state.projects[0]?.id;
    if (!projectId) {
      throw new Error("Cannot create a chat thread without a chat project.");
    }
    const now = timestamp();
    const title = this.nextThreadTitle(projectId);
    const thread: ChatThread = {
      id: `chat-thread-${randomUUID()}`,
      projectId,
      title,
      createdAt: now,
      updatedAt: now
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)")
        .run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.updatedAt, this.nextSortOrder("chat_threads"));
      this.setSettingInTransaction("selected_project_id", thread.projectId);
      this.setSettingInTransaction("selected_thread_id", thread.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return thread;
  }

  selectThread(threadId: string): void {
    const thread = this.db.prepare("SELECT id, project_id FROM chat_threads WHERE id = ?").get(threadId) as
      | { id: string; project_id: string }
      | undefined;
    if (!thread) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setSettingInTransaction("selected_project_id", thread.project_id);
      this.setSettingInTransaction("selected_thread_id", thread.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addLocalModel(modelPath: string): ChatModel {
    const resolvedPath = path.resolve(modelPath.trim());
    if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      throw new Error(`Model file not found: ${resolvedPath}`);
    }
    if (path.extname(resolvedPath).toLowerCase() !== ".gguf") {
      throw new Error(`Local model must be a GGUF file: ${resolvedPath}`);
    }
    const existing = this.db.prepare("SELECT id FROM chat_models WHERE path = ?").get(resolvedPath) as { id: string } | undefined;
    if (existing) {
      this.selectModel(existing.id);
      return this.loadState().models.find((model) => model.id === existing.id)!;
    }
    const now = timestamp();
    const model: ChatModel = {
      id: `chat-model-${randomUUID()}`,
      label: path.basename(resolvedPath, path.extname(resolvedPath)),
      path: resolvedPath,
      createdAt: now
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO chat_models (id, label, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)")
        .run(model.id, model.label, model.path, model.createdAt, this.nextSortOrder("chat_models"));
      this.setSettingInTransaction("selected_model_id", model.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return model;
  }

  selectModel(modelId: string): void {
    const model = this.db.prepare("SELECT id FROM chat_models WHERE id = ?").get(modelId) as { id: string } | undefined;
    if (!model) {
      throw new Error(`Chat model does not exist: ${modelId}`);
    }
    this.setSetting("selected_model_id", model.id);
  }

  createMessage(threadId: string, role: ChatMessageRole, content: string, status: ChatMessageStatus): ChatMessage {
    const thread = this.db.prepare("SELECT id FROM chat_threads WHERE id = ?").get(threadId) as { id: string } | undefined;
    if (!thread) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    const now = timestamp();
    const message: ChatMessage = {
      id: `chat-message-${randomUUID()}`,
      threadId,
      role,
      content,
      status,
      createdAt: now,
      updatedAt: now
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO chat_messages (id, thread_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(message.id, message.threadId, message.role, message.content, message.status, message.createdAt, message.updatedAt, this.nextSortOrder("chat_messages"));
      this.touchThreadInTransaction(threadId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return message;
  }

  messageCount(threadId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE thread_id = ?").get(threadId) as { count: number };
    return row.count;
  }

  renameThread(threadId: string, title: string): void {
    const normalizedTitle = title.trim().split(/\s+/).join(" ").slice(0, 80);
    if (!normalizedTitle) {
      return;
    }
    const row = this.db.prepare("SELECT project_id FROM chat_threads WHERE id = ?").get(threadId) as
      | { project_id: string }
      | undefined;
    if (!row) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?").run(normalizedTitle, now, threadId);
      this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id = ?").run(now, row.project_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendToMessage(messageId: string, contentDelta: string): void {
    if (!contentDelta) {
      return;
    }
    const row = this.db.prepare("SELECT thread_id, content FROM chat_messages WHERE id = ?").get(messageId) as
      | { thread_id: string; content: string }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE chat_messages SET content = ?, updated_at = ? WHERE id = ?")
        .run(`${row.content}${contentDelta}`, now, messageId);
      this.touchThreadInTransaction(row.thread_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateMessageStatus(messageId: string, status: ChatMessageStatus): void {
    const row = this.db.prepare("SELECT thread_id FROM chat_messages WHERE id = ?").get(messageId) as
      | { thread_id: string }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE chat_messages SET status = ?, updated_at = ? WHERE id = ?").run(status, now, messageId);
      this.touchThreadInTransaction(row.thread_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES chat_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'interrupted', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_models (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private seedIfEmpty(): void {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chat_projects").get() as { count: number };
    if (row.count > 0) {
      return;
    }
    const now = timestamp();
    const projectId = "chat-project-default";
    const threadId = "chat-thread-default";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO chat_projects (id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, 0)")
        .run(projectId, "Project 1", now, now);
      this.db
        .prepare("INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, 0)")
        .run(threadId, projectId, "Thread 1", now, now);
      this.setSettingInTransaction("selected_project_id", projectId);
      this.setSettingInTransaction("selected_thread_id", threadId);
      this.setSettingInTransaction("runtime_settings_json", JSON.stringify(DEFAULT_RUNTIME_SETTINGS));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private runtimeSettings(): ChatRuntimeSettings {
    const raw = this.setting("runtime_settings_json");
    if (!raw) {
      return DEFAULT_RUNTIME_SETTINGS;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ChatRuntimeSettings>;
      return normalizeRuntimeSettings(parsed);
    } catch {
      return DEFAULT_RUNTIME_SETTINGS;
    }
  }

  private setting(key: string): string {
    const row = this.db.prepare("SELECT value FROM chat_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? "";
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  private setSettingInTransaction(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  private nextThreadTitle(projectId: string): string {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM chat_threads WHERE project_id = ?")
      .get(projectId) as { count: number };
    return `Thread ${row.count + 1}`;
  }

  private nextSortOrder(table: "chat_threads" | "chat_messages" | "chat_models"): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${table}`).get() as { next: number };
    return row.next;
  }

  private touchThreadInTransaction(threadId: string, updatedAt: string): void {
    const thread = this.db.prepare("SELECT project_id FROM chat_threads WHERE id = ?").get(threadId) as
      | { project_id: string }
      | undefined;
    if (!thread) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    this.db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(updatedAt, threadId);
    this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id = ?").run(updatedAt, thread.project_id);
  }
}

function projectFromRow(row: ChatProjectRow): ChatProject {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function threadFromRow(row: ChatThreadRow): ChatThread {
  return { id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function messageFromRow(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function modelFromRow(row: ChatModelRow): ChatModel {
  return { id: row.id, label: row.label, path: row.path, createdAt: row.created_at };
}

function normalizeRuntimeSettings(value: Partial<ChatRuntimeSettings>): ChatRuntimeSettings {
  return {
    nCtx: positiveInteger(value.nCtx, DEFAULT_RUNTIME_SETTINGS.nCtx),
    nGpuLayers: Number.isInteger(value.nGpuLayers) ? value.nGpuLayers! : DEFAULT_RUNTIME_SETTINGS.nGpuLayers,
    temperature: finiteNumber(value.temperature, DEFAULT_RUNTIME_SETTINGS.temperature),
    repeatPenalty: finiteNumber(value.repeatPenalty, DEFAULT_RUNTIME_SETTINGS.repeatPenalty),
    maxTokens: positiveInteger(value.maxTokens, DEFAULT_RUNTIME_SETTINGS.maxTokens)
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function timestamp(): string {
  return new Date().toISOString();
}
