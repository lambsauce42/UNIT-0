import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatActionButton,
  ChatAttachment,
  ChatAppSettings,
  ChatBuiltinAgenticFramework,
  ChatCodexApprovalMode,
  ChatDocumentIndex,
  ChatMessage,
  ChatMessageRole,
  ChatMessageStatus,
  ChatModel,
  ChatCodexModel,
  ChatContextMarker,
  ChatPermissionMode,
  ChatProject,
  ChatProviderMode,
  ChatReasoningEffort,
  ChatRuntimeSettings,
  ChatSettingsPreset,
  ChatState,
  ChatTimelineBlock,
  ChatThread,
  ChatUsageIndicatorId,
  ChatUsageIndicatorPreference
} from "../shared/types.js";

type ChatProjectRow = {
  id: string;
  title: string;
  directory: string;
  action_buttons_json: string | null;
  created_at: string;
  updated_at: string;
};

type ChatThreadRow = ChatProjectRow & {
  project_id: string;
  provider_mode: string | null;
  selected_settings_preset_id: string | null;
  builtin_model_id: string | null;
  runtime_settings_json: string | null;
  builtin_agentic_framework: string | null;
  document_analysis_embedding_model_path: string | null;
  codex_model_id: string | null;
  codex_reasoning_effort: string | null;
  permission_mode: string | null;
  codex_approval_mode: string | null;
  plan_mode_enabled: number | null;
  document_index_id: string | null;
  codex_last_session_id: string | null;
  open_code_session_id: string | null;
  remote_session_id: string | null;
  remote_slot_id: number | null;
  remote_settings_signature: string | null;
  remote_host_identity: string | null;
  active_context_start_message_index: number | null;
  context_revision: number | null;
  context_markers_json: string | null;
};

type ChatMessageRow = {
  id: string;
  thread_id: string;
  role: ChatMessageRole;
  content: string;
  attachments_json: string | null;
  label: string | null;
  source_label: string | null;
  reasoning: string | null;
  metadata_json: string | null;
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

type ChatDocumentIndexRow = {
  id: string;
  project_id: string;
  title: string;
  source_path: string;
  embedding_model_path: string | null;
  state: string;
  progress: number | null;
  message: string | null;
  created_at: string;
  updated_at: string;
};

type LegacyHistoryImport = {
  projects: Array<ChatProject & { expanded: boolean }>;
  threads: ChatThread[];
  messages: ChatMessage[];
  selectedProjectId: string;
  selectedThreadId: string;
  sourcePath: string;
};

export type ChatDocumentSearchEntry = {
  chunkId: string;
  resultId: string;
  sourceId?: string;
  sourceTitle: string;
  sourcePath: string;
  sectionLabel?: string;
  candidateCount?: number;
  truncated?: boolean;
  pageStart: number;
  pageEnd: number;
  text: string;
  tokenCount: number;
  score: number;
  ordinalStart: number;
  ordinalEnd: number;
};

type ChatDocumentChunkInput = Omit<ChatDocumentSearchEntry, "resultId" | "score"> & {
  embedding?: number[];
};

type ChatDocumentChunkRow = ChatDocumentSearchEntry & {
  embedding?: number[];
};

type ResidentDocumentVectorIndex = {
  documentIndexId: string;
  updatedAt: string;
  rows: ChatDocumentChunkRow[];
  missingEmbeddings: boolean;
};

const MIN_DOCUMENT_VECTOR_SCORE = 0.6;
const MAX_RESIDENT_DOCUMENT_VECTOR_INDEXES = 3;

const DEFAULT_RUNTIME_SETTINGS: ChatRuntimeSettings = {
  nCtx: 32768,
  nGpuLayers: -1,
  temperature: 1.0,
  repeatPenalty: 1.0,
  maxTokens: 32768,
  reasoningEffort: "medium",
  permissionMode: "full_access",
  trimReserveTokens: 2000,
  trimReservePercent: 15,
  trimAmountTokens: 4000,
  trimAmountPercent: 30,
  systemPrompt: "When writing math, keep explanatory prose outside display-math environments; use normal sentences for labels or setup text, and reserve display math for the equations themselves. Do not put headings, captions, or narrative text inside aligned/align/gathered math blocks unless the user explicitly asks for raw LaTeX structure. If a line contains only an equation, format it as display math rather than inline math so it renders as a centered equation block."
};

const DEFAULT_APP_SETTINGS: ChatAppSettings = {
  usageIndicatorPlacement: "footer",
  usageIndicatorOrder: ["git_diff", "context", "week", "five_hour"],
  usageIndicatorPreferences: {
    git_diff: { displayMode: "bar", placement: "bottom", order: 1 },
    context: { displayMode: "bar", placement: "bottom", order: 2 },
    week: { displayMode: "circle", placement: "left", order: 1 },
    five_hour: { displayMode: "circle", placement: "right", order: 1 }
  },
  actionButtons: [],
  expandedProjectIds: [],
  autoExpandCodexDisclosures: true,
  tokenizerModelPath: "",
  remoteHostAddress: "",
  remoteHostPort: 14555,
  remotePairingCode: "",
  remoteHostId: "",
  remoteHostIdentity: "",
  remoteProtocolVersion: ""
};

const DEFAULT_SETTINGS_PRESET_ID = "custom::default";
const presetRuntimeSettings = (settings: Partial<ChatRuntimeSettings>): Omit<ChatRuntimeSettings, "permissionMode"> => {
  const { permissionMode: _permissionMode, ...runtimeSettings } = normalizeRuntimeSettings(settings);
  return runtimeSettings;
};
const DEFAULT_CODEX_PRESET_ICON_NAME = "openai";
const SETTINGS_PRESET_ICON_NAMES = new Set([
  "sliders",
  "openai",
  "bolt",
  "brain",
  "brand",
  "settings",
  "list",
  "folder",
  "git_branch"
]);

export const DEFAULT_CODEX_MODELS: ChatCodexModel[] = [
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    isDefault: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsImageInput: true
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    isDefault: false,
    reasoningEfforts: ["low", "medium", "high"],
    supportsImageInput: true
  }
];

const DEFAULT_SETTINGS_PRESETS: ChatSettingsPreset[] = [
  {
    id: DEFAULT_SETTINGS_PRESET_ID,
    label: "Default",
    runtimeSettings: presetRuntimeSettings(DEFAULT_RUNTIME_SETTINGS),
    providerMode: "builtin",
    iconName: "sliders",
    builtinModelId: "",
    builtinAgenticFramework: "chat",
    documentAnalysisEmbeddingModelPath: "",
    codexModelId: defaultCodexModelId(),
    codexReasoningEffort: "medium",
    builtIn: false,
    editable: true,
    deletable: false
  },
  {
    id: "builtin::fast",
    label: "Fast",
    runtimeSettings: presetRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, nCtx: 4096, maxTokens: 4096, reasoningEffort: "low" }),
    providerMode: "builtin",
    iconName: "bolt",
    builtinModelId: "",
    builtinAgenticFramework: "chat",
    documentAnalysisEmbeddingModelPath: "",
    codexModelId: defaultCodexModelId(),
    codexReasoningEffort: "medium",
    builtIn: true,
    editable: true,
    deletable: true
  },
  {
    id: "builtin::deep",
    label: "Deep",
    runtimeSettings: presetRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, nCtx: 16384, maxTokens: 16384, reasoningEffort: "high" }),
    providerMode: "builtin",
    iconName: "brain",
    builtinModelId: "",
    builtinAgenticFramework: "chat",
    documentAnalysisEmbeddingModelPath: "",
    codexModelId: defaultCodexModelId(),
    codexReasoningEffort: "medium",
    builtIn: true,
    editable: true,
    deletable: true
  }
];

