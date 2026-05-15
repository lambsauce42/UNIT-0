import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatService } from "../src/main/chatService";
import { ChatStore } from "../src/main/chatStore";
import { MockCodexRuntime, type CodexRunOptions, type CodexThreadEvent } from "../src/main/codexRuntime";
import type { DocumentEmbeddingRuntime } from "../src/main/embeddingRuntime";
import { LocalLlamaRuntime } from "../src/main/localLlamaRuntime";
import { mapOpenCodeEvent, normalizeOpenCodeHarmonyEvent, parseOpenCodeHarmonySnapshot, splitSseFrames, type OpenCodeRunOptions, type OpenCodeRuntime, type OpenCodeRuntimeEvent } from "../src/main/openCodeRuntime";
import { RemoteHostRuntime } from "../src/main/remoteHostRuntime";
import type { ChatBuiltinAgenticFramework, ChatMessage, ChatModel, ChatRuntimeSettings } from "../src/shared/types";

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-service-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  return { service, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function captureAssistantFrame(service: ChatService): { content: string; reasoning: string } {
  const assistant = service.state().messages.find((message) => message.role === "assistant");
  return {
    content: assistant?.content ?? "",
    reasoning: assistant?.reasoning ?? ""
  };
}

class TestEmbeddingRuntime implements DocumentEmbeddingRuntime {
  async embedDocuments(options: { modelPath: string; texts: string[]; nCtx: number; nGpuLayers: number; onProgress?: (completed: number, total: number) => void }): Promise<number[][]> {
    options.onProgress?.(options.texts.length, options.texts.length);
    return options.texts.map((text) => testEmbeddingForText(text));
  }

  async embedQuery(options: { modelPath: string; text: string; nCtx: number; nGpuLayers: number }): Promise<number[]> {
    return testEmbeddingForText(options.text);
  }

  async warm(_options: { modelPath: string; nCtx: number; nGpuLayers: number; shouldCancel?: () => boolean }): Promise<void> {}

  close(): void {}
}

class RecordingEmbeddingRuntime extends TestEmbeddingRuntime {
  readonly documentTextBatches: string[][] = [];

  override async embedDocuments(options: { modelPath: string; texts: string[]; nCtx: number; nGpuLayers: number; onProgress?: (completed: number, total: number) => void }): Promise<number[][]> {
    this.documentTextBatches.push([...options.texts]);
    return super.embedDocuments(options);
  }
}

function testEmbeddingForText(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("alpha")) {
    return [1, 0, 0];
  }
  if (lower.includes("beta")) {
    return [0, 1, 0];
  }
  return [0, 0, 1];
}

class ScriptedLlamaRuntime extends LocalLlamaRuntime {
  readonly calls: ChatMessage[][] = [];
  readonly settingsCalls: ChatRuntimeSettings[] = [];
  readonly frameworkCalls: string[] = [];
  readonly documentTitleCalls: string[] = [];

  constructor(
    private readonly replies: string[],
    private readonly beforeReply?: (callIndex: number) => Promise<void> | void
  ) {
    super({ startupTimeoutMs: 10 });
  }

  override async streamChat(options: {
    model: ChatModel;
    settings: ChatRuntimeSettings;
    messages: ChatMessage[];
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
    builtinAgenticFramework?: ChatBuiltinAgenticFramework;
    documentTitle?: string;
  }): Promise<void> {
    this.calls.push(options.messages.map((message) => ({ ...message })));
    this.settingsCalls.push({ ...options.settings });
    this.frameworkCalls.push(options.builtinAgenticFramework ?? "chat");
    this.documentTitleCalls.push(options.documentTitle ?? "");
    await this.beforeReply?.(this.calls.length - 1);
    const reply = this.replies.shift() ?? "";
    options.onToken(reply);
  }
}

class StreamingDocumentLlamaRuntime extends LocalLlamaRuntime {
  private readonly replies = [
    { tokens: ['<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>'], reasoning: ["Need ", "search."] },
    { tokens: ["Alpha ", "appears in the indexed document [r1]."], reasoning: ["Reading ", "evidence."] }
  ];

  override async streamChat(options: {
    model: ChatModel;
    settings: ChatRuntimeSettings;
    messages: ChatMessage[];
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
  }): Promise<void> {
    const reply = this.replies.shift() ?? { tokens: [], reasoning: [] };
    for (const token of reply.reasoning) {
      options.onReasoning?.(token);
      await Promise.resolve();
    }
    for (const token of reply.tokens) {
      options.onToken(token);
      await Promise.resolve();
    }
  }
}

class StreamingOpenCodeLlamaRuntime extends LocalLlamaRuntime {
  constructor(
    private readonly tokens: string[],
    private readonly afterToken?: (index: number) => Promise<void> | void,
    private readonly reasoningTokens: string[] = []
  ) {
    super({ startupTimeoutMs: 10 });
  }

  override async streamChat(options: {
    model: ChatModel;
    settings: ChatRuntimeSettings;
    messages: ChatMessage[];
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
    builtinAgenticFramework?: ChatBuiltinAgenticFramework;
  }): Promise<void> {
    for (const token of this.reasoningTokens) {
      options.onReasoning?.(token);
      await Promise.resolve();
    }
    for (let index = 0; index < this.tokens.length; index += 1) {
      options.onToken(this.tokens[index]);
      await this.afterToken?.(index);
    }
  }
}

class ScriptedRemoteRuntime extends RemoteHostRuntime {
  readonly frameworkCalls: string[] = [];
  readonly calls: ChatMessage[][] = [];
  private pass = 0;

  constructor(private readonly replies: Array<{ content: string; reasoning?: string }>) {
    super();
  }

  override async streamChat(options: Parameters<RemoteHostRuntime["streamChat"]>[0]): Promise<Awaited<ReturnType<RemoteHostRuntime["streamChat"]>>> {
    this.frameworkCalls.push(options.builtinAgenticFramework ?? "chat");
    this.calls.push(options.messages.map((message) => ({ ...message })));
    const reply = this.replies[this.pass++] ?? { content: "" };
    if (reply.reasoning) {
      options.onReasoning?.(reply.reasoning);
    }
    if (reply.content) {
      options.onToken(reply.content);
    }
    return {
      remoteSessionId: "remote-session",
      remoteSlotId: 0,
      remoteHostId: "host",
      remoteHostIdentity: "Remote Host",
      remoteSessionStatus: "warm",
      metrics: { backend: "llama-server" }
    };
  }
}

class ScriptedOpenCodeRuntime implements OpenCodeRuntime {
  readonly calls: OpenCodeRunOptions[] = [];
  readonly approvals: Array<{ permissionId: string; decision: "approve" | "deny" }> = [];
  readonly userInputs: Array<{ requestId: string; answers: Record<string, string> }> = [];

  constructor(private readonly turns: OpenCodeRuntimeEvent[][] = []) {}

  async *runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent> {
    this.calls.push({ ...options });
    yield { type: "session.started", sessionId: `opencode-session-${this.calls.length}` };
    for (const event of this.turns[this.calls.length - 1] ?? []) {
      yield event;
    }
    yield { type: "turn.completed" };
  }

  async answerApproval(permissionId: string, decision: "approve" | "deny"): Promise<void> {
    this.approvals.push({ permissionId, decision });
  }

  async answerUserInput(requestId: string, answers: Record<string, string>): Promise<void> {
    this.userInputs.push({ requestId, answers });
  }

  cancelActiveRequest(): void {}

  close(): void {}
}

class IncompleteOpenCodeRuntime implements OpenCodeRuntime {
  async *runTurn(): AsyncIterable<OpenCodeRuntimeEvent> {
    yield { type: "session.started", sessionId: "opencode-incomplete-session" };
    yield { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Partial answer." };
    throw new Error("OpenCode event stream ended before turn completion.");
  }

  async answerApproval(): Promise<void> {}

  async answerUserInput(): Promise<void> {}

  cancelActiveRequest(): void {}

  close(): void {}
}

class EndpointOnlyLlamaRuntime extends LocalLlamaRuntime {
  async openAiEndpoint(): Promise<{ baseUrl: string; modelId: string }> {
    return { baseUrl: "http://127.0.0.1:12345", modelId: "llama" };
  }
}

class ReasoningOnlyThenToolRuntime extends LocalLlamaRuntime {
  private attempt = 0;

  override async streamChat(options: {
    model: ChatModel;
    settings: ChatRuntimeSettings;
    messages: ChatMessage[];
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
  }): Promise<void> {
    this.attempt += 1;
    if (this.attempt === 1) {
      options.onReasoning?.("Need search but forgot final tool call.");
      return;
    }
    if (this.attempt === 2) {
      options.onReasoning?.("Need search.");
      options.onToken('<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>');
      return;
    }
    options.onReasoning?.("Reading evidence.");
    options.onToken("Alpha appears in the indexed document [r1].");
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

class CapturingCodexRuntime extends MockCodexRuntime {
  lastOptions: CodexRunOptions | null = null;

  override async *runTurn(options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    this.lastOptions = options;
    yield* super.runTurn(options);
  }
}

test("keeps Codex assistant and reasoning timeline blocks in stream order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-order-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new OrderedCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new StreamingDetailsCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new CompletedContentReasoningCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new EmptySummaryPartCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new FlakyAccountCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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

test("does not pass local system prompt as Codex base instructions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-system-prompt-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const codexRuntime = new CapturingCodexRuntime();
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), codexRuntime, () => undefined, new TestEmbeddingRuntime());
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "Codex Project", dir);
    store.updateThreadSettings(state.selectedThreadId, {
      providerMode: "codex",
      runtimeSettings: { systemPrompt: "hidden local prompt" }
    });

    await service.submit({ text: "ignore local prompt" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    expect(codexRuntime.lastOptions?.baseInstructions).toBe("");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("blocks Codex submit when the project directory is empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-codex-empty-dir-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const codexRuntime = new CapturingCodexRuntime();
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), codexRuntime, () => undefined, new TestEmbeddingRuntime());
  try {
    const state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "No Directory Project", "");
    store.updateThreadSettings(state.selectedThreadId, { providerMode: "codex" });

    const blocked = await service.submit({ text: "should not start" });

    expect(blocked.generation).toMatchObject({
      status: "error",
      error: "Select a project directory before running a Codex thread."
    });
    expect(store.messageCount(state.selectedThreadId)).toBe(0);
    expect(codexRuntime.lastOptions).toBeNull();
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
    service.close();
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
    service.close();
    cleanup();
  }
});

