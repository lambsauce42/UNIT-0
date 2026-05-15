import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore } from "../src/main/chatStore";

function makeStore(): { store: ChatStore; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-store-"));
  const dbPath = path.join(dir, "unit0.sqlite");
  return { store: new ChatStore(dbPath), dir, dbPath };
}

function validStoredPresetFixture(): Record<string, unknown> {
  return {
    id: "custom::valid",
    label: "Valid",
    runtimeSettings: { nCtx: 4096, maxTokens: 4096, reasoningEffort: "medium" },
    providerMode: "builtin",
    iconName: "settings",
    builtinModelId: "",
    builtinAgenticFramework: "chat",
    documentAnalysisEmbeddingModelPath: "",
    codexModelId: "gpt-5.3-codex",
    codexReasoningEffort: "medium",
    builtIn: false,
    editable: true,
    deletable: true
  };
}

function storedPresetFromJson(raw: string, id: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  return parsed.find((preset) => preset.id === id);
}

function hiddenFastOverridePayload(): Record<string, unknown> {
  return {
    id: "builtin::fast",
    label: "Custom Fast",
    runtimeSettings: {
      nCtx: 8192,
      maxTokens: 8192,
      reasoningEffort: "medium",
      temperature: 1,
      repeatPenalty: 1,
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30
    },
    providerMode: "builtin",
    iconName: "bolt",
    builtinModelId: "",
    builtinAgenticFramework: "opencode",
    documentAnalysisEmbeddingModelPath: "",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high",
    builtIn: true,
    editable: true,
    deletable: true
  };
}

test("seeds a default global chat project and thread", () => {
  const { store, dbPath } = makeStore();
  const state = store.loadState();

  expect(state.projects).toHaveLength(1);
  expect(state.threads).toHaveLength(1);
  expect(state.selectedProjectId).toBe(state.projects[0].id);
  expect(state.selectedThreadId).toBe(state.threads[0].id);
  expect(state.messages).toEqual([]);
  expect(state.models).toEqual([]);
  expect(state.codexModels.some((model) => model.isDefault)).toBe(true);
  expect(state.codexModels.every((model) => model.supportsImageInput)).toBe(true);
  expect(state.threads[0]).toMatchObject({
    providerMode: "builtin",
    codexModelId: "gpt-5.3-codex",
    codexReasoningEffort: "medium",
    permissionMode: "full_access",
    codexApprovalMode: "never",
    planModeEnabled: false
  });
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(state.selectedThreadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  db.close();
  expect(row.permission_mode).toBe("full_access");
  expect(row.codex_approval_mode).toBe("never");
  expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "full_access" });
  store.close();
});