export class ChatStore {
  private readonly db: DatabaseSync;
  private readonly documentVectorIndexes = new Map<string, ResidentDocumentVectorIndex>();

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.markStreamingMessagesInterrupted();
    this.importLegacyHistoryIfEmpty();
    this.seedIfEmpty();
    this.repairLegacySettingsPresetAccessState();
    this.repairLegacySettingsPresetCodexModelState();
    this.migrateProjectActionButtonsToAppSettings();
  }

  loadState(): Omit<ChatState, "generation" | "contextUsage"> {
    this.seedIfEmpty();
    const projects = (this.db
      .prepare(
        `SELECT id, title, COALESCE(directory, '') AS directory,
                COALESCE(action_buttons_json, '[]') AS action_buttons_json,
                created_at, updated_at
         FROM chat_projects ORDER BY sort_order`
      )
      .all() as ChatProjectRow[]).map(projectFromRow);
    const threads = (this.db
      .prepare(
        `SELECT id, project_id, title,
                COALESCE(provider_mode, 'builtin') AS provider_mode,
                COALESCE(selected_settings_preset_id, 'custom::default') AS selected_settings_preset_id,
                COALESCE(builtin_model_id, '') AS builtin_model_id,
                runtime_settings_json,
                COALESCE(builtin_agentic_framework, 'chat') AS builtin_agentic_framework,
                COALESCE(document_analysis_embedding_model_path, '') AS document_analysis_embedding_model_path,
                COALESCE(codex_model_id, 'gpt-5.3-codex') AS codex_model_id,
                COALESCE(codex_reasoning_effort, 'medium') AS codex_reasoning_effort,
                COALESCE(permission_mode, 'full_access') AS permission_mode,
                COALESCE(codex_approval_mode, 'default') AS codex_approval_mode,
                COALESCE(plan_mode_enabled, 0) AS plan_mode_enabled,
                COALESCE(document_index_id, '') AS document_index_id,
                COALESCE(codex_last_session_id, '') AS codex_last_session_id,
                COALESCE(open_code_session_id, '') AS open_code_session_id,
                COALESCE(remote_session_id, '') AS remote_session_id,
                COALESCE(remote_slot_id, 0) AS remote_slot_id,
                COALESCE(remote_settings_signature, '') AS remote_settings_signature,
                COALESCE(remote_host_identity, '') AS remote_host_identity,
                COALESCE(active_context_start_message_index, 0) AS active_context_start_message_index,
                COALESCE(context_revision, 0) AS context_revision,
                COALESCE(context_markers_json, '[]') AS context_markers_json,
                created_at, updated_at
         FROM chat_threads ORDER BY sort_order`
      )
      .all() as ChatThreadRow[]).map(threadFromRow);
    const messages = (this.db
      .prepare(
        `SELECT id, thread_id, role, content,
                COALESCE(attachments_json, '[]') AS attachments_json,
                label,
                source_label,
                reasoning,
                metadata_json,
                status, created_at, updated_at
         FROM chat_messages ORDER BY sort_order`
      )
      .all() as ChatMessageRow[]).map(messageFromRow);
    const models = (this.db
      .prepare("SELECT id, label, path, created_at FROM chat_models ORDER BY sort_order")
      .all() as ChatModelRow[]).map(modelFromRow);
    const remoteModels = parseJsonArray<ChatModel>(this.setting("remote_models_json"), []).map(normalizeRemoteModel).filter((model) => model.id);
    const documentIndexes = (this.db
      .prepare(
        `SELECT id, project_id, title, source_path, COALESCE(embedding_model_path, '') AS embedding_model_path, state,
                COALESCE(progress, 0) AS progress,
                COALESCE(message, '') AS message,
                created_at, updated_at
         FROM chat_document_indexes ORDER BY sort_order`
      )
      .all() as ChatDocumentIndexRow[]).map(documentIndexFromRow);
    const selectedProjectId = this.setting("selected_project_id") || projects[0]?.id || "";
    const selectedThreadId = this.setting("selected_thread_id") || threads.find((thread) => thread.projectId === selectedProjectId)?.id || threads[0]?.id || "";
    const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
    const selectedModelId = selectedThread?.builtinModelId || this.setting("selected_model_id");
    const globalRuntimeSettings = this.runtimeSettings();
    return {
      projects,
      threads,
      messages,
      models: [...models, ...remoteModels],
      codexModels: DEFAULT_CODEX_MODELS,
      codexAccount: { status: "unknown" },
      settingsPresets: this.settingsPresets(),
      documentIndexes,
      selectedProjectId,
      selectedThreadId,
      selectedModelId,
      runtimeSettings: selectedThread?.runtimeSettings ?? globalRuntimeSettings,
      appSettings: this.appSettings(),
      queuedSubmissions: []
    };
  }

  createProject(): ChatProject {
    const state = this.loadState();
    const now = timestamp();
    const project: ChatProject = {
      id: `chat-project-${randomUUID()}`,
      title: `Project ${state.projects.length + 1}`,
      directory: "",
      actionButtons: [],
      createdAt: now,
      updatedAt: now
    };
    const thread: ChatThread = {
      id: `chat-thread-${randomUUID()}`,
      projectId: project.id,
      title: "Thread 1",
      providerMode: "builtin",
      selectedSettingsPresetId: DEFAULT_SETTINGS_PRESET_ID,
      builtinModelId: "",
      runtimeSettings: DEFAULT_RUNTIME_SETTINGS,
      builtinAgenticFramework: "chat",
      documentAnalysisEmbeddingModelPath: "",
      codexModelId: defaultCodexModelId(),
      codexReasoningEffort: "medium",
      permissionMode: DEFAULT_RUNTIME_SETTINGS.permissionMode,
      codexApprovalMode: codexApprovalModeForAccessMode(DEFAULT_RUNTIME_SETTINGS.permissionMode),
      planModeEnabled: false,
      documentIndexId: "",
      codexLastSessionId: "",
      openCodeSessionId: "",
      remoteSessionId: "",
      remoteSlotId: 0,
      remoteSettingsSignature: "",
      remoteHostIdentity: "",
      activeContextStartMessageIndex: 0,
      contextRevision: 0,
      contextMarkers: [],
      createdAt: now,
      updatedAt: now
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO chat_projects (id, title, directory, action_buttons_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(project.id, project.title, project.directory, JSON.stringify(project.actionButtons), project.createdAt, project.updatedAt, this.nextSortOrder("chat_projects"));
      this.db
        .prepare(`INSERT INTO chat_threads
          (id, project_id, title, runtime_settings_json, permission_mode, codex_approval_mode, created_at, updated_at, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          thread.id,
          thread.projectId,
          thread.title,
          JSON.stringify(thread.runtimeSettings),
          thread.permissionMode,
          thread.codexApprovalMode,
          thread.createdAt,
          thread.updatedAt,
          this.nextSortOrder("chat_threads")
        );
      this.setSettingInTransaction("selected_project_id", project.id);
      this.setSettingInTransaction("selected_thread_id", thread.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return project;
  }

  selectProject(projectId: string): void {
    const project = this.db.prepare("SELECT id FROM chat_projects WHERE id = ?").get(projectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Chat project does not exist: ${projectId}`);
    }
    const thread = this.db
      .prepare("SELECT id FROM chat_threads WHERE project_id = ? ORDER BY sort_order LIMIT 1")
      .get(projectId) as { id: string } | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setSettingInTransaction("selected_project_id", project.id);
      this.setSettingInTransaction("selected_thread_id", thread?.id ?? "");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createThread(projectId?: string): ChatThread {
    const state = this.loadState();
    const targetProjectId = projectId?.trim() || state.selectedProjectId || state.projects[0]?.id;
    if (!targetProjectId) {
      throw new Error("Cannot create a chat thread without a chat project.");
    }
    const project = this.db.prepare("SELECT id FROM chat_projects WHERE id = ?").get(targetProjectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Chat project does not exist: ${targetProjectId}`);
    }
    const now = timestamp();
    const title = this.nextThreadTitle(targetProjectId);
    const templateThread = state.threads.find((item) => item.id === state.selectedThreadId);
    const thread: ChatThread = {
      id: `chat-thread-${randomUUID()}`,
      projectId: targetProjectId,
      title,
      providerMode: templateThread?.providerMode ?? "builtin",
      selectedSettingsPresetId: templateThread?.selectedSettingsPresetId ?? DEFAULT_SETTINGS_PRESET_ID,
      builtinModelId: templateThread?.builtinModelId ?? "",
      runtimeSettings: templateThread?.runtimeSettings ?? DEFAULT_RUNTIME_SETTINGS,
      builtinAgenticFramework: templateThread?.builtinAgenticFramework ?? "chat",
      documentAnalysisEmbeddingModelPath: templateThread?.documentAnalysisEmbeddingModelPath ?? "",
      codexModelId: templateThread?.codexModelId ?? defaultCodexModelId(),
      codexReasoningEffort: templateThread?.codexReasoningEffort ?? "medium",
      permissionMode: templateThread?.permissionMode ?? DEFAULT_RUNTIME_SETTINGS.permissionMode,
      codexApprovalMode: syncedCodexApprovalMode(templateThread?.permissionMode ?? DEFAULT_RUNTIME_SETTINGS.permissionMode, templateThread?.codexApprovalMode ?? "default", false),
      planModeEnabled: templateThread?.planModeEnabled ?? false,
      documentIndexId: "",
      codexLastSessionId: "",
      openCodeSessionId: "",
      remoteSessionId: "",
      remoteSlotId: 0,
      remoteSettingsSignature: "",
      remoteHostIdentity: "",
      activeContextStartMessageIndex: 0,
      contextRevision: 0,
      contextMarkers: [],
      createdAt: now,
      updatedAt: now
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO chat_threads
          (id, project_id, title, provider_mode, selected_settings_preset_id, builtin_model_id, runtime_settings_json, builtin_agentic_framework,
           document_analysis_embedding_model_path, codex_model_id, codex_reasoning_effort, permission_mode, codex_approval_mode, plan_mode_enabled,
           document_index_id, codex_last_session_id, open_code_session_id, remote_session_id, remote_slot_id, remote_settings_signature, remote_host_identity, created_at, updated_at, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          thread.id,
          thread.projectId,
          thread.title,
          thread.providerMode,
          thread.selectedSettingsPresetId,
          thread.builtinModelId,
          JSON.stringify(thread.runtimeSettings),
          thread.builtinAgenticFramework,
          thread.documentAnalysisEmbeddingModelPath,
          thread.codexModelId,
          thread.codexReasoningEffort,
          thread.permissionMode,
          thread.codexApprovalMode,
          thread.planModeEnabled ? 1 : 0,
          thread.documentIndexId,
          thread.codexLastSessionId,
          thread.openCodeSessionId,
          thread.remoteSessionId,
          thread.remoteSlotId,
          thread.remoteSettingsSignature,
          thread.remoteHostIdentity,
          thread.createdAt,
          thread.updatedAt,
          this.nextSortOrder("chat_threads")
        );
      this.setSettingInTransaction("selected_project_id", thread.projectId);
      this.setSettingInTransaction("selected_thread_id", thread.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return thread;
  }

  renameProject(projectId: string, title: string): void {
    this.updateProjectSettings(projectId, title, undefined);
  }

  updateProjectSettings(projectId: string, title: string, directory: string | undefined): void {
    const normalizedTitle = normalizeTitle(title, 80);
    if (!normalizedTitle) {
      return;
    }
    const project = this.db.prepare("SELECT id FROM chat_projects WHERE id = ?").get(projectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Chat project does not exist: ${projectId}`);
    }
    this.db
      .prepare("UPDATE chat_projects SET title = ?, directory = COALESCE(?, directory), updated_at = ? WHERE id = ?")
      .run(normalizedTitle, directory ?? null, timestamp(), project.id);
  }

  deleteProject(projectId: string): void {
    const project = this.db.prepare("SELECT id FROM chat_projects WHERE id = ?").get(projectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Chat project does not exist: ${projectId}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM chat_projects WHERE id = ?").run(project.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.ensureSelection();
  }

  moveProject(projectId: string, targetProjectId: string, position: "before" | "after"): void {
    if (projectId === targetProjectId) {
      return;
    }
    const rows = this.db
      .prepare("SELECT id FROM chat_projects ORDER BY sort_order")
      .all() as Array<{ id: string }>;
    const ids = rows.map((row) => row.id);
    if (!ids.includes(projectId)) {
      throw new Error(`Chat project does not exist: ${projectId}`);
    }
    const targetIndex = ids.indexOf(targetProjectId);
    if (targetIndex < 0) {
      throw new Error(`Chat project does not exist: ${targetProjectId}`);
    }
    const withoutMoving = ids.filter((id) => id !== projectId);
    const nextTargetIndex = withoutMoving.indexOf(targetProjectId);
    const insertIndex = position === "after" ? nextTargetIndex + 1 : nextTargetIndex;
    withoutMoving.splice(insertIndex, 0, projectId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE chat_projects SET sort_order = ?, updated_at = ? WHERE id = ?");
      const now = timestamp();
      withoutMoving.forEach((id, index) => update.run(index, now, id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      providerId: "local",
      reference: resolvedPath,
      sourceLabel: "Built-in",
      hostId: "",
      createdAt: now
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO chat_models (id, label, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)")
        .run(model.id, model.label, model.path, model.createdAt, this.nextSortOrder("chat_models"));
      this.setSettingInTransaction("selected_model_id", model.id);
      const threadId = this.setting("selected_thread_id");
      if (threadId) {
        this.db.prepare("UPDATE chat_threads SET selected_settings_preset_id = ?, builtin_model_id = ?, updated_at = ? WHERE id = ?").run(DEFAULT_SETTINGS_PRESET_ID, model.id, now, threadId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return model;
  }

  selectModel(modelId: string): void {
    const model = this.loadState().models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`Chat model does not exist: ${modelId}`);
    }
    const threadId = this.setting("selected_thread_id");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setSettingInTransaction("selected_model_id", model.id);
      if (threadId) {
        this.db.prepare("UPDATE chat_threads SET selected_settings_preset_id = ?, builtin_model_id = ?, updated_at = ? WHERE id = ?").run(DEFAULT_SETTINGS_PRESET_ID, model.id, timestamp(), threadId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  refreshLocalModels(): { removedModelIds: string[]; selectedModelId: string } {
    const models = this.loadState().models;
    const removedModelIds = models
      .filter((model) => !fs.existsSync(model.path) || !fs.statSync(model.path).isFile() || path.extname(model.path).toLowerCase() !== ".gguf")
      .map((model) => model.id);
    if (removedModelIds.length === 0) {
      return { removedModelIds, selectedModelId: this.setting("selected_model_id") };
    }
    const placeholders = removedModelIds.map(() => "?").join(", ");
    const remainingModel = this.db.prepare(`SELECT id FROM chat_models WHERE id NOT IN (${placeholders}) ORDER BY sort_order LIMIT 1`).get(...removedModelIds) as
      | { id: string }
      | undefined;
    const nextSelectedModelId = remainingModel?.id ?? "";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM chat_models WHERE id IN (${placeholders})`).run(...removedModelIds);
      this.db.prepare(`UPDATE chat_threads SET builtin_model_id = '', updated_at = ? WHERE builtin_model_id IN (${placeholders})`).run(timestamp(), ...removedModelIds);
      this.setSettingInTransaction("selected_model_id", nextSelectedModelId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { removedModelIds, selectedModelId: nextSelectedModelId };
  }

  replaceRemoteModels(models: ChatModel[], host: { hostId: string; hostIdentity: string; protocolVersion: string }): void {
    const remoteModels = models.map(normalizeRemoteModel).filter((model) => model.providerId === "remote" && model.id);
    this.setSetting("remote_models_json", JSON.stringify(remoteModels));
    this.updateAppSettings({
      remoteHostId: host.hostId,
      remoteHostIdentity: host.hostIdentity,
      remoteProtocolVersion: host.protocolVersion
    });
  }

  clearRemoteModels(): void {
    this.setSetting("remote_models_json", "[]");
    this.updateAppSettings({
      remoteHostId: "",
      remoteHostIdentity: "",
      remoteProtocolVersion: ""
    });
  }

  createMessage(
    threadId: string,
    role: ChatMessageRole,
    content: string,
    status: ChatMessageStatus,
    options: {
      attachments?: ChatAttachment[];
      label?: string;
      sourceLabel?: string;
      reasoning?: string;
      metadata?: Record<string, unknown>;
      timelineBlocks?: ChatTimelineBlock[];
    } = {}
  ): ChatMessage {
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
      attachments: options.attachments ?? [],
      label: options.label,
      sourceLabel: options.sourceLabel,
      reasoning: options.reasoning,
      timelineBlocks: options.timelineBlocks,
      metadata: options.timelineBlocks ? { ...(options.metadata ?? {}), timelineBlocks: options.timelineBlocks } : options.metadata,
      status,
      createdAt: now,
      updatedAt: now
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO chat_messages
            (id, thread_id, role, content, attachments_json, label, source_label, reasoning, metadata_json, status, created_at, updated_at, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          message.id,
          message.threadId,
          message.role,
          message.content,
          JSON.stringify(message.attachments),
          message.label ?? null,
          message.sourceLabel ?? null,
          message.reasoning ?? null,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.status,
          message.createdAt,
          message.updatedAt,
          this.nextSortOrder("chat_messages")
        );
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

  updateLocalContextBoundary(threadId: string, boundaryMessageCount: number, markerKind: "trim" | "reset"): ChatThread {
    const state = this.loadState();
    const thread = state.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    const messageCount = this.messageCount(threadId);
    const boundedMessageCount = Math.max(0, Math.min(messageCount, Math.floor(boundaryMessageCount)));
    const now = timestamp();
    const contextMarkers = [
      ...thread.contextMarkers,
      { kind: markerKind, boundaryMessageCount: boundedMessageCount, timestamp: now }
    ];
    this.db.prepare(
      `UPDATE chat_threads
       SET active_context_start_message_index = ?,
           context_revision = ?,
           context_markers_json = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(boundedMessageCount, thread.contextRevision + 1, JSON.stringify(contextMarkers), now, threadId);
    return this.loadState().threads.find((item) => item.id === threadId)!;
  }

  renameThread(threadId: string, title: string): void {
    const normalizedTitle = normalizeTitle(title, 80);
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

  moveThread(threadId: string, projectId: string, targetThreadId?: string, position: "before" | "after" = "after"): void {
    const row = this.db.prepare("SELECT id, project_id, runtime_settings_json FROM chat_threads WHERE id = ?").get(threadId) as
      | { id: string; project_id: string; runtime_settings_json: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    const project = this.db.prepare("SELECT id FROM chat_projects WHERE id = ?").get(projectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Chat project does not exist: ${projectId}`);
    }
    const targetThread = targetThreadId
      ? this.db.prepare("SELECT id, project_id FROM chat_threads WHERE id = ?").get(targetThreadId) as
        | { id: string; project_id: string }
        | undefined
      : undefined;
    const orderedTargetId = targetThread?.project_id === project.id ? targetThread.id : undefined;
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE chat_threads SET project_id = ?, updated_at = ? WHERE id = ?").run(project.id, now, row.id);
      const ids = (this.db.prepare("SELECT id FROM chat_threads WHERE project_id = ? ORDER BY sort_order").all(project.id) as Array<{ id: string }>)
        .map((item) => item.id)
        .filter((id) => id !== row.id);
      if (orderedTargetId) {
        const targetIndex = Math.max(0, ids.indexOf(orderedTargetId));
        ids.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, row.id);
      } else {
        ids.push(row.id);
      }
      const updateThreadOrder = this.db.prepare("UPDATE chat_threads SET sort_order = ?, updated_at = ? WHERE id = ?");
      ids.forEach((id, index) => updateThreadOrder.run(index, now, id));
      this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id IN (?, ?)").run(now, row.project_id, project.id);
      this.setSettingInTransaction("selected_project_id", project.id);
      this.setSettingInTransaction("selected_thread_id", row.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteThread(threadId: string): void {
    const row = this.db.prepare("SELECT id, project_id, runtime_settings_json FROM chat_threads WHERE id = ?").get(threadId) as
      | { id: string; project_id: string; runtime_settings_json: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM chat_threads WHERE id = ?").run(row.id);
      this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id = ?").run(timestamp(), row.project_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.ensureSelection(row.project_id);
  }

  updateRuntimeSettings(settings: Partial<ChatRuntimeSettings>): void {
    const selectedThreadId = this.setting("selected_thread_id");
    const currentThread = selectedThreadId
      ? this.db.prepare("SELECT runtime_settings_json, permission_mode, codex_approval_mode FROM chat_threads WHERE id = ?").get(selectedThreadId) as { runtime_settings_json: string | null; permission_mode: string | null; codex_approval_mode: string | null } | undefined
      : undefined;
    const currentPermissionMode = currentThread
      ? normalizePermissionMode(currentThread.permission_mode, DEFAULT_RUNTIME_SETTINGS.permissionMode)
      : undefined;
    const currentCodexApprovalMode = normalizeCodexApprovalMode(currentThread?.codex_approval_mode, "default");
    const currentSettings = currentThread?.runtime_settings_json
      ? { ...normalizeRuntimeSettings(parseJsonObject(currentThread.runtime_settings_json) as Partial<ChatRuntimeSettings>), permissionMode: currentPermissionMode ?? DEFAULT_RUNTIME_SETTINGS.permissionMode }
      : currentThread
        ? { ...this.runtimeSettings(), permissionMode: currentPermissionMode ?? DEFAULT_RUNTIME_SETTINGS.permissionMode }
      : this.runtimeSettings();
    const requestedPermissionMode = settings.permissionMode === undefined
      ? undefined
      : normalizePermissionMode(settings.permissionMode, currentSettings.permissionMode);
    const effectivePermissionMode = requestedPermissionMode ?? currentPermissionMode ?? currentSettings.permissionMode;
    const effectiveCodexApprovalMode = syncedCodexApprovalMode(effectivePermissionMode, currentCodexApprovalMode, requestedPermissionMode !== undefined);
    const nextSettings = normalizeRuntimeSettings({ ...currentSettings, ...settings, permissionMode: effectivePermissionMode });
    const nextSettingsJson = JSON.stringify(nextSettings);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setSettingInTransaction("runtime_settings_json", nextSettingsJson);
      if (selectedThreadId) {
        const selectedSettingsPresetId = runtimeSettingsPatchInvalidatesPreset(settings) ? DEFAULT_SETTINGS_PRESET_ID : null;
        this.db.prepare(
          `UPDATE chat_threads
           SET selected_settings_preset_id = COALESCE(?, selected_settings_preset_id),
               runtime_settings_json = ?,
               permission_mode = ?,
               codex_approval_mode = ?,
               updated_at = ?
           WHERE id = ?`
        ).run(selectedSettingsPresetId, nextSettingsJson, effectivePermissionMode, effectiveCodexApprovalMode, timestamp(), selectedThreadId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateAppSettings(settings: Partial<ChatAppSettings>): void {
    this.setSetting("app_settings_json", JSON.stringify(normalizeAppSettings({ ...this.appSettings(), ...settings })));
  }

  updateThreadSettings(
    threadId: string,
    settings: Partial<Omit<Pick<ChatThread, "providerMode" | "selectedSettingsPresetId" | "builtinModelId" | "builtinAgenticFramework" | "documentAnalysisEmbeddingModelPath" | "codexModelId" | "codexReasoningEffort" | "permissionMode" | "codexApprovalMode" | "planModeEnabled" | "documentIndexId" | "codexLastSessionId" | "openCodeSessionId" | "remoteSessionId" | "remoteSlotId" | "remoteSettingsSignature" | "remoteHostIdentity">, never>> & { runtimeSettings?: Partial<ChatRuntimeSettings> }
  ): void {
    const row = this.db.prepare(
      `SELECT id, project_id, provider_mode, builtin_model_id, runtime_settings_json, builtin_agentic_framework,
              document_analysis_embedding_model_path, codex_model_id, codex_reasoning_effort, permission_mode,
              codex_approval_mode, plan_mode_enabled
       FROM chat_threads WHERE id = ?`
    ).get(threadId) as
      | {
        id: string;
        project_id: string;
        provider_mode: string | null;
        builtin_model_id: string | null;
        runtime_settings_json: string | null;
        builtin_agentic_framework: string | null;
        document_analysis_embedding_model_path: string | null;
        codex_model_id: string | null;
        codex_reasoning_effort: string | null;
        permission_mode: string | null;
        codex_approval_mode: string | null;
        plan_mode_enabled: number | null;
      }
      | undefined;
    if (!row) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    const providerMode = settings.providerMode ? normalizeProviderMode(settings.providerMode, "builtin") : undefined;
    const selectedSettingsPresetId = settings.selectedSettingsPresetId === undefined ? undefined : normalizeSettingsPresetId(settings.selectedSettingsPresetId, this.settingsPresets());
    const builtinModelId = settings.builtinModelId === undefined ? undefined : settings.builtinModelId.trim();
    const currentPermissionMode = normalizePermissionMode(row.permission_mode, DEFAULT_RUNTIME_SETTINGS.permissionMode);
    const parsedThreadSettings = row.runtime_settings_json
      ? normalizeRuntimeSettings(parseJsonObject(row.runtime_settings_json) as Partial<ChatRuntimeSettings>)
      : undefined;
    const currentThreadSettings = row.runtime_settings_json
      ? { ...parsedThreadSettings!, permissionMode: currentPermissionMode }
      : { ...this.runtimeSettings(), permissionMode: currentPermissionMode };
    const builtinAgenticFramework = settings.builtinAgenticFramework ? normalizeBuiltinAgenticFramework(settings.builtinAgenticFramework) : undefined;
    const documentAnalysisEmbeddingModelPath = settings.documentAnalysisEmbeddingModelPath === undefined ? undefined : settings.documentAnalysisEmbeddingModelPath.trim();
    const codexModelId = settings.codexModelId ? normalizeCodexModelId(settings.codexModelId) : undefined;
    const codexReasoningEffort = settings.codexReasoningEffort
      ? normalizeReasoningEffort(settings.codexReasoningEffort, "medium")
      : undefined;
    const requestedCodexApprovalMode = settings.codexApprovalMode ? normalizeCodexApprovalMode(settings.codexApprovalMode, "default") : undefined;
    const permissionMode = settings.permissionMode
      ? normalizePermissionMode(settings.permissionMode, DEFAULT_RUNTIME_SETTINGS.permissionMode)
      : requestedCodexApprovalMode
        ? accessModeForCodexApprovalMode(requestedCodexApprovalMode)
        : undefined;
    const effectivePermissionMode = permissionMode ?? currentPermissionMode;
    const runtimeAccessMismatched = parsedThreadSettings !== undefined && parsedThreadSettings.permissionMode !== currentPermissionMode;
    const runtimeSettingsValue = settings.runtimeSettings === undefined && permissionMode === undefined && !runtimeAccessMismatched
      ? undefined
      : { ...normalizeRuntimeSettings({ ...currentThreadSettings, ...(settings.runtimeSettings ?? {}) }), permissionMode: effectivePermissionMode };
    const runtimeSettings = runtimeSettingsValue === undefined ? undefined : JSON.stringify(runtimeSettingsValue);
    const currentCodexApprovalMode = normalizeCodexApprovalMode(row.codex_approval_mode, "default");
    const codexApprovalMode = syncedCodexApprovalMode(effectivePermissionMode, requestedCodexApprovalMode ?? currentCodexApprovalMode, permissionMode !== undefined && requestedCodexApprovalMode === undefined);
    const planModeEnabled = settings.planModeEnabled === undefined ? undefined : (settings.planModeEnabled ? 1 : 0);
    const currentThread = threadFromRow({
      id: row.id,
      project_id: row.project_id,
      title: "",
      directory: "",
      action_buttons_json: null,
      created_at: "",
      updated_at: "",
      provider_mode: row.provider_mode,
      selected_settings_preset_id: null,
      builtin_model_id: row.builtin_model_id,
      runtime_settings_json: row.runtime_settings_json,
      builtin_agentic_framework: row.builtin_agentic_framework,
      document_analysis_embedding_model_path: row.document_analysis_embedding_model_path,
      codex_model_id: row.codex_model_id,
      codex_reasoning_effort: row.codex_reasoning_effort,
      permission_mode: row.permission_mode,
      codex_approval_mode: row.codex_approval_mode,
      plan_mode_enabled: row.plan_mode_enabled,
      document_index_id: null,
      codex_last_session_id: null,
      open_code_session_id: null,
      remote_session_id: null,
      remote_slot_id: null,
      remote_settings_signature: null,
      remote_host_identity: null,
      active_context_start_message_index: null,
      context_revision: null,
      context_markers_json: null
    });
    const selectedSettingsPresetIdUpdate = selectedSettingsPresetId ?? (threadSettingsChangeInvalidatesPreset(currentThread, {
      providerMode,
      builtinModelId,
      runtimeSettings: runtimeSettingsValue,
      builtinAgenticFramework,
      documentAnalysisEmbeddingModelPath,
      codexModelId,
      codexReasoningEffort,
      permissionMode,
      codexApprovalMode,
      planModeEnabled: planModeEnabled === undefined ? undefined : Boolean(planModeEnabled)
    }) ? DEFAULT_SETTINGS_PRESET_ID : undefined);
    const documentIndexId = settings.documentIndexId === undefined ? undefined : settings.documentIndexId.trim();
    const codexLastSessionId = settings.codexLastSessionId === undefined ? undefined : settings.codexLastSessionId.trim();
    const openCodeSessionId = settings.openCodeSessionId === undefined ? undefined : settings.openCodeSessionId.trim();
    const remoteSessionId = settings.remoteSessionId === undefined ? undefined : settings.remoteSessionId.trim();
    const remoteSlotId = settings.remoteSlotId === undefined ? undefined : nonNegativeInteger(settings.remoteSlotId, 0);
    const remoteSettingsSignature = settings.remoteSettingsSignature === undefined ? undefined : settings.remoteSettingsSignature.trim();
    const remoteHostIdentity = settings.remoteHostIdentity === undefined ? undefined : settings.remoteHostIdentity.trim();
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE chat_threads
           SET provider_mode = COALESCE(?, provider_mode),
               selected_settings_preset_id = COALESCE(?, selected_settings_preset_id),
               builtin_model_id = COALESCE(?, builtin_model_id),
               runtime_settings_json = COALESCE(?, runtime_settings_json),
               builtin_agentic_framework = COALESCE(?, builtin_agentic_framework),
               document_analysis_embedding_model_path = COALESCE(?, document_analysis_embedding_model_path),
               codex_model_id = COALESCE(?, codex_model_id),
               codex_reasoning_effort = COALESCE(?, codex_reasoning_effort),
               permission_mode = COALESCE(?, permission_mode),
              codex_approval_mode = ?,
               plan_mode_enabled = COALESCE(?, plan_mode_enabled),
               document_index_id = COALESCE(?, document_index_id),
               codex_last_session_id = COALESCE(?, codex_last_session_id),
               open_code_session_id = COALESCE(?, open_code_session_id),
               remote_session_id = COALESCE(?, remote_session_id),
               remote_slot_id = COALESCE(?, remote_slot_id),
               remote_settings_signature = COALESCE(?, remote_settings_signature),
               remote_host_identity = COALESCE(?, remote_host_identity),
               updated_at = ?
           WHERE id = ?`
        )
        .run(providerMode ?? null, selectedSettingsPresetIdUpdate ?? null, builtinModelId ?? null, runtimeSettings ?? null, builtinAgenticFramework ?? null, documentAnalysisEmbeddingModelPath ?? null, codexModelId ?? null, codexReasoningEffort ?? null, permissionMode ?? null, codexApprovalMode, planModeEnabled ?? null, documentIndexId ?? null, codexLastSessionId ?? null, openCodeSessionId ?? null, remoteSessionId ?? null, remoteSlotId ?? null, remoteSettingsSignature ?? null, remoteHostIdentity ?? null, now, row.id);
      this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id = ?").run(now, row.project_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  applySettingsPreset(threadId: string, presetId: string): void {
    const preset = this.settingsPresets().find((candidate) => candidate.id === presetId);
    if (!preset) {
      throw new Error(`Chat settings preset does not exist: ${presetId}`);
    }
    const thread = this.db.prepare(
      `SELECT id, provider_mode, runtime_settings_json, permission_mode, codex_approval_mode
       FROM chat_threads WHERE id = ?`
    ).get(threadId) as
      | {
        id: string;
        provider_mode: string | null;
        runtime_settings_json: string | null;
        permission_mode: string | null;
        codex_approval_mode: string | null;
      }
      | undefined;
    if (!thread) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    if (preset.providerMode === "builtin" && preset.builtinModelId) {
      this.selectModel(preset.builtinModelId);
    }
    const currentRuntimeSettings = thread.runtime_settings_json
      ? normalizeRuntimeSettings(parseJsonObject(thread.runtime_settings_json) as Partial<ChatRuntimeSettings>)
      : this.runtimeSettings();
    const currentAccessMode = normalizePermissionMode(thread.permission_mode, currentRuntimeSettings.permissionMode);
    this.updateThreadSettings(thread.id, {
      providerMode: preset.providerMode,
      selectedSettingsPresetId: preset.id,
      builtinModelId: preset.builtinModelId,
      runtimeSettings: { ...preset.runtimeSettings, permissionMode: currentAccessMode },
      builtinAgenticFramework: preset.builtinAgenticFramework,
      documentAnalysisEmbeddingModelPath: preset.documentAnalysisEmbeddingModelPath,
      codexModelId: preset.codexModelId || defaultCodexModelId(),
      codexReasoningEffort: preset.codexReasoningEffort
    });
  }

  saveSettingsPreset(preset: {
    id?: string;
    label: string;
    runtimeSettings?: Partial<ChatRuntimeSettings>;
    providerMode?: ChatProviderMode;
    iconName?: string;
    builtinModelId?: string;
    builtinAgenticFramework?: ChatBuiltinAgenticFramework;
    documentAnalysisEmbeddingModelPath?: string;
    codexModelId?: string;
    codexReasoningEffort?: ChatReasoningEffort;
  }): ChatSettingsPreset {
    const currentPresets = this.storedSettingsPresets();
    const rawId = preset.id?.trim();
    const existing = rawId ? currentPresets.find((candidate) => candidate.id === rawId) : undefined;
    if (existing && !existing.editable) {
      throw new Error(`Chat settings preset is not editable: ${existing.label}`);
    }
    const nextPreset = normalizeSettingsPreset({
      id: rawId || `custom::${randomUUID()}`,
      label: preset.label,
      runtimeSettings: preset.runtimeSettings,
      providerMode: preset.providerMode,
      iconName: preset.iconName,
      builtinModelId: preset.builtinModelId,
      builtinAgenticFramework: preset.builtinAgenticFramework,
      documentAnalysisEmbeddingModelPath: preset.documentAnalysisEmbeddingModelPath,
      codexModelId: preset.codexModelId,
      codexReasoningEffort: preset.codexReasoningEffort,
      builtIn: existing?.builtIn ?? false,
      editable: true,
      deletable: existing?.deletable ?? rawId !== DEFAULT_SETTINGS_PRESET_ID
    });
    const nextPresets = currentPresets.some((candidate) => candidate.id === nextPreset.id)
      ? currentPresets.map((candidate) => candidate.id === nextPreset.id ? nextPreset : candidate)
      : [...currentPresets, nextPreset];
    this.setSetting("settings_presets_json", JSON.stringify(nextPresets));
    this.setSetting("hidden_settings_preset_ids_json", JSON.stringify(this.hiddenSettingsPresetIds().filter((id) => id !== nextPreset.id)));
    return nextPreset;
  }

  deleteSettingsPreset(presetId: string): void {
    const normalizedId = presetId.trim();
    const currentPresets = this.storedSettingsPresets();
    const existing = currentPresets.find((candidate) => candidate.id === normalizedId);
    if (!existing) {
      throw new Error(`Chat settings preset does not exist: ${presetId}`);
    }
    if (!existing.deletable) {
      throw new Error(`Chat settings preset is not deletable: ${existing.label}`);
    }
    if (existing.builtIn) {
      this.setSetting("hidden_settings_preset_ids_json", JSON.stringify([...new Set([...this.hiddenSettingsPresetIds(), normalizedId])]));
    } else {
      this.setSetting("settings_presets_json", JSON.stringify(currentPresets.filter((candidate) => candidate.id !== normalizedId)));
    }
    this.db
      .prepare("UPDATE chat_threads SET selected_settings_preset_id = ? WHERE selected_settings_preset_id = ?")
      .run(DEFAULT_SETTINGS_PRESET_ID, normalizedId);
  }

  createDocumentIndex(projectId: string, title: string, sourcePath: string, embeddingModelPath = ""): ChatDocumentIndex {
    const project = this.db.prepare("SELECT id FROM chat_projects WHERE id = ?").get(projectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Chat project does not exist: ${projectId}`);
    }
    const normalizedSourcePath = sourcePath.trim();
    if (!normalizedSourcePath) {
      throw new Error("Document index requires a source path.");
    }
    const sourcePaths = normalizeDocumentSourcePaths(normalizedSourcePath);
    for (const sourceItem of sourcePaths) {
      if (!fs.existsSync(sourceItem)) {
        throw new Error(`Document source does not exist: ${sourceItem}`);
      }
    }
    const normalizedTitle = normalizeTitle(title || path.basename(sourcePaths[0] ?? normalizedSourcePath), 80);
    if (!normalizedTitle) {
      throw new Error("Document index requires a title.");
    }
    const now = timestamp();
    const documentIndex: ChatDocumentIndex = {
      id: `chat-doc-index-${randomUUID()}`,
      projectId: project.id,
      title: normalizedTitle,
      sourcePath: normalizedSourcePath,
      embeddingModelPath: embeddingModelPath.trim(),
      state: "building",
      progress: 0,
      message: "Queued",
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(`INSERT INTO chat_document_indexes
        (id, project_id, title, source_path, embedding_model_path, state, progress, message, created_at, updated_at, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(documentIndex.id, documentIndex.projectId, documentIndex.title, documentIndex.sourcePath, documentIndex.embeddingModelPath, documentIndex.state, documentIndex.progress, documentIndex.message, documentIndex.createdAt, documentIndex.updatedAt, this.nextSortOrder("chat_document_indexes"));
    return documentIndex;
  }

  updateDocumentIndex(documentIndexId: string, title: string, sourcePath: string, embeddingModelPath = ""): ChatDocumentIndex {
    const current = this.documentIndex(documentIndexId);
    if (!current) {
      throw new Error(`Document index does not exist: ${documentIndexId}`);
    }
    const normalizedSourcePath = sourcePath.trim();
    if (!normalizedSourcePath) {
      throw new Error("Document index requires a source path.");
    }
    const sourcePaths = normalizeDocumentSourcePaths(normalizedSourcePath);
    for (const sourceItem of sourcePaths) {
      if (!fs.existsSync(sourceItem)) {
        throw new Error(`Document source does not exist: ${sourceItem}`);
      }
    }
    const normalizedTitle = normalizeTitle(title || path.basename(sourcePaths[0] ?? normalizedSourcePath), 80);
    if (!normalizedTitle) {
      throw new Error("Document index requires a title.");
    }
    const now = timestamp();
    const normalizedEmbeddingModelPath = embeddingModelPath.trim();
    const embeddingModelChanged = normalizedEmbeddingModelPath !== current.embeddingModelPath.trim();
    const indexedSourcePaths = this.documentIndexIndexedSourcePaths(current.id);
    const indexedSourceKeys = new Set(indexedSourcePaths.map(documentSourcePathKey));
    const nextSourceKeys = new Set(sourcePaths.map(documentSourcePathKey));
    const removedIndexedSourcePaths = indexedSourcePaths.filter((indexedSourcePath) => !nextSourceKeys.has(documentSourcePathKey(indexedSourcePath)));
    const hasNewSourcePaths = sourcePaths.some((sourceItem) => !indexedSourceKeys.has(documentSourcePathKey(sourceItem)));
    const nextState = embeddingModelChanged || hasNewSourcePaths ? "building" : current.state;
    const nextProgress = embeddingModelChanged || hasNewSourcePaths ? 0 : current.progress;
    const nextMessage = embeddingModelChanged || hasNewSourcePaths ? "Queued" : current.message;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`UPDATE chat_document_indexes
          SET title = ?, source_path = ?, embedding_model_path = ?, state = ?, progress = ?, message = ?, updated_at = ?
          WHERE id = ?`)
        .run(normalizedTitle, normalizedSourcePath, normalizedEmbeddingModelPath, nextState, nextProgress, nextMessage, now, current.id);
      if (embeddingModelChanged) {
        this.db.prepare("DELETE FROM chat_document_index_chunks WHERE document_index_id = ?").run(current.id);
      } else if (removedIndexedSourcePaths.length > 0) {
        const deleteRemovedChunks = this.db.prepare("DELETE FROM chat_document_index_chunks WHERE document_index_id = ? AND source_path = ?");
        for (const removedSourcePath of removedIndexedSourcePaths) {
          deleteRemovedChunks.run(current.id, removedSourcePath);
        }
      }
      this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id = ?").run(now, current.projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (embeddingModelChanged || removedIndexedSourcePaths.length > 0 || hasNewSourcePaths) {
      this.documentVectorIndexes.delete(current.id);
    }
    return {
      ...current,
      title: normalizedTitle,
      sourcePath: normalizedSourcePath,
      embeddingModelPath: normalizedEmbeddingModelPath,
      state: nextState,
      progress: nextProgress,
      message: nextMessage,
      updatedAt: now
    };
  }

  deleteDocumentIndex(documentIndexId: string): void {
    const current = this.documentIndex(documentIndexId);
    if (!current) {
      throw new Error(`Document index does not exist: ${documentIndexId}`);
    }
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE chat_threads SET document_index_id = '', updated_at = ? WHERE document_index_id = ?").run(now, current.id);
      this.db.prepare("DELETE FROM chat_document_indexes WHERE id = ?").run(current.id);
      this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id = ?").run(now, current.projectId);
      this.db.exec("COMMIT");
      this.documentVectorIndexes.delete(current.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertDocumentIndex(documentIndex: ChatDocumentIndex): void {
    const normalizedProjectId = documentIndex.projectId.trim();
    const project = this.db.prepare("SELECT id FROM chat_projects WHERE id = ?").get(normalizedProjectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Chat project does not exist: ${documentIndex.projectId}`);
    }
    const now = timestamp();
    this.db
      .prepare(`INSERT INTO chat_document_indexes
        (id, project_id, title, source_path, embedding_model_path, state, progress, message, created_at, updated_at, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          source_path = excluded.source_path,
          embedding_model_path = excluded.embedding_model_path,
          state = excluded.state,
          progress = excluded.progress,
          message = excluded.message,
          updated_at = excluded.updated_at`)
      .run(
        documentIndex.id,
        normalizedProjectId,
        normalizeTitle(documentIndex.title, 80) || "Remote document",
        documentIndex.sourcePath,
        documentIndex.embeddingModelPath ?? "",
        documentIndex.state,
        Math.max(0, Math.min(1, documentIndex.progress)),
        documentIndex.message,
        documentIndex.createdAt || now,
        now,
        this.nextSortOrder("chat_document_indexes")
      );
  }

  updateDocumentIndexStatus(documentIndexId: string, status: Pick<ChatDocumentIndex, "state" | "progress" | "message">): void {
    const now = timestamp();
    this.db.prepare("UPDATE chat_document_indexes SET state = ?, progress = ?, message = ?, updated_at = ? WHERE id = ?")
      .run(status.state, Math.max(0, Math.min(1, status.progress)), status.message, now, documentIndexId);
  }

  replaceDocumentIndexChunks(documentIndexId: string, chunks: ChatDocumentChunkInput[]): void {
    const index = this.db.prepare("SELECT id FROM chat_document_indexes WHERE id = ?").get(documentIndexId) as { id: string } | undefined;
    if (!index) {
      throw new Error(`Document index does not exist: ${documentIndexId}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM chat_document_index_chunks WHERE document_index_id = ?").run(documentIndexId);
      const insert = this.db.prepare(
        `INSERT INTO chat_document_index_chunks
          (id, document_index_id, source_title, source_path, page_start, page_end, text, token_count, ordinal, embedding_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      chunks.forEach((chunk, ordinal) => {
        insert.run(chunk.chunkId, documentIndexId, chunk.sourceTitle, chunk.sourcePath, chunk.pageStart, chunk.pageEnd, chunk.text, chunk.tokenCount, ordinal, chunk.embedding ? JSON.stringify(normalizeEmbedding(chunk.embedding)) : null);
      });
      this.db.exec("COMMIT");
      this.documentVectorIndexes.delete(documentIndexId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendDocumentIndexChunks(documentIndexId: string, chunks: ChatDocumentChunkInput[]): void {
    const index = this.db.prepare("SELECT id FROM chat_document_indexes WHERE id = ?").get(documentIndexId) as { id: string } | undefined;
    if (!index) {
      throw new Error(`Document index does not exist: ${documentIndexId}`);
    }
    if (chunks.length === 0) {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const nextOrdinal = this.nextDocumentIndexChunkOrdinal(documentIndexId);
      const insert = this.db.prepare(
        `INSERT INTO chat_document_index_chunks
          (id, document_index_id, source_title, source_path, page_start, page_end, text, token_count, ordinal, embedding_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      chunks.forEach((chunk, index) => {
        insert.run(chunk.chunkId, documentIndexId, chunk.sourceTitle, chunk.sourcePath, chunk.pageStart, chunk.pageEnd, chunk.text, chunk.tokenCount, nextOrdinal + index, chunk.embedding ? JSON.stringify(normalizeEmbedding(chunk.embedding)) : null);
      });
      this.db.exec("COMMIT");
      this.documentVectorIndexes.delete(documentIndexId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  documentIndexUnindexedSourcePaths(documentIndexId: string): string[] {
    const index = this.documentIndex(documentIndexId);
    if (!index) {
      throw new Error(`Document index does not exist: ${documentIndexId}`);
    }
    const indexedSourceKeys = new Set(this.documentIndexIndexedSourcePaths(documentIndexId).map(documentSourcePathKey));
    return normalizeDocumentSourcePaths(index.sourcePath).filter((sourcePath) => !indexedSourceKeys.has(documentSourcePathKey(sourcePath)));
  }

  nextDocumentIndexChunkOrdinal(documentIndexId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(ordinal) + 1, 0) AS next_ordinal FROM chat_document_index_chunks WHERE document_index_id = ?")
      .get(documentIndexId) as { next_ordinal: number } | undefined;
    return Math.max(0, Number(row?.next_ordinal ?? 0));
  }

  documentIndexChunkCount(documentIndexId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chat_document_index_chunks WHERE document_index_id = ?")
      .get(documentIndexId) as { count: number } | undefined;
    return Math.max(0, Number(row?.count ?? 0));
  }

  documentIndex(documentIndexId: string): ChatDocumentIndex | undefined {
    const row = this.db.prepare(
      `SELECT id, project_id, title, source_path, COALESCE(embedding_model_path, '') AS embedding_model_path, state,
              COALESCE(progress, 0) AS progress,
              COALESCE(message, '') AS message,
              created_at, updated_at
       FROM chat_document_indexes WHERE id = ?`
    ).get(documentIndexId) as ChatDocumentIndexRow | undefined;
    return row ? documentIndexFromRow(row) : undefined;
  }

  searchDocumentIndexByVector(documentIndexId: string, queryEmbedding: number[], topK = 8, budgetTokens = 6000): ChatDocumentSearchEntry[] {
    const index = this.documentIndex(documentIndexId);
    if (!index) {
      throw new Error("Selected document index was not found.");
    }
    if (index.state !== "ready") {
      throw new Error("Selected document index is not ready yet.");
    }
    const normalizedQuery = normalizeEmbedding(queryEmbedding);
    const vectorIndex = this.documentVectorIndex(documentIndexId, index.updatedAt);
    if (vectorIndex.rows.length === 0 || vectorIndex.missingEmbeddings) {
      throw new Error("Selected document index does not contain vector embeddings. Rebuild the document group.");
    }
    let usedTokens = 0;
    const candidates: Array<{ row: ChatDocumentChunkRow; score: number }> = [];
    const boundedTopK = Math.max(1, topK);
    for (const row of vectorIndex.rows) {
      const score = cosineSimilarity(normalizedQuery, row.embedding ?? []);
      if (score < MIN_DOCUMENT_VECTOR_SCORE) {
        continue;
      }
      candidates.push({ row, score });
      candidates.sort((a, b) => b.score - a.score || a.row.ordinalStart - b.row.ordinalStart);
      if (candidates.length > boundedTopK) {
        candidates.pop();
      }
    }
    return candidates
      .filter((item) => {
        if (usedTokens >= budgetTokens || usedTokens + item.row.tokenCount > budgetTokens) {
          return false;
        }
        usedTokens += item.row.tokenCount;
        return true;
      })
      .map((item, index) => ({
        chunkId: item.row.chunkId,
        resultId: `r${index + 1}`,
        sourceId: (item.row.sourceId ?? path.basename(item.row.sourcePath)) || item.row.sourcePath,
        sourceTitle: item.row.sourceTitle,
        sourcePath: item.row.sourcePath,
        sectionLabel: item.row.sectionLabel ?? `page ${item.row.pageStart}${item.row.pageEnd !== item.row.pageStart ? `-${item.row.pageEnd}` : ""}`,
        candidateCount: vectorIndex.rows.length,
        truncated: usedTokens >= budgetTokens,
        pageStart: item.row.pageStart,
        pageEnd: item.row.pageEnd,
        text: item.row.text,
        tokenCount: item.row.tokenCount,
        score: item.score,
        ordinalStart: item.row.ordinalStart,
        ordinalEnd: item.row.ordinalEnd
      }));
  }

  modifyDocumentSearchResults(
    documentIndexId: string,
    results: ChatDocumentSearchEntry[],
    dropResultIds: string[],
    expand: Array<{ resultId: string; before: number; after: number }>,
    budgetTokens = 6000
  ): ChatDocumentSearchEntry[] {
    const drop = new Set(dropResultIds.map((id) => id.trim()).filter(Boolean));
    const expansionById = new Map(expand.map((item) => [item.resultId, item]));
    const index = this.documentIndex(documentIndexId);
    if (!index) {
      throw new Error("Selected document index was not found.");
    }
    const rows = this.documentVectorIndex(documentIndexId, index.updatedAt).rows;
    let usedTokens = 0;
    const expanded: ChatDocumentSearchEntry[] = [];
    for (const result of results) {
      if (drop.has(result.resultId)) {
        continue;
      }
      const expansion = expansionById.get(result.resultId);
      const startOrdinal = Math.max(0, result.ordinalStart - Math.max(0, expansion?.before ?? 0));
      const endOrdinal = result.ordinalEnd + Math.max(0, expansion?.after ?? 0);
      const group = rows.filter((row) => row.sourcePath === result.sourcePath && row.ordinalStart >= startOrdinal && row.ordinalStart <= endOrdinal);
      if (group.length === 0 || usedTokens >= budgetTokens) {
        continue;
      }
      const tokenCount = group.reduce((total, row) => total + row.tokenCount, 0);
      if (usedTokens + tokenCount > budgetTokens) {
        continue;
      }
      usedTokens += tokenCount;
      expanded.push({
        ...result,
        sourceId: (result.sourceId ?? path.basename(result.sourcePath)) || result.sourcePath,
        sectionLabel: result.sectionLabel ?? `page ${Math.min(...group.map((row) => row.pageStart))}${Math.max(...group.map((row) => row.pageEnd)) !== Math.min(...group.map((row) => row.pageStart)) ? `-${Math.max(...group.map((row) => row.pageEnd))}` : ""}`,
        candidateCount: result.candidateCount ?? group.length,
        truncated: usedTokens >= budgetTokens,
        pageStart: Math.min(...group.map((row) => row.pageStart)),
        pageEnd: Math.max(...group.map((row) => row.pageEnd)),
        text: group.map((row) => row.text).join("\n\n"),
        tokenCount,
        ordinalStart: startOrdinal,
        ordinalEnd: endOrdinal
      });
    }
    return expanded;
  }

  private documentIndexChunks(documentIndexId: string): ChatDocumentChunkRow[] {
    const rows = this.db.prepare(
      `SELECT id, source_title, source_path, page_start, page_end, text, token_count, ordinal, embedding_json
       FROM chat_document_index_chunks WHERE document_index_id = ? ORDER BY ordinal`
    ).all(documentIndexId) as Array<{
      id: string;
      source_title: string;
      source_path: string;
      page_start: number;
      page_end: number;
      text: string;
      token_count: number;
      ordinal: number;
      embedding_json: string | null;
    }>;
    return rows.map((row) => ({
      chunkId: row.id,
      resultId: "",
      sourceId: path.basename(row.source_path) || row.source_path,
      sourceTitle: row.source_title,
      sourcePath: row.source_path,
      sectionLabel: `page ${row.page_start}${row.page_end !== row.page_start ? `-${row.page_end}` : ""}`,
      candidateCount: 1,
      truncated: false,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      text: row.text,
      tokenCount: row.token_count,
      score: 0,
      ordinalStart: row.ordinal,
      ordinalEnd: row.ordinal,
      embedding: parseEmbeddingJson(row.embedding_json)
    }));
  }

  private documentIndexIndexedSourcePaths(documentIndexId: string): string[] {
    const rows = this.db.prepare(
      `SELECT source_path FROM chat_document_index_chunks
       WHERE document_index_id = ? GROUP BY source_path ORDER BY MIN(ordinal)`
    ).all(documentIndexId) as Array<{ source_path: string }>;
    return rows.map((row) => row.source_path);
  }

  private documentVectorIndex(documentIndexId: string, updatedAt: string): ResidentDocumentVectorIndex {
    const cached = this.documentVectorIndexes.get(documentIndexId);
    if (cached && cached.updatedAt === updatedAt) {
      return cached;
    }
    const rows = this.documentIndexChunks(documentIndexId);
    const vectorIndex: ResidentDocumentVectorIndex = {
      documentIndexId,
      updatedAt,
      rows,
      missingEmbeddings: rows.some((row) => !row.embedding)
    };
    this.documentVectorIndexes.set(documentIndexId, vectorIndex);
    this.evictResidentDocumentVectorIndexes();
    return vectorIndex;
  }

  private evictResidentDocumentVectorIndexes(): void {
    while (this.documentVectorIndexes.size > MAX_RESIDENT_DOCUMENT_VECTOR_INDEXES) {
      const oldestKey = this.documentVectorIndexes.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      this.documentVectorIndexes.delete(oldestKey);
    }
  }

  selectDocumentIndex(threadId: string, documentIndexId: string): void {
    const thread = this.db.prepare("SELECT id, project_id FROM chat_threads WHERE id = ?").get(threadId) as
      | { id: string; project_id: string }
      | undefined;
    if (!thread) {
      throw new Error(`Chat thread does not exist: ${threadId}`);
    }
    const normalizedDocumentIndexId = documentIndexId.trim();
    if (normalizedDocumentIndexId) {
      const documentIndex = this.db.prepare("SELECT id, project_id FROM chat_document_indexes WHERE id = ?").get(normalizedDocumentIndexId) as
        | { id: string; project_id: string }
        | undefined;
      if (!documentIndex || documentIndex.project_id !== thread.project_id) {
        throw new Error("Document index does not belong to this thread's project.");
      }
    }
    const now = timestamp();
    this.db.prepare("UPDATE chat_threads SET document_index_id = ?, updated_at = ? WHERE id = ?").run(normalizedDocumentIndexId, now, thread.id);
    this.db.prepare("UPDATE chat_projects SET updated_at = ? WHERE id = ?").run(now, thread.project_id);
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

  replaceMessageContent(messageId: string, content: string): void {
    const row = this.db.prepare("SELECT thread_id FROM chat_messages WHERE id = ?").get(messageId) as
      | { thread_id: string }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE chat_messages SET content = ?, updated_at = ? WHERE id = ?")
        .run(content, now, messageId);
      this.touchThreadInTransaction(row.thread_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendToMessageReasoning(messageId: string, reasoningDelta: string): void {
    if (!reasoningDelta) {
      return;
    }
    const row = this.db.prepare("SELECT thread_id, COALESCE(reasoning, '') AS reasoning FROM chat_messages WHERE id = ?").get(messageId) as
      | { thread_id: string; reasoning: string }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE chat_messages SET reasoning = ?, updated_at = ? WHERE id = ?")
        .run(`${row.reasoning}${reasoningDelta}`, now, messageId);
      this.touchThreadInTransaction(row.thread_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceMessageReasoning(messageId: string, reasoning: string): void {
    const row = this.db.prepare("SELECT thread_id FROM chat_messages WHERE id = ?").get(messageId) as
      | { thread_id: string }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE chat_messages SET reasoning = ?, updated_at = ? WHERE id = ?")
        .run(reasoning, now, messageId);
      this.touchThreadInTransaction(row.thread_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateMessageTimelineBlocks(messageId: string, timelineBlocks: ChatTimelineBlock[]): void {
    const row = this.db.prepare("SELECT thread_id, metadata_json FROM chat_messages WHERE id = ?").get(messageId) as
      | { thread_id: string; metadata_json: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const metadata = parseJsonObject(row.metadata_json) ?? {};
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE chat_messages SET metadata_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...metadata, timelineBlocks }), now, messageId);
      this.touchThreadInTransaction(row.thread_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  mergeMessageMetadata(messageId: string, patch: Record<string, unknown>): void {
    const row = this.db.prepare("SELECT thread_id, metadata_json FROM chat_messages WHERE id = ?").get(messageId) as
      | { thread_id: string; metadata_json: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const metadata = parseJsonObject(row.metadata_json) ?? {};
    const now = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE chat_messages SET metadata_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...metadata, ...patch }), now, messageId);
      this.touchThreadInTransaction(row.thread_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateMessageTimelineBlock(messageId: string, blockId: string, update: (block: ChatTimelineBlock) => ChatTimelineBlock): void {
    const row = this.db.prepare("SELECT metadata_json FROM chat_messages WHERE id = ?").get(messageId) as
      | { metadata_json: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Chat message does not exist: ${messageId}`);
    }
    const metadata = parseJsonObject(row.metadata_json) ?? {};
    const blocks = Array.isArray(metadata.timelineBlocks) ? metadata.timelineBlocks as ChatTimelineBlock[] : [];
    const nextBlocks = blocks.map((block) => block.id === blockId ? update(block) : block);
    this.updateMessageTimelineBlocks(messageId, nextBlocks);
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
        directory TEXT NOT NULL DEFAULT '',
        action_buttons_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES chat_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        provider_mode TEXT NOT NULL DEFAULT 'builtin',
        selected_settings_preset_id TEXT NOT NULL DEFAULT 'custom::default',
        builtin_model_id TEXT NOT NULL DEFAULT '',
        runtime_settings_json TEXT,
        builtin_agentic_framework TEXT NOT NULL DEFAULT 'chat',
        document_analysis_embedding_model_path TEXT NOT NULL DEFAULT '',
        codex_model_id TEXT NOT NULL DEFAULT 'gpt-5.3-codex',
        codex_reasoning_effort TEXT NOT NULL DEFAULT 'medium',
        permission_mode TEXT NOT NULL DEFAULT 'full_access',
        codex_approval_mode TEXT NOT NULL DEFAULT 'default',
        plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
        active_context_start_message_index INTEGER NOT NULL DEFAULT 0,
        context_revision INTEGER NOT NULL DEFAULT 0,
        context_markers_json TEXT NOT NULL DEFAULT '[]',
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

      CREATE TABLE IF NOT EXISTS chat_document_indexes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES chat_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_path TEXT NOT NULL,
        embedding_model_path TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'ready',
        progress REAL NOT NULL DEFAULT 1,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_document_index_chunks (
        id TEXT PRIMARY KEY,
        document_index_id TEXT NOT NULL REFERENCES chat_document_indexes(id) ON DELETE CASCADE,
        source_title TEXT NOT NULL,
        source_path TEXT NOT NULL,
        page_start INTEGER NOT NULL,
        page_end INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        embedding_json TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const projectColumns = this.db.prepare("PRAGMA table_info(chat_projects)").all() as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "directory")) {
      this.db.exec("ALTER TABLE chat_projects ADD COLUMN directory TEXT NOT NULL DEFAULT ''");
    }
    if (!projectColumns.some((column) => column.name === "action_buttons_json")) {
      this.db.exec("ALTER TABLE chat_projects ADD COLUMN action_buttons_json TEXT NOT NULL DEFAULT '[]'");
    }
    const threadColumns = this.db.prepare("PRAGMA table_info(chat_threads)").all() as Array<{ name: string }>;
    const hadThreadPermissionModeColumn = threadColumns.some((column) => column.name === "permission_mode");
    const ensureThreadColumn = (name: string, definition: string) => {
      if (!threadColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE chat_threads ADD COLUMN ${definition}`);
      }
    };
    ensureThreadColumn("provider_mode", "provider_mode TEXT NOT NULL DEFAULT 'builtin'");
    ensureThreadColumn("selected_settings_preset_id", "selected_settings_preset_id TEXT NOT NULL DEFAULT 'custom::default'");
    ensureThreadColumn("builtin_model_id", "builtin_model_id TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("runtime_settings_json", "runtime_settings_json TEXT");
    ensureThreadColumn("builtin_agentic_framework", "builtin_agentic_framework TEXT NOT NULL DEFAULT 'chat'");
    ensureThreadColumn("document_analysis_embedding_model_path", "document_analysis_embedding_model_path TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("codex_model_id", "codex_model_id TEXT NOT NULL DEFAULT 'gpt-5.3-codex'");
    ensureThreadColumn("codex_reasoning_effort", "codex_reasoning_effort TEXT NOT NULL DEFAULT 'medium'");
    ensureThreadColumn("permission_mode", "permission_mode TEXT NOT NULL DEFAULT 'full_access'");
    ensureThreadColumn("codex_approval_mode", "codex_approval_mode TEXT NOT NULL DEFAULT 'default'");
    ensureThreadColumn("plan_mode_enabled", "plan_mode_enabled INTEGER NOT NULL DEFAULT 0");
    ensureThreadColumn("document_index_id", "document_index_id TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("codex_last_session_id", "codex_last_session_id TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("open_code_session_id", "open_code_session_id TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("remote_session_id", "remote_session_id TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("remote_slot_id", "remote_slot_id INTEGER NOT NULL DEFAULT 0");
    ensureThreadColumn("remote_settings_signature", "remote_settings_signature TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("remote_host_identity", "remote_host_identity TEXT NOT NULL DEFAULT ''");
    ensureThreadColumn("active_context_start_message_index", "active_context_start_message_index INTEGER NOT NULL DEFAULT 0");
    ensureThreadColumn("context_revision", "context_revision INTEGER NOT NULL DEFAULT 0");
    ensureThreadColumn("context_markers_json", "context_markers_json TEXT NOT NULL DEFAULT '[]'");
    if (!hadThreadPermissionModeColumn) {
      this.seedMigratedThreadAccessState();
    }
    this.repairThreadAccessState();
    const messageColumns = this.db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    const ensureMessageColumn = (name: string, definition: string) => {
      if (!messageColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE chat_messages ADD COLUMN ${definition}`);
      }
    };
    ensureMessageColumn("attachments_json", "attachments_json TEXT NOT NULL DEFAULT '[]'");
    ensureMessageColumn("label", "label TEXT");
    ensureMessageColumn("source_label", "source_label TEXT");
    ensureMessageColumn("reasoning", "reasoning TEXT");
    ensureMessageColumn("metadata_json", "metadata_json TEXT");
    const documentIndexColumns = this.db.prepare("PRAGMA table_info(chat_document_indexes)").all() as Array<{ name: string }>;
    if (!documentIndexColumns.some((column) => column.name === "embedding_model_path")) {
      this.db.exec("ALTER TABLE chat_document_indexes ADD COLUMN embedding_model_path TEXT NOT NULL DEFAULT ''");
    }
    const documentChunkColumns = this.db.prepare("PRAGMA table_info(chat_document_index_chunks)").all() as Array<{ name: string }>;
    if (!documentChunkColumns.some((column) => column.name === "embedding_json")) {
      this.db.exec("ALTER TABLE chat_document_index_chunks ADD COLUMN embedding_json TEXT");
    }
  }

  private repairThreadAccessState(): void {
    const rows = this.db.prepare("SELECT id, runtime_settings_json, permission_mode, codex_approval_mode FROM chat_threads").all() as Array<{
      id: string;
      runtime_settings_json: string | null;
      permission_mode: string | null;
      codex_approval_mode: string | null;
    }>;
    const update = this.db.prepare("UPDATE chat_threads SET runtime_settings_json = ?, permission_mode = ?, codex_approval_mode = ? WHERE id = ?");
    for (const row of rows) {
      let rawRuntimeSettings: Partial<ChatRuntimeSettings> | undefined;
      if (row.runtime_settings_json) {
        try {
          rawRuntimeSettings = JSON.parse(row.runtime_settings_json) as Partial<ChatRuntimeSettings>;
        } catch {
          continue;
        }
        if (!isRecord(rawRuntimeSettings)) {
          continue;
        }
      }
      const currentRuntimeSettings = rawRuntimeSettings
        ? normalizeRuntimeSettings(rawRuntimeSettings)
        : undefined;
      const runtimeHasPermissionMode = rawRuntimeSettings !== undefined && Object.prototype.hasOwnProperty.call(rawRuntimeSettings, "permissionMode");
      const runtimePermissionMode = runtimeHasPermissionMode
        ? normalizePermissionMode(currentRuntimeSettings?.permissionMode, DEFAULT_RUNTIME_SETTINGS.permissionMode)
        : undefined;
      const storedPermissionMode = normalizePermissionMode(row.permission_mode, DEFAULT_RUNTIME_SETTINGS.permissionMode);
      const permissionMode = runtimePermissionMode === "default_permissions" && row.permission_mode === "full_access"
        ? runtimePermissionMode
        : runtimeHasPermissionMode
          ? storedPermissionMode
          : "default_permissions";
      const codexApprovalMode = syncedCodexApprovalMode(permissionMode, normalizeCodexApprovalMode(row.codex_approval_mode, "default"), false);
      const runtimeSettingsJson = currentRuntimeSettings
        ? JSON.stringify({ ...currentRuntimeSettings, permissionMode })
        : null;
      if (row.permission_mode !== permissionMode || row.codex_approval_mode !== codexApprovalMode || row.runtime_settings_json !== runtimeSettingsJson) {
        update.run(runtimeSettingsJson, permissionMode, codexApprovalMode, row.id);
      }
    }
  }

  private seedMigratedThreadAccessState(): void {
    const rows = this.db.prepare("SELECT id, runtime_settings_json, codex_approval_mode FROM chat_threads").all() as Array<{
      id: string;
      runtime_settings_json: string | null;
      codex_approval_mode: string | null;
    }>;
    const update = this.db.prepare("UPDATE chat_threads SET permission_mode = ?, codex_approval_mode = ? WHERE id = ?");
    for (const row of rows) {
      const rawRuntimeSettings = row.runtime_settings_json
        ? parseJsonObject(row.runtime_settings_json) as Partial<ChatRuntimeSettings>
        : {};
      const codexApprovalMode = normalizeCodexApprovalMode(row.codex_approval_mode, "default");
      const fallbackPermissionMode = "default_permissions";
      const permissionMode = normalizePermissionMode(rawRuntimeSettings.permissionMode, fallbackPermissionMode);
      update.run(permissionMode, syncedCodexApprovalMode(permissionMode, codexApprovalMode, false), row.id);
    }
  }

  private importLegacyHistoryIfEmpty(): void {
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM chat_projects").get() as { count: number };
    if (existing.count > 0) {
      return;
    }
    const sourcePath = legacyHistoryPath(this.dbPath);
    if (!sourcePath) {
      return;
    }
    const imported = loadLegacyHistory(sourcePath);
    if (!imported) {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertProject = this.db.prepare(
        "INSERT INTO chat_projects (id, title, directory, action_buttons_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      imported.projects.forEach((project, index) => {
        insertProject.run(
          project.id,
          project.title,
          project.directory,
          JSON.stringify(project.actionButtons),
          project.createdAt,
          project.updatedAt,
          index
        );
      });
      const insertThread = this.db.prepare(
        `INSERT INTO chat_threads
          (id, project_id, title, provider_mode, selected_settings_preset_id, builtin_model_id, runtime_settings_json, builtin_agentic_framework,
           document_analysis_embedding_model_path, codex_model_id, codex_reasoning_effort, permission_mode, codex_approval_mode, plan_mode_enabled,
           document_index_id, codex_last_session_id, open_code_session_id, remote_session_id, remote_slot_id, remote_settings_signature, remote_host_identity,
           active_context_start_message_index, context_revision, context_markers_json, created_at, updated_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      imported.threads.forEach((thread, index) => {
        insertThread.run(
          thread.id,
          thread.projectId,
          thread.title,
          thread.providerMode,
          thread.selectedSettingsPresetId,
          thread.builtinModelId,
          JSON.stringify(thread.runtimeSettings),
          thread.builtinAgenticFramework,
          thread.documentAnalysisEmbeddingModelPath,
          thread.codexModelId,
          thread.codexReasoningEffort,
          thread.permissionMode,
          thread.codexApprovalMode,
          thread.planModeEnabled ? 1 : 0,
          thread.documentIndexId,
          thread.codexLastSessionId,
          thread.openCodeSessionId ?? "",
          thread.remoteSessionId,
          thread.remoteSlotId,
          thread.remoteSettingsSignature,
          thread.remoteHostIdentity,
          thread.activeContextStartMessageIndex,
          thread.contextRevision,
          JSON.stringify(thread.contextMarkers),
          thread.createdAt,
          thread.updatedAt,
          index
        );
      });
      const insertMessage = this.db.prepare(
        `INSERT INTO chat_messages
          (id, thread_id, role, content, attachments_json, label, source_label, reasoning, metadata_json, status, created_at, updated_at, sort_order)
         VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      imported.messages.forEach((message, index) => {
        insertMessage.run(
          message.id,
          message.threadId,
          message.role,
          message.content,
          message.label ?? null,
          message.sourceLabel ?? null,
          message.reasoning ?? null,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.status,
          message.createdAt,
          message.updatedAt,
          index
        );
      });
      this.setSettingInTransaction("selected_project_id", imported.selectedProjectId);
      this.setSettingInTransaction("selected_thread_id", imported.selectedThreadId);
      this.setSettingInTransaction("runtime_settings_json", JSON.stringify(DEFAULT_RUNTIME_SETTINGS));
      this.setSettingInTransaction(
        "app_settings_json",
        JSON.stringify(normalizeAppSettings({
          ...DEFAULT_APP_SETTINGS,
          actionButtons: imported.projects.find((project) => project.id === imported.selectedProjectId)?.actionButtons
            ?? imported.projects.find((project) => project.actionButtons.length > 0)?.actionButtons
            ?? [],
          expandedProjectIds: imported.projects.filter((project) => project.expanded).map((project) => project.id)
        }))
      );
      this.setSettingInTransaction("settings_presets_json", JSON.stringify(DEFAULT_SETTINGS_PRESETS));
      this.setSettingInTransaction("legacy_history_imported_path", imported.sourcePath);
      this.repairThreadAccessState();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
        .prepare("INSERT INTO chat_projects (id, title, directory, action_buttons_json, created_at, updated_at, sort_order) VALUES (?, ?, '', '[]', ?, ?, 0)")
        .run(projectId, "Project 1", now, now);
      this.db
        .prepare(`INSERT INTO chat_threads
          (id, project_id, title, runtime_settings_json, permission_mode, codex_approval_mode, created_at, updated_at, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(
          threadId,
          projectId,
          "Thread 1",
          JSON.stringify(DEFAULT_RUNTIME_SETTINGS),
          DEFAULT_RUNTIME_SETTINGS.permissionMode,
          codexApprovalModeForAccessMode(DEFAULT_RUNTIME_SETTINGS.permissionMode),
          now,
          now
        );
      this.setSettingInTransaction("selected_project_id", projectId);
      this.setSettingInTransaction("selected_thread_id", threadId);
      this.setSettingInTransaction("runtime_settings_json", JSON.stringify(DEFAULT_RUNTIME_SETTINGS));
      this.setSettingInTransaction("app_settings_json", JSON.stringify(DEFAULT_APP_SETTINGS));
      this.setSettingInTransaction("settings_presets_json", JSON.stringify(DEFAULT_SETTINGS_PRESETS));
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
      if (!isRecord(parsed)) {
        throw new Error("Stored chat runtime settings are malformed.");
      }
      return normalizeRuntimeSettings(parsed);
    } catch {
      throw new Error("Stored chat runtime settings are malformed.");
    }
  }

  private appSettings(): ChatAppSettings {
    const raw = this.setting("app_settings_json");
    if (!raw) {
      return DEFAULT_APP_SETTINGS;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ChatAppSettings>;
      return normalizeAppSettings(parsed);
    } catch {
      return DEFAULT_APP_SETTINGS;
    }
  }

  private migrateProjectActionButtonsToAppSettings(): void {
    const rawSettings = this.setting("app_settings_json");
    if (!rawSettings) {
      return;
    }
    let parsedSettings: Partial<ChatAppSettings>;
    try {
      parsedSettings = JSON.parse(rawSettings) as Partial<ChatAppSettings>;
    } catch {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(parsedSettings, "actionButtons")) {
      return;
    }
    const selectedProjectId = this.setting("selected_project_id");
    const rows = this.db
      .prepare("SELECT id, COALESCE(action_buttons_json, '[]') AS action_buttons_json FROM chat_projects ORDER BY sort_order")
      .all() as Array<{ id: string; action_buttons_json: string }>;
    const selectedRow = rows.find((row) => row.id === selectedProjectId);
    const selectedButtons = selectedRow ? normalizeActionButtons(parseJsonArray<ChatActionButton>(selectedRow.action_buttons_json, [])) : [];
    const firstButtons = selectedButtons.length > 0
      ? selectedButtons
      : rows.map((row) => normalizeActionButtons(parseJsonArray<ChatActionButton>(row.action_buttons_json, []))).find((buttons) => buttons.length > 0) ?? [];
    this.setSetting("app_settings_json", JSON.stringify(normalizeAppSettings({ ...parsedSettings, actionButtons: firstButtons })));
  }

  private repairLegacySettingsPresetAccessState(): void {
    if (this.setting("settings_presets_access_separated") === "1") {
      return;
    }
    const raw = this.setting("settings_presets_json");
    if (!raw) {
      this.setSetting("settings_presets_access_separated", "1");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) {
      return;
    }
    let changed = false;
    const repaired = parsed.map((preset) => {
      if (!isRecord(preset)) {
        return preset;
      }
      const {
        permissionMode: _permissionMode,
        codexApprovalMode: _codexApprovalMode,
        runtimeSettings,
        ...rest
      } = preset;
      if (_permissionMode !== undefined || _codexApprovalMode !== undefined) {
        changed = true;
      }
      if (!isRecord(runtimeSettings)) {
        return runtimeSettings === undefined ? rest : { ...rest, runtimeSettings };
      }
      const { permissionMode: _runtimePermissionMode, ...runtimeRest } = runtimeSettings;
      if (_runtimePermissionMode !== undefined) {
        changed = true;
      }
      return { ...rest, runtimeSettings: runtimeRest };
    });
    try {
      validateStoredSettingsPresets(repaired, { allowLegacyEmptyCodexModelId: true });
    } catch {
      return;
    }
    if (changed) {
      const normalized = normalizeSettingsPresets(repaired as ChatSettingsPreset[], []);
      validateStoredSettingsPresets(normalized);
      this.setSetting("settings_presets_json", JSON.stringify(normalized));
    }
    this.setSetting("settings_presets_access_separated", "1");
  }

  private repairLegacySettingsPresetCodexModelState(): void {
    if (this.setting("settings_presets_codex_model_normalized") === "1") {
      return;
    }
    const raw = this.setting("settings_presets_json");
    if (!raw) {
      this.setSetting("settings_presets_codex_model_normalized", "1");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) {
      return;
    }
    try {
      validateStoredSettingsPresets(parsed, { allowLegacyEmptyCodexModelId: true });
    } catch {
      return;
    }
    const needsRepair = parsed.some((preset) => isRecord(preset) && preset.codexModelId === "");
    if (needsRepair) {
      const normalized = normalizeSettingsPresets(parsed as ChatSettingsPreset[], []);
      validateStoredSettingsPresets(normalized);
      this.setSetting("settings_presets_json", JSON.stringify(normalized));
    }
    this.setSetting("settings_presets_codex_model_normalized", "1");
  }

  private markStreamingMessagesInterrupted(): void {
    const now = timestamp();
    this.db.prepare("UPDATE chat_messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'").run(now);
  }

  private settingsPresets(): ChatSettingsPreset[] {
    return normalizeSettingsPresets(this.storedSettingsPresets(), this.hiddenSettingsPresetIds());
  }

  private storedSettingsPresets(): ChatSettingsPreset[] {
    const raw = this.setting("settings_presets_json");
    if (!raw) {
      return normalizeSettingsPresets(DEFAULT_SETTINGS_PRESETS, []);
    }
    try {
      const parsed = JSON.parse(raw) as ChatSettingsPreset[];
      if (!Array.isArray(parsed)) {
        throw new Error("Stored chat settings presets are malformed.");
      }
      validateStoredSettingsPresets(parsed);
      return normalizeSettingsPresets(parsed, []);
    } catch {
      throw new Error("Stored chat settings presets are malformed.");
    }
  }

  private hiddenSettingsPresetIds(): string[] {
    const raw = this.setting("hidden_settings_preset_ids_json");
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error("Stored hidden chat settings preset ids are malformed.");
      }
      return parsed;
    } catch {
      throw new Error("Stored hidden chat settings preset ids are malformed.");
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

  private nextSortOrder(table: "chat_projects" | "chat_threads" | "chat_messages" | "chat_models" | "chat_document_indexes"): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${table}`).get() as { next: number };
    return row.next;
  }

  private ensureSelection(preferredProjectId?: string): void {
    this.seedIfEmpty();
    const selectedThreadId = this.setting("selected_thread_id");
    const selectedThread = selectedThreadId
      ? this.db.prepare("SELECT id, project_id FROM chat_threads WHERE id = ?").get(selectedThreadId) as
          | { id: string; project_id: string }
          | undefined
      : undefined;
    if (selectedThread) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.setSettingInTransaction("selected_project_id", selectedThread.project_id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    const nextThread = this.db
      .prepare(
        `SELECT id, project_id FROM chat_threads
         WHERE (? = '' OR project_id = ?)
         ORDER BY sort_order LIMIT 1`
      )
      .get(preferredProjectId ?? "", preferredProjectId ?? "") as { id: string; project_id: string } | undefined;
    const fallbackThread = nextThread ?? this.db
      .prepare("SELECT id, project_id FROM chat_threads ORDER BY sort_order LIMIT 1")
      .get() as { id: string; project_id: string } | undefined;
    const fallbackProject = this.db
      .prepare("SELECT id FROM chat_projects ORDER BY sort_order LIMIT 1")
      .get() as { id: string } | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setSettingInTransaction("selected_project_id", fallbackThread?.project_id ?? fallbackProject?.id ?? "");
      this.setSettingInTransaction("selected_thread_id", fallbackThread?.id ?? "");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

function legacyHistoryPath(dbPath: string): string | null {
  const explicit = process.env.UNIT_0_HISTORY_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const resolvedDbPath = path.resolve(dbPath).toLowerCase();
  const resolvedTempPath = path.resolve(os.tmpdir()).toLowerCase();
  if (process.env.NODE_ENV === "test" || resolvedDbPath.startsWith(resolvedTempPath)) {
    return null;
  }
  const stateDir = process.env.UNIT_0_STATE_DIR?.trim();
  const candidates = [
    stateDir ? path.join(path.resolve(stateDir), "history.json") : "",
    path.join(os.homedir(), "Documents", "UNIT-0", "history.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "UNIT-0", "history.json") : ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadLegacyHistory(sourcePath: string): LegacyHistoryImport | null {
  if (!fs.existsSync(sourcePath)) {
    if (process.env.UNIT_0_HISTORY_PATH?.trim()) {
      throw new Error(`Legacy UNIT-0 chat history file does not exist: ${sourcePath}`);
    }
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
  } catch (error) {
    throw new Error(`Legacy UNIT-0 chat history could not be parsed: ${sourcePath}. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(payload)) {
    throw new Error(`Legacy UNIT-0 chat history has an invalid root payload: ${sourcePath}`);
  }
  const rawProjects = Array.isArray(payload.projects) ? payload.projects : [];
  const rawConversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  if (rawProjects.length === 0 && rawConversations.length === 0) {
    return null;
  }
  const projectIds = new Set<string>();
  const projectIdMap = new Map<string, string>();
  const projects = rawProjects.map((item, index): ChatProject & { expanded: boolean } | null => {
    if (!isRecord(item)) {
      return null;
    }
    const createdAt = legacyTimestamp(item.created_at);
    const originalId = legacyText(item.id);
    const id = uniqueLegacyId(originalId, "chat-project", projectIds);
    if (originalId) {
      projectIdMap.set(originalId, id);
    }
    const settings = isRecord(item.settings) ? item.settings : {};
    return {
      id,
      title: normalizeTitle(legacyText(item.name) || `Project ${index + 1}`, 80) || `Project ${index + 1}`,
      directory: legacyText(settings.directory),
      actionButtons: normalizeLegacyActionButtons(settings.action_buttons),
      expanded: item.expanded !== false,
      createdAt,
      updatedAt: legacyTimestamp(item.updated_at, createdAt)
    };
  }).filter((project): project is ChatProject & { expanded: boolean } => Boolean(project));
  if (projects.length === 0) {
    const now = timestamp();
    const id = uniqueLegacyId("", "chat-project", projectIds);
    projects.push({ id, title: "Project 1", directory: "", actionButtons: [], expanded: true, createdAt: now, updatedAt: now });
  }
  const defaultProjectId = projects[0].id;
  const threadIds = new Set<string>();
  const threadIdMap = new Map<string, string>();
  const messageIds = new Set<string>();
  const threads: ChatThread[] = [];
  const messages: ChatMessage[] = [];
  rawConversations.forEach((item, index) => {
    if (!isRecord(item)) {
      return;
    }
    const createdAt = legacyTimestamp(item.created_at);
    const originalThreadId = legacyText(item.id);
    const threadId = uniqueLegacyId(originalThreadId, "chat-thread", threadIds);
    if (originalThreadId) {
      threadIdMap.set(originalThreadId, threadId);
    }
    const settings = legacyThreadSettings(item.settings);
    const legacyProjectId = legacyText(item.project_id);
    const projectId = projectIdMap.get(legacyProjectId) ?? (projectIds.has(legacyProjectId) ? legacyProjectId : defaultProjectId);
    threads.push({
      id: threadId,
      projectId,
      title: normalizeTitle(legacyText(item.title) || `Thread ${index + 1}`, 80) || `Thread ${index + 1}`,
      ...settings,
      createdAt,
      updatedAt: legacyTimestamp(item.updated_at, createdAt)
    });
    const rawMessages = Array.isArray(item.messages) ? item.messages : [];
    rawMessages.forEach((rawMessage) => {
      if (!isRecord(rawMessage)) {
        return;
      }
      const role = legacyText(rawMessage.role) === "user" ? "user" : "assistant";
      const messageCreatedAt = legacyTimestamp(rawMessage.created_at, createdAt);
      messages.push({
        id: uniqueLegacyId(legacyText(rawMessage.id), "chat-message", messageIds),
        threadId,
        role,
        content: legacyText(rawMessage.content),
        attachments: [],
        label: legacyText(rawMessage.model_label) || undefined,
        sourceLabel: legacyProviderLabel(rawMessage.provider_id),
        reasoning: legacyText(rawMessage.reasoning) || undefined,
        metadata: legacyMessageMetadata(rawMessage),
        status: "complete",
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt
      });
    });
  });
  if (threads.length === 0) {
    const now = timestamp();
    threads.push({
      id: uniqueLegacyId("", "chat-thread", threadIds),
      projectId: defaultProjectId,
      title: "Thread 1",
      ...legacyThreadSettings(undefined),
      createdAt: now,
      updatedAt: now
    });
  }
  const selectedThreadId = threadIdMap.get(legacyText(payload.current_conversation_id))
    ?? [...threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id
    ?? threads[0].id;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? threads[0];
  const selectedProjectId = projectIdMap.get(legacyText(payload.selected_project_id))
    ?? selectedThread.projectId
    ?? projects[0].id;
  return {
    projects,
    threads,
    messages,
    selectedProjectId,
    selectedThreadId: selectedThread.id,
    sourcePath
  };
}

function legacyThreadSettings(value: unknown): Omit<ChatThread, "id" | "projectId" | "title" | "createdAt" | "updatedAt"> {
  const payload = isRecord(value) ? value : {};
  const builtin = isRecord(payload.builtin) ? payload.builtin : {};
  const codex = isRecord(payload.codex) ? payload.codex : {};
  const builtinInferenceSettings = isRecord(builtin.inference_settings) ? builtin.inference_settings : {};
  const runtimeSettings = legacyRuntimeSettings(builtinInferenceSettings);
  const providerMode = normalizeProviderMode(payload.provider_mode, "builtin");
  const permissionMode = normalizePermissionMode(
    builtinInferenceSettings.permission_mode,
    "default_permissions"
  );
  const codexApprovalMode = syncedCodexApprovalMode(permissionMode, normalizeCodexApprovalMode(codex.approval_mode, "default"), false);
  const syncedRuntimeSettings = { ...runtimeSettings, permissionMode };
  return {
    providerMode,
    selectedSettingsPresetId: typeof payload.selected_settings_preset_id === "string" && payload.selected_settings_preset_id.trim()
      ? payload.selected_settings_preset_id.trim()
      : DEFAULT_SETTINGS_PRESET_ID,
    builtinModelId: legacyText(builtin.selected_model_id),
    runtimeSettings: syncedRuntimeSettings,
    builtinAgenticFramework: legacyText(builtin.document_index_id) ? "document_analysis" : "chat",
    documentAnalysisEmbeddingModelPath: legacyText(builtin.document_analysis_embedding_model_path),
    codexModelId: normalizeCodexModelId(codex.selected_model_id),
    codexReasoningEffort: normalizeReasoningEffort(codex.selected_reasoning_effort, "medium"),
    permissionMode,
    codexApprovalMode,
    planModeEnabled: Boolean(codex.plan_mode_enabled),
    documentIndexId: legacyText(builtin.document_index_id),
    codexLastSessionId: legacyText(codex.last_session_id),
    openCodeSessionId: "",
    remoteSessionId: legacyText(builtin.runtime_backend) === "remote_llama_host" ? legacyText(builtin.runtime_session_id) : "",
    remoteSlotId: legacyText(builtin.runtime_backend) === "remote_llama_host" ? legacyNonNegativeInteger(builtin.runtime_slot_id, 0) : 0,
    remoteSettingsSignature: legacyText(builtin.runtime_backend) === "remote_llama_host" ? legacyText(builtin.runtime_settings_signature) : "",
    remoteHostIdentity: legacyText(builtin.remote_host_identity),
    activeContextStartMessageIndex: legacyNonNegativeInteger(builtin.active_context_start_message_index, 0),
    contextRevision: legacyNonNegativeInteger(builtin.context_revision, 0),
    contextMarkers: legacyContextMarkers(builtin.context_markers)
  };
}

function legacyRuntimeSettings(value: Record<string, unknown>): ChatRuntimeSettings {
  return normalizeRuntimeSettings({
    nCtx: legacyPositiveInteger(value.n_ctx, DEFAULT_RUNTIME_SETTINGS.nCtx),
    nGpuLayers: legacyInteger(value.n_gpu_layers, DEFAULT_RUNTIME_SETTINGS.nGpuLayers),
    temperature: legacyFiniteNumber(value.temperature, DEFAULT_RUNTIME_SETTINGS.temperature),
    repeatPenalty: legacyFiniteNumber(value.repeat_penalty, DEFAULT_RUNTIME_SETTINGS.repeatPenalty),
    maxTokens: legacyPositiveInteger(value.max_tokens, DEFAULT_RUNTIME_SETTINGS.maxTokens),
    reasoningEffort: normalizeBuiltinReasoningEffort(value.reasoning_effort, DEFAULT_RUNTIME_SETTINGS.reasoningEffort),
    permissionMode: normalizePermissionMode(value.permission_mode, DEFAULT_RUNTIME_SETTINGS.permissionMode),
    trimReserveTokens: legacyPositiveInteger(value.trim_trigger_remaining_tokens, DEFAULT_RUNTIME_SETTINGS.trimReserveTokens),
    trimReservePercent: legacyFiniteNumber(value.trim_trigger_remaining_ratio, DEFAULT_RUNTIME_SETTINGS.trimReservePercent),
    trimAmountTokens: legacyPositiveInteger(value.trim_target_cleared_tokens, DEFAULT_RUNTIME_SETTINGS.trimAmountTokens),
    trimAmountPercent: legacyFiniteNumber(value.trim_target_cleared_ratio, DEFAULT_RUNTIME_SETTINGS.trimAmountPercent),
    systemPrompt: typeof value.system_prompt === "string" ? value.system_prompt : DEFAULT_RUNTIME_SETTINGS.systemPrompt
  });
}

function legacyContextMarkers(value: unknown): ChatContextMarker[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return normalizeContextMarkers(value.map((item): ChatContextMarker | null => {
    if (!isRecord(item)) {
      return null;
    }
    return {
      kind: legacyText(item.kind) === "reset" ? "reset" : "trim",
      boundaryMessageCount: legacyNonNegativeInteger(item.boundary_message_count, 0),
      timestamp: legacyTimestamp(item.created_at)
    };
  }).filter((item): item is ChatContextMarker => Boolean(item)));
}

function normalizeLegacyActionButtons(value: unknown): ChatActionButton[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return normalizeActionButtons(value.map((item, index) => {
    const row = isRecord(item) ? item : {};
    return {
      id: legacyText(row.id) || `action-${index + 1}`,
      label: legacyText(row.label),
      command: legacyText(row.command),
      directory: legacyText(row.directory)
    };
  }));
}

function legacyMessageMetadata(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (typeof value.reasoning_initially_expanded === "boolean") {
    metadata.reasoningInitiallyExpanded = value.reasoning_initially_expanded;
  }
  const providerId = legacyText(value.provider_id);
  if (providerId) {
    metadata.providerId = providerId;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function legacyProviderLabel(value: unknown): string | undefined {
  const providerId = legacyText(value);
  if (!providerId) {
    return undefined;
  }
  if (providerId === "codex") {
    return "Codex";
  }
  if (providerId === "builtin" || providerId === "local") {
    return "Built-in";
  }
  return providerId;
}

function uniqueLegacyId(value: string, prefix: string, seen: Set<string>): string {
  const trimmed = value.trim();
  const candidate = trimmed || `${prefix}-${randomUUID()}`;
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  let next = `${prefix}-${randomUUID()}`;
  while (seen.has(next)) {
    next = `${prefix}-${randomUUID()}`;
  }
  seen.add(next);
  return next;
}

function legacyText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function legacyTimestamp(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return value;
    }
  }
  return fallback ?? timestamp();
}

function legacyInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function legacyPositiveInteger(value: unknown, fallback: number): number {
  const parsed = legacyInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function legacyNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = legacyInteger(value, fallback);
  return parsed >= 0 ? parsed : fallback;
}

function legacyFiniteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectFromRow(row: ChatProjectRow): ChatProject {
  return {
    id: row.id,
    title: row.title,
    directory: row.directory ?? "",
    actionButtons: normalizeActionButtons(parseJsonArray<ChatActionButton>(row.action_buttons_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function threadFromRow(row: ChatThreadRow): ChatThread {
  const permissionMode = normalizePermissionMode(row.permission_mode, DEFAULT_RUNTIME_SETTINGS.permissionMode);
  const rawRuntimeSettings = parseRequiredJsonObject(row.runtime_settings_json, "Stored thread runtime settings are malformed.") as Partial<ChatRuntimeSettings>;
  const runtimeSettings = {
    ...normalizeRuntimeSettings(rawRuntimeSettings),
    permissionMode
  };
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    providerMode: normalizeProviderMode(row.provider_mode, "builtin"),
    selectedSettingsPresetId: row.selected_settings_preset_id || DEFAULT_SETTINGS_PRESET_ID,
    builtinModelId: row.builtin_model_id ?? "",
    runtimeSettings,
    builtinAgenticFramework: normalizeBuiltinAgenticFramework(row.builtin_agentic_framework),
    documentAnalysisEmbeddingModelPath: row.document_analysis_embedding_model_path ?? "",
    codexModelId: normalizeCodexModelId(row.codex_model_id),
    codexReasoningEffort: normalizeReasoningEffort(row.codex_reasoning_effort, "medium"),
    permissionMode,
    codexApprovalMode: normalizeCodexApprovalMode(row.codex_approval_mode, "default"),
    planModeEnabled: row.plan_mode_enabled === 1,
    documentIndexId: row.document_index_id ?? "",
    codexLastSessionId: row.codex_last_session_id ?? "",
    openCodeSessionId: row.open_code_session_id ?? "",
    remoteSessionId: row.remote_session_id ?? "",
    remoteSlotId: nonNegativeInteger(row.remote_slot_id, 0),
    remoteSettingsSignature: row.remote_settings_signature ?? "",
    remoteHostIdentity: row.remote_host_identity ?? "",
    activeContextStartMessageIndex: nonNegativeInteger(row.active_context_start_message_index, 0),
    contextRevision: nonNegativeInteger(row.context_revision, 0),
    contextMarkers: normalizeContextMarkers(parseJsonArray<ChatContextMarker>(row.context_markers_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function messageFromRow(row: ChatMessageRow): ChatMessage {
  const attachments = parseJsonArray<ChatAttachment>(row.attachments_json, []);
  const metadata = parseJsonObject(row.metadata_json);
  const rawTimelineBlocks = metadata?.timelineBlocks;
  const timelineBlocks = Array.isArray(rawTimelineBlocks) ? rawTimelineBlocks as ChatTimelineBlock[] : undefined;
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    attachments,
    label: row.label ?? undefined,
    sourceLabel: row.source_label ?? undefined,
    reasoning: row.reasoning ?? undefined,
    timelineBlocks,
    metadata,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function modelFromRow(row: ChatModelRow): ChatModel {
  return { id: row.id, label: row.label, path: row.path, providerId: "local", reference: row.path, sourceLabel: "Built-in", hostId: "", createdAt: row.created_at };
}

function normalizeRemoteModel(value: Partial<ChatModel>): ChatModel {
  return {
    id: typeof value.id === "string" ? value.id.trim() : "",
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : (typeof value.id === "string" ? value.id.trim() : ""),
    path: typeof value.path === "string" ? value.path : "",
    providerId: "remote",
    reference: typeof value.reference === "string" ? value.reference.trim() : "",
    promptFormat: typeof value.promptFormat === "string" ? value.promptFormat.trim() : "",
    contextTokens: positiveInteger(value.contextTokens, 0) || undefined,
    sourceLabel: typeof value.sourceLabel === "string" && value.sourceLabel.trim() ? value.sourceLabel.trim() : "Remote Built-in",
    hostId: typeof value.hostId === "string" ? value.hostId.trim() : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : timestamp()
  };
}

function normalizeRuntimeSettings(value: Partial<ChatRuntimeSettings>): ChatRuntimeSettings {
  return {
    nCtx: positiveInteger(value.nCtx, DEFAULT_RUNTIME_SETTINGS.nCtx),
    nGpuLayers: Number.isInteger(value.nGpuLayers) ? value.nGpuLayers! : DEFAULT_RUNTIME_SETTINGS.nGpuLayers,
    temperature: finiteNumber(value.temperature, DEFAULT_RUNTIME_SETTINGS.temperature),
    repeatPenalty: finiteNumber(value.repeatPenalty, DEFAULT_RUNTIME_SETTINGS.repeatPenalty),
    maxTokens: positiveInteger(value.maxTokens, DEFAULT_RUNTIME_SETTINGS.maxTokens),
    reasoningEffort: normalizeBuiltinReasoningEffort(value.reasoningEffort, DEFAULT_RUNTIME_SETTINGS.reasoningEffort),
    permissionMode: normalizePermissionMode(value.permissionMode, DEFAULT_RUNTIME_SETTINGS.permissionMode),
    trimReserveTokens: positiveInteger(value.trimReserveTokens, DEFAULT_RUNTIME_SETTINGS.trimReserveTokens),
    trimReservePercent: finiteNumber(value.trimReservePercent, DEFAULT_RUNTIME_SETTINGS.trimReservePercent),
    trimAmountTokens: positiveInteger(value.trimAmountTokens, DEFAULT_RUNTIME_SETTINGS.trimAmountTokens),
    trimAmountPercent: finiteNumber(value.trimAmountPercent, DEFAULT_RUNTIME_SETTINGS.trimAmountPercent),
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : DEFAULT_RUNTIME_SETTINGS.systemPrompt
  };
}

function normalizeAppSettings(value: Partial<ChatAppSettings>): ChatAppSettings {
  return {
    usageIndicatorPlacement: value.usageIndicatorPlacement === "composer" ? "composer" : "footer",
    usageIndicatorOrder: Array.isArray(value.usageIndicatorOrder) && value.usageIndicatorOrder.every((item) => typeof item === "string")
      ? value.usageIndicatorOrder
      : DEFAULT_APP_SETTINGS.usageIndicatorOrder,
    usageIndicatorPreferences: normalizeUsageIndicatorPreferences(value.usageIndicatorPreferences),
    actionButtons: Array.isArray(value.actionButtons)
      ? normalizeActionButtons(value.actionButtons)
      : DEFAULT_APP_SETTINGS.actionButtons,
    expandedProjectIds: Array.isArray(value.expandedProjectIds) && value.expandedProjectIds.every((item) => typeof item === "string")
      ? value.expandedProjectIds
      : DEFAULT_APP_SETTINGS.expandedProjectIds,
    autoExpandCodexDisclosures: typeof value.autoExpandCodexDisclosures === "boolean"
      ? value.autoExpandCodexDisclosures
      : DEFAULT_APP_SETTINGS.autoExpandCodexDisclosures,
    tokenizerModelPath: typeof value.tokenizerModelPath === "string" ? value.tokenizerModelPath : "",
    remoteHostAddress: typeof value.remoteHostAddress === "string" ? value.remoteHostAddress : "",
    remoteHostPort: positiveInteger(value.remoteHostPort, DEFAULT_APP_SETTINGS.remoteHostPort),
    remotePairingCode: typeof value.remotePairingCode === "string" ? value.remotePairingCode : "",
    remoteHostId: typeof value.remoteHostId === "string" ? value.remoteHostId : "",
    remoteHostIdentity: typeof value.remoteHostIdentity === "string" ? value.remoteHostIdentity : "",
    remoteProtocolVersion: typeof value.remoteProtocolVersion === "string" ? value.remoteProtocolVersion : ""
  };
}

function threadSettingsChangeInvalidatesPreset(current: ChatThread, next: {
  providerMode?: ChatProviderMode;
  builtinModelId?: string;
  runtimeSettings?: ChatRuntimeSettings;
  builtinAgenticFramework?: ChatBuiltinAgenticFramework;
  documentAnalysisEmbeddingModelPath?: string;
  codexModelId?: string;
  codexReasoningEffort?: ChatReasoningEffort;
  permissionMode?: ChatPermissionMode;
  codexApprovalMode?: ChatCodexApprovalMode;
  planModeEnabled?: boolean;
}): boolean {
  return (next.providerMode !== undefined && next.providerMode !== current.providerMode)
    || (next.builtinModelId !== undefined && next.builtinModelId !== current.builtinModelId)
    || (next.runtimeSettings !== undefined && JSON.stringify(presetRuntimeSettings(next.runtimeSettings)) !== JSON.stringify(presetRuntimeSettings(current.runtimeSettings)))
    || (next.builtinAgenticFramework !== undefined && next.builtinAgenticFramework !== current.builtinAgenticFramework)
    || (next.documentAnalysisEmbeddingModelPath !== undefined && next.documentAnalysisEmbeddingModelPath !== current.documentAnalysisEmbeddingModelPath)
    || (next.codexModelId !== undefined && next.codexModelId !== current.codexModelId)
    || (next.codexReasoningEffort !== undefined && next.codexReasoningEffort !== current.codexReasoningEffort)
    || (next.planModeEnabled !== undefined && next.planModeEnabled !== current.planModeEnabled);
}

function runtimeSettingsPatchInvalidatesPreset(settings: Partial<ChatRuntimeSettings>): boolean {
  return Object.keys(settings).some((key) => key !== "permissionMode");
}

function normalizeUsageIndicatorPreferences(value: Partial<Record<ChatUsageIndicatorId, Partial<ChatUsageIndicatorPreference>>> | undefined): Record<ChatUsageIndicatorId, ChatUsageIndicatorPreference> {
  return {
    git_diff: normalizeUsageIndicatorPreference(value?.git_diff, DEFAULT_APP_SETTINGS.usageIndicatorPreferences.git_diff),
    context: normalizeUsageIndicatorPreference(value?.context, DEFAULT_APP_SETTINGS.usageIndicatorPreferences.context),
    week: normalizeUsageIndicatorPreference(value?.week, DEFAULT_APP_SETTINGS.usageIndicatorPreferences.week),
    five_hour: normalizeUsageIndicatorPreference(value?.five_hour, DEFAULT_APP_SETTINGS.usageIndicatorPreferences.five_hour)
  };
}

function normalizeUsageIndicatorPreference(value: Partial<ChatUsageIndicatorPreference> | undefined, fallback: ChatUsageIndicatorPreference): ChatUsageIndicatorPreference {
  const placement = value?.placement;
  const displayMode = value?.displayMode;
  return {
    displayMode: displayMode === "circle" ? "circle" : "bar",
    placement: placement === "left" || placement === "right" || placement === "bottom" || placement === "footer_right" || placement === "sidebar" || placement === "hidden"
      ? placement
      : fallback.placement,
    order: Math.max(1, Math.min(4, positiveInteger(value?.order, fallback.order)))
  };
}

function normalizeSettingsPresets(value: ChatSettingsPreset[], hiddenIds: string[]): ChatSettingsPreset[] {
  const byId = new Map<string, ChatSettingsPreset>();
  for (const preset of DEFAULT_SETTINGS_PRESETS) {
    byId.set(preset.id, normalizeSettingsPreset(preset));
  }
  const customOrder: string[] = [];
  for (const preset of value) {
    const normalized = normalizeSettingsPreset(preset);
    if (!normalized.id) {
      continue;
    }
    if (!byId.has(normalized.id) && !customOrder.includes(normalized.id)) {
      customOrder.push(normalized.id);
    }
    byId.set(normalized.id, normalized);
  }
  const hidden = new Set(hiddenIds);
  return [
    byId.get(DEFAULT_SETTINGS_PRESET_ID) ?? normalizeSettingsPreset(DEFAULT_SETTINGS_PRESETS[0]),
    ...DEFAULT_SETTINGS_PRESETS.slice(1).map((preset) => byId.get(preset.id) ?? normalizeSettingsPreset(preset)),
    ...customOrder.map((id) => byId.get(id)).filter((preset): preset is ChatSettingsPreset => Boolean(preset))
  ].filter((preset) => !hidden.has(preset.id));
}

function validateStoredSettingsPresets(value: unknown[], options: { allowLegacyEmptyCodexModelId?: boolean } = {}): asserts value is ChatSettingsPreset[] {
  const stringKeys = new Set(["id", "label", "providerMode", "iconName", "builtinModelId", "builtinAgenticFramework", "documentAnalysisEmbeddingModelPath", "codexModelId", "codexReasoningEffort"]);
  const booleanKeys = new Set(["builtIn", "editable", "deletable"]);
  const allowedKeys = new Set([...stringKeys, ...booleanKeys, "runtimeSettings"]);
  for (const preset of value) {
    if (!isRecord(preset)) {
      throw new Error("Stored chat settings presets are malformed.");
    }
    if (preset.runtimeSettings !== undefined && !isRecord(preset.runtimeSettings)) {
      throw new Error("Stored chat settings presets are malformed.");
    }
    for (const key of allowedKeys) {
      if (preset[key] === undefined) {
        throw new Error("Stored chat settings presets are malformed.");
      }
    }
    for (const key of Object.keys(preset)) {
      if (!allowedKeys.has(key)) {
        throw new Error("Stored chat settings presets are malformed.");
      }
    }
    for (const key of stringKeys) {
      if (preset[key] !== undefined && typeof preset[key] !== "string") {
        throw new Error("Stored chat settings presets are malformed.");
      }
    }
    for (const key of booleanKeys) {
      if (preset[key] !== undefined && typeof preset[key] !== "boolean") {
        throw new Error("Stored chat settings presets are malformed.");
      }
    }
    if (typeof preset.id !== "string" || typeof preset.label !== "string" || !preset.id.trim() || !preset.label.trim()) {
      throw new Error("Stored chat settings presets are malformed.");
    }
    if (preset.providerMode !== undefined && preset.providerMode !== "builtin" && preset.providerMode !== "codex") {
      throw new Error("Stored chat settings presets are malformed.");
    }
    const iconName = typeof preset.iconName === "string" ? preset.iconName.trim() : "";
    if (iconName && !SETTINGS_PRESET_ICON_NAMES.has(iconName)) {
      throw new Error("Stored chat settings presets are malformed.");
    }
    if (preset.builtinAgenticFramework !== undefined && preset.builtinAgenticFramework !== "chat" && preset.builtinAgenticFramework !== "document_analysis" && preset.builtinAgenticFramework !== "opencode") {
      throw new Error("Stored chat settings presets are malformed.");
    }
    if (preset.codexReasoningEffort !== undefined && preset.codexReasoningEffort !== "low" && preset.codexReasoningEffort !== "medium" && preset.codexReasoningEffort !== "high" && preset.codexReasoningEffort !== "xhigh") {
      throw new Error("Stored chat settings presets are malformed.");
    }
    if (options.allowLegacyEmptyCodexModelId && preset.codexModelId === "") {
      // Legacy stored presets used an empty value to mean the default Codex model.
    } else if (!DEFAULT_CODEX_MODELS.some((model) => model.id === preset.codexModelId)) {
      throw new Error("Stored chat settings presets are malformed.");
    }
    if (isRecord(preset.runtimeSettings)) {
      validateStoredPresetRuntimeSettings(preset.runtimeSettings);
    }
  }
}

function validateStoredPresetRuntimeSettings(value: Record<string, unknown>): void {
  const positiveIntegerKeys = new Set(["nCtx", "maxTokens", "trimReserveTokens", "trimAmountTokens"]);
  const integerKeys = new Set(["nGpuLayers"]);
  const finiteNumberKeys = new Set(["temperature", "repeatPenalty", "trimReservePercent", "trimAmountPercent"]);
  const numberKeys = new Set([...positiveIntegerKeys, ...integerKeys, ...finiteNumberKeys]);
  const stringKeys = new Set(["reasoningEffort", "systemPrompt"]);
  const allowedKeys = new Set([...numberKeys, ...stringKeys]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error("Stored chat settings presets are malformed.");
    }
  }
  for (const key of positiveIntegerKeys) {
    if (value[key] !== undefined && !positiveInteger(value[key], 0)) {
      throw new Error("Stored chat settings presets are malformed.");
    }
  }
  for (const key of integerKeys) {
    if (value[key] !== undefined && !Number.isInteger(value[key])) {
      throw new Error("Stored chat settings presets are malformed.");
    }
  }
  for (const key of finiteNumberKeys) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      throw new Error("Stored chat settings presets are malformed.");
    }
  }
  const temperature = value.temperature;
  if (typeof temperature === "number" && temperature < 0) {
    throw new Error("Stored chat settings presets are malformed.");
  }
  const repeatPenalty = value.repeatPenalty;
  if (typeof repeatPenalty === "number" && repeatPenalty <= 0) {
    throw new Error("Stored chat settings presets are malformed.");
  }
  for (const key of ["trimReservePercent", "trimAmountPercent"]) {
    const numberValue = value[key];
    if (typeof numberValue === "number" && (numberValue < 0 || numberValue > 100)) {
      throw new Error("Stored chat settings presets are malformed.");
    }
  }
  for (const key of stringKeys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error("Stored chat settings presets are malformed.");
    }
  }
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== "low" && value.reasoningEffort !== "medium" && value.reasoningEffort !== "high") {
    throw new Error("Stored chat settings presets are malformed.");
  }
}

function normalizeSettingsPreset(value: Omit<Partial<ChatSettingsPreset>, "runtimeSettings"> & { id?: string; runtimeSettings?: Partial<ChatRuntimeSettings> }): ChatSettingsPreset {
  const providerMode = normalizeProviderMode(value.providerMode, "builtin");
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : `custom::${randomUUID()}`;
  return {
    id,
    label: typeof value.label === "string" && value.label.trim() ? normalizeTitle(value.label, 80) : "Untitled settings",
    runtimeSettings: presetRuntimeSettings(value.runtimeSettings ?? {}),
    providerMode,
    iconName: normalizeSettingsPresetIconName(value.iconName, providerMode),
    builtinModelId: typeof value.builtinModelId === "string" ? value.builtinModelId.trim() : "",
    builtinAgenticFramework: normalizeBuiltinAgenticFramework(value.builtinAgenticFramework),
    documentAnalysisEmbeddingModelPath: typeof value.documentAnalysisEmbeddingModelPath === "string" ? value.documentAnalysisEmbeddingModelPath.trim() : "",
    codexModelId: normalizeCodexModelId(value.codexModelId),
    codexReasoningEffort: normalizeReasoningEffort(value.codexReasoningEffort, "medium"),
    builtIn: Boolean(value.builtIn),
    editable: typeof value.editable === "boolean" ? value.editable : true,
    deletable: typeof value.deletable === "boolean" ? value.deletable : id !== DEFAULT_SETTINGS_PRESET_ID
  };
}

function normalizeSettingsPresetIconName(value: unknown, providerMode: ChatSettingsPreset["providerMode"]): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "code") {
    return DEFAULT_CODEX_PRESET_ICON_NAME;
  }
  if (SETTINGS_PRESET_ICON_NAMES.has(normalized)) {
    return normalized;
  }
  return providerMode === "codex" ? DEFAULT_CODEX_PRESET_ICON_NAME : "sliders";
}

function normalizeSettingsPresetId(value: string, presets: ChatSettingsPreset[]): string {
  const id = value.trim();
  return presets.some((preset) => preset.id === id) ? id : DEFAULT_SETTINGS_PRESET_ID;
}

function defaultCodexModelId(): string {
  return DEFAULT_CODEX_MODELS.find((model) => model.isDefault)?.id ?? DEFAULT_CODEX_MODELS[0].id;
}

function normalizeProviderMode(value: unknown, fallback: ChatProviderMode): ChatProviderMode {
  return value === "codex" || value === "builtin" ? value : fallback;
}

function normalizeReasoningEffort(value: unknown, fallback: ChatReasoningEffort): ChatReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : fallback;
}

function normalizeBuiltinReasoningEffort(value: unknown, fallback: Exclude<ChatReasoningEffort, "xhigh">): Exclude<ChatReasoningEffort, "xhigh"> {
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function normalizePermissionMode(value: unknown, fallback: ChatPermissionMode): ChatPermissionMode {
  return value === "default_permissions" || value === "full_access" ? value : fallback;
}

function normalizeBuiltinAgenticFramework(value: unknown): ChatBuiltinAgenticFramework {
  return value === "document_analysis" || value === "opencode" ? value : "chat";
}

function documentIndexFromRow(row: ChatDocumentIndexRow): ChatDocumentIndex {
  const state = row.state === "building" || row.state === "error" ? row.state : "ready";
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sourcePath: row.source_path,
    embeddingModelPath: row.embedding_model_path ?? "",
    state,
    progress: Math.max(0, Math.min(1, Number(row.progress ?? 0))),
    message: row.message ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeDocumentSourcePaths(sourcePath: string): string[] {
  return sourcePath.split(/\r?\n/g).map((item) => item.trim()).filter(Boolean);
}

function documentSourcePathKey(sourcePath: string): string {
  return path.resolve(sourcePath).toLocaleLowerCase();
}

function normalizeEmbedding(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error("Document embedding contains a non-finite value.");
    }
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error("Document embedding cannot be empty.");
  }
  return vector.map((value) => value / norm);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0 || left.length !== right.length) {
    return -1;
  }
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}

function parseEmbeddingJson(value: string | null): number[] | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJsonArray<number>(value, []);
  return parsed.length > 0 ? normalizeEmbedding(parsed.map(Number)) : undefined;
}

function normalizeCodexApprovalMode(value: unknown, fallback: ChatCodexApprovalMode): ChatCodexApprovalMode {
  if (value === "on_request") {
    return "on-request";
  }
  if (value === "on_failure") {
    return "on-failure";
  }
  if (value === "never_ask") {
    return "never";
  }
  return value === "default" || value === "on-request" || value === "on-failure" || value === "untrusted" || value === "never" ? value : fallback;
}

function codexApprovalModeForAccessMode(value: ChatPermissionMode): ChatCodexApprovalMode {
  return value === "full_access" ? "never" : "default";
}

function syncedCodexApprovalMode(value: ChatPermissionMode, current: ChatCodexApprovalMode, explicitAccessChange: boolean): ChatCodexApprovalMode {
  if (value === "full_access") {
    return "never";
  }
  if (explicitAccessChange || current === "never") {
    return "default";
  }
  return current;
}

function accessModeForCodexApprovalMode(value: ChatCodexApprovalMode): ChatPermissionMode {
  return value === "never" ? "full_access" : "default_permissions";
}

function normalizeActionButtons(value: ChatActionButton[]): ChatActionButton[] {
  return value
    .map((button, index) => ({
      id: typeof button.id === "string" && button.id.trim() ? button.id.trim() : `action-${index + 1}`,
      label: typeof button.label === "string" ? button.label.trim().slice(0, 40) : "",
      command: typeof button.command === "string" ? button.command.trim() : "",
      directory: typeof button.directory === "string" ? button.directory.trim() : ""
    }))
    .filter((button) => button.label && button.command);
}

function normalizeContextMarkers(value: ChatContextMarker[]): ChatContextMarker[] {
  return value
    .map((marker): ChatContextMarker => ({
      kind: marker.kind === "reset" ? "reset" : "trim",
      boundaryMessageCount: nonNegativeInteger(marker.boundaryMessageCount, 0),
      timestamp: typeof marker.timestamp === "string" ? marker.timestamp : ""
    }))
    .filter((marker) => marker.timestamp);
}

function normalizeCodexModelId(value: unknown): string {
  const id = typeof value === "string" && value.trim() ? value.trim() : defaultCodexModelId();
  return DEFAULT_CODEX_MODELS.some((model) => model.id === id) ? id : defaultCodexModelId();
}

function normalizeTitle(value: string, maxLength: number): string {
  return value.trim().split(/\s+/).join(" ").slice(0, maxLength);
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseJsonArray<T>(value: string | null, fallback: T[]): T[] {
  if (!value) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseRequiredJsonObject(value: string | null, message: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error(message);
    }
    return parsed;
  } catch {
    throw new Error(message);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}