test("runs OpenCode shell tool calls through local harness timeline blocks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    {
      type: "timeline",
      eventType: "item.completed",
      block: { kind: "tool", id: "tool-1", toolName: "bash", status: "completed", command: "echo open-code-ok", output: "open-code-ok" }
    },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Done." }
  ]]);
  const runtime = new EndpointOnlyLlamaRuntime();
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "check the workspace" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Done.");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "tool" && block.toolName === "bash" && block.status === "completed" && block.output?.includes("open-code-ok"))).toBe(true);
    expect(openCodeRuntime.calls).toHaveLength(1);
    expect(openCodeRuntime.calls[0]).toMatchObject({
      cwd: dir,
      prompt: "check the workspace",
      permissionMode: "full_access",
      nativeGptOss: false
    });
    expect(store.loadState().threads.find((thread) => thread.id === state.selectedThreadId)?.openCodeSessionId).toBe("opencode-session-1");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not mark an incomplete OpenCode runtime stream as complete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-incomplete-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), new IncompleteOpenCodeRuntime());
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Incomplete Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "stream partially" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Partial answer.");
    expect(assistant?.status).toBe("error");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("streams OpenCode reasoning answer and tool blocks in event order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-stream-order-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Plan " },
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "work." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "First visible answer. " },
    {
      type: "timeline",
      eventType: "item.started",
      block: { kind: "tool", id: "tool-1", toolName: "bash", status: "started", command: "echo ok", initiallyExpanded: true }
    },
    {
      type: "timeline",
      eventType: "item.completed",
      block: { kind: "tool", id: "tool-1", toolName: "bash", status: "completed", command: "echo ok", output: "ok" }
    },
    { type: "reasoning.delta", id: "reasoning-2", status: "updated", text: "Check " },
    { type: "reasoning.delta", id: "reasoning-2", status: "updated", text: "result." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "After tool." },
    { type: "final.snapshot", content: "First visible answer. After tool. Hidden tail.", reasoning: "Plan work.Check result. Hidden reasoning." }
  ]]);
  const frames: Array<ReturnType<ChatService["state"]>> = [];
  let service: ChatService | null = null;
  service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => {
    const snapshot = service?.state();
    if (snapshot) {
      frames.push(snapshot);
    }
  }, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Stream Order Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "stream in order" });
    await expect.poll(() => service?.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("First visible answer. After tool.");
    expect(assistant?.reasoning).toBe("Plan work.Check result.");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["reasoning", "assistant_message", "tool", "reasoning", "assistant_message"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "reasoning", text: "Plan work.", status: "completed" });
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({ kind: "assistant_message", text: "First visible answer. ", status: "completed" });
    expect(assistant?.timelineBlocks?.[2]).toMatchObject({ kind: "tool", status: "completed", output: "ok" });
    expect(assistant?.timelineBlocks?.[3]).toMatchObject({ kind: "reasoning", text: "Check result.", status: "completed" });
    expect(assistant?.timelineBlocks?.[4]).toMatchObject({ kind: "assistant_message", text: "After tool.", status: "completed" });

    const assistantFrames = frames.map((frame) => frame.messages.find((message) => message.role === "assistant")).filter(Boolean);
    expect(assistantFrames.some((message) => message?.reasoning === "Plan ")).toBe(true);
    expect(assistantFrames.some((message) => message?.reasoning === "Plan work.")).toBe(true);
    expect(assistantFrames.some((message) => message?.reasoning === "Plan work.Check ")).toBe(true);
    expect(assistantFrames.some((message) => message?.reasoning === "Plan work.Check result.")).toBe(true);
    expect(assistantFrames.some((message) => message?.content === "First visible answer. ")).toBe(true);
    expect(assistantFrames.some((message) => message?.content === "First visible answer. After tool.")).toBe(true);
    expect(assistantFrames.some((message) => message?.timelineBlocks?.some((block) => block.kind === "reasoning" && block.text === "Plan"))).toBe(true);
    expect(assistantFrames.some((message) => message?.timelineBlocks?.some((block) => block.kind === "reasoning" && block.text === "Check result."))).toBe(true);
    expect(assistantFrames.some((message) => message?.timelineBlocks?.some((block) => block.kind === "assistant_message" && block.text === "First visible answer. "))).toBe(true);
    expect(assistantFrames.some((message) => message?.timelineBlocks?.some((block) => block.kind === "tool" && block.status === "started"))).toBe(true);
    expect(assistantFrames.some((message) => message?.timelineBlocks?.map((block) => block.kind).join(",") === "reasoning,assistant_message,tool,reasoning,assistant_message")).toBe(true);
    expect(assistantFrames.some((message) => message?.content.includes("Hidden tail"))).toBe(false);
    expect(assistantFrames.some((message) => (message?.reasoning ?? "").includes("Hidden reasoning"))).toBe(false);
  } finally {
    service?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collapses stale OpenCode timeline segments when a full part snapshot replaces text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-replace-segment-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "First. " },
    {
      type: "timeline",
      eventType: "item.completed",
      block: { kind: "tool", id: "tool-1", toolName: "bash", status: "completed", command: "echo ok", output: "ok" }
    },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Second." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Replacement.", replace: true }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Replace Segment Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "replace segmented text" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Replacement.");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["assistant_message", "tool"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "assistant_message", text: "Replacement." });
    expect(JSON.stringify(assistant?.timelineBlocks)).not.toContain("Second.");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clears stale OpenCode timeline text when a full part snapshot replaces with empty text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-empty-replace-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Stale text." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "", replace: true }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Empty Replace Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "clear stale text" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(JSON.stringify(assistant?.timelineBlocks)).not.toContain("Stale text.");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed")).toBe(true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clears stale OpenCode reasoning timeline text when a full part snapshot replaces with empty text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-empty-reasoning-replace-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Stale reasoning." },
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "", replace: true },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Final answer." }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Empty Reasoning Replace Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "clear stale reasoning text" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Final answer.");
    expect(assistant?.reasoning).toBe("");
    expect(JSON.stringify(assistant?.timelineBlocks)).not.toContain("Stale reasoning.");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("completes OpenCode answer-only turns without requiring reasoning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-answer-only-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Hello!" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Answer Only Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "hi" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Hello!");
    expect(assistant?.reasoning ?? "").toBe("");
    expect(assistant?.status).toBe("complete");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed")).toBe(false);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requires streamed reasoning for native GPT-OSS OpenCode turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-gptoss-reasoning-required-test-"));
  const modelPath = path.join(dir, "gpt-oss-20b-mxfp4.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Hello!" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode GPT-OSS Reasoning Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "hi" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Hello!");
    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed" && block.message.includes("without streamed reasoning"))).toBe(true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("streams OpenCode answer and reasoning in upstream chunk order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-upstream-stream-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "X" },
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Y" },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "A" },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "B" },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "C" }
  ]]);
  const frames: Array<{ content: string; reasoning: string }> = [];
  let service: ChatService | null = null;
  service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => {
    const assistant = service?.state().messages.find((message) => message.role === "assistant");
    if (assistant) {
      frames.push({ content: assistant.content, reasoning: assistant.reasoning ?? "" });
    }
  }, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Render Unit Stream Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "stream small units" });
    await expect.poll(() => service?.state().generation.status).toBe("idle");

    const expectedFrames = [
      { content: "", reasoning: "X" },
      { content: "", reasoning: "XY" },
      { content: "A", reasoning: "XY" },
      { content: "AB", reasoning: "XY" },
      { content: "ABC", reasoning: "XY" }
    ];
    const firstIndex = frames.findIndex((frame) => frame.content === "" && frame.reasoning === "X");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(frames.slice(firstIndex, firstIndex + expectedFrames.length)).toEqual(expectedFrames);
    for (let index = firstIndex + expectedFrames.length; index < frames.length; index += 1) {
      expect(frames[index]).toEqual({ content: "ABC", reasoning: "XY" });
    }
  } finally {
    service?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails OpenCode tool-only turns that never stream answer or reasoning text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-tool-only-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    {
      type: "timeline",
      eventType: "item.completed",
      block: { kind: "tool", id: "tool-1", toolName: "bash", status: "completed", command: "echo ok", output: "ok" }
    },
    { type: "final.snapshot", content: "Unstreamed answer.", reasoning: "Unstreamed reasoning." }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Tool Only Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "run tool only" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "tool")).toBe(true);
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed" && block.message.includes("without streamed output"))).toBe(true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails unmarked multi-paragraph OpenCode GPT-OSS text instead of guessing channels", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-flat-test-"));
  const modelPath = path.join(dir, "gpt-oss-renamed-model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  class NormalizingFlattenedOpenCodeRuntime implements OpenCodeRuntime {
    readonly calls: OpenCodeRunOptions[] = [];

    async *runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent> {
      this.calls.push({ ...options });
      const states = new Map();
      yield { type: "session.started", sessionId: "opencode-session-flat" };
      for (const event of [
        {
          type: "assistant.delta" as const,
          id: "msg_flat:prt_flat",
          status: "updated",
          sessionId: "opencode-session-flat",
          text: "User says \"hi\". We need to respond appropriately.\n\n"
        },
        {
          type: "assistant.delta" as const,
          id: "msg_flat:prt_flat",
          status: "updated",
          sessionId: "opencode-session-flat",
          text: "Hello!<|return|>"
        }
      ]) {
        for (const normalizedEvent of normalizeOpenCodeHarmonyEvent(event, states, options.nativeGptOss)) {
          yield normalizedEvent;
        }
      }
      yield { type: "turn.completed", sessionId: "opencode-session-flat" };
    }

    async answerApproval(): Promise<void> {}

    async answerUserInput(): Promise<void> {}

    cancelActiveRequest(): void {}

    close(): void {}
  }
  const openCodeRuntime = new NormalizingFlattenedOpenCodeRuntime();
  const snapshots: Array<ReturnType<ChatService["state"]>> = [];
  let service: ChatService | null = null;
  service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => {
    const snapshot = service?.state();
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "hi" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(assistant?.reasoning ?? "").toBe("");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed")).toBe(true);
    expect(snapshots.some((snapshot) => {
      const item = snapshot.messages.find((message) => message.role === "assistant");
      return Boolean(item?.content || item?.reasoning || item?.timelineBlocks?.some((block) => (block.kind === "reasoning" || block.kind === "assistant_message") && block.text));
    })).toBe(false);
    expect(openCodeRuntime.calls[0]?.nativeGptOss).toBe(true);
    expect(openCodeRuntime.calls[0]?.endpoint.modelId).toBe("llama");
  } finally {
    service?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciles OpenCode final snapshots with visible timeline blocks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-final-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Need a final answer." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Final " },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "answer." },
    { type: "final.snapshot", content: "Final answer. Hidden tail.", reasoning: "Need a final answer. Hidden reasoning." }
  ]]);
  const frames: Array<ReturnType<ChatService["state"]>> = [];
  let service: ChatService | null = null;
  service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => {
    const snapshot = service?.state();
    if (snapshot) {
      frames.push(snapshot);
    }
  }, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Final Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "finish cleanly" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Final answer.");
    expect(assistant?.reasoning).toBe("Need a final answer.");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["reasoning", "assistant_message"]);
    expect(assistant?.timelineBlocks?.filter((block) => block.kind === "assistant_message")).toEqual([
      expect.objectContaining({ status: "completed", text: "Final answer." })
    ]);
    expect(assistant?.timelineBlocks?.filter((block) => block.kind === "reasoning")).toEqual([
      expect.objectContaining({ status: "completed", text: "Need a final answer." })
    ]);
    const reasoningAfterAssistantFrames = frames.filter((frame) => {
      const item = frame.messages.find((message) => message.role === "assistant");
      const kinds = item?.timelineBlocks?.map((block) => block.kind) ?? [];
      let sawAssistant = false;
      return kinds.some((kind) => {
        if (kind === "assistant_message") {
          sawAssistant = true;
        }
        return sawAssistant && kind === "reasoning";
      });
    });
    expect(reasoningAfterAssistantFrames).toEqual([]);
    expect(frames.some((frame) => frame.messages.some((message) => message.role === "assistant" && message.content === "Final "))).toBe(true);
    expect(frames.some((frame) => frame.messages.some((message) => message.role === "assistant" && message.content === "Final answer."))).toBe(true);
    expect(frames.some((frame) => frame.messages.some((message) => message.role === "assistant" && message.content.includes("Hidden tail")))).toBe(false);
    expect(frames.some((frame) => frame.messages.some((message) => message.role === "assistant" && (message.reasoning ?? "").includes("Hidden reasoning")))).toBe(false);
  } finally {
    service?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not clear streamed OpenCode content when final snapshot content is empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-empty-final-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Need a final answer." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Final answer." },
    { type: "final.snapshot", content: "", reasoning: "Need a final answer." }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Empty Final Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "finish cleanly" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Final answer.");
    expect(assistant?.reasoning).toBe("Need a final answer.");
    expect(assistant?.timelineBlocks?.find((block) => block.kind === "assistant_message")).toMatchObject({
      status: "completed",
      text: "Final answer."
    });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not fail OpenCode turns when final answer streams after reasoning-only continuation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-continued-final-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "message-1:reasoning-1", status: "updated", text: "Need acknowledgement." },
    { type: "assistant.delta", id: "message-1:text-1", status: "updated", text: "Sure." },
    { type: "final.snapshot", content: "Sure.", reasoning: "Need acknowledgement.", strict: true, messageId: "message-1" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Continued Final Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "Cool!" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.status).toBe("complete");
    expect(assistant?.content).toBe("Sure.");
    expect(assistant?.reasoning).toBe("Need acknowledgement.");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed")).toBe(false);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not append snapshot-only OpenCode reasoning after streamed answer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-answer-only-final-reasoning-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "opencode-ok" },
    { type: "final.snapshot", content: "opencode-ok", reasoning: "The task is straightforward and requires no code changes." }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Answer Only Final Reasoning Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "finish cleanly" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("opencode-ok");
    expect(assistant?.reasoning ?? "").toBe("");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["assistant_message"]);
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "reasoning")).toBe(false);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not replace streamed OpenCode text with shorter stale final snapshots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-stale-short-final-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Need a final answer." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Final answer." },
    { type: "final.snapshot", content: "Final", reasoning: "Need" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Stale Short Final Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "finish cleanly" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Final answer.");
    expect(assistant?.reasoning).toBe("Need a final answer.");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not introduce OpenCode answer or reasoning text from snapshot-only final state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-snapshot-only-final-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "final.snapshot", content: "Unstreamed answer.", reasoning: "Unstreamed reasoning." }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Snapshot Only Final Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "finish cleanly" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(assistant?.reasoning).toBe("");
    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed" && block.message.includes("without streamed output"))).toBe(true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not mine OpenCode answers from reasoning-channel text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-reasoning-final-marker-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const frames: Array<{ content: string; reasoning: string }> = [];
  let service: ChatService;
  class ObservingOpenCodeRuntime implements OpenCodeRuntime {
    async *runTurn(): AsyncIterable<OpenCodeRuntimeEvent> {
      yield { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Need a final answer. Then fi" };
      frames.push(captureAssistantFrame(service));
      yield { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "nal." };
      frames.push(captureAssistantFrame(service));
      yield { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "op" };
      frames.push(captureAssistantFrame(service));
      yield { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "encode-ok" };
      frames.push(captureAssistantFrame(service));
      yield { type: "final.snapshot", content: "", reasoning: "Need a final answer. Then final." };
    }

    async answerApproval(): Promise<void> {}

    async answerUserInput(): Promise<void> {}

    cancelActiveRequest(): void {}

    close(): void {}
  }
  service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), new ObservingOpenCodeRuntime());
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Reasoning Final Marker Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "finish cleanly" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(assistant?.reasoning).toBe("Need a final answer. Then final.opencode-ok");
    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed" && block.message.includes("without streamed final answer"))).toBe(true);
    expect(frames[0]).toEqual({ content: "", reasoning: "Need a final answer. Then fi" });
    expect(frames[1]).toEqual({ content: "", reasoning: "Need a final answer. Then final." });
    expect(frames[2]).toEqual({ content: "", reasoning: "Need a final answer. Then final.op" });
    expect(frames[3]).toEqual({ content: "", reasoning: "Need a final answer. Then final.opencode-ok" });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maps OpenCode server permission events to Unit-0 approval blocks", () => {
  const errors: string[] = [];
  const events = Array.from(mapOpenCodeEvent({
    type: "permission.asked",
    properties: {
      id: "per_123",
      sessionID: "ses_123",
      permission: "bash",
      patterns: ["git status*"],
      always: ["git status*"],
      metadata: { command: "git status --short" },
      tool: { messageID: "msg_123", callID: "call_123" }
    }
  }, (message) => errors.push(message)));

  expect(errors).toEqual([]);
  expect(events).toEqual([{
    type: "timeline",
    eventType: "item.started",
    sessionId: "ses_123",
    block: {
      kind: "approval",
      id: "per_123",
      status: "requested",
      title: "OpenCode approval required: bash",
      details: expect.stringContaining("git status --short"),
      requestMethod: "opencode",
      toolCallId: "ses_123"
    }
  }]);
});