test("imports legacy PySide history into a fresh SQLite chat store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-legacy-"));
  const historyPath = path.join(dir, "history.json");
  const previousHistoryPath = process.env.UNIT_0_HISTORY_PATH;
  process.env.UNIT_0_HISTORY_PATH = historyPath;
  fs.writeFileSync(historyPath, JSON.stringify({
    projects: [{
      id: "legacy-project",
      name: "Legacy Project",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      expanded: true,
      settings: {
        directory: "C:\\Legacy",
        action_buttons: [{ label: "Dev", command: "npm run dev", directory: "C:\\Legacy" }]
      }
    }],
    conversations: [{
      id: "legacy-thread",
      project_id: "legacy-project",
      title: "Legacy Thread",
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
      messages: [
        { id: "m-user", role: "user", content: "hello", created_at: "2026-01-03T00:00:00Z" },
        { id: "m-assistant", role: "assistant", content: "world", reasoning: "thinking", model_label: "Qwen", provider_id: "builtin", created_at: "2026-01-03T00:01:00Z" }
      ],
      settings: {
        provider_mode: "codex",
        selected_settings_preset_id: "custom::default",
        builtin: {
          selected_model_id: "local::legacy",
          inference_settings: {
            n_ctx: 8192,
            n_gpu_layers: -1,
            reasoning_effort: "high",
            permission_mode: "default_permissions",
            system_prompt: "Legacy prompt",
            temperature: 0.2,
            repeat_penalty: 1.05,
            trim_trigger_remaining_tokens: 500,
            trim_trigger_remaining_ratio: 10,
            trim_target_cleared_tokens: 1500,
            trim_target_cleared_ratio: 25,
            max_tokens: 4096
          },
          document_index_id: "doc-1",
          active_context_start_message_index: 1,
          context_revision: 2,
          context_markers: [{ kind: "reset", boundary_message_count: 1, created_at: "2026-01-03T00:02:00Z" }]
        },
        codex: {
          selected_model_id: "gpt-5.3-codex-spark",
          selected_reasoning_effort: "high",
          approval_mode: "on_request",
          last_session_id: "codex-session",
          plan_mode_enabled: true
        }
      }
    }],
    current_conversation_id: "legacy-thread",
    selected_project_id: "legacy-project"
  }));

  try {
    const store = new ChatStore(path.join(dir, "unit0.sqlite"));
    const state = store.loadState();

    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({
      id: "legacy-project",
      title: "Legacy Project",
      directory: "C:\\Legacy"
    });
    expect(state.projects[0].actionButtons).toMatchObject([{ label: "Dev", command: "npm run dev", directory: "C:\\Legacy" }]);
    expect(state.appSettings.actionButtons).toMatchObject([{ label: "Dev", command: "npm run dev", directory: "C:\\Legacy" }]);
    expect(state.threads[0]).toMatchObject({
      id: "legacy-thread",
      projectId: "legacy-project",
      providerMode: "codex",
      builtinModelId: "local::legacy",
      codexModelId: "gpt-5.3-codex-spark",
      codexReasoningEffort: "high",
      codexApprovalMode: "on-request",
      planModeEnabled: true,
      documentIndexId: "doc-1",
      activeContextStartMessageIndex: 1,
      contextRevision: 2
    });
    expect(state.runtimeSettings).toMatchObject({ nCtx: 8192, maxTokens: 4096, systemPrompt: "Legacy prompt" });
    expect(state.selectedProjectId).toBe("legacy-project");
    expect(state.selectedThreadId).toBe("legacy-thread");
    expect(state.messages.map((message) => [message.id, message.role, message.content, message.label, message.sourceLabel])).toEqual([
      ["m-user", "user", "hello", undefined, undefined],
      ["m-assistant", "assistant", "world", "Qwen", "Built-in"]
    ]);
    expect(state.appSettings.expandedProjectIds).toEqual(["legacy-project"]);
    const db = new DatabaseSync(path.join(dir, "unit0.sqlite"));
    const row = db
      .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
      .get("legacy-thread") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
    db.close();
    expect(row.permission_mode).toBe("default_permissions");
    expect(row.codex_approval_mode).toBe("on-request");
    expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
    store.close();
  } finally {
    if (previousHistoryPath === undefined) {
      delete process.env.UNIT_0_HISTORY_PATH;
    } else {
      process.env.UNIT_0_HISTORY_PATH = previousHistoryPath;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imports legacy Codex never approval without overriding explicit runtime access", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-legacy-never-"));
  const historyPath = path.join(dir, "history.json");
  const previousHistoryPath = process.env.UNIT_0_HISTORY_PATH;
  process.env.UNIT_0_HISTORY_PATH = historyPath;
  fs.writeFileSync(historyPath, JSON.stringify({
    projects: [{ id: "legacy-project", name: "Legacy Project", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }],
    conversations: [{
      id: "legacy-thread",
      project_id: "legacy-project",
      title: "Legacy Thread",
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
      messages: [],
      settings: {
        provider_mode: "codex",
        builtin: { inference_settings: { permission_mode: "default_permissions" } },
        codex: { approval_mode: "never" }
      }
    }],
    current_conversation_id: "legacy-thread",
    selected_project_id: "legacy-project"
  }));

  let store: ChatStore | undefined;
  try {
    const dbPath = path.join(dir, "unit0.sqlite");
    store = new ChatStore(dbPath);
    const state = store.loadState();
    expect(state.threads[0]).toMatchObject({
      providerMode: "codex",
      permissionMode: "default_permissions",
      codexApprovalMode: "default",
      runtimeSettings: { permissionMode: "default_permissions" }
    });
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
      .get("legacy-thread") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
    db.close();
    expect(row.permission_mode).toBe("default_permissions");
    expect(row.codex_approval_mode).toBe("default");
    expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
    store.close();
  } finally {
    if (previousHistoryPath === undefined) {
      delete process.env.UNIT_0_HISTORY_PATH;
    } else {
      process.env.UNIT_0_HISTORY_PATH = previousHistoryPath;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imports legacy Codex approval as default access when runtime access is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-legacy-missing-access-"));
  const historyPath = path.join(dir, "history.json");
  const previousHistoryPath = process.env.UNIT_0_HISTORY_PATH;
  process.env.UNIT_0_HISTORY_PATH = historyPath;
  fs.writeFileSync(historyPath, JSON.stringify({
    projects: [{ id: "legacy-project", name: "Legacy Project", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }],
    conversations: [{
      id: "legacy-thread",
      project_id: "legacy-project",
      title: "Legacy Thread",
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
      messages: [],
      settings: {
        provider_mode: "codex",
        builtin: { inference_settings: { n_ctx: 4096 } },
        codex: { approval_mode: "on_request" }
      }
    }],
    current_conversation_id: "legacy-thread",
    selected_project_id: "legacy-project"
  }));

  let store: ChatStore | undefined;
  try {
    const dbPath = path.join(dir, "unit0.sqlite");
    store = new ChatStore(dbPath);
    const state = store.loadState();
    expect(state.threads[0]).toMatchObject({
      providerMode: "codex",
      permissionMode: "default_permissions",
      codexApprovalMode: "on-request",
      runtimeSettings: { permissionMode: "default_permissions" }
    });
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
      .get("legacy-thread") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
    db.close();
    expect(row.permission_mode).toBe("default_permissions");
    expect(row.codex_approval_mode).toBe("on-request");
    expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
  } finally {
    store?.close();
    if (previousHistoryPath === undefined) {
      delete process.env.UNIT_0_HISTORY_PATH;
    } else {
      process.env.UNIT_0_HISTORY_PATH = previousHistoryPath;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imports legacy Codex never approval as default access when runtime access is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-legacy-missing-never-access-"));
  const historyPath = path.join(dir, "history.json");
  const previousHistoryPath = process.env.UNIT_0_HISTORY_PATH;
  process.env.UNIT_0_HISTORY_PATH = historyPath;
  fs.writeFileSync(historyPath, JSON.stringify({
    projects: [{ id: "legacy-project", name: "Legacy Project", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }],
    conversations: [{
      id: "legacy-thread",
      project_id: "legacy-project",
      title: "Legacy Thread",
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
      messages: [],
      settings: {
        provider_mode: "codex",
        builtin: { inference_settings: { n_ctx: 4096 } },
        codex: { approval_mode: "never" }
      }
    }],
    current_conversation_id: "legacy-thread",
    selected_project_id: "legacy-project"
  }));

  let store: ChatStore | undefined;
  try {
    const dbPath = path.join(dir, "unit0.sqlite");
    store = new ChatStore(dbPath);
    const state = store.loadState();
    expect(state.threads[0]).toMatchObject({
      providerMode: "codex",
      permissionMode: "default_permissions",
      codexApprovalMode: "default",
      runtimeSettings: { permissionMode: "default_permissions" }
    });
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
      .get("legacy-thread") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
    db.close();
    expect(row.permission_mode).toBe("default_permissions");
    expect(row.codex_approval_mode).toBe("default");
    expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
  } finally {
    store?.close();
    if (previousHistoryPath === undefined) {
      delete process.env.UNIT_0_HISTORY_PATH;
    } else {
      process.env.UNIT_0_HISTORY_PATH = previousHistoryPath;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creates and selects threads with persisted messages", () => {
  const { store, dbPath } = makeStore();
  const thread = store.createThread();
  store.createMessage(thread.id, "user", "hello", "complete", {
    attachments: [{ id: "attachment-1", name: "notes.md", path: path.join(dbPath, "..", "notes.md"), kind: "file" }]
  });
  const assistant = store.createMessage(thread.id, "assistant", "", "streaming", { label: "test-model", sourceLabel: "Built-in" });
  store.appendToMessageReasoning(assistant.id, "thinking");
  store.appendToMessage(assistant.id, "world");
  store.updateMessageStatus(assistant.id, "complete");
  store.close();

  const restarted = new ChatStore(dbPath);
  const state = restarted.loadState();
  expect(state.selectedThreadId).toBe(thread.id);
  expect(state.messages.map((message) => [message.role, message.content, message.status])).toEqual([
    ["user", "hello", "complete"],
    ["assistant", "world", "complete"]
  ]);
  expect(state.messages[0].attachments.map((attachment) => attachment.name)).toEqual(["notes.md"]);
  expect(state.messages[1].label).toBe("test-model");
  expect(state.messages[1].reasoning).toBe("thinking");
  restarted.close();
});

test("adds only GGUF local models and selects duplicate paths", () => {
  const { store, dir } = makeStore();
  const modelPath = path.join(dir, "test-model.gguf");
  fs.writeFileSync(modelPath, "not a real model");
  const model = store.addLocalModel(modelPath);
  const duplicate = store.addLocalModel(modelPath);

  expect(duplicate.id).toBe(model.id);
  expect(store.loadState().selectedModelId).toBe(model.id);
  expect(() => store.addLocalModel(path.join(dir, "missing.gguf"))).toThrow(/Model file not found/);
  const textPath = path.join(dir, "model.txt");
  fs.writeFileSync(textPath, "not a gguf");
  expect(() => store.addLocalModel(textPath)).toThrow(/GGUF/);
  store.close();
});

test("refreshes local model catalog by reconciling missing GGUF files", () => {
  const { store, dir } = makeStore();
  const modelPath = path.join(dir, "test-model.gguf");
  fs.writeFileSync(modelPath, "not a real model");
  const model = store.addLocalModel(modelPath);
  fs.rmSync(modelPath);

  const refresh = store.refreshLocalModels();
  const state = store.loadState();

  expect(refresh.removedModelIds).toEqual([model.id]);
  expect(state.models).toEqual([]);
  expect(state.selectedModelId).toBe("");
  expect(state.threads[0].builtinModelId).toBe("");
  store.close();
});

test("persists local context trim/reset markers", () => {
  const { store } = makeStore();
  const state = store.loadState();
  const threadId = state.selectedThreadId;
  store.createMessage(threadId, "user", "one", "complete");
  store.createMessage(threadId, "assistant", "two", "complete");

  const updated = store.updateLocalContextBoundary(threadId, 2, "reset");

  expect(updated.activeContextStartMessageIndex).toBe(2);
  expect(updated.contextRevision).toBe(1);
  expect(updated.contextMarkers).toMatchObject([{ kind: "reset", boundaryMessageCount: 2 }]);
  store.close();
});

test("searches document index chunks by stored vector embeddings", () => {
  const { store, dir } = makeStore();
  const sourcePath = path.join(dir, "notes.txt");
  fs.writeFileSync(sourcePath, "alpha project facts\n\nbeta release notes");
  const state = store.loadState();
  const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath, path.join(dir, "embed.gguf"));
  store.replaceDocumentIndexChunks(index.id, [
    {
      chunkId: "chunk-1",
      sourceTitle: "notes.txt",
      sourcePath,
      pageStart: 1,
      pageEnd: 1,
      text: "unrelated surface text",
      tokenCount: 5,
      ordinalStart: 0,
      ordinalEnd: 0,
      embedding: [1, 0, 0]
    },
    {
      chunkId: "chunk-2",
      sourceTitle: "notes.txt",
      sourcePath,
      pageStart: 2,
      pageEnd: 2,
      text: "also unrelated surface text",
      tokenCount: 5,
      ordinalStart: 1,
      ordinalEnd: 1,
      embedding: [0, 1, 0]
    }
  ]);
  store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });

  const results = store.searchDocumentIndexByVector(index.id, [0.98, 0.02, 0], 2, 100);

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ chunkId: "chunk-1", score: expect.any(Number) });
  expect(store.searchDocumentIndexByVector(index.id, [0, 0, 1], 2, 100)).toEqual([]);
  store.close();
});

