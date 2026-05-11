import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatService } from "../src/main/chatService";
import { ChatStore } from "../src/main/chatStore";
import { MockCodexRuntime, type CodexRunOptions, type CodexThreadEvent } from "../src/main/codexRuntime";
import type { DocumentEmbeddingRuntime } from "../src/main/embeddingRuntime";
import { LocalLlamaRuntime } from "../src/main/localLlamaRuntime";
import { RemoteHostRuntime, type RemoteStreamMetrics } from "../src/main/remoteHostRuntime";
import type { ChatAppSettings, ChatBuiltinAgenticFramework, ChatMessage, ChatModel, ChatRuntimeSettings } from "../src/shared/types";

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-service-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  return { service, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

class TestEmbeddingRuntime implements DocumentEmbeddingRuntime {
  async embedDocuments(options: { texts: string[]; onProgress?: (completed: number, total: number) => void }): Promise<number[][]> {
    options.onProgress?.(options.texts.length, options.texts.length);
    return options.texts.map((text) => testEmbeddingForText(text));
  }

  async embedQuery(options: { text: string }): Promise<number[]> {
    return testEmbeddingForText(options.text);
  }

  close(): void {}
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

class StreamingRemoteDocumentRuntime extends RemoteHostRuntime {
  override async streamDocumentAnalysis(options: {
    settings: ChatAppSettings;
    model: ChatModel;
    runtimeSettings: ChatRuntimeSettings;
    messages: ChatMessage[];
    documentIndexId: string;
    remoteSessionId?: string;
    runtimeSlotId?: number;
    runtimeSettingsSignature?: string;
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
    onAgentEvents?: (events: unknown[], sessionState: unknown) => void;
  }): Promise<RemoteStreamMetrics> {
    options.onReasoning?.("Need remote search.");
    options.onAgentEvents?.([
      {
        type: "tool_call",
        tool_call_id: "remote-search-1",
        tool_name: "search",
        status: "completed",
        summary: "pdf links",
        command: "pdf links"
      },
      {
        type: "tool_output",
        tool_call_id: "remote-search-1",
        stage: "final",
        stream: "combined",
        content: "Tool result:\n[r1] Adobe PDF32000_2008.pdf page 366: Link annotations connect document regions to destinations or actions."
      }
    ], {});
    options.onReasoning?.("Reading remote evidence.");
    options.onToken("PDF links are represented by link annotations in the PDF evidence.");
    return {
      remoteSessionId: "session-1",
      remoteSlotId: 1,
      remoteHostId: "host-1",
      remoteHostIdentity: "identity-1",
      remoteSessionStatus: "ready",
      metrics: {}
    };
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
  const runtime = new ScriptedLlamaRuntime([
    '<tool_call>{"tool":"shell","command":"echo open-code-ok"}</tool_call>',
    "Done."
  ]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
    expect(assistant?.timelineBlocks?.some((block) => block.kind === "tool" && block.toolName === "shell" && block.status === "completed" && block.output?.includes("open-code-ok"))).toBe(true);
    expect(runtime.frameworkCalls).toEqual(["opencode", "opencode"]);
    expect(runtime.calls[1].at(-1)?.content).toContain("Tool result:");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
  const runtime = new StreamingOpenCodeLlamaRuntime(["Streaming ", "answer."], async (index) => {
    if (index === 0) {
      await secondTokenGate;
    }
  }, ["Thinking ", "first."]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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

test("rejects remote models for OpenCode harness settings", async () => {
  const { service, store, cleanup } = makeService();
  const localModelDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-local-model-"));
  const localModelPath = path.join(localModelDir, "model.gguf");
  fs.writeFileSync(localModelPath, "");
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

    store.saveSettingsPreset({
      label: "Legacy Blank OpenCode",
      providerMode: "builtin",
      builtinAgenticFramework: "opencode",
      builtinModelId: ""
    });
    const legacyBlankPreset = store.loadState().settingsPresets.find((preset) => preset.label === "Legacy Blank OpenCode");
    expect(legacyBlankPreset).toBeTruthy();
    const rejectedPresetApply = service.applySettingsPreset({
      threadId: state.selectedThreadId,
      presetId: legacyBlankPreset!.id
    });
    expect(rejectedPresetApply.generation).toMatchObject({
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

    store.addLocalModel(localModelPath);
    const localState = store.loadState();
    service.updateThreadSettings({
      threadId: localState.selectedThreadId,
      builtinAgenticFramework: "opencode",
      builtinModelId: localState.selectedModelId
    });

    const blockedSelect = service.selectModel("remote-model");

    expect(blockedSelect.generation).toMatchObject({
      status: "error",
      error: "OpenCode requires a local built-in model."
    });
    expect(store.loadState().threads.find((thread) => thread.id === localState.selectedThreadId)?.builtinModelId).toBe(localState.selectedModelId);
  } finally {
    service.close();
    cleanup();
    fs.rmSync(localModelDir, { recursive: true, force: true });
  }
});

test("cancels active OpenCode shell tool execution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-cancel-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const command = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{}, 30000)"`;
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const runtime = new ScriptedLlamaRuntime([
    `<tool_call>${JSON.stringify({ tool: "shell", command })}</tool_call>`,
    "Should not continue."
  ]);
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
    await expect.poll(() => service.state().messages.find((message) => message.role === "assistant")?.timelineBlocks?.some((block) => block.kind === "tool" && block.status === "interrupted") ?? false).toBe(true);

    state = store.loadState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant?.status).toBe("interrupted");
    expect(runtime.frameworkCalls).toEqual(["opencode"]);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelled OpenCode run does not clear a newer generation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-opencode-race-test-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const command = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{}, 30000)"`;
  let releaseSecondReply: (() => void) | null = null;
  const secondReplyGate = new Promise<void>((resolve) => {
    releaseSecondReply = resolve;
  });
  let secondReplyStarted: (() => void) | null = null;
  const secondReplyStartedGate = new Promise<void>((resolve) => {
    secondReplyStarted = resolve;
  });
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const runtime = new ScriptedLlamaRuntime([
    `<tool_call>${JSON.stringify({ tool: "shell", command })}</tool_call>`,
    "Second response."
  ], async (callIndex) => {
    if (callIndex === 1) {
      secondReplyStarted?.();
      await secondReplyGate;
    }
  });
  const service = new ChatService(store, runtime, new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
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
    await expect.poll(() => service.state().messages.find((message) => message.role === "assistant" && message.timelineBlocks?.some((block) => block.kind === "tool" && block.status === "interrupted"))?.status).toBe("interrupted");

    expect(service.state().generation.status).toBe("running");

    releaseSecondReply?.();
    await expect.poll(() => service.state().generation.status).toBe("idle");
    state = store.loadState();
    const assistants = state.messages.filter((message) => message.role === "assistant");
    expect(assistants.at(-1)?.content).toBe("Second response.");
    expect(assistants.at(-1)?.status).toBe("complete");
  } finally {
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

test("keeps remote-hosted document reasoning and tool output in event order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-doc-remote-stream-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new ScriptedLlamaRuntime([]), new StreamingRemoteDocumentRuntime(), new MockCodexRuntime(), () => undefined, new TestEmbeddingRuntime());
  try {
    const sourcePath = path.join(dir, "remote-notes.txt");
    fs.writeFileSync(sourcePath, "pdf links are annotations");
    store.replaceRemoteModels([
      {
        id: "remote-model",
        label: "Remote Model",
        path: "",
        providerId: "remote",
        reference: "remote-model",
        hostId: "host-1",
        createdAt: new Date().toISOString()
      }
    ], { hostId: "host-1", hostIdentity: "identity-1", protocolVersion: "1" });
    store.updateAppSettings({
      documentIndexLocation: "remote",
      documentToolExecutionLocation: "remote",
      remoteHostAddress: "127.0.0.1",
      remotePairingCode: "123456"
    });
    let state = store.loadState();
    store.updateThreadSettings(state.selectedThreadId, {
      builtinModelId: "remote-model",
      builtinAgenticFramework: "document_analysis"
    });
    const index = store.createDocumentIndex(state.selectedProjectId, "Adobe PDF", sourcePath);
    const remoteIndexId = "remote-doc::identity-1::doc-1";
    (store as unknown as { db: { prepare: (sql: string) => { run: (...values: unknown[]) => void } } })
      .db
      .prepare("UPDATE chat_document_indexes SET id = ? WHERE id = ?")
      .run(remoteIndexId, index.id);
    store.updateDocumentIndexStatus(remoteIndexId, { state: "ready", progress: 1, message: "Ready" });
    state = store.loadState();
    store.selectDocumentIndex(state.selectedThreadId, remoteIndexId);

    await service.submit({ text: "Tell me sth about pdf links" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = service.state();
    const assistant = next.messages.filter((message) => message.role === "assistant").at(-1);

    expect(assistant?.status).toBe("complete");
    expect(assistant?.reasoning ?? "").toBe("");
    expect(assistant?.content).toContain("PDF links are represented by link annotations");
    expect(assistant?.timelineBlocks?.map((block) => block.kind)).toEqual(["reasoning", "tool", "reasoning"]);
    expect(assistant?.timelineBlocks?.[0]).toMatchObject({ kind: "reasoning", text: "Need remote search.", status: "completed", initiallyExpanded: true });
    expect(assistant?.timelineBlocks?.[1]).toMatchObject({
      kind: "tool",
      id: "remote-search-1",
      toolName: "search",
      command: "pdf links",
      output: expect.stringContaining("Adobe PDF32000_2008.pdf"),
      initiallyExpanded: true
    });
    expect(assistant?.timelineBlocks?.[2]).toMatchObject({ kind: "reasoning", text: "Reading remote evidence.", status: "completed", initiallyExpanded: true });
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