test("maps OpenCode message deltas and diffs full part snapshots", () => {
  const errors: string[] = [];
  const snapshotOnlyState = new Map<string, { text: string; streamed: boolean }>();
  const snapshotOnlyEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_snapshot_only",
      part: {
        id: "prt_snapshot_only",
        sessionID: "ses_snapshot_only",
        messageID: "msg_snapshot_only",
        type: "text",
        text: "snapshot-only text"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshotOnlyState));
  const repeatedSnapshotOnlyEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_snapshot_only",
      part: {
        id: "prt_snapshot_only",
        sessionID: "ses_snapshot_only",
        messageID: "msg_snapshot_only",
        type: "text",
        text: "snapshot-only text continued"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshotOnlyState));
  const snapshots = new Map<string, { text: string; streamed: boolean }>();
  const deltaEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_123",
      messageID: "msg_123",
      partID: "prt_123",
      field: "text",
      delta: "hello"
    }
  }, (message) => errors.push(message), snapshots));
  const firstFullPartEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_123",
      part: {
        id: "prt_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "text",
        text: "hello"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshots));
  const secondFullPartEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_123",
      part: {
        id: "prt_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "text",
        text: "hello world"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshots));
  const deltaWithSnapshotEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_123",
      delta: "!",
      part: {
        id: "prt_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "text",
        text: "hello world!"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshots));
  const duplicateFullPartEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_123",
      part: {
        id: "prt_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "text",
        text: "hello world!"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshots));
  const staleFullPartEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_123",
      part: {
        id: "prt_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "text",
        text: "hello world"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshots));
  const divergentFullPartEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_123",
      part: {
        id: "prt_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "text",
        text: "hello brave world!"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshots));
  const continuedDivergentFullPartEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_123",
      part: {
        id: "prt_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "text",
        text: "hello brave world! done"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), snapshots));
  const divergentDeltaEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_delta_divergent",
      delta: "!",
      part: {
        id: "prt_delta_divergent",
        sessionID: "ses_delta_divergent",
        messageID: "msg_delta_divergent",
        type: "text",
        text: "corrected!"
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), new Map([["ses_delta_divergent:msg_delta_divergent:prt_delta_divergent:text", { text: "wrong", streamed: true }]])));
  const shorterSnapshotEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_shorter",
      part: {
        id: "prt_shorter",
        sessionID: "ses_shorter",
        messageID: "msg_shorter",
        type: "text",
        text: "First."
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), new Map([["ses_shorter:msg_shorter:prt_shorter:text", { text: "First. Second.", streamed: true }]])));
  const emptySnapshotEvents = Array.from(mapOpenCodeEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_empty_replace",
      part: {
        id: "prt_empty_replace",
        sessionID: "ses_empty_replace",
        messageID: "msg_empty_replace",
        type: "text",
        text: ""
      },
      time: Date.now()
    }
  }, (message) => errors.push(message), new Map([["ses_empty_replace:msg_empty_replace:prt_empty_replace:text", { text: "Stale text.", streamed: true }]])));

  expect(errors).toEqual([]);
  expect(snapshotOnlyEvents).toEqual([]);
  expect(repeatedSnapshotOnlyEvents).toEqual([]);
  expect(deltaEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_123:prt_123",
    status: "updated",
    text: "hello",
    sessionId: "ses_123"
  }]);
  expect(firstFullPartEvents).toEqual([]);
  expect(secondFullPartEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_123:prt_123",
    status: "updated",
    text: " world",
    sessionId: "ses_123"
  }]);
  expect(deltaWithSnapshotEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_123:prt_123",
    status: "updated",
    text: "!",
    sessionId: "ses_123"
  }]);
  expect(duplicateFullPartEvents).toEqual([]);
  expect(staleFullPartEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_123:prt_123",
    status: "updated",
    text: "hello world",
    replace: true,
    sessionId: "ses_123"
  }]);
  expect(divergentFullPartEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_123:prt_123",
    status: "updated",
    text: "hello brave world!",
    replace: true,
    sessionId: "ses_123"
  }]);
  expect(continuedDivergentFullPartEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_123:prt_123",
    status: "updated",
    text: " done",
    sessionId: "ses_123"
  }]);
  expect(divergentDeltaEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_delta_divergent:prt_delta_divergent",
    status: "updated",
    text: "corrected!",
    replace: true,
    sessionId: "ses_delta_divergent"
  }]);
  expect(shorterSnapshotEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_shorter:prt_shorter",
    status: "updated",
    text: "First.",
    replace: true,
    sessionId: "ses_shorter"
  }]);
  expect(emptySnapshotEvents).toEqual([{
    type: "assistant.delta",
    id: "msg_empty_replace:prt_empty_replace",
    status: "updated",
    text: "",
    replace: true,
    sessionId: "ses_empty_replace"
  }]);
});

test("maps OpenCode permission replies to normalized approval decisions", () => {
  const errors: string[] = [];
  const events = Array.from(mapOpenCodeEvent({
    type: "permission.replied",
    properties: {
      sessionID: "ses_123",
      requestID: "per_123",
      reply: "once"
    }
  }, (message) => errors.push(message)));

  expect(errors).toEqual([]);
  expect(events).toEqual([{
    type: "timeline",
    eventType: "item.completed",
    sessionId: "ses_123",
    block: {
      kind: "approval",
      id: "per_123",
      status: "completed",
      title: "Approval answered",
      decision: "accepted"
    }
  }]);
});