test("rejects vector search on indexes without stored embeddings", () => {
  const { store, dir } = makeStore();
  const sourcePath = path.join(dir, "notes.txt");
  fs.writeFileSync(sourcePath, "alpha project facts");
  const state = store.loadState();
  const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
  store.replaceDocumentIndexChunks(index.id, [
    {
      chunkId: "chunk-1",
      sourceTitle: "notes.txt",
      sourcePath,
      pageStart: 1,
      pageEnd: 1,
      text: "alpha project facts",
      tokenCount: 5,
      ordinalStart: 0,
      ordinalEnd: 0
    }
  ]);
  store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });

  expect(() => store.searchDocumentIndexByVector(index.id, [1, 0, 0])).toThrow(/does not contain vector embeddings/);
  store.close();
});

test("updates and deletes document index groups", () => {
  const { store, dir } = makeStore();
  const sourcePath = path.join(dir, "notes.txt");
  const nextSourcePath = path.join(dir, "brief.txt");
  fs.writeFileSync(sourcePath, "alpha project facts");
  fs.writeFileSync(nextSourcePath, "beta project facts");
  const state = store.loadState();
  const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
  store.selectDocumentIndex(state.selectedThreadId, index.id);
  store.replaceDocumentIndexChunks(index.id, [
    {
      chunkId: "chunk-1",
      sourceTitle: "notes.txt",
      sourcePath,
      pageStart: 1,
      pageEnd: 1,
      text: "alpha project facts",
      tokenCount: 5,
      ordinalStart: 0,
      ordinalEnd: 0,
      embedding: [1, 0, 0]
    }
  ]);
  store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });

  const renamed = store.updateDocumentIndex(index.id, "Knowledge", sourcePath);
  let next = store.loadState();
  expect(renamed).toMatchObject({ id: index.id, title: "Knowledge", sourcePath, state: "ready", progress: 1 });
  expect(next.documentIndexes.find((item) => item.id === index.id)).toMatchObject({ title: "Knowledge", sourcePath, state: "ready" });
  expect(store.searchDocumentIndexByVector(index.id, [1, 0, 0], 1, 100)).toHaveLength(1);

  const updated = store.updateDocumentIndex(index.id, "Brief", nextSourcePath);
  next = store.loadState();
  expect(updated).toMatchObject({ id: index.id, title: "Brief", sourcePath: nextSourcePath, state: "building", progress: 0 });
  expect(next.documentIndexes.find((item) => item.id === index.id)).toMatchObject({ title: "Brief", sourcePath: nextSourcePath, state: "building" });
  expect(() => store.searchDocumentIndexByVector(index.id, [1, 0, 0])).toThrow(/not ready/);

  store.deleteDocumentIndex(index.id);
  next = store.loadState();
  expect(next.documentIndexes.some((item) => item.id === index.id)).toBe(false);
  expect(next.threads.find((thread) => thread.id === state.selectedThreadId)?.documentIndexId).toBe("");
  store.close();
});

test("manages projects, threads, deletion selection, and runtime settings", () => {
  const { store } = makeStore();
  const project = store.createProject();
  const projectTwo = store.createProject();
  let state = store.loadState();
  expect(state.selectedProjectId).toBe(projectTwo.id);
  expect(state.threads.filter((thread) => thread.projectId === project.id)).toHaveLength(1);
  store.moveProject(projectTwo.id, project.id, "before");
  state = store.loadState();
  const reorderedProjectIds = state.projects.map((item) => item.id);
  expect(reorderedProjectIds.indexOf(projectTwo.id)).toBeLessThan(reorderedProjectIds.indexOf(project.id));

  store.updateProjectSettings(project.id, "Renamed Project", "C:\\Workspace");
  const thread = store.createThread(project.id);
  store.renameThread(thread.id, "Renamed Thread");
  store.moveThread(thread.id, projectTwo.id);
  store.updateThreadSettings(thread.id, {
    providerMode: "codex",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high",
    permissionMode: "default_permissions",
    codexApprovalMode: "default",
    planModeEnabled: true
  });
  store.updateRuntimeSettings({ nCtx: 8192, maxTokens: 2048, reasoningEffort: "high", permissionMode: "default_permissions" });
  state = store.loadState();
  expect(state.projects.find((item) => item.id === project.id)?.title).toBe("Renamed Project");
  expect(state.projects.find((item) => item.id === project.id)?.directory).toBe("C:\\Workspace");
  expect(state.threads.find((item) => item.id === thread.id)?.title).toBe("Renamed Thread");
  expect(state.threads.find((item) => item.id === thread.id)?.projectId).toBe(projectTwo.id);
  expect(state.threads.find((item) => item.id === thread.id)).toMatchObject({
    providerMode: "codex",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high",
    permissionMode: "default_permissions",
    planModeEnabled: true
  });
  expect(state.runtimeSettings.nCtx).toBe(8192);
  expect(state.runtimeSettings.maxTokens).toBe(2048);
  expect(state.runtimeSettings.reasoningEffort).toBe("high");
  expect(state.runtimeSettings.permissionMode).toBe("default_permissions");

  store.deleteThread(thread.id);
  state = store.loadState();
  expect(state.threads.some((item) => item.id === thread.id)).toBe(false);
  expect(state.selectedProjectId).toBe(projectTwo.id);
  expect(state.selectedThreadId).toBeTruthy();

  store.deleteProject(project.id);
  state = store.loadState();
  expect(state.projects.some((item) => item.id === project.id)).toBe(false);
  expect(state.projects.some((item) => item.id === state.selectedProjectId)).toBe(true);
  store.close();
});

