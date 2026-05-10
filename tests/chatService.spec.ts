import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatService } from "../src/main/chatService";
import { ChatStore } from "../src/main/chatStore";
import { MockCodexRuntime, type CodexRunOptions, type CodexThreadEvent } from "../src/main/codexRuntime";
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

class FlakyAccountCodexRuntime extends MockCodexRuntime {
  private attempts = 0;

  override async readAccount(force?: boolean): ReturnType<MockCodexRuntime["readAccount"]> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("temporary Codex startup failure");
    }
    return super.readAccount(force);
  }
}

class OrderedCodexRuntime extends MockCodexRuntime {
  override async *runTurn(_options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    yield { type: "thread.started", thread_id: "thread-ordered" };
    yield { type: "turn.started" };
    yield { type: "item.updated", item: { id: "answer", type: "agent_message", text: "First answer.\n" } };
    yield { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "Checked the next step.", initiallyExpanded: false } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "First answer.\nSecond answer." } };
    yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  }
}

class StreamingDetailsCodexRuntime extends MockCodexRuntime {
  override async *runTurn(_options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    yield { type: "thread.started", thread_id: "thread-streaming-details" };
    yield { type: "turn.started" };
    yield { type: "item.updated", item: { id: "reasoning", type: "reasoning", section_key: "reasoning:summary:0", text: "Plan " } };
    yield { type: "item.completed", item: { id: "reasoning", type: "reasoning", sections: [{ key: "reasoning:summary:0", text: "Plan done." }, { key: "reasoning:summary:1", text: "Checked output." }], text: "Plan done.\n\nChecked output.", initiallyExpanded: false } };
    yield { type: "item.updated", item: { id: "cmd", type: "command_execution", command: "npm test", aggregated_output: "first\n", status: "in_progress" } };
    yield { type: "item.updated", item: { id: "cmd", type: "command_execution", aggregated_output: "second\n", status: "in_progress" } };
    yield { type: "item.completed", item: { id: "cmd", type: "command_execution", command: "npm test", exit_code: 0, status: "completed" } };
    yield { type: "item.updated", item: { id: "diff", type: "file_change", summary: "Updated diff", diff: "+one\n", status: "updated" } };
    yield { type: "item.updated", item: { id: "diff", type: "file_change", summary: "Updated diff", diff: "+two\n", status: "updated" } };
    yield { type: "item.completed", item: { id: "diff", type: "file_change", summary: "Updated diff", added_lines: 2, deleted_lines: 0, status: "completed" } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } };
    yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  }
}

class CompletedContentReasoningCodexRuntime extends MockCodexRuntime {
  override async *runTurn(_options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    yield { type: "thread.started", thread_id: "thread-content-reasoning" };
    yield { type: "turn.started" };
    yield { type: "item.updated", item: { id: "reason", type: "reasoning", section_key: "reason", text: "Inspecting" } };
    yield { type: "item.completed", item: { id: "reason", type: "reasoning", sections: [{ key: "reason", text: "Inspecting repository" }], text: "Inspecting repository" } };
    yield { type: "item.updated", item: { id: "diff", type: "file_change", summary: "Updated diff", diff: "+raw patch\n", status: "updated" } };
    yield { type: "item.completed", item: { id: "diff", type: "file_change", summary: "File change", diff: "modified: src/app.ts (+1 -0)", changes: [{ path: "src/app.ts", kind: "modified", addedLines: 1, deletedLines: 0 }], status: "completed" } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } };
    yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  }
}

class EmptySummaryPartCodexRuntime extends MockCodexRuntime {
  override async *runTurn(_options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    yield { type: "thread.started", thread_id: "thread-summary-parts" };
    yield { type: "turn.started" };
    yield { type: "item.updated", item: { id: "reason", type: "reasoning", section_key: "reason:summary:1", text: "", sections: [{ key: "reason:summary:1", text: "" }] } };
    yield { type: "item.updated", item: { id: "reason", type: "reasoning", section_key: "reason:summary:0", text: "", sections: [{ key: "reason:summary:0", text: "" }] } };
    yield { type: "item.updated", item: { id: "reason", type: "reasoning", section_key: "reason:summary:1", text: "Second" } };
    yield { type: "item.updated", item: { id: "reason", type: "reasoning", section_key: "reason:summary:0", text: "First" } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } };
    yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  }
}