test("fails OpenCode turns when streamed final text differs from the final snapshot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-snapshot-mismatch-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Partial" },
    { type: "final.snapshot", content: "Partial answer.", reasoning: "", strict: true }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Snapshot Mismatch Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "stream incomplete" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Partial");
    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed" && block.message.includes("did not match"))).toBe(true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validates strict OpenCode final snapshots against streamed message segments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-segment-snapshot-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "First" },
    { type: "assistant.delta", id: "msg_2:prt_2", status: "updated", text: "Second" },
    { type: "final.snapshot", content: "Second", reasoning: "", strict: true, messageId: "msg_2" },
    { type: "turn.completed" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Segment Snapshot Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "two messages" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("FirstSecond");
    expect(assistant?.status).toBe("complete");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validates strict OpenCode snapshots against concatenated message parts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-multipart-snapshot-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "msg_1:rsn_1", status: "updated", text: "Think " },
    { type: "reasoning.delta", id: "msg_1:rsn_2", status: "updated", text: "first." },
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "Hello " },
    { type: "assistant.delta", id: "msg_1:prt_2", status: "updated", text: "world." },
    { type: "final.snapshot", content: "Hello world.", reasoning: "Think first.", strict: true, messageId: "msg_1" },
    { type: "turn.completed" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Multipart Snapshot Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "multipart message" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Hello world.");
    expect(assistant?.reasoning).toBe("Think first.");
    expect(assistant?.status).toBe("complete");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validates strict OpenCode snapshots against actual interleaved stream order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-interleaved-snapshot-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "A" },
    { type: "assistant.delta", id: "msg_1:prt_2", status: "updated", text: "B" },
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "C" },
    { type: "final.snapshot", content: "ABC", reasoning: "", strict: true, messageId: "msg_1" },
    { type: "turn.completed" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Interleaved Snapshot Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "interleaved message" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("ABC");
    expect(assistant?.status).toBe("complete");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails strict OpenCode reasoning snapshots that omit streamed reasoning for the source message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-reasoning-omitted-snapshot-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "msg_1:rsn_1", status: "updated", text: "Need answer." },
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "Done." },
    { type: "final.snapshot", content: "Done.", reasoning: "", strict: true, messageId: "msg_1" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Reasoning Omitted Snapshot Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "reasoning mismatch" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "status" && block.code === "opencode_failed" && block.message.includes("reasoning did not match"))).toBe(true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("answers OpenCode question blocks through the OpenCode runtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-question-action-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    {
      type: "timeline",
      eventType: "item.started",
      block: {
        kind: "question",
        id: "que_test",
        status: "requested",
        title: "Pattern",
        question: "What pattern should I grep for?",
        questions: [{ id: "que_test:0", label: "What pattern should I grep for?", options: ["TODO"], allowsCustomAnswer: true }],
        requestMethod: "opencode"
      }
    }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Question Action Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    state = store.loadState();
    const assistant = store.createMessage(state.selectedThreadId, "assistant", "", "streaming", {
      timelineBlocks: [{
        kind: "question",
        id: "que_test",
        status: "requested",
        title: "Pattern",
        question: "What pattern should I grep for?\nWhich files should I include?",
        questions: [
          { id: "que_test:0", label: "What pattern should I grep for?", options: ["TODO"], allowsCustomAnswer: true },
          { id: "que_test:1", label: "Which files should I include?", options: ["*.ts"], allowsCustomAnswer: true }
        ],
        requestMethod: "opencode"
      }]
    });
    const question = assistant.timelineBlocks?.find((block) => block.kind === "question");
    expect(question).toBeTruthy();

    await service.timelineAction({ messageId: assistant.id, blockId: "que_test", action: "answer", answers: { "que_test:0": "TODO", "que_test:1": "*.ts" } });

    expect(openCodeRuntime.userInputs).toEqual([{ requestId: "que_test", answers: { "que_test:0": "TODO", "que_test:1": "*.ts" } }]);
    state = store.loadState();
    const completedQuestion = state.messages.find((message) => message.id === assistant.id)?.timelineBlocks?.find((block) => block.kind === "question");
    expect(completedQuestion).toMatchObject({
      kind: "question",
      status: "completed",
      question: "What pattern should I grep for?\nWhich files should I include?",
      answers: { "que_test:0": "TODO", "que_test:1": "*.ts" }
    });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not complete OpenCode question blocks when answer submission fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-question-failure-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  class RejectingOpenCodeRuntime extends ScriptedOpenCodeRuntime {
    override async answerUserInput(): Promise<void> {
      throw new Error("question reply failed");
    }
  }
  const openCodeRuntime = new RejectingOpenCodeRuntime();
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Question Failure Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });
    const assistant = store.createMessage(state.selectedThreadId, "assistant", "", "streaming", {
      timelineBlocks: [{
        kind: "question",
        id: "que_fail",
        status: "requested",
        title: "Pattern",
        question: "What pattern should I grep for?",
        questions: [{ id: "que_fail:0", label: "What pattern should I grep for?", options: ["TODO"], allowsCustomAnswer: true }],
        requestMethod: "opencode"
      }]
    });

    await expect(service.timelineAction({ messageId: assistant.id, blockId: "que_fail", action: "answer", answer: "TODO" })).rejects.toThrow("question reply failed");

    state = store.loadState();
    const question = state.messages.find((message) => message.id === assistant.id)?.timelineBlocks?.find((block) => block.kind === "question");
    expect(question).toMatchObject({ kind: "question", status: "requested" });
    expect(question && "answers" in question ? question.answers : undefined).toBeUndefined();
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not complete OpenCode approval blocks when approval submission fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-approval-failure-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  class RejectingApprovalOpenCodeRuntime extends ScriptedOpenCodeRuntime {
    override async answerApproval(): Promise<void> {
      throw new Error("approval reply failed");
    }
  }
  const openCodeRuntime = new RejectingApprovalOpenCodeRuntime();
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Approval Failure Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });
    const assistant = store.createMessage(state.selectedThreadId, "assistant", "", "streaming", {
      timelineBlocks: [{
        kind: "approval",
        id: "perm_fail",
        status: "requested",
        title: "OpenCode approval required: webfetch",
        details: "https://example.com",
        requestMethod: "opencode"
      }]
    });

    await expect(service.timelineAction({ messageId: assistant.id, blockId: "perm_fail", action: "approve" })).rejects.toThrow("approval reply failed");

    state = store.loadState();
    const approval = state.messages.find((message) => message.id === assistant.id)?.timelineBlocks?.find((block) => block.kind === "approval");
    expect(approval).toMatchObject({ kind: "approval", status: "requested" });
    expect(approval && "decision" in approval ? approval.decision : undefined).toBeUndefined();
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("completes OpenCode approval blocks only after approval submission succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-approval-success-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime();
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Approval Success Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });
    const assistant = store.createMessage(state.selectedThreadId, "assistant", "", "streaming", {
      timelineBlocks: [{
        kind: "approval",
        id: "perm_ok",
        status: "requested",
        title: "OpenCode approval required: webfetch",
        details: "https://example.com",
        requestMethod: "opencode"
      }]
    });

    await service.timelineAction({ messageId: assistant.id, blockId: "perm_ok", action: "approve" });

    expect(openCodeRuntime.approvals).toEqual([{ permissionId: "perm_ok", decision: "approve" }]);
    state = store.loadState();
    const approval = state.messages.find((message) => message.id === assistant.id)?.timelineBlocks?.find((block) => block.kind === "approval");
    expect(approval).toMatchObject({ kind: "approval", status: "completed", decision: "accepted" });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves OpenCode approval prompt fields when the server completes the approval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-approval-complete-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    {
      type: "timeline",
      eventType: "item.started",
      block: {
        kind: "approval",
        id: "perm_done",
        status: "requested",
        title: "OpenCode approval required: webfetch",
        details: "Patterns: https://example.com",
        requestMethod: "opencode",
        toolCallId: "ses_done"
      }
    },
    {
      type: "timeline",
      eventType: "item.completed",
      block: {
        kind: "approval",
        id: "perm_done",
        status: "completed",
        title: "Approval answered",
        decision: "accepted"
      }
    },
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "Done." },
    { type: "final.snapshot", content: "Done.", reasoning: "" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Approval Complete Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "approve and continue" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const approval = state.messages.find((message) => message.role === "assistant")?.timelineBlocks?.find((block) => block.kind === "approval");
    expect(approval).toMatchObject({
      kind: "approval",
      status: "completed",
      title: "OpenCode approval required: webfetch",
      details: "Patterns: https://example.com",
      requestMethod: "opencode",
      toolCallId: "ses_done",
      decision: "accepted"
    });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves OpenCode question prompt fields when the server completes the question", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-question-complete-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    {
      type: "timeline",
      eventType: "item.started",
      block: {
        kind: "question",
        id: "que_done",
        status: "requested",
        title: "Pattern",
        question: "What pattern should I grep for?",
        questions: [{ id: "que_done:0", label: "What pattern should I grep for?", options: ["TODO"], allowsCustomAnswer: true }],
        requestMethod: "opencode"
      }
    },
    {
      type: "timeline",
      eventType: "item.completed",
      block: {
        kind: "question",
        id: "que_done",
        status: "completed",
        title: "Question answered",
        answers: { "que_done:0": "TODO" },
        requestMethod: "opencode"
      }
    },
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "Done." },
    { type: "final.snapshot", content: "Done.", reasoning: "" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Question Complete Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "ask and answer" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const question = state.messages.find((message) => message.role === "assistant")?.timelineBlocks?.find((block) => block.kind === "question");
    expect(question).toMatchObject({
      kind: "question",
      status: "completed",
      title: "Question answered",
      question: "What pattern should I grep for?",
      questions: [{ id: "que_done:0", label: "What pattern should I grep for?", options: ["TODO"], allowsCustomAnswer: true }],
      answers: { "que_done:0": "TODO" }
    });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails strict OpenCode final snapshots that do not match their source message segment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-stale-segment-snapshot-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "assistant.delta", id: "msg_1:prt_1", status: "updated", text: "First" },
    { type: "assistant.delta", id: "msg_2:prt_2", status: "updated", text: "Second" },
    { type: "final.snapshot", content: "First", reasoning: "", strict: true, messageId: "msg_2" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Stale Segment Snapshot Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "two messages" });
    await expect.poll(() => service.state().generation.status).toBe("error");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("FirstSecond");
    expect(assistant?.status).toBe("error");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not compare strict OpenCode final snapshots against earlier streamed reasoning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-snapshot-reasoning-scope-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const openCodeRuntime = new ScriptedOpenCodeRuntime([[
    { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Use a tool first." },
    { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Done." },
    { type: "final.snapshot", content: "Done.", reasoning: "", strict: true },
    { type: "turn.completed" }
  ]]);
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Snapshot Reasoning Scope Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "finish after tool" });
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Done.");
    expect(assistant?.reasoning).toBe("Use a tool first.");
    expect(assistant?.status).toBe("complete");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("splits OpenCode SSE frames with CRLF and flushes final unterminated data", () => {
  const first = splitSseFrames("data: {\"type\":\"one\"}\r\n\r\n");
  const partial = splitSseFrames("data: {\"type\":\"two\"}\r");
  const completed = splitSseFrames(`${partial.rest}\n\r\n`);
  const flushed = splitSseFrames("data: {\"type\":\"three\"}", true);

  expect(first).toEqual({ frames: ["data: {\"type\":\"one\"}"], rest: "" });
  expect(partial).toEqual({ frames: [], rest: "data: {\"type\":\"two\"}\r" });
  expect(completed).toEqual({ frames: ["data: {\"type\":\"two\"}"], rest: "" });
  expect(flushed).toEqual({ frames: ["data: {\"type\":\"three\"}"], rest: "" });
});