test("persists settings presets and applies provider/framework state", () => {
  const { store, dbPath } = makeStore();
  let state = store.loadState();
  const threadId = state.selectedThreadId;
  expect(state.settingsPresets.map((preset) => preset.label)).toEqual(["Default", "Fast", "Deep"]);

  const preset = store.saveSettingsPreset({
    label: "Document preset",
    runtimeSettings: { nCtx: 8192, reasoningEffort: "low", permissionMode: "default_permissions" },
    providerMode: "builtin",
    iconName: "brain",
    builtinAgenticFramework: "document_analysis",
    documentAnalysisEmbeddingModelPath: "C:\\Models\\embed.gguf"
  });
  const openCodePreset = store.saveSettingsPreset({
    label: "OpenCode preset",
    runtimeSettings: { temperature: 0.2 },
    providerMode: "builtin",
    builtinAgenticFramework: "opencode"
  });
  const codexPreset = store.saveSettingsPreset({
    label: "Codex preset",
    runtimeSettings: {},
    providerMode: "codex",
    iconName: "code",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high"
  });
  expect(codexPreset.iconName).toBe("openai");
  expect("permissionMode" in preset.runtimeSettings).toBe(false);
  const rawPresetDb = new DatabaseSync(dbPath);
  const rawPresetRow = rawPresetDb
    .prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'")
    .get() as { value: string };
  rawPresetDb.close();
  expect(rawPresetRow.value).not.toContain("permissionMode");
  store.applySettingsPreset(threadId, preset.id);
  state = store.loadState();
  expect(state.runtimeSettings.nCtx).toBe(8192);
  expect(state.runtimeSettings.permissionMode).toBe("full_access");
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    selectedSettingsPresetId: preset.id,
    permissionMode: "full_access",
    codexApprovalMode: "never",
    builtinAgenticFramework: "document_analysis",
    documentAnalysisEmbeddingModelPath: "C:\\Models\\embed.gguf"
  });
  store.applySettingsPreset(threadId, openCodePreset.id);
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    selectedSettingsPresetId: openCodePreset.id,
    permissionMode: "full_access",
    codexApprovalMode: "never",
    builtinAgenticFramework: "opencode"
  });
  expect(state.runtimeSettings.permissionMode).toBe("full_access");
  store.updateThreadSettings(threadId, { builtinAgenticFramework: "chat" });
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)?.selectedSettingsPresetId).toBe("custom::default");
  store.applySettingsPreset(threadId, openCodePreset.id);
  store.updateRuntimeSettings({ permissionMode: "default_permissions" });
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)?.selectedSettingsPresetId).toBe(openCodePreset.id);
  store.applySettingsPreset(threadId, preset.id);
  state = store.loadState();
  expect(state.runtimeSettings.permissionMode).toBe("default_permissions");
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    permissionMode: "default_permissions",
    codexApprovalMode: "default"
  });
  store.updateRuntimeSettings({ temperature: 0.7 });
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)?.selectedSettingsPresetId).toBe("custom::default");

  store.updateThreadSettings(threadId, {
    permissionMode: "full_access",
    runtimeSettings: { permissionMode: "full_access" }
  });
  store.applySettingsPreset(threadId, codexPreset.id);
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    selectedSettingsPresetId: codexPreset.id,
    providerMode: "codex",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high",
    permissionMode: "full_access",
    codexApprovalMode: "never",
    runtimeSettings: { permissionMode: "full_access" }
  });
  expect(state.runtimeSettings.permissionMode).toBe("full_access");

  store.updateThreadSettings(threadId, {
    providerMode: "codex",
    permissionMode: "default_permissions",
    codexApprovalMode: "default"
  });
  store.applySettingsPreset(threadId, codexPreset.id);
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    selectedSettingsPresetId: codexPreset.id,
    providerMode: "codex",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high",
    permissionMode: "default_permissions",
    codexApprovalMode: "default"
  });
  expect(state.runtimeSettings.permissionMode).toBe("default_permissions");
  store.applySettingsPreset(threadId, openCodePreset.id);
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    selectedSettingsPresetId: openCodePreset.id,
    providerMode: "builtin",
    permissionMode: "default_permissions",
    codexApprovalMode: "default"
  });
  expect(state.runtimeSettings.permissionMode).toBe("default_permissions");
  store.updateThreadSettings(threadId, {
    permissionMode: "full_access",
    runtimeSettings: { permissionMode: "full_access" }
  });
  state = store.loadState();
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    selectedSettingsPresetId: openCodePreset.id,
    permissionMode: "full_access",
    codexApprovalMode: "never"
  });

  store.deleteSettingsPreset("builtin::fast");
  expect(store.loadState().settingsPresets.some((item) => item.id === "builtin::fast")).toBe(false);
  store.close();

  const restarted = new ChatStore(dbPath);
  expect(restarted.loadState().settingsPresets.some((item) => item.id === "builtin::fast")).toBe(false);
  expect(restarted.loadState().settingsPresets.some((item) => item.label === "Document preset")).toBe(true);
  restarted.close();
});

test("repairs legacy preset access at rest without applying it", () => {
  const { store, dbPath } = makeStore();
  store.close();
  const legacyPreset = {
    id: "custom::legacy-access",
    label: "Legacy Access",
    permissionMode: "full_access",
    codexApprovalMode: "never",
    runtimeSettings: { nCtx: 4096, permissionMode: "default_permissions" },
    providerMode: "builtin",
    iconName: "settings",
    builtinModelId: "",
    builtinAgenticFramework: "chat",
    documentAnalysisEmbeddingModelPath: "",
    codexModelId: "",
    codexReasoningEffort: "medium",
    builtIn: false,
    editable: true,
    deletable: true
  };
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
    .run("settings_presets_json", JSON.stringify([legacyPreset]));
  db.prepare("DELETE FROM chat_settings WHERE key = ?").run("settings_presets_access_separated");
  db.close();

  const repairedStore = new ChatStore(dbPath);
  const state = repairedStore.loadState();
  const repairedPreset = state.settingsPresets.find((preset) => preset.id === legacyPreset.id);
  expect(repairedPreset).toBeTruthy();
  expect(repairedPreset).toMatchObject({
    codexModelId: "gpt-5.3-codex",
    runtimeSettings: { nCtx: 4096 }
  });
  expect("permissionMode" in (repairedPreset?.runtimeSettings ?? {})).toBe(false);
  const repairedDb = new DatabaseSync(dbPath);
  const repairedRow = repairedDb
    .prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'")
    .get() as { value: string };
  repairedDb.close();
  expect(repairedRow.value).not.toContain("permissionMode");
  expect(repairedRow.value).not.toContain("codexApprovalMode");
  repairedStore.close();
});

