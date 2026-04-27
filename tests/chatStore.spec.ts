import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore } from "../src/main/chatStore";

function makeStore(): { store: ChatStore; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-store-"));
  const dbPath = path.join(dir, "unit0.sqlite");
  return { store: new ChatStore(dbPath), dir, dbPath };
}

test("seeds a default global chat project and thread", () => {
  const { store } = makeStore();
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
    codexApprovalMode: "default",
    planModeEnabled: false
  });
  store.close();
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

test("builds and searches document index chunks", () => {
  const { store, dir } = makeStore();
  const sourcePath = path.join(dir, "notes.txt");
  fs.writeFileSync(sourcePath, "alpha project facts\n\nbeta release notes");
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

  const results = store.searchDocumentIndex(index.id, "alpha", 4, 100);

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ resultId: "r1", text: "alpha project facts" });
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
  store.applySettingsPreset(threadId, preset.id);
  state = store.loadState();
  expect(state.runtimeSettings.nCtx).toBe(8192);
  expect(state.threads.find((thread) => thread.id === threadId)).toMatchObject({
    selectedSettingsPresetId: preset.id,
    builtinAgenticFramework: "document_analysis",
    documentAnalysisEmbeddingModelPath: "C:\\Models\\embed.gguf"
  });

  store.deleteSettingsPreset("builtin::fast");
  expect(store.loadState().settingsPresets.some((item) => item.id === "builtin::fast")).toBe(false);
  store.close();

  const restarted = new ChatStore(dbPath);
  expect(restarted.loadState().settingsPresets.some((item) => item.id === "builtin::fast")).toBe(false);
  expect(restarted.loadState().settingsPresets.some((item) => item.label === "Document preset")).toBe(true);
  restarted.close();
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

test("new threads inherit active provider and thread settings without runtime sessions", () => {
  const { store } = makeStore();
  let state = store.loadState();
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
    codexLastSessionId: "old-session"
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
    codexLastSessionId: ""
  });
  expect(state.threads.find((thread) => thread.id === inherited.id)?.runtimeSettings.nCtx).toBe(16384);
  store.close();
});