test("normalizes GPT-OSS Harmony channels from OpenCode text deltas", () => {
  const parsers = new Map();
  const events = [
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_123:prt_123",
      status: "updated",
      sessionId: "ses_123",
      text: "<|channel|>analysis<|message|>Need short answer.<|end|><|start|>assistant<|channel|>final<|message|>opencode-ok<|return|>"
    }, parsers)
  ];

  expect(events).toEqual([
    {
      type: "reasoning.delta",
      id: "msg_123:prt_123:reasoning",
      status: "updated",
      text: "Need short answer.",
      sessionId: "ses_123"
    },
    {
      type: "assistant.delta",
      id: "msg_123:prt_123",
      status: "updated",
      text: "opencode-ok",
      sessionId: "ses_123"
    }
  ]);
  expect(events.map((event) => "text" in event ? event.text : "").join("")).not.toContain("<|return|>");
});

test("normalizes GPT-OSS Harmony channels split across OpenCode text deltas", () => {
  const parsers = new Map();
  const first = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_split:prt_split",
    status: "updated",
    sessionId: "ses_split",
    text: "<|chan"
  }, parsers);
  const second = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_split:prt_split",
    status: "updated",
    sessionId: "ses_split",
    text: "nel|>analysis<|message|>Need short answer.<|end|><|start|>assistant<|channel|>final<|message|>opencode-ok<|return|>"
  }, parsers);

  expect(first).toEqual([]);
  expect(second).toEqual([
    {
      type: "reasoning.delta",
      id: "msg_split:prt_split:reasoning",
      status: "updated",
      text: "Need short answer.",
      sessionId: "ses_split"
    },
    {
      type: "assistant.delta",
      id: "msg_split:prt_split",
      status: "updated",
      text: "opencode-ok",
      sessionId: "ses_split"
    }
  ]);
  expect(second.map((event) => "text" in event ? event.text : "").join("")).not.toContain("<|");
});

test("does not duplicate reasoning when OpenCode emits native reasoning and Harmony text", () => {
  const parsers = new Map();
  const native = normalizeOpenCodeHarmonyEvent({
    type: "reasoning.delta",
    id: "msg_dupe:reasoning_part",
    status: "updated",
    sessionId: "ses_dupe",
    text: "Need short answer."
  }, parsers);
  const harmony = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_dupe:text_part",
    status: "updated",
    sessionId: "ses_dupe",
    text: "<|channel|>analysis<|message|>Need short answer.<|end|><|start|>assistant<|channel|>final<|message|>Done.<|return|>"
  }, parsers);

  expect(native).toEqual([{
    type: "reasoning.delta",
    id: "msg_dupe:reasoning_part",
    status: "updated",
    text: "Need short answer.",
    sessionId: "ses_dupe"
  }]);
  expect(harmony).toEqual([{
    type: "assistant.delta",
    id: "msg_dupe:text_part",
    status: "updated",
    text: "Done.",
    sessionId: "ses_dupe"
  }]);
});

test("preserves parsed reasoning suffix when native OpenCode reasoning was partial", () => {
  const parsers = new Map();
  const native = normalizeOpenCodeHarmonyEvent({
    type: "reasoning.delta",
    id: "msg_reasoning_suffix:reasoning_part",
    status: "updated",
    sessionId: "ses_reasoning_suffix",
    text: "Need files."
  }, parsers);
  const harmony = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_reasoning_suffix:text_part",
    status: "updated",
    sessionId: "ses_reasoning_suffix",
    text: "<|channel|>analysis<|message|>Need files. Verify filenames before answering.<|end|><|start|>assistant<|channel|>final<|message|>Done.<|return|>"
  }, parsers);

  expect(native).toEqual([{
    type: "reasoning.delta",
    id: "msg_reasoning_suffix:reasoning_part",
    status: "updated",
    text: "Need files.",
    sessionId: "ses_reasoning_suffix"
  }]);
  expect(harmony).toEqual([
    {
      type: "reasoning.delta",
      id: "msg_reasoning_suffix:text_part:reasoning",
      status: "updated",
      text: " Verify filenames before answering.",
      replace: undefined,
      sessionId: "ses_reasoning_suffix"
    },
    {
      type: "assistant.delta",
      id: "msg_reasoning_suffix:text_part",
      status: "updated",
      text: "Done.",
      sessionId: "ses_reasoning_suffix"
    }
  ]);
});

test("allows final content after native OpenCode reasoning in a later response part", () => {
  const parsers = new Map();
  const native = normalizeOpenCodeHarmonyEvent({
    type: "reasoning.delta",
    id: "msg_native_split:reasoning_part",
    status: "updated",
    sessionId: "ses_native_split",
    text: "Need short answer."
  }, parsers);
  const final = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_native_split:text_part",
    status: "updated",
    sessionId: "ses_native_split",
    text: "[[UNIT0_ANALYSIS]][[UNIT0_FINAL]]Done.<|return|>"
  }, parsers, true, "marker-secret");

  expect(native).toEqual([{
    type: "reasoning.delta",
    id: "msg_native_split:reasoning_part",
    status: "updated",
    text: "Need short answer.",
    sessionId: "ses_native_split"
  }]);
  expect(final).toEqual([{
    type: "assistant.delta",
    id: "msg_native_split:text_part",
    status: "updated",
    text: "Done.",
    replace: undefined,
    sessionId: "ses_native_split"
  }]);
});

test("rejects final-only delimited content even after earlier native reasoning", () => {
  const parsers = new Map();
  normalizeOpenCodeHarmonyEvent({
    type: "reasoning.delta",
    id: "msg_final_only_after_reasoning:reasoning_part",
    status: "updated",
    sessionId: "ses_final_only_after_reasoning",
    text: "Need short answer."
  }, parsers);
  const final = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_final_only_after_reasoning:text_part",
    status: "updated",
    sessionId: "ses_final_only_after_reasoning",
    text: "[[UNIT0_FINAL]]Done.<|return|>"
  }, parsers, true, "marker-secret");

  expect(final).toEqual([{ type: "error", message: "OpenCode GPT-OSS emitted malformed channel delimiters." }]);
});

test("normalizes multiple delimited reasoning spans around tool markers", () => {
  const parsers = new Map();
  const toolStart = Buffer.from(JSON.stringify({
    id: "call_multi_reasoning",
    name: "glob",
    argumentsText: "{\"pattern\":\"*\"}",
    cwd: "C:\\Workspace"
  }), "utf8").toString("base64url");
  const toolComplete = Buffer.from(JSON.stringify({
    id: "call_multi_reasoning",
    name: "glob",
    argumentsText: "{\"pattern\":\"*\"}",
    cwd: "C:\\Workspace",
    output: "a.ts"
  }), "utf8").toString("base64url");
  const events = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_multi_reasoning:prt_multi_reasoning",
    status: "updated",
    sessionId: "ses_multi_reasoning",
    text: `[[UNIT0_ANALYSIS]]Need files.[[UNIT0_TOOL_START:${toolStart}]][[UNIT0_TOOL_COMPLETE:${toolComplete}]][[UNIT0_ANALYSIS]]Got files.[[UNIT0_FINAL]]Done.<|return|>`
  }, parsers);

  expect(events.map((event) => event.type)).toEqual(["reasoning.delta", "timeline", "timeline", "reasoning.delta", "assistant.delta"]);
  expect(events[0]).toMatchObject({ type: "reasoning.delta", text: "Need files." });
  expect(events[1]).toMatchObject({ type: "timeline", eventType: "item.started" });
  expect(events[2]).toMatchObject({ type: "timeline", eventType: "item.completed" });
  expect(events[3]).toMatchObject({ type: "reasoning.delta", text: "Got files." });
  expect(events[4]).toMatchObject({ type: "assistant.delta", text: "Done." });
});

test("allows final content after an authenticated tool completion without extra analysis", () => {
  const parsers = new Map();
  const toolStart = Buffer.from(JSON.stringify({
    id: "call_final_after_tool",
    name: "glob",
    argumentsText: "{\"pattern\":\"*\"}",
    cwd: "C:\\Workspace"
  }), "utf8").toString("base64url");
  const toolComplete = Buffer.from(JSON.stringify({
    id: "call_final_after_tool",
    name: "glob",
    argumentsText: "{\"pattern\":\"*\"}",
    cwd: "C:\\Workspace",
    output: "a.ts"
  }), "utf8").toString("base64url");

  const first = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_final_after_tool:prt_final_after_tool",
    status: "updated",
    sessionId: "ses_final_after_tool",
    text: `[[UNIT0_ANALYSIS]]Need files.[[UNIT0_TOOL_START:${toolStart}]]`
  }, parsers);
  const second = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_final_after_tool:prt_final_after_tool_2",
    status: "updated",
    sessionId: "ses_final_after_tool",
    text: `[[UNIT0_TOOL_COMPLETE:${toolComplete}]][[UNIT0_FINAL]]a.ts<|return|>`
  }, parsers);

  expect(first.map((event) => event.type)).toEqual(["reasoning.delta", "timeline"]);
  expect(second.map((event) => event.type)).toEqual(["timeline", "assistant.delta"]);
  expect(second[0]).toMatchObject({ type: "timeline", eventType: "item.completed" });
  expect(second[1]).toMatchObject({ type: "assistant.delta", text: "a.ts" });
});

test("rejects delimited tool markers after final content instead of reordering them", () => {
  const parsers = new Map();
  const toolStart = Buffer.from(JSON.stringify({
    id: "call_after_final",
    name: "glob",
    argumentsText: "{\"pattern\":\"*\"}"
  }), "utf8").toString("base64url");
  const events = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_tool_after_final:prt_tool_after_final",
    status: "updated",
    sessionId: "ses_tool_after_final",
    text: `[[UNIT0_ANALYSIS]]Think.[[UNIT0_FINAL]]Answer.[[UNIT0_TOOL_START:${toolStart}]]<|return|>`
  }, parsers);

  expect(events).toEqual([{ type: "error", message: "OpenCode GPT-OSS emitted malformed channel delimiters." }]);
});

test("rejects divergent native and parsed reasoning instead of merging suffixes", () => {
  const parsers = new Map();
  const native = normalizeOpenCodeHarmonyEvent({
    type: "reasoning.delta",
    id: "msg_reasoning_diverge:reasoning_part",
    status: "updated",
    sessionId: "ses_reasoning_diverge",
    text: "Need file."
  }, parsers);
  const harmony = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_reasoning_diverge:text_part",
    status: "updated",
    sessionId: "ses_reasoning_diverge",
    text: "<|channel|>analysis<|message|>Need files.<|end|><|start|>assistant<|channel|>final<|message|>Done.<|return|>"
  }, parsers);

  expect(native).toHaveLength(1);
  expect(harmony).toEqual([{ type: "error", message: "OpenCode GPT-OSS emitted divergent native and parsed reasoning." }]);
});

test("does not duplicate reasoning when parsed Harmony reasoning arrives before native reasoning", () => {
  const parsers = new Map();
  const harmony = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_dupe_reverse:text_part",
    status: "updated",
    sessionId: "ses_dupe_reverse",
    text: "<|channel|>analysis<|message|>Need short answer.<|end|>"
  }, parsers);
  const native = normalizeOpenCodeHarmonyEvent({
    type: "reasoning.delta",
    id: "msg_dupe_reverse:reasoning_part",
    status: "updated",
    sessionId: "ses_dupe_reverse",
    text: "Need short answer."
  }, parsers);
  const final = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_dupe_reverse:text_part",
    status: "updated",
    sessionId: "ses_dupe_reverse",
    text: "<|start|>assistant<|channel|>final<|message|>Done.<|return|>"
  }, parsers);

  expect(harmony).toEqual([{
    type: "reasoning.delta",
    id: "msg_dupe_reverse:text_part:reasoning",
    status: "updated",
    text: "Need short answer.",
    sessionId: "ses_dupe_reverse"
  }]);
  expect(native).toEqual([]);
  expect(final).toEqual([{
    type: "assistant.delta",
    id: "msg_dupe_reverse:text_part",
    status: "updated",
    text: "Done.",
    sessionId: "ses_dupe_reverse"
  }]);
});