test("rejects malformed settings preset storage instead of masking it", () => {
  const { store, dbPath } = makeStore();
  const selectedThreadId = store.loadState().selectedThreadId;
  for (const malformed of [
    "{ permissionMode: full_access, codexApprovalMode: never",
    JSON.stringify({ permissionMode: "full_access", codexApprovalMode: "never" }),
    JSON.stringify(["bad"]),
    JSON.stringify([{}]),
    JSON.stringify([{ id: "custom::bad", label: "Bad" }]),
    JSON.stringify([{ ...validStoredPresetFixture(), id: "" }]),
    JSON.stringify([{ ...validStoredPresetFixture(), label: " " }]),
    JSON.stringify([{ ...validStoredPresetFixture(), codexModelId: "unknown-model" }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: "bad" }]),
    JSON.stringify([{ id: 42, label: "Bad", runtimeSettings: {} }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", providerMode: "bad", runtimeSettings: {} }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { nCtx: "bad" } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { nCtx: 0 } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { maxTokens: -1 } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { temperature: -0.1 } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { repeatPenalty: 0 } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { trimReservePercent: 101 } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { trimAmountPercent: -1 } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { reasoningEffort: "xhigh" } }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", permissionMode: "full_access", runtimeSettings: {} }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", codexApprovalMode: "never", runtimeSettings: {} }]),
    JSON.stringify([{ id: "custom::bad", label: "Bad", runtimeSettings: { permissionMode: "full_access" } }])
  ]) {
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
      .run("settings_presets_json", malformed);
    db.close();

    expect(() => store.loadState()).toThrow(/settings presets are malformed/);
    const stateDb = new DatabaseSync(dbPath);
    const threadRow = stateDb
      .prepare("SELECT permission_mode, codex_approval_mode FROM chat_threads WHERE id = ?")
      .get(selectedThreadId) as { permission_mode: string; codex_approval_mode: string };
    stateDb.close();
    expect(threadRow.permission_mode).toBe("full_access");
    expect(threadRow.codex_approval_mode).toBe("never");
  }
  store.close();
});

test("malformed preset storage does not mark legacy preset access migration complete", () => {
  const { store, dbPath } = makeStore();
  store.close();
  for (const malformed of [
    JSON.stringify({ permissionMode: "full_access" }),
    JSON.stringify(["bad"]),
    JSON.stringify([{ ...validStoredPresetFixture(), permissionMode: "full_access" }, "bad"])
  ]) {
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
      .run("settings_presets_json", malformed);
    db.prepare("DELETE FROM chat_settings WHERE key = ?").run("settings_presets_access_separated");
    db.prepare("DELETE FROM chat_settings WHERE key = ?").run("settings_presets_codex_model_normalized");
    db.close();

    let migratedStore: ChatStore | undefined;
    expect(() => {
      migratedStore = new ChatStore(dbPath);
    }).not.toThrow();
    expect(() => migratedStore?.loadState()).toThrow(/settings presets are malformed/);
    migratedStore?.close();
    const flaggedDb = new DatabaseSync(dbPath);
    const flagRow = flaggedDb.prepare("SELECT value FROM chat_settings WHERE key = ?")
      .get("settings_presets_access_separated") as { value: string } | undefined;
    const codexFlagRow = flaggedDb.prepare("SELECT value FROM chat_settings WHERE key = ?")
      .get("settings_presets_codex_model_normalized") as { value: string } | undefined;
    const rawRow = flaggedDb.prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'").get() as { value: string };
    flaggedDb.close();
    expect(flagRow).toBeUndefined();
    expect(codexFlagRow).toBeUndefined();
    expect(rawRow.value).toBe(malformed);
  }

  const repairedPreset = {
    id: "custom::legacy-after-bad-storage",
    label: "Legacy After Bad Storage",
    permissionMode: "full_access",
    codexApprovalMode: "never",
    runtimeSettings: { nCtx: 4096, permissionMode: "default_permissions" },
    providerMode: "builtin",
    iconName: "settings",
    builtinModelId: "",
    builtinAgenticFramework: "chat",
    documentAnalysisEmbeddingModelPath: "",
    codexModelId: "",
    codexReasoningEffort: "medium",
    builtIn: false,
    editable: true,
    deletable: true
  };
  const repairDb = new DatabaseSync(dbPath);
  repairDb.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
    .run("settings_presets_json", JSON.stringify([repairedPreset]));
  repairDb.close();

  const repairedStore = new ChatStore(dbPath);
  const preset = repairedStore.loadState().settingsPresets.find((candidate) => candidate.id === repairedPreset.id);
  expect(preset).toMatchObject({
    codexModelId: "gpt-5.3-codex",
    runtimeSettings: { nCtx: 4096 }
  });
  expect("permissionMode" in (preset?.runtimeSettings ?? {})).toBe(false);
  repairedStore.close();
});

test("legacy empty preset Codex model is repaired independently of access migration", () => {
  const { store, dbPath } = makeStore();
  store.close();
  const legacyPreset = { ...validStoredPresetFixture(), id: "custom::legacy-empty-codex-model", codexModelId: "" };
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
    .run("settings_presets_json", JSON.stringify([legacyPreset]));
  db.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
    .run("settings_presets_access_separated", "1");
  db.prepare("DELETE FROM chat_settings WHERE key = ?").run("settings_presets_codex_model_normalized");
  db.close();

  const repairedStore = new ChatStore(dbPath);
  const preset = repairedStore.loadState().settingsPresets.find((candidate) => candidate.id === legacyPreset.id);
  expect(preset).toMatchObject({ codexModelId: "gpt-5.3-codex" });
  const repairedDb = new DatabaseSync(dbPath);
  const rawRow = repairedDb.prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'").get() as { value: string };
  const flagRow = repairedDb.prepare("SELECT value FROM chat_settings WHERE key = ?")
    .get("settings_presets_codex_model_normalized") as { value: string };
  repairedDb.close();
  expect(storedPresetFromJson(rawRow.value, legacyPreset.id)?.codexModelId).toBe("gpt-5.3-codex");
  expect(flagRow.value).toBe("1");
  repairedStore.close();
});