test("keeps Codex assistant and reasoning timeline blocks in stream order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-order-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new OrderedCodexRuntime(), () => undefined);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "Codex Project", dir);
    store.updateThreadSettings(state.selectedThreadId, { providerMode: "codex" });

    await service.submit({ text: "stream ordering" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = service.state();
    const assistant = state.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.content).toBe("First answer.\nSecond answer.");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["assistant_message", "reasoning", "assistant_message"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "assistant_message", text: "First answer.\n" });
    expect(assistant?.timelineBlocks?.[2]).toMatchObject({ kind: "assistant_message", text: "Second answer." });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("accumulates streamed Codex details without duplicating completed snapshots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-stream-details-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new StreamingDetailsCodexRuntime(), () => undefined);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "Codex Project", dir);
    store.updateThreadSettings(state.selectedThreadId, { providerMode: "codex" });

    await service.submit({ text: "stream details" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = service.state();
    const assistant = state.messages.filter((message) => message.role === "assistant").at(-1);
    const tool = assistant?.timelineBlocks?.find((block) => block.kind === "tool");
    const diff = assistant?.timelineBlocks?.find((block) => block.kind === "diff");

    expect(assistant?.reasoning).toBe("Plan done.\n\nChecked output.");
    expect(tool).toMatchObject({ kind: "tool", output: "first\nsecond\n", status: "completed" });
    expect(diff).toMatchObject({ kind: "diff", preview: "+one\n+two\n", status: "completed", addedLines: 2 });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("completed Codex reasoning content and structured file snapshots replace matching streams", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-content-reasoning-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new CompletedContentReasoningCodexRuntime(), () => undefined);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "Codex Project", dir);
    store.updateThreadSettings(state.selectedThreadId, { providerMode: "codex" });

    await service.submit({ text: "content reasoning" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = service.state();
    const assistant = state.messages.filter((message) => message.role === "assistant").at(-1);
    const diff = assistant?.timelineBlocks?.find((block) => block.kind === "diff");

    expect(assistant?.reasoning).toBe("Inspecting repository");
    expect(diff).toMatchObject({ kind: "diff", preview: "modified: src/app.ts (+1 -0)", status: "completed" });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty Codex reasoning summary parts preserve stream section order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-summary-order-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new EmptySummaryPartCodexRuntime(), () => undefined);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "Codex Project", dir);
    store.updateThreadSettings(state.selectedThreadId, { providerMode: "codex" });

    await service.submit({ text: "summary order" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = service.state();
    const assistant = state.messages.filter((message) => message.role === "assistant").at(-1);
    const reasoning = assistant?.timelineBlocks?.find((block) => block.kind === "reasoning");

    expect(reasoning).toMatchObject({
      kind: "reasoning",
      sections: [
        { key: "reason:summary:1", text: "Second" },
        { key: "reason:summary:0", text: "First" }
      ],
      text: "Second\n\nFirst"
    });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex account refresh recovers without surfacing a chat generation error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-account-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new FlakyAccountCodexRuntime(), () => undefined);
  try {
    const failed = await service.refreshCodexAccount();
    expect(failed.codexAccount.status).toBe("error");
    expect(failed.generation.status).toBe("idle");

    const recovered = await service.refreshCodexAccount();
    expect(recovered.codexAccount.status).toBe("ready");
    if (recovered.codexAccount.status === "ready") {
      expect(recovered.codexAccount.rateLimits?.primary?.usedPercent).toBe(12);
      expect(recovered.codexAccount.rateLimits?.secondary?.usedPercent).toBe(34);
    }
    expect(recovered.generation.status).toBe("idle");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test("runs global chat action buttons from the selected project root when directory is empty", async () => {
  const { service, store, cleanup } = makeService();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-action-root-"));
  try {
    const state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "Action Root", projectRoot);
    store.updateAppSettings({
      actionButtons: [{
        id: "write-cwd",
        label: "CWD",
        command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('cwd.txt', process.cwd())"`,
        directory: ""
      }]
    });

    await service.runProjectAction(state.selectedProjectId, "write-cwd");

    expect(fs.readFileSync(path.join(projectRoot, "cwd.txt"), "utf-8")).toBe(projectRoot);
  } finally {
    service.close();
    cleanup();
    fs.rmSync(projectRoot, { recursive: true, force: true });
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