test("holds unmarked GPT-OSS OpenCode text instead of guessing channels", () => {
  const parsers = new Map();
  const first = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_flat:prt_flat",
    status: "updated",
    sessionId: "ses_flat",
    text: "User says \"hi\". We need to respond appropriately.\n\n"
  }, parsers);
  const second = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_flat:prt_flat",
    status: "updated",
    sessionId: "ses_flat",
    text: "Hello!<|return|>"
  }, parsers);

  expect(first).toEqual([]);
  expect(second).toEqual([]);
});

test("streams delimited plain GPT-OSS text into reasoning and final content", () => {
  const parsers = new Map();
  const events = [
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_live:prt_live",
      status: "updated",
      sessionId: "ses_live",
      text: "[[UNIT0_ANALYSIS]]Need "
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_live:prt_live",
      status: "updated",
      sessionId: "ses_live",
      text: "a short greeting.[[UNIT0_FINAL]]Hel"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_live:prt_live",
      status: "updated",
      sessionId: "ses_live",
      text: "lo<|return|>"
    }, parsers)
  ];

  expect(events).toEqual([
    {
      type: "reasoning.delta",
      id: "msg_live:prt_live:reasoning",
      status: "updated",
      text: "Need ",
      replace: undefined,
      sessionId: "ses_live"
    },
    {
      type: "reasoning.delta",
      id: "msg_live:prt_live:reasoning",
      status: "updated",
      text: "a short greeting.",
      replace: undefined,
      sessionId: "ses_live"
    },
    {
      type: "assistant.delta",
      id: "msg_live:prt_live",
      status: "updated",
      text: "Hel",
      replace: undefined,
      sessionId: "ses_live"
    },
    {
      type: "assistant.delta",
      id: "msg_live:prt_live",
      status: "updated",
      text: "lo",
      replace: undefined,
      sessionId: "ses_live"
    }
  ]);
});

test("holds all unmarked GPT-OSS paragraphs when no delimiter arrives", () => {
  const parsers = new Map();
  const events = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_multi:prt_multi",
    status: "updated",
    sessionId: "ses_multi",
    text: "Reason one.\n\nReason two.\n\nFinal answer.<|return|>"
  }, parsers);

  expect(events).toEqual([]);
});

test("holds ambiguous unmarked paragraphs before return", () => {
  const parsers = new Map();
  const events = [
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_multi_live:prt_multi_live",
      status: "updated",
      sessionId: "ses_multi_live",
      text: "Reason one.\n\nReason two."
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_multi_live:prt_multi_live",
      status: "updated",
      sessionId: "ses_multi_live",
      text: "\n\nFinal answer.<|return|>"
    }, parsers)
  ];

  expect(events).toEqual([]);
});

test("passes GPT-OSS reasoning deltas through without speculative final cue splitting", () => {
  const states = new Map();
  const events = [
    ...normalizeOpenCodeHarmonyEvent({
      type: "reasoning.delta",
      id: "msg_reasoning:prt_reasoning",
      status: "updated",
      sessionId: "ses_reasoning",
      text: "Need a short reply. Final "
    }, states),
    ...normalizeOpenCodeHarmonyEvent({
      type: "reasoning.delta",
      id: "msg_reasoning:prt_reasoning",
      status: "updated",
      sessionId: "ses_reasoning",
      text: "output: op"
    }, states),
    ...normalizeOpenCodeHarmonyEvent({
      type: "reasoning.delta",
      id: "msg_reasoning:prt_reasoning",
      status: "updated",
      sessionId: "ses_reasoning",
      text: "encode-ok"
    }, states)
  ];

  expect(events).toEqual([
    {
      type: "reasoning.delta",
      id: "msg_reasoning:prt_reasoning",
      status: "updated",
      text: "Need a short reply. Final ",
      sessionId: "ses_reasoning"
    },
    {
      type: "reasoning.delta",
      id: "msg_reasoning:prt_reasoning",
      status: "updated",
      text: "output: op",
      sessionId: "ses_reasoning"
    },
    {
      type: "reasoning.delta",
      id: "msg_reasoning:prt_reasoning",
      status: "updated",
      text: "encode-ok",
      sessionId: "ses_reasoning"
    }
  ]);
});

test("holds unmarked GPT-OSS OpenCode final text before return instead of guessing", () => {
  const parsers = new Map();
  const events = [
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_stream:prt_stream",
      status: "updated",
      sessionId: "ses_stream",
      text: "Need a short greeting.\n\n"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_stream:prt_stream",
      status: "updated",
      sessionId: "ses_stream",
      text: "Hel"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_stream:prt_stream",
      status: "updated",
      sessionId: "ses_stream",
      text: "lo"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_stream:prt_stream",
      status: "updated",
      sessionId: "ses_stream",
      text: "!<|return|>"
    }, parsers)
  ];

  expect(events).toEqual([]);
  expect(events.map((event) => "text" in event ? event.text : "").join("")).not.toContain("<|return|>");
});

test("holds partial return markers and unmarked text without delimiters", () => {
  const parsers = new Map();
  const events = [
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_partial:prt_partial",
      status: "updated",
      sessionId: "ses_partial",
      text: "Need a short greeting.\n\nAns"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_partial:prt_partial",
      status: "updated",
      sessionId: "ses_partial",
      text: "wer<"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_partial:prt_partial",
      status: "updated",
      sessionId: "ses_partial",
      text: "|return|>"
    }, parsers)
  ];

  expect(events).toEqual([]);
  expect(events.map((event) => "text" in event ? event.text : "").join("")).not.toContain("<");
});

test("holds unmarked final text with trailing blank line when no delimiter arrives", () => {
  const parsers = new Map();
  const events = [
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_trailing:prt_trailing",
      status: "updated",
      sessionId: "ses_trailing",
      text: "Need a short answer.\n\nopencode-ok"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_trailing:prt_trailing",
      status: "updated",
      sessionId: "ses_trailing",
      text: "\n\n"
    }, parsers),
    ...normalizeOpenCodeHarmonyEvent({
      type: "assistant.delta",
      id: "msg_trailing:prt_trailing",
      status: "updated",
      sessionId: "ses_trailing",
      text: "<|return|>"
    }, parsers)
  ];

  expect(events).toEqual([]);
});

test("holds unmarked GPT-OSS OpenCode text before return without mining reasoning", () => {
  const parsers = new Map();
  const first = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_late:prt_late",
    status: "updated",
    sessionId: "ses_late",
    text: "User says \"hi\". We need to respond appropriately."
  }, parsers);
  const second = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_late:prt_late",
    status: "updated",
    sessionId: "ses_late",
    text: "\n\nHello!<|return|>"
  }, parsers);

  expect(first).toEqual([]);
  expect(second).toEqual([]);
});

test("holds completed unmarked GPT-OSS text from full part snapshots", () => {
  const parsers = new Map();
  const first = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_replace:prt_replace",
    status: "updated",
    sessionId: "ses_replace",
    text: "Old reason.\n\nold-answer<|return|>"
  }, parsers);
  const corrected = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_replace:prt_replace",
    status: "updated",
    sessionId: "ses_replace",
    text: "Correct reason.\n\ncorrect-answer<|return|>",
    replace: true
  }, parsers);

  expect(first).toEqual([]);
  expect(corrected).toEqual([]);
});

test("normalizes GPT-OSS Harmony channels from OpenCode final snapshots", () => {
  const parsed = parseOpenCodeHarmonySnapshot("<|channel|>analysis<|message|>Think.<|end|><|start|>assistant<|channel|>final<|message|>Done.<|return|>");

  expect(parsed).toEqual({
    reasoning: "Think.",
    content: "Done."
  });
});

test("does not mine unmarked GPT-OSS final snapshots without delimiters", () => {
  const parsed = parseOpenCodeHarmonySnapshot("User says \"hi\". We need a greeting.\n\nHello!<|return|>");

  expect(parsed).toEqual({
    reasoning: "",
    content: ""
  });
});

test("does not mine unmarked GPT-OSS final snapshots with trailing blank line before return", () => {
  const parsed = parseOpenCodeHarmonySnapshot("Need a short answer.\n\nopencode-ok\n\n<|return|>");

  expect(parsed).toEqual({
    reasoning: "",
    content: ""
  });
});

test("normalizes delimited plain GPT-OSS final snapshots", () => {
  const parsed = parseOpenCodeHarmonySnapshot("[[UNIT0_ANALYSIS]]Need a short answer.[[UNIT0_FINAL]]opencode-ok<|return|>");

  expect(parsed).toEqual({
    reasoning: "Need a short answer.",
    content: "opencode-ok"
  });
});

test("rejects final-only and duplicate-marker delimited plain GPT-OSS snapshots", () => {
  expect(parseOpenCodeHarmonySnapshot("[[UNIT0_FINAL]]answer<|return|>")).toEqual({ reasoning: "", content: "" });
  expect(parseOpenCodeHarmonySnapshot("[[UNIT0_ANALYSIS]]one[[UNIT0_FINAL]]answer[[UNIT0_ANALYSIS]]two<|return|>")).toEqual({ reasoning: "", content: "" });
});

test("surfaces malformed delimited OpenCode GPT-OSS streams as errors", () => {
  const parsers = new Map();
  const first = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_bad_markers:prt_bad_markers",
    status: "updated",
    sessionId: "ses_bad_markers",
    text: "[[UNIT0_ANALYSIS]]think[[UNIT0_FINAL]]answer"
  }, parsers);
  const second = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_bad_markers:prt_bad_markers",
    status: "updated",
    sessionId: "ses_bad_markers",
    text: "[[UNIT0_ANALYSIS]]more"
  }, parsers);

  expect(first.some((event) => event.type === "assistant.delta")).toBe(true);
  expect(second).toEqual([{ type: "error", message: "OpenCode GPT-OSS emitted malformed channel delimiters." }]);
});

test("preserves multi-paragraph delimited GPT-OSS final snapshots", () => {
  expect(parseOpenCodeHarmonySnapshot("[[UNIT0_ANALYSIS]]think[[UNIT0_FINAL]]first\n\nsecond<|return|>")).toEqual({
    reasoning: "think",
    content: "first\n\nsecond"
  });
});

test("passes through non-GPT-OSS OpenCode plain text deltas", () => {
  const events = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_plain:prt_plain",
    status: "updated",
    sessionId: "ses_plain",
    text: "plain model text"
  }, new Map(), false);

  expect(events).toEqual([{
    type: "assistant.delta",
    id: "msg_plain:prt_plain",
    status: "updated",
    sessionId: "ses_plain",
    text: "plain model text"
  }]);
});

test("holds no-boundary unmarked GPT-OSS text before return", () => {
  const parsers = new Map();
  const first = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_direct:prt_direct",
    status: "updated",
    sessionId: "ses_direct",
    text: "Hello"
  }, parsers);
  const second = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_direct:prt_direct",
    status: "updated",
    sessionId: "ses_direct",
    text: " world<|return|>"
  }, parsers);

  expect(first).toEqual([]);
  expect(second).toEqual([]);
});