test("hiding a customized built-in settings preset does not prune its stored override", () => {
  const { store, dbPath } = makeStore();
  store.saveSettingsPreset({
    id: "builtin::fast",
    label: "Custom Fast",
    runtimeSettings: { nCtx: 8192, maxTokens: 8192 },
    providerMode: "builtin",
    iconName: "bolt",
    builtinAgenticFramework: "opencode",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high"
  });
  store.deleteSettingsPreset("builtin::fast");
  expect(store.loadState().settingsPresets.some((item) => item.id === "builtin::fast")).toBe(false);
  const db = new DatabaseSync(dbPath);
  const rawRow = db.prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'").get() as { value: string };
  db.close();
  expect(rawRow.value).toContain("Custom Fast");
  expect(rawRow.value).toContain("builtin::fast");
  expect(storedPresetFromJson(rawRow.value, "builtin::fast")).toMatchObject(hiddenFastOverridePayload());
  store.saveSettingsPreset({
    label: "Other preset",
    runtimeSettings: { nCtx: 4096 },
    providerMode: "builtin",
    iconName: "settings",
    builtinAgenticFramework: "chat",
    codexReasoningEffort: "medium"
  });
  const afterSaveDb = new DatabaseSync(dbPath);
  const afterSaveRow = afterSaveDb.prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'").get() as { value: string };
  afterSaveDb.close();
  expect(afterSaveRow.value).toContain("Custom Fast");
  expect(afterSaveRow.value).toContain("Other preset");
  expect(storedPresetFromJson(afterSaveRow.value, "builtin::fast")).toMatchObject(hiddenFastOverridePayload());
  const otherPreset = store.loadState().settingsPresets.find((preset) => preset.label === "Other preset");
  expect(otherPreset).toBeTruthy();
  store.deleteSettingsPreset(otherPreset!.id);
  const afterDeleteDb = new DatabaseSync(dbPath);
  const afterDeleteRow = afterDeleteDb.prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'").get() as { value: string };
  afterDeleteDb.close();
  expect(afterDeleteRow.value).toContain("Custom Fast");
  expect(afterDeleteRow.value).not.toContain("Other preset");
  expect(storedPresetFromJson(afterDeleteRow.value, "builtin::fast")).toMatchObject(hiddenFastOverridePayload());
  store.close();

  const restarted = new ChatStore(dbPath);
  expect(restarted.loadState().settingsPresets.some((item) => item.id === "builtin::fast")).toBe(false);
  const restartedDb = new DatabaseSync(dbPath);
  const restartedRawRow = restartedDb.prepare("SELECT value FROM chat_settings WHERE key = 'settings_presets_json'").get() as { value: string };
  restartedDb.close();
  expect(restartedRawRow.value).toContain("Custom Fast");
  expect(restartedRawRow.value).toContain("builtin::fast");
  expect(storedPresetFromJson(restartedRawRow.value, "builtin::fast")).toMatchObject(hiddenFastOverridePayload());
  restarted.close();
});

test("rejects malformed hidden settings preset ids instead of resurrecting presets", () => {
  const { store, dbPath } = makeStore();
  for (const malformed of ["{ hidden", JSON.stringify({ id: "builtin::fast" }), JSON.stringify(["builtin::fast", 42])]) {
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
      .run("hidden_settings_preset_ids_json", malformed);
    db.close();
    expect(() => store.loadState()).toThrow(/hidden chat settings preset ids are malformed/);
  }
  store.close();
});

test("persists per-thread built-in model, runtime settings, and expanded projects", () => {
  const { store } = makeStore();
  const initial = store.loadState();
  const firstThreadId = initial.selectedThreadId;
  const firstProjectId = initial.selectedProjectId;
  const secondProject = store.createProject("Second Project");
  const secondThread = store.createThread(secondProject.id, "Second Thread");

  store.updateThreadSettings(firstThreadId, {
    builtinModelId: "first-model",
    runtimeSettings: { nCtx: 4096, temperature: 0.4 }
  });
  store.updateThreadSettings(secondThread.id, {
    builtinModelId: "second-model",
    runtimeSettings: { nCtx: 16384, temperature: 0.9 }
  });
  store.updateAppSettings({ expandedProjectIds: [firstProjectId] });

  store.selectThread(firstThreadId);
  let state = store.loadState();
  expect(state.selectedModelId).toBe("first-model");
  expect(state.runtimeSettings.nCtx).toBe(4096);
  expect(state.runtimeSettings.temperature).toBe(0.4);
  expect(state.appSettings.expandedProjectIds).toEqual([firstProjectId]);

  store.selectThread(secondThread.id);
  state = store.loadState();
  expect(state.selectedModelId).toBe("second-model");
  expect(state.runtimeSettings.nCtx).toBe(16384);
  expect(state.runtimeSettings.temperature).toBe(0.9);
  expect(state.threads.find((thread) => thread.id === firstThreadId)?.runtimeSettings.nCtx).toBe(4096);
  store.close();
});

