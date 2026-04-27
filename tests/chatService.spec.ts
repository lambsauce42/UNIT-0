import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatService } from "../src/main/chatService";
import { ChatStore } from "../src/main/chatStore";
import { MockCodexRuntime } from "../src/main/codexRuntime";
import { LocalLlamaRuntime } from "../src/main/localLlamaRuntime";
import { RemoteHostRuntime } from "../src/main/remoteHostRuntime";
import type { ChatMessage, ChatModel, ChatRuntimeSettings } from "../src/shared/types";

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-service-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined);
  return { service, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

class ScriptedLlamaRuntime extends LocalLlamaRuntime {
  constructor(private readonly replies: string[]) {
    super({ startupTimeoutMs: 10 });
  }

  override async streamChat(options: {
    model: ChatModel;
    settings: ChatRuntimeSettings;
    messages: ChatMessage[];
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
  }): Promise<void> {
    const reply = this.replies.shift() ?? "";
    options.onToken(reply);
  }
}

test("blocks switching a local-history thread to Codex", () => {
  const { service, store, cleanup } = makeService();
  try {
    const state = store.loadState();
    store.createMessage(state.selectedThreadId, "assistant", "local answer", "complete", {
      sourceLabel: "Built-in"
    });

    const blocked = service.updateThreadSettings({
      threadId: state.selectedThreadId,
      providerMode: "codex"
    });

    expect(blocked.generation).toMatchObject({
      status: "error",
      error: expect.stringContaining("Local to Codex is not yet supported")
    });
    expect(blocked.threads.find((thread) => thread.id === state.selectedThreadId)?.providerMode).toBe("builtin");
  } finally {
    store.close();
    cleanup();
  }
});

test("handles local /reset without starting generation", async () => {
  const { service, store, cleanup } = makeService();
  try {
    const state = store.loadState();
    store.createMessage(state.selectedThreadId, "user", "hello", "complete");
    store.createMessage(state.selectedThreadId, "assistant", "answer", "complete");

    const next = await service.submit({ text: "/reset", attachments: [] });
    const thread = next.threads.find((item) => item.id === state.selectedThreadId);

    expect(next.generation.status).toBe("idle");
    expect(thread?.activeContextStartMessageIndex).toBe(2);
    expect(thread?.contextMarkers[0]).toMatchObject({ kind: "reset", boundaryMessageCount: 2 });
    expect(next.messages.at(-1)?.content).toContain("Local context reset");
  } finally {
    store.close();
    cleanup();
  }
});

test("runs iterative document-analysis tool calls against a ready local index", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-service-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(
    store,
    new ScriptedLlamaRuntime([
      '<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>',
      '<tool_call>{"tool":"modify_results","expand":[{"result_id":"r1","before":0,"after":1}]}</tool_call>',
      "Alpha appears in the indexed document [r1]."
    ]),
    new RemoteHostRuntime(),
    new MockCodexRuntime(),
    () => undefined
  );
  try {
    const sourcePath = path.join(dir, "notes.txt");
    fs.writeFileSync(sourcePath, "alpha first paragraph\n\nbeta neighbor paragraph");
    let state = store.loadState();
    fs.writeFileSync(path.join(dir, "model.gguf"), "");
    store.addLocalModel(path.join(dir, "model.gguf"));
    state = store.loadState();
    const modelId = state.models[0].id;
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: modelId,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    store.updateAppSettings({ tokenizerModelPath: path.join(dir, "tokenizer.gguf") });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0 },
      { chunkId: "c2", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "beta neighbor paragraph", tokenCount: 4, ordinalStart: 1, ordinalEnd: 1 }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.content).toContain("Alpha appears");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["tool", "tool"]);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("surfaces exhausted document-analysis evidence budget without tool fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-budget-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(
    store,
    new ScriptedLlamaRuntime(['<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>']),
    new RemoteHostRuntime(),
    new MockCodexRuntime(),
    () => undefined
  );
  try {
    const sourcePath = path.join(dir, "notes.txt");
    const modelPath = path.join(dir, "model.gguf");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    fs.writeFileSync(modelPath, "");
    let state = store.loadState();
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      runtimeSettings: { nCtx: 1024, maxTokens: 1 }
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0 }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);
    store.createMessage(state.selectedThreadId, "user", "x ".repeat(3000), "complete");

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(next.generation).toMatchObject({
      status: "error",
      error: expect.stringContaining("ran out of safe evidence budget")
    });
    expect(assistant?.status).toBe("error");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