test("holds no-boundary multi-line unmarked GPT-OSS text", () => {
  const parsers = new Map();
  const events = normalizeOpenCodeHarmonyEvent({
    type: "assistant.delta",
    id: "msg_multiline_direct:prt_multiline_direct",
    status: "updated",
    sessionId: "ses_multiline_direct",
    text: "Hello\nworld<|return|>"
  }, parsers);

  expect(events).toEqual([]);
});

test("rejects remote models for OpenCode because the real harness is bound to the local OpenAI endpoint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-remote-opencode-test-"));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-remote-opencode-store-"));
  const store = new ChatStore(path.join(storeDir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    store.updateProjectSettings(store.loadState().selectedProjectId, "Remote OpenCode Project", dir);
    store.replaceRemoteModels([{
      id: "remote-model",
      label: "Remote Model",
      path: "remote://model",
      providerId: "remote",
      reference: "gpt-oss",
      sourceLabel: "Remote Built-in",
      hostId: "host",
      createdAt: new Date().toISOString()
    }], { hostId: "host", hostIdentity: "Remote Host", protocolVersion: "1" });
    const state = store.loadState();
    const next = service.updateThreadSettings({
      threadId: state.selectedThreadId,
      builtinAgenticFramework: "opencode",
      builtinModelId: "remote-model"
    });

    expect(next.generation).toMatchObject({
      status: "error",
      error: "OpenCode requires a local built-in model."
    });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("streams OpenCode final answer content after tool-call prefix is ruled out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-stream-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  let releaseSecondToken: (() => void) | null = null;
  const secondTokenGate = new Promise<void>((resolve) => {
    releaseSecondToken = resolve;
  });
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  class GatedOpenCodeRuntime extends ScriptedOpenCodeRuntime {
    override async *runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent> {
      this.calls.push({ ...options });
      yield { type: "session.started", sessionId: "opencode-session-stream" };
      yield { type: "reasoning.delta", id: "reasoning-1", status: "updated", text: "Thinking first." };
      yield { type: "assistant.delta", id: "assistant-1", status: "updated", text: "Streaming " };
      await secondTokenGate;
      yield { type: "assistant.delta", id: "assistant-1", status: "updated", text: "answer." };
      yield { type: "turn.completed" };
    }
  }
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), new GatedOpenCodeRuntime());
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Stream Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "stream final answer" });
    await expect.poll(() => service.state().messages.find((message) => message.role === "assistant")?.content).toBe("Streaming ");
    const streamingAssistant = service.state().messages.find((message) => message.role === "assistant");
    expect(streamingAssistant?.timelineBlocks?.find((block) => block.kind === "reasoning")).toMatchObject({
      status: "completed",
      text: "Thinking first."
    });
    expect(service.state().generation.status).toBe("running");

    releaseSecondToken?.();
    await expect.poll(() => service.state().generation.status).toBe("idle");
    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Streaming answer.");
    expect(assistant?.status).toBe("complete");
  } finally {
    releaseSecondToken?.();
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requires local models for OpenCode harness settings", async () => {
  const { service, store, cleanup } = makeService();
  try {
    store.replaceRemoteModels([{
      id: "remote-model",
      label: "Remote Model",
      path: "remote://model",
      providerId: "remote",
      reference: "remote-model",
      sourceLabel: "Remote Built-in",
      hostId: "host",
      createdAt: new Date().toISOString()
    }], { hostId: "host", hostIdentity: "Remote Host", protocolVersion: "1" });
    const state = store.loadState();
    service.selectModel("remote-model");

    const next = service.updateThreadSettings({
      threadId: state.selectedThreadId,
      builtinAgenticFramework: "opencode",
      builtinModelId: "remote-model"
    });

    expect(next.generation).toMatchObject({
      status: "error",
      error: "OpenCode requires a local built-in model."
    });

    const blankModel = service.updateThreadSettings({
      threadId: state.selectedThreadId,
      builtinAgenticFramework: "opencode",
      builtinModelId: ""
    });
    expect(blankModel.generation).toMatchObject({
      status: "error",
      error: "OpenCode requires a local built-in model."
    });

    const rejectedPresetSave = service.saveSettingsPreset({
      label: "Blank OpenCode",
      runtimeSettings: {},
      providerMode: "builtin",
      builtinAgenticFramework: "opencode",
      builtinModelId: ""
    });
    expect(rejectedPresetSave.generation).toMatchObject({
      status: "error",
      error: "OpenCode requires a local built-in model."
    });

    const remotePresetState = service.saveSettingsPreset({
      label: "Remote OpenCode",
      runtimeSettings: {},
      providerMode: "builtin",
      builtinAgenticFramework: "opencode",
      builtinModelId: "remote-model"
    });
    expect(remotePresetState.generation).toMatchObject({
      status: "error",
      error: "OpenCode requires a local built-in model."
    });

    const codexWithHiddenOpenCodeState = service.saveSettingsPreset({
      label: "Codex Preset",
      runtimeSettings: {},
      providerMode: "codex",
      builtinAgenticFramework: "opencode",
      builtinModelId: "remote-model"
    });
    expect(codexWithHiddenOpenCodeState.generation.status).toBe("idle");
    const savedCodexPreset = store.loadState().settingsPresets.find((preset) => preset.label === "Codex Preset");
    expect(savedCodexPreset).toMatchObject({
      providerMode: "codex",
      builtinAgenticFramework: "chat"
    });
  } finally {
    service.close();
    cleanup();
  }
});