test("thread permission mode is canonical over mismatched runtime access", () => {
  const { store, dbPath } = makeStore();
  const state = store.loadState();
  const threadId = state.selectedThreadId;

  store.updateThreadSettings(threadId, {
    permissionMode: "default_permissions",
    runtimeSettings: { permissionMode: "full_access" }
  });
  store.updateThreadSettings(threadId, { permissionMode: "full_access" });
  let stateAfterAccess = store.loadState();
  expect(stateAfterAccess.threads.find((thread) => thread.id === threadId)).toMatchObject({
    permissionMode: "full_access",
    codexApprovalMode: "never",
    runtimeSettings: { permissionMode: "full_access" }
  });
  store.updateThreadSettings(threadId, { permissionMode: "default_permissions", runtimeSettings: { permissionMode: "full_access" } });
  const next = store.loadState();
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(threadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  db.close();

  expect(next.threads.find((thread) => thread.id === threadId)).toMatchObject({
    permissionMode: "default_permissions",
    runtimeSettings: { permissionMode: "default_permissions" }
  });
  expect(next.runtimeSettings.permissionMode).toBe("default_permissions");
  expect(row.permission_mode).toBe("default_permissions");
  expect(row.codex_approval_mode).toBe("default");
  expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });

  const rawDb = new DatabaseSync(dbPath);
  rawDb.prepare("UPDATE chat_threads SET permission_mode = ?, codex_approval_mode = ?, runtime_settings_json = ? WHERE id = ?")
    .run("full_access", "default", JSON.stringify({ ...JSON.parse(row.runtime_settings_json), permissionMode: "default_permissions" }), threadId);
  rawDb.close();

  store.updateThreadSettings(threadId, { openCodeSessionId: "session-after-raw-mismatch" });
  const fixedDb = new DatabaseSync(dbPath);
  const fixedRow = fixedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(threadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  fixedDb.close();
  expect(fixedRow.permission_mode).toBe("full_access");
  expect(fixedRow.codex_approval_mode).toBe("never");
  expect(JSON.parse(fixedRow.runtime_settings_json)).toMatchObject({
    permissionMode: "full_access"
  });

  const rawRuntimeDb = new DatabaseSync(dbPath);
  rawRuntimeDb.prepare("UPDATE chat_threads SET permission_mode = ?, codex_approval_mode = ?, runtime_settings_json = ? WHERE id = ?")
    .run("default_permissions", "never", JSON.stringify({ ...JSON.parse(fixedRow.runtime_settings_json), permissionMode: "full_access" }), threadId);
  rawRuntimeDb.close();

  store.updateRuntimeSettings({ temperature: 0.31 });
  const fixedRuntimeDb = new DatabaseSync(dbPath);
  const fixedRuntimeRow = fixedRuntimeDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(threadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  fixedRuntimeDb.close();
  expect(fixedRuntimeRow.permission_mode).toBe("default_permissions");
  expect(fixedRuntimeRow.codex_approval_mode).toBe("default");
  expect(JSON.parse(fixedRuntimeRow.runtime_settings_json)).toMatchObject({
    permissionMode: "default_permissions",
    temperature: 0.31
  });

  store.updateRuntimeSettings({ permissionMode: "full_access" });
  const fullRuntimeDb = new DatabaseSync(dbPath);
  const fullRuntimeRow = fullRuntimeDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(threadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  fullRuntimeDb.close();
  expect(fullRuntimeRow.permission_mode).toBe("full_access");
  expect(fullRuntimeRow.codex_approval_mode).toBe("never");
  expect(JSON.parse(fullRuntimeRow.runtime_settings_json)).toMatchObject({ permissionMode: "full_access" });

  const startupRawDb = new DatabaseSync(dbPath);
  startupRawDb.prepare("UPDATE chat_threads SET permission_mode = ?, codex_approval_mode = ?, runtime_settings_json = ? WHERE id = ?")
    .run("full_access", "default", JSON.stringify({ ...JSON.parse(fullRuntimeRow.runtime_settings_json), permissionMode: "default_permissions" }), threadId);
  startupRawDb.close();
  store.close();
  const repairedStore = new ChatStore(dbPath);
  const repairedDb = new DatabaseSync(dbPath);
  const repairedRow = repairedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(threadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  repairedDb.close();
  expect(repairedRow.permission_mode).toBe("default_permissions");
  expect(repairedRow.codex_approval_mode).toBe("default");
  expect(JSON.parse(repairedRow.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
  repairedStore.close();
});

test("startup repair leaves malformed thread runtime settings untouched", () => {
  const { store, dbPath } = makeStore();
  const threadId = store.loadState().selectedThreadId;
  store.close();
  const malformedRuntime = "{ permissionMode: default_permissions";
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE chat_threads SET permission_mode = ?, codex_approval_mode = ?, runtime_settings_json = ? WHERE id = ?")
    .run("full_access", "never", malformedRuntime, threadId);
  db.close();

  const repairedStore = new ChatStore(dbPath);
  expect(() => repairedStore.loadState()).toThrow(/thread runtime settings are malformed/);
  const repairedDb = new DatabaseSync(dbPath);
  const row = repairedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(threadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  repairedDb.close();
  expect(row.permission_mode).toBe("full_access");
  expect(row.codex_approval_mode).toBe("never");
  expect(row.runtime_settings_json).toBe(malformedRuntime);
  repairedStore.close();
});

test("startup repair does not escalate explicit runtime default access with legacy never approval", () => {
  const { store, dbPath } = makeStore();
  const threadId = store.loadState().selectedThreadId;
  store.close();
  const rawRuntime = JSON.stringify({ nCtx: 4096, permissionMode: "default_permissions" });
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE chat_threads SET permission_mode = ?, codex_approval_mode = ?, runtime_settings_json = ? WHERE id = ?")
    .run("full_access", "never", rawRuntime, threadId);
  db.close();

  const repairedStore = new ChatStore(dbPath);
  const repairedDb = new DatabaseSync(dbPath);
  const row = repairedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(threadId) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  repairedDb.close();
  expect(row.permission_mode).toBe("default_permissions");
  expect(row.codex_approval_mode).toBe("default");
  expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ nCtx: 4096, permissionMode: "default_permissions" });
  repairedStore.close();
});

test("malformed global runtime settings fail loudly", () => {
  const { store, dbPath } = makeStore();
  store.close();
  const malformedRuntime = "{ nCtx: 4096";
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT OR REPLACE INTO chat_settings (key, value) VALUES (?, ?)")
    .run("runtime_settings_json", malformedRuntime);
  db.close();

  const restarted = new ChatStore(dbPath);
  expect(() => restarted.loadState()).toThrow(/chat runtime settings are malformed/);
  const rawDb = new DatabaseSync(dbPath);
  const rawRow = rawDb.prepare("SELECT value FROM chat_settings WHERE key = ?")
    .get("runtime_settings_json") as { value: string };
  rawDb.close();
  expect(rawRow.value).toBe(malformedRuntime);
  restarted.close();
});

test("migration seeds new thread permission column from existing runtime access", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-store-migrate-"));
  const dbPath = path.join(dir, "unit0.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_threads (
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
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_context_start_message_index INTEGER NOT NULL DEFAULT 0,
      context_revision INTEGER NOT NULL DEFAULT 0,
      context_markers_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO chat_projects (id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?)")
    .run("project-old", "Old Project", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 0);
  db.prepare(`INSERT INTO chat_threads (
    id, project_id, title, runtime_settings_json, created_at, updated_at, sort_order
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "thread-old",
      "project-old",
      "Old Thread",
      JSON.stringify({ nCtx: 4096, permissionMode: "default_permissions" }),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      0
    );
  db.close();

  const store = new ChatStore(dbPath);
  const state = store.loadState();
  expect(state.threads.find((thread) => thread.id === "thread-old")).toMatchObject({
    permissionMode: "default_permissions",
    codexApprovalMode: "default",
    runtimeSettings: { permissionMode: "default_permissions" }
  });
  const migratedDb = new DatabaseSync(dbPath);
  const row = migratedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get("thread-old") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  migratedDb.close();
  expect(row.permission_mode).toBe("default_permissions");
  expect(row.codex_approval_mode).toBe("default");
  expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
  store.close();
});

test("migration derives missing thread permission from existing Codex approval", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-store-migrate-approval-"));
  const dbPath = path.join(dir, "unit0.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_threads (
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
      codex_approval_mode TEXT NOT NULL DEFAULT 'on-request',
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_context_start_message_index INTEGER NOT NULL DEFAULT 0,
      context_revision INTEGER NOT NULL DEFAULT 0,
      context_markers_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO chat_projects (id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?)")
    .run("project-old", "Old Project", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 0);
  db.prepare(`INSERT INTO chat_threads (
    id, project_id, title, runtime_settings_json, codex_approval_mode, created_at, updated_at, sort_order
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "thread-old",
      "project-old",
      "Old Thread",
      JSON.stringify({ nCtx: 4096 }),
      "on-request",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      0
    );
  db.close();

  const store = new ChatStore(dbPath);
  const state = store.loadState();
  expect(state.threads.find((thread) => thread.id === "thread-old")).toMatchObject({
    permissionMode: "default_permissions",
    codexApprovalMode: "on-request",
    runtimeSettings: { permissionMode: "default_permissions" }
  });
  const migratedDb = new DatabaseSync(dbPath);
  const row = migratedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get("thread-old") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  migratedDb.close();
  expect(row.permission_mode).toBe("default_permissions");
  expect(row.codex_approval_mode).toBe("on-request");
  expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
  store.close();
});

test("migration does not infer full access from legacy Codex never approval", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-store-migrate-never-approval-"));
  const dbPath = path.join(dir, "unit0.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_threads (
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
      codex_approval_mode TEXT NOT NULL DEFAULT 'never',
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_context_start_message_index INTEGER NOT NULL DEFAULT 0,
      context_revision INTEGER NOT NULL DEFAULT 0,
      context_markers_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO chat_projects (id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?)")
    .run("project-old", "Old Project", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 0);
  db.prepare(`INSERT INTO chat_threads (
    id, project_id, title, runtime_settings_json, codex_approval_mode, created_at, updated_at, sort_order
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "thread-old",
      "project-old",
      "Old Thread",
      JSON.stringify({ nCtx: 4096 }),
      "never",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      0
    );
  db.close();

  const store = new ChatStore(dbPath);
  const state = store.loadState();
  expect(state.threads.find((thread) => thread.id === "thread-old")).toMatchObject({
    permissionMode: "default_permissions",
    codexApprovalMode: "default",
    runtimeSettings: { permissionMode: "default_permissions" }
  });
  const migratedDb = new DatabaseSync(dbPath);
  const row = migratedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get("thread-old") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  migratedDb.close();
  expect(row.permission_mode).toBe("default_permissions");
  expect(row.codex_approval_mode).toBe("default");
  expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
  store.close();
});

test("repair does not preserve schema-default full access without explicit runtime access", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-store-migrate-present-permission-"));
  const dbPath = path.join(dir, "unit0.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_threads (
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
      codex_approval_mode TEXT NOT NULL DEFAULT 'never',
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_context_start_message_index INTEGER NOT NULL DEFAULT 0,
      context_revision INTEGER NOT NULL DEFAULT 0,
      context_markers_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE chat_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO chat_projects (id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?)")
    .run("project-old", "Old Project", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 0);
  db.prepare(`INSERT INTO chat_threads (
    id, project_id, title, runtime_settings_json, created_at, updated_at, sort_order
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "thread-old",
      "project-old",
      "Old Thread",
      JSON.stringify({ nCtx: 4096 }),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      0
    );
  db.close();

  const store = new ChatStore(dbPath);
  const state = store.loadState();
  expect(state.threads.find((thread) => thread.id === "thread-old")).toMatchObject({
    permissionMode: "default_permissions",
    codexApprovalMode: "default",
    runtimeSettings: { permissionMode: "default_permissions" }
  });
  const repairedDb = new DatabaseSync(dbPath);
  const row = repairedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get("thread-old") as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  repairedDb.close();
  expect(row.permission_mode).toBe("default_permissions");
  expect(row.codex_approval_mode).toBe("default");
  expect(JSON.parse(row.runtime_settings_json)).toMatchObject({ permissionMode: "default_permissions" });
  store.close();
});

test("new threads inherit active provider and thread settings without runtime sessions", () => {
  const { store, dbPath } = makeStore();
  let state = store.loadState();
  const project = store.createProject();
  state = store.loadState();
  const projectThread = state.threads.find((thread) => thread.projectId === project.id);
  expect(projectThread).toMatchObject({
    permissionMode: "full_access",
    codexApprovalMode: "never",
    runtimeSettings: { permissionMode: "full_access" }
  });
  const db = new DatabaseSync(dbPath);
  const projectThreadRow = db
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(projectThread!.id) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  db.close();
  expect(projectThreadRow.permission_mode).toBe("full_access");
  expect(projectThreadRow.codex_approval_mode).toBe("never");
  expect(JSON.parse(projectThreadRow.runtime_settings_json)).toMatchObject({ permissionMode: "full_access" });

  store.updateThreadSettings(state.selectedThreadId, {
    providerMode: "codex",
    selectedSettingsPresetId: "builtin::deep",
    builtinModelId: "local-a",
    runtimeSettings: { nCtx: 16384, temperature: 0.25 },
    builtinAgenticFramework: "document_analysis",
    documentAnalysisEmbeddingModelPath: "C:\\Models\\embed.gguf",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high",
    permissionMode: "default_permissions",
    codexApprovalMode: "on-request",
    planModeEnabled: true,
    documentIndexId: "old-index",
    codexLastSessionId: "old-session",
    remoteSessionId: "remote-session",
    remoteSlotId: 7,
    remoteSettingsSignature: "old-signature",
    remoteHostIdentity: "old-host"
  });

  const inherited = store.createThread();
  state = store.loadState();

  expect(state.selectedThreadId).toBe(inherited.id);
  expect(state.threads.find((thread) => thread.id === inherited.id)).toMatchObject({
    providerMode: "codex",
    selectedSettingsPresetId: "builtin::deep",
    builtinModelId: "local-a",
    builtinAgenticFramework: "document_analysis",
    documentAnalysisEmbeddingModelPath: "C:\\Models\\embed.gguf",
    codexModelId: "gpt-5.3-codex-spark",
    codexReasoningEffort: "high",
    permissionMode: "default_permissions",
    codexApprovalMode: "on-request",
    planModeEnabled: true,
    documentIndexId: "",
    codexLastSessionId: "",
    remoteSessionId: "",
    remoteSlotId: 0,
    remoteSettingsSignature: "",
    remoteHostIdentity: ""
  });
  expect(state.threads.find((thread) => thread.id === inherited.id)?.runtimeSettings.nCtx).toBe(16384);
  const inheritedDb = new DatabaseSync(dbPath);
  const inheritedRow = inheritedDb
    .prepare("SELECT permission_mode, codex_approval_mode, runtime_settings_json FROM chat_threads WHERE id = ?")
    .get(inherited.id) as { permission_mode: string; codex_approval_mode: string; runtime_settings_json: string };
  inheritedDb.close();
  expect(inheritedRow.permission_mode).toBe("default_permissions");
  expect(inheritedRow.codex_approval_mode).toBe("on-request");
  expect(JSON.parse(inheritedRow.runtime_settings_json)).toMatchObject({
    permissionMode: "default_permissions",
    nCtx: 16384
  });
  store.close();
});

test("ignores legacy remote document indexing settings", () => {
  const { store } = makeStore();
  store.updateAppSettings({
    documentIndexLocation: "local",
    documentToolExecutionLocation: "remote"
  } as never);

  expect(store.loadState().appSettings).not.toHaveProperty("documentIndexLocation");
  expect(store.loadState().appSettings).not.toHaveProperty("documentToolExecutionLocation");
  store.close();
});