test("cancels active OpenCode shell tool execution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-cancel-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  let releaseRun: (() => void) | null = null;
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  class BlockingOpenCodeRuntime extends ScriptedOpenCodeRuntime {
    cancelled = false;

    override async *runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent> {
      this.calls.push({ ...options });
      yield { type: "session.started", sessionId: "opencode-session-cancel" };
      yield {
        type: "timeline",
        eventType: "item.started",
        block: { kind: "tool", id: "tool-1", toolName: "bash", status: "started", command: "long command" }
      };
      await runGate;
      if (this.cancelled) {
        yield {
          type: "timeline",
          eventType: "item.completed",
          block: { kind: "tool", id: "tool-1", toolName: "bash", status: "interrupted", command: "long command", output: "Command cancelled." }
        };
      }
    }

    override cancelActiveRequest(): void {
      this.cancelled = true;
      releaseRun?.();
    }
  }
  const openCodeRuntime = new BlockingOpenCodeRuntime();
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), openCodeRuntime);
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Cancel Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "start long command" });
    await expect.poll(() => service.state().messages.find((message) => message.role === "assistant")?.timelineBlocks?.some((block) => block.kind === "tool" && block.status === "started") ?? false).toBe(true);
    service.cancel();
    await expect.poll(() => service.state().generation.status).toBe("idle");

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.status).toBe("interrupted");
    expect(openCodeRuntime.calls).toHaveLength(1);
  } finally {
    releaseRun?.();
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelled OpenCode run does not clear a newer generation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-race-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  let releaseSecondReply: (() => void) | null = null;
  const secondReplyGate = new Promise<void>((resolve) => {
    releaseSecondReply = resolve;
  });
  let secondReplyStarted: (() => void) | null = null;
  const secondReplyStartedGate = new Promise<void>((resolve) => {
    secondReplyStarted = resolve;
  });
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  let releaseFirstRun: (() => void) | null = null;
  const firstRunGate = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  class RacingOpenCodeRuntime extends ScriptedOpenCodeRuntime {
    override async *runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent> {
      this.calls.push({ ...options });
      const callIndex = this.calls.length - 1;
      yield { type: "session.started", sessionId: `opencode-race-${callIndex}` };
      if (callIndex === 0) {
        yield {
          type: "timeline",
          eventType: "item.started",
          block: { kind: "tool", id: "tool-1", toolName: "bash", status: "started", command: "long command" }
        };
        await firstRunGate;
        return;
      }
      secondReplyStarted?.();
      await secondReplyGate;
      yield { type: "assistant.delta", id: "assistant-2", status: "updated", text: "Second response." };
      yield { type: "turn.completed" };
    }

    override cancelActiveRequest(): void {
      releaseFirstRun?.();
    }
  }
  const service = new ChatService(store, new EndpointOnlyLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime(), new RacingOpenCodeRuntime());
  try {
    let state = store.loadState();
    store.updateProjectSettings(state.selectedProjectId, "OpenCode Race Project", dir);
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinAgenticFramework: "opencode",
      builtinModelId: state.selectedModelId
    });

    await service.submit({ text: "start long command" });
    await expect.poll(() => service.state().messages.find((message) => message.role === "assistant")?.timelineBlocks?.some((block) => block.kind === "tool" && block.status === "started") ?? false).toBe(true);
    service.cancel();
    await service.submit({ text: "new request" });
    await secondReplyStartedGate;
    await expect.poll(() => service.state().messages.find((message) => message.role === "assistant")?.status).toBe("interrupted");

    expect(service.state().generation.status).toBe("running");

    releaseSecondReply?.();
    await expect.poll(() => service.state().generation.status).toBe("idle");
    state = store.loadState();
    const assistants = state.messages.filter((message) => message.role === "assistant");
    expect(assistants.at(-1)?.content).toBe("Second response.");
    expect(assistants.at(-1)?.status).toBe("complete");
  } finally {
    releaseFirstRun?.();
    releaseSecondReply?.();
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
    () => undefined,
    new TestEmbeddingRuntime()
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
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] },
      { chunkId: "c2", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "beta neighbor paragraph", tokenCount: 4, ordinalStart: 1, ordinalEnd: 1, embedding: [0, 1, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.content).toContain("Alpha appears");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["tool", "tool"]);
    expect(assistant?.timelineBlocks?.filter((block) => block.kind === "tool")).toEqual([
      expect.objectContaining({ kind: "tool", command: "alpha", initiallyExpanded: true }),
      expect.objectContaining({ kind: "tool", command: "modify_results", initiallyExpanded: true })
    ]);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps document-analysis retry on the search protocol after malformed local tool calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-malformed-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const runtime = new ScriptedLlamaRuntime([
    '<tool_call>{"tool":"search","query":"alpha",</tool_call>',
    '<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>',
    "",
    "Alpha appears in the indexed document [r1]."
  ]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const sourcePath = path.join(dir, "notes.txt");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    let state = store.loadState();
    fs.writeFileSync(path.join(dir, "model.gguf"), "");
    store.addLocalModel(path.join(dir, "model.gguf"));
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);
    expect(assistant?.status).toBe("complete");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["tool", "tool", "tool"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "tool", status: "failed", initiallyExpanded: false });
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({ kind: "tool", initiallyExpanded: true });
    expect(assistant?.timelineBlocks?.[2]).toMatchObject({ kind: "tool", status: "failed", initiallyExpanded: false });
    expect(runtime.frameworkCalls[0]).toBe("document_analysis");
    expect(runtime.documentTitleCalls[0]).toBe("Notes");
    expect(runtime.settingsCalls[0].systemPrompt).toContain("This framework is for analyzing one selected indexed document index");
    expect(runtime.calls[1].at(-1)?.content).toContain("Do not answer normally until document search results are provided.");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rolls back streamed document final candidates that later fail tool-call parsing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-candidate-rollback-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const runtime = new ScriptedLlamaRuntime([
    '<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>',
    'Bad partial <tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>',
    "Alpha appears in the indexed document [r1]."
  ]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const sourcePath = path.join(dir, "notes.txt");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    let state = store.loadState();
    fs.writeFileSync(path.join(dir, "model.gguf"), "");
    store.addLocalModel(path.join(dir, "model.gguf"));
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.status).toBe("complete");
    expect(assistant?.content).toBe("Alpha appears in the indexed document [r1].");
    expect(assistant?.content).not.toContain("Bad partial");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["tool", "tool"]);
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({ kind: "tool", status: "failed" });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("surfaces document-analysis setup failures on the assistant turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-visible-error-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new ScriptedLlamaRuntime([]), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const modelPath = path.join(dir, "model.gguf");
    fs.writeFileSync(modelPath, "");
    let state = store.loadState();
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });

    await service.submit({ text: "Tell me about links in the PDF using the tool" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(next.generation).toMatchObject({
      status: "error",
      error: "No document index is selected for this thread."
    });
    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks).toEqual([
      expect.objectContaining({
        kind: "status",
        level: "error",
        message: "No document index is selected for this thread.",
        code: "document_analysis_failed"
      })
    ]);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("surfaces legacy document indexes without vector embeddings on the assistant turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-legacy-vector-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(
    store,
    new ScriptedLlamaRuntime(['<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>']),
    new RemoteHostRuntime(),
    new MockCodexRuntime(),
    () => undefined,
    new TestEmbeddingRuntime()
  );
  try {
    const sourcePath = path.join(dir, "notes.txt");
    const modelPath = path.join(dir, "model.gguf");
    const embeddingPath = path.join(dir, "embed.gguf");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    fs.writeFileSync(modelPath, "");
    fs.writeFileSync(embeddingPath, "");
    let state = store.loadState();
    store.addLocalModel(modelPath);
    state = store.loadState();
    const index = store.createDocumentIndex(state.selectedProjectId, "Legacy", sourcePath, embeddingPath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0 }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: embeddingPath
    });

    await service.submit({ text: "Tell me about alpha" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(next.generation).toMatchObject({
      status: "error",
      error: "Selected document index does not contain vector embeddings. Rebuild the document group."
    });
    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks?.at(-1)).toMatchObject({
      kind: "status",
      level: "error",
      message: "Selected document index does not contain vector embeddings. Rebuild the document group.",
      code: "document_analysis_failed"
    });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renames document groups without reindexing and embeds only new documents", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-incremental-index-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const embeddingRuntime = new RecordingEmbeddingRuntime();
  const service = new ChatService(
    store,
    new LocalLlamaRuntime(),
    new RemoteHostRuntime(),
    new MockCodexRuntime(),
    () => undefined,
    embeddingRuntime
  );
  try {
    const firstSourcePath = path.join(dir, "alpha.txt");
    const secondSourcePath = path.join(dir, "beta.txt");
    const modelPath = path.join(dir, "model.gguf");
    const embeddingPath = path.join(dir, "embed.gguf");
    fs.writeFileSync(firstSourcePath, "alpha first paragraph");
    fs.writeFileSync(secondSourcePath, "beta second paragraph");
    fs.writeFileSync(modelPath, "");
    fs.writeFileSync(embeddingPath, "");
    let state = store.loadState();
    store.addLocalModel(modelPath);
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: embeddingPath
    });

    state = await service.createDocumentIndex({
      projectId: state.selectedProjectId,
      title: "Knowledge",
      sourcePath: firstSourcePath
    });
    const documentIndexId = state.documentIndexes.find((index) => index.title === "Knowledge")?.id ?? "";
    await expect.poll(() => service.state().documentIndexes.find((index) => index.id === documentIndexId)?.state).toBe("ready");
    expect(embeddingRuntime.documentTextBatches).toEqual([["alpha first paragraph"]]);

    await service.updateDocumentIndex({
      documentIndexId,
      title: "Renamed Knowledge",
      sourcePath: firstSourcePath
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.state().documentIndexes.find((index) => index.id === documentIndexId)).toMatchObject({
      title: "Renamed Knowledge",
      state: "ready"
    });
    expect(embeddingRuntime.documentTextBatches).toEqual([["alpha first paragraph"]]);

    await service.updateDocumentIndex({
      documentIndexId,
      title: "Renamed Knowledge",
      sourcePath: `${firstSourcePath}\n${secondSourcePath}`
    });
    await expect.poll(() => service.state().documentIndexes.find((index) => index.id === documentIndexId)?.state).toBe("ready");
    expect(embeddingRuntime.documentTextBatches).toEqual([
      ["alpha first paragraph"],
      ["beta second paragraph"]
    ]);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("streams document-analysis reasoning and final answer after tool evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-stream-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const snapshots: ReturnType<ChatService["state"]>[] = [];
  let service!: ChatService;
  service = new ChatService(
    store,
    new StreamingDocumentLlamaRuntime(),
    new RemoteHostRuntime(),
    new MockCodexRuntime(),
    () => snapshots.push(service.state()),
    new TestEmbeddingRuntime()
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
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);
    const runningSnapshots = snapshots.filter((snapshot) => snapshot.generation.status === "running");
    const runningAssistantMessages = runningSnapshots
      .map((snapshot) => snapshot.messages.filter((message) => message.role === "assistant").at(-1))
      .filter(Boolean);

    expect(assistant?.status).toBe("complete");
    expect(assistant?.content).toBe("Alpha appears in the indexed document [r1].");
    expect(assistant?.reasoning ?? "").toBe("");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["reasoning", "tool", "reasoning"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "reasoning", text: "Need search.", initiallyExpanded: true });
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({ kind: "tool", initiallyExpanded: true });
    expect(assistant?.timelineBlocks?.[2]).toMatchObject({ kind: "reasoning", text: "Reading evidence.", initiallyExpanded: true });
    expect(runningAssistantMessages.some((message) => message?.content === "Alpha ")).toBe(true);
    expect(runningSnapshots.some((snapshot) => {
      const runningAssistant = snapshot.messages.filter((message) => message.role === "assistant").at(-1);
      return runningAssistant?.timelineBlocks?.some((block) => block.kind === "reasoning" && block.text === "Reading ");
    })).toBe(true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps transient document-analysis reasoning with a failed tool marker when retry succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-transient-reasoning-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new ReasoningOnlyThenToolRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.status).toBe("complete");
    expect(assistant?.content).toBe("Alpha appears in the indexed document [r1].");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["reasoning", "tool", "reasoning", "tool", "reasoning"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "reasoning", text: "Need search but forgot final tool call.", initiallyExpanded: true });
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({ kind: "tool", status: "failed", initiallyExpanded: false });
    expect(assistant?.timelineBlocks?.[2]).toMatchObject({ kind: "reasoning", text: "Need search.", initiallyExpanded: true });
    expect(assistant?.timelineBlocks?.[3]).toMatchObject({ kind: "tool", status: "completed", initiallyExpanded: true });
    expect(assistant?.timelineBlocks?.[4]).toMatchObject({ kind: "reasoning", text: "Reading evidence.", initiallyExpanded: true });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts document-analysis final answers without forcing search", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-no-forced-search-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const runtime = new ScriptedLlamaRuntime(["Here is a deliberately long random answer without using document search."]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const sourcePath = path.join(dir, "notes.txt");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    let state = store.loadState();
    fs.writeFileSync(path.join(dir, "model.gguf"), "");
    store.addLocalModel(path.join(dir, "model.gguf"));
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "write random long texts (dont care what about, dont use search)" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.status).toBe("complete");
    expect(assistant?.content).toBe("Here is a deliberately long random answer without using document search.");
    expect(assistant?.timelineBlocks ?? []).toEqual([]);
    expect(runtime.calls).toHaveLength(1);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not retry unwrapped document-analysis JSON as a forced search", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-unwrapped-json-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const runtime = new ScriptedLlamaRuntime([
    '{"tool":"document_analysis","query":"alpha"}'
  ]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const sourcePath = path.join(dir, "notes.txt");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    let state = store.loadState();
    fs.writeFileSync(path.join(dir, "model.gguf"), "");
    store.addLocalModel(path.join(dir, "model.gguf"));
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.status).toBe("complete");
    expect(assistant?.content).toBe('{"tool":"document_analysis","query":"alpha"}');
    expect(assistant?.timelineBlocks ?? []).toEqual([]);
    expect(runtime.calls).toHaveLength(1);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects document-analysis tool calls mixed with surrounding text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-mixed-tool-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const runtime = new ScriptedLlamaRuntime([
    'Sure: <tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>',
    '<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>',
    "Alpha appears in the indexed document [r1]."
  ]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const sourcePath = path.join(dir, "notes.txt");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    let state = store.loadState();
    fs.writeFileSync(path.join(dir, "model.gguf"), "");
    store.addLocalModel(path.join(dir, "model.gguf"));
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.status).toBe("complete");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["tool", "tool"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "tool", status: "failed" });
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({ kind: "tool", command: "alpha" });
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects document-analysis tool calls emitted only in reasoning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-reasoning-tool-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  class ReasoningOnlyToolRuntime extends LocalLlamaRuntime {
    readonly calls: ChatMessage[][] = [];

    override async streamChat(options: {
      model: ChatModel;
      settings: ChatRuntimeSettings;
      messages: ChatMessage[];
      onToken: (token: string) => void;
      onReasoning?: (token: string) => void;
    }): Promise<void> {
      this.calls.push(options.messages);
      options.onReasoning?.('<tool_call>{"tool":"search","query":"alpha","top_k":4}</tool_call>');
    }
  }
  const runtime = new ReasoningOnlyToolRuntime({ startupTimeoutMs: 10 });
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const sourcePath = path.join(dir, "notes.txt");
    fs.writeFileSync(sourcePath, "alpha first paragraph");
    let state = store.loadState();
    fs.writeFileSync(path.join(dir, "model.gguf"), "");
    store.addLocalModel(path.join(dir, "model.gguf"));
    state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: state.models[0].id,
      builtinAgenticFramework: "document_analysis",
      documentAnalysisEmbeddingModelPath: path.join(dir, "embed.gguf")
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Notes", sourcePath);
    store.replaceDocumentIndexChunks(index.id, [
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
    ]);
    store.updateDocumentIndexStatus(index.id, { state: "ready", progress: 1, message: "Ready" });
    store.selectDocumentIndex(state.selectedThreadId, index.id);

    await service.submit({ text: "Where is alpha?" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.status).toBe("error");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["reasoning", "tool", "reasoning", "tool", "status"]);
    expect(assistant?.timelineBlocks?.filter((block) => block.kind === "tool")).toHaveLength(2);
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({ kind: "tool", status: "failed" });
    expect(runtime.calls[1].at(-1)?.content).toContain("only final assistant message content can contain `<tool_call>` blocks");
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
    () => undefined,
    new TestEmbeddingRuntime()
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
      { chunkId: "c1", sourceTitle: "notes.txt", sourcePath, pageStart: 1, pageEnd: 1, text: "alpha first paragraph", tokenCount: 4, ordinalStart: 0, ordinalEnd: 0, embedding: [1, 0, 0] }
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

