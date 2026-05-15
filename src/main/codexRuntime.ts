import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ChatCodexAccountState, ChatCodexApprovalMode, ChatCodexModel, ChatCodexRateLimits, ChatReasoningEffort, ChatTimelineBlock, ChatTimelineFileChange, ChatTimelineReasoningSection } from "../shared/types.js";

const DEFAULT_COLLABORATION_INSTRUCTIONS = [
  "# Collaboration Mode: Default",
  "",
  "You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.",
  "",
  "Your active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.",
  "",
  "## request_user_input availability",
  "",
  "The `request_user_input` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.",
  "",
  "In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message."
].join("\n");

const PLAN_COLLABORATION_INSTRUCTIONS = [
  "# Plan Mode (Conversational)",
  "",
  "You work in 3 phases, and you should chat your way to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be decision complete, where the implementer does not need to make any decisions.",
  "",
  "## Mode rules (strict)",
  "",
  "You are in Plan Mode until a developer message explicitly ends it.",
  "",
  "Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to plan the execution, not perform it.",
  "",
  "## Plan Mode vs update_plan tool",
  "",
  "Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a `<proposed_plan>` block.",
  "",
  "Separately, `update_plan` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use `update_plan` in Plan mode, it will return an error.",
  "",
  "## Execution vs. mutation in Plan Mode",
  "",
  "You may explore and execute non-mutating actions that improve the plan. You must not perform mutating actions.",
  "",
  "Only output the final plan when it is decision complete and leaves no decisions to the implementer. When you present the official plan, wrap it in a `<proposed_plan>` block so the client can render it specially."
].join("\n");

export type CodexThreadItem =
  | { id?: string; type: "agent_message"; text?: string; initiallyExpanded?: boolean }
  | { id?: string; type: "reasoning"; text?: string; section_key?: string; sections?: ChatTimelineReasoningSection[]; initiallyExpanded?: boolean }
  | { id?: string; type: "command_execution"; command?: string; directory?: string; aggregated_output?: string; exit_code?: number | null; status?: string; initiallyExpanded?: boolean }
  | { id?: string; type: "file_change"; path?: string; summary?: string; diff?: string; added_lines?: number; deleted_lines?: number; files_changed?: number; changes?: ChatTimelineFileChange[]; status?: string; initiallyExpanded?: boolean }
  | { id?: string; type: "mcp_tool_call"; tool_name?: string; arguments?: unknown; result?: unknown; status?: string }
  | { id?: string; type: "web_search"; query?: string; status?: string }
  | { id?: string; type: "todo_list"; items?: Array<{ text?: string; status?: string }>; status?: string }
  | { id?: string; type: "approval_request"; title?: string; details?: string; status?: string; request_method?: string; tool_call_id?: string }
  | { id?: string; type: "user_question"; title?: string; question?: string; status?: string; questions?: Array<{ id: string; label: string; options?: string[]; allowsCustomAnswer?: boolean }>; answers?: Record<string, string> }
  | { id?: string; type: "status"; level?: string; message?: string; code?: string; initiallyExpanded?: boolean }
  | { id?: string; type: "error"; message?: string };

export type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.started" | "item.updated" | "item.completed"; item: CodexThreadItem }
  | { type: "turn.completed"; usage?: Record<string, unknown> }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string };

export interface CodexRunOptions {
  cwd: string;
  prompt: string;
  imagePaths?: string[];
  baseInstructions?: string;
  resumeThreadId?: string;
  model: string;
  reasoningEffort: ChatReasoningEffort;
  permissionMode: "default_permissions" | "full_access";
  approvalMode: ChatCodexApprovalMode;
  planModeEnabled: boolean;
}

export interface CodexRuntime {
  runTurn(options: CodexRunOptions): AsyncIterable<CodexThreadEvent>;
  readAccount(force?: boolean): Promise<{ account: ChatCodexAccountState; models: ChatCodexModel[] }>;
  steerCurrentTurn(options: { text: string; imagePaths?: string[] }): Promise<void>;
  answerApproval(approvalId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel"): void;
  answerUserInput(requestId: string, answers: Record<string, string>): void;
  cancelActiveRequest(): void;
  close(): void;
}

export function effectiveCodexApprovalPolicy(options: Pick<CodexRunOptions, "permissionMode" | "approvalMode">): ChatCodexApprovalMode | undefined {
  if (options.permissionMode === "full_access") {
    return "never";
  }
  return options.approvalMode === "default" ? undefined : options.approvalMode;
}

export class MockCodexRuntime implements CodexRuntime {
  private cancelled = false;
  private active = false;
  private steeredTexts: string[] = [];

  async *runTurn(options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    this.cancelled = false;
    this.active = true;
    this.steeredTexts = [];
    yield { type: "thread.started", thread_id: "thread-mock-1" };
    yield { type: "turn.started" };
    if (options.planModeEnabled) {
      yield {
        type: "item.completed",
        item: {
          id: "mock-plan",
          type: "todo_list",
          status: "completed",
          items: [
            { text: "Inspect request", status: "complete" },
            { text: "Apply local changes", status: "complete" },
            { text: "Report result", status: "complete" }
          ]
        }
      };
    }
    const reasoningCodeFixture = options.prompt.includes("[reasoning-code-fixture]")
      ? "\n```ts\nconst reason = 7;\n```\n"
      : "";
    yield {
      type: "item.completed",
      item: {
        id: "mock-reasoning",
        type: "reasoning",
        text: `Using ${options.model} with ${options.reasoningEffort} reasoning, ${options.approvalMode} approvals, and ${options.imagePaths?.length ?? 0} image attachment(s) in mocked Codex mode.\n${reasoningCodeFixture}`,
        initiallyExpanded: false
      }
    };
    yield {
      type: "item.started",
      item: { id: "mock-command", type: "command_execution", command: "npm test", aggregated_output: "", exit_code: null, status: "in_progress", initiallyExpanded: false }
    };
    await delay(10);
    if (this.cancelled) {
      this.active = false;
      return;
    }
    const steeringSuffix = this.steeredTexts.length > 0 ? ` Steering: ${this.steeredTexts.join(" ")}` : "";
    yield {
      type: "item.completed",
      item: { id: "mock-command", type: "command_execution", command: "npm test", aggregated_output: "ok\n", exit_code: 0, status: "completed" }
    };
    yield {
      type: "item.completed",
      item: { id: "mock-message", type: "agent_message", text: `Mocked Codex response: ${options.prompt}${steeringSuffix}` }
    };
    yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
    this.active = false;
  }

  cancelActiveRequest(): void {
    this.cancelled = true;
    this.active = false;
  }

  async readAccount(): Promise<{ account: ChatCodexAccountState; models: ChatCodexModel[] }> {
    return {
      account: {
        status: "ready",
        authMode: "chatgpt",
        email: "mock-codex@example.com",
        planType: "pro",
        requiresOpenaiAuth: true,
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1767225600 },
          secondary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1767240000 },
          rateLimitReachedType: null
        }
      },
      models: [
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", isDefault: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], supportsImageInput: true },
        { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", isDefault: false, reasoningEfforts: ["low", "medium", "high"], supportsImageInput: true }
      ]
    };
  }

  answerApproval(_approvalId: string, _decision: "accept" | "acceptForSession" | "decline" | "cancel"): void {
    return;
  }

  answerUserInput(_requestId: string, _answers: Record<string, string>): void {
    return;
  }

  async steerCurrentTurn(options: { text: string; imagePaths?: string[] }): Promise<void> {
    if (!this.active) {
      throw new Error("Codex steering requires an active turn.");
    }
    if (!options.text.trim() && (options.imagePaths?.length ?? 0) === 0) {
      throw new Error("Cannot steer with an empty message.");
    }
    if (options.text.trim()) {
      this.steeredTexts.push(options.text.trim());
    }
  }

  close(): void {
    this.cancelActiveRequest();
  }
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string } | string;
};

class AsyncMessageQueue<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve: (value: T) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private failure: Error | null = null;

  push(value: T): void {
    if (this.failure) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  shift(timeoutMs = 60000): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const value = this.values.shift();
    if (value) {
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("Timed out waiting for Codex app-server events."));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

class JsonRpcAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly notifications = new AsyncMessageQueue<JsonRpcMessage>();
  private readonly responses = new Map<string, { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextRequestId = 1;
  private stderr = "";

  constructor(command = resolveCodexCommand()) {
    this.child = spawn(command, ["app-server"], {
      env: process.env,
      windowsHide: true
    });
    this.child.once("error", (error) => {
      const startupError = new Error(`Codex app-server failed to start (${command}): ${error.message}`);
      for (const pending of this.responses.values()) {
        clearTimeout(pending.timer);
        pending.reject(startupError);
      }
      this.responses.clear();
      this.notifications.fail(startupError);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.routeLine(line));
    this.child.once("close", () => {
      const message = this.stderr.trim() || "Codex app-server closed.";
      for (const pending of this.responses.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      this.responses.clear();
      this.notifications.fail(new Error(message));
    });
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const id = this.nextRequestId++;
    const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(String(id));
        reject(new Error(`Timed out waiting for Codex response to ${method}.`));
      }, timeoutMs);
      this.responses.set(String(id), { resolve, reject, timer });
    });
    this.write(payload);
    return response.then((message) => {
      if (message.error) {
        const error = typeof message.error === "string" ? message.error : message.error.message;
        throw new Error(error || "Codex app-server request failed.");
      }
      return message.result ?? {};
    });
  }

  waitForMessage(timeoutMs = 60000): Promise<JsonRpcMessage> {
    return this.notifications.shift(timeoutMs);
  }

  respond(id: string | number, result: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  close(): void {
    this.child.kill();
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.child.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private routeLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.responses.get(String(message.id));
      if (pending) {
        this.responses.delete(String(message.id));
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
      return;
    }
    if (message.method) {
      this.notifications.push(message);
    }
  }
}

export class CodexAppServerRuntime implements CodexRuntime {
  private connection: JsonRpcAppServerConnection | null = null;
  private initialized = false;
  private activeThreadId = "";
  private activeTurnId = "";
  private pendingApprovals = new Map<string, { rpcId: string | number; method: string }>();
  private pendingUserInputs = new Map<string, { rpcId: string | number }>();

  async *runTurn(options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    if (this.activeTurnId) {
      throw new Error("A Codex request is already running.");
    }
    const connection = this.ensureConnection();
    await this.ensureInitialized(connection);
    const threadId = options.resumeThreadId
      ? await this.resumeThread(connection, options)
      : await this.startThread(connection, options);
    this.activeThreadId = threadId;
    yield { type: "thread.started", thread_id: threadId };
    const turn = await connection.request("turn/start", codexTurnStartPayload(threadId, options));
    const turnRecord = turn.turn;
    this.activeTurnId = isRecord(turnRecord) ? String(turnRecord.id ?? "") : "";
    if (!this.activeTurnId) {
      throw new Error("Codex turn/start response missing turn id.");
    }
    yield { type: "turn.started" };
    try {
      while (this.activeTurnId) {
        const message = await connection.waitForMessage();
        const mapped = this.mapAppServerMessage(message, threadId, this.activeTurnId);
        for (const event of mapped.events) {
          yield event;
        }
        if (mapped.completed) {
          this.activeTurnId = "";
          if (!mapped.events.some((event) => event.type === "turn.completed")) {
            yield { type: "turn.completed" };
          }
        }
      }
    } finally {
      this.activeTurnId = "";
    }
  }

  async readAccount(force = false): Promise<{ account: ChatCodexAccountState; models: ChatCodexModel[] }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const connection = this.ensureConnection();
        await this.ensureInitialized(connection);
        const [accountResponse, rateLimitResponse, modelResponse] = await Promise.all([
          connection.request("account/read", { refreshToken: force }),
          connection.request("account/rateLimits/read"),
          connection.request("model/list", { includeHidden: false })
        ]);
        return {
          account: codexAccountFromResponses(accountResponse, rateLimitResponse),
          models: codexModelsFromResponse(modelResponse)
        };
      } catch (error) {
        this.close();
        if (attempt === 1) {
          throw error;
        }
      }
    }
    throw new Error("Codex account read failed.");
  }

  async steerCurrentTurn(options: { text: string; imagePaths?: string[] }): Promise<void> {
    if (!this.connection || !this.activeThreadId || !this.activeTurnId) {
      throw new Error("Codex steering requires an active turn.");
    }
    const input = codexInputItemsFrom(options.text, options.imagePaths ?? []);
    if (input.length === 0) {
      throw new Error("Cannot steer with an empty message.");
    }
    await this.connection.request("turn/steer", {
      threadId: this.activeThreadId,
      input,
      expectedTurnId: this.activeTurnId
    });
  }

  answerApproval(approvalId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel"): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || !this.connection) {
      throw new Error(`Unknown Codex approval id: ${approvalId}`);
    }
    this.pendingApprovals.delete(approvalId);
    const payload = { decision };
    this.connection.respond(pending.rpcId, payload);
  }

  answerUserInput(requestId: string, answers: Record<string, string>): void {
    const pending = this.pendingUserInputs.get(requestId);
    if (!pending || !this.connection) {
      throw new Error(`Unknown Codex user input request: ${requestId}`);
    }
    this.pendingUserInputs.delete(requestId);
    this.connection.respond(pending.rpcId, {
      answers: Object.fromEntries(
        Object.entries(answers)
          .filter(([key, value]) => key.trim() && value.trim())
          .map(([key, value]) => [key, { answers: [value] }])
      )
    });
  }

  cancelActiveRequest(): void {
    if (!this.connection || !this.activeThreadId || !this.activeTurnId) {
      return;
    }
    void this.connection.request("turn/interrupt", {
      threadId: this.activeThreadId,
      turnId: this.activeTurnId
    }).catch(() => undefined);
    this.activeTurnId = "";
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
    this.initialized = false;
  }

  private ensureConnection(): JsonRpcAppServerConnection {
    if (!this.connection) {
      this.connection = new JsonRpcAppServerConnection();
    }
    return this.connection;
  }

  private async ensureInitialized(connection: JsonRpcAppServerConnection): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await connection.request("initialize", {
        clientInfo: { name: "UNIT-0", version: "0.0.0" }
      }, 60000);
      this.initialized = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async startThread(connection: JsonRpcAppServerConnection, options: CodexRunOptions): Promise<string> {
    const response = await connection.request("thread/start", {
      cwd: options.cwd,
      model: options.model,
      baseInstructions: options.baseInstructions?.trim() || undefined,
      approvalPolicy: effectiveCodexApprovalPolicy(options)
    });
    const thread = response.thread;
    const id = isRecord(thread) ? String(thread.id ?? "") : "";
    if (!id) {
      throw new Error("Codex thread/start response missing thread id.");
    }
    return id;
  }

  private async resumeThread(connection: JsonRpcAppServerConnection, options: CodexRunOptions): Promise<string> {
    const response = await connection.request("thread/resume", {
      threadId: options.resumeThreadId,
      cwd: options.cwd,
      model: options.model,
      baseInstructions: options.baseInstructions?.trim() || undefined,
      approvalPolicy: effectiveCodexApprovalPolicy(options)
    });
    const thread = response.thread;
    const id = isRecord(thread) ? String(thread.id ?? options.resumeThreadId ?? "") : options.resumeThreadId ?? "";
    if (!id) {
      throw new Error("Codex thread/resume response missing thread id.");
    }
    return id;
  }

  private mapAppServerMessage(message: JsonRpcMessage, threadId: string, turnId: string): { events: CodexThreadEvent[]; completed: boolean } {
    const method = message.method ?? "";
    const params = message.params ?? {};
    const messageThreadId = String(params.threadId ?? "");
    const messageTurnId = String(params.turnId ?? "");
    if (messageThreadId && messageThreadId !== threadId) {
      return { events: [], completed: false };
    }
    if (messageTurnId && messageTurnId !== turnId) {
      return { events: [], completed: false };
    }
    if (method === "turn/completed") {
      return {
        events: [{ type: "turn.completed", usage: isRecord(params.usage) ? params.usage : isRecord(params.tokenUsage) ? params.tokenUsage : undefined }],
        completed: true
      };
    }
    if (method === "thread/tokenUsage/updated") {
      return {
        events: [{ type: "turn.completed", usage: isRecord(params.usage) ? params.usage : isRecord(params.tokenUsage) ? params.tokenUsage : params }],
        completed: false
      };
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const id = String(message.id ?? "");
      this.pendingApprovals.set(id, { rpcId: message.id ?? id, method });
      return {
        completed: false,
        events: [{
          type: "item.started",
          item: {
            id,
            type: "approval_request",
            status: "requested",
            title: method === "item/commandExecution/requestApproval" ? "Approve command execution" : "Approve file change",
            details: [params.reason, params.command, params.cwd].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n"),
            request_method: method,
            tool_call_id: String(params.itemId ?? "")
          }
        }]
      };
    }
    if (method === "item/tool/requestUserInput") {
      const id = String(message.id ?? "");
      this.pendingUserInputs.set(id, { rpcId: message.id ?? id });
      const questions = parseQuestions(params.questions);
      return {
        completed: false,
        events: [{
          type: "item.started",
          item: {
            id,
            type: "user_question",
            status: "requested",
            title: "Input requested",
            question: questions.map((question) => question.label).join("\n"),
            questions
          }
        }]
      };
    }
    if (method === "item/agentMessage/delta") {
      return { completed: false, events: [{ type: "item.updated", item: { id: String(params.itemId ?? "assistant"), type: "agent_message", text: String(params.delta ?? "") } }] };
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/summaryPartAdded") {
      const baseId = String(params.itemId ?? "reasoning");
      const summaryIndex = Number(params.summaryIndex);
      const sectionKey = method === "item/reasoning/textDelta" || !Number.isInteger(summaryIndex) ? baseId : `${baseId}:summary:${summaryIndex}`;
      const text = String(params.delta ?? "");
      return { completed: false, events: [{ type: "item.updated", item: { id: baseId, type: "reasoning", section_key: sectionKey, text, sections: method === "item/reasoning/summaryPartAdded" ? [{ key: sectionKey, text }] : undefined } }] };
    }
    if (method === "item/commandExecution/outputDelta") {
      return { completed: false, events: [{ type: "item.updated", item: { id: String(params.itemId ?? "command"), type: "command_execution", aggregated_output: String(params.delta ?? ""), status: "in_progress" } }] };
    }
    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      return {
        completed: false,
        events: [{
          type: "item.updated",
          item: {
            id: `${threadId}:${turnId}:plan`,
            type: "todo_list",
            status: "in_progress",
            items: plan.map((item) => isRecord(item) ? { text: String(item.step ?? ""), status: String(item.status ?? "") } : { text: "", status: "" })
          }
        }]
      };
    }
    if (method === "turn/diff/updated" || method === "item/fileChange/outputDelta") {
      return { completed: false, events: [{ type: "item.updated", item: { id: String(params.itemId ?? `${threadId}:${turnId}:diff`), type: "file_change", summary: "Updated diff", diff: String(params.diff ?? params.delta ?? ""), status: "updated" } }] };
    }
    if (method === "item/started" && isRecord(params.item)) {
      return { completed: false, events: codexAppServerItemEvents("item.started", params.item) };
    }
    if (method === "item/completed" && isRecord(params.item)) {
      return { completed: false, events: codexAppServerItemEvents("item.completed", params.item) };
    }
    if (method === "thread/compacted") {
      return { completed: false, events: [{ type: "item.completed", item: { id: `${threadId}:${turnId}:compaction`, type: "status", level: "info", message: "Context compacted.", code: "context_compacted" } }] };
    }
    return { events: [], completed: false };
  }
}

export function codexTurnStartPayload(threadId: string, options: CodexRunOptions): Record<string, unknown> {
  return {
    threadId,
    input: codexInputItems(options),
    model: options.model,
    effort: options.reasoningEffort,
    approvalPolicy: effectiveCodexApprovalPolicy(options),
    sandboxPolicy: options.permissionMode === "full_access" ? { type: "dangerFullAccess" } : undefined,
    collaborationMode: collaborationModePayload(options)
  };
}

export class CodexCliRuntime implements CodexRuntime {
  private activeProcess: ChildProcessWithoutNullStreams | null = null;

  async readAccount(): Promise<{ account: ChatCodexAccountState; models: ChatCodexModel[] }> {
    throw new Error("Codex account state requires the Codex app-server runtime.");
  }

  async *runTurn(options: CodexRunOptions): AsyncIterable<CodexThreadEvent> {
    if (this.activeProcess) {
      throw new Error("A Codex request is already running.");
    }
    const command = buildCodexExecCommand(options);
    const child = spawn(command.command, command.args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      windowsHide: true
    });
    this.activeProcess = child;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        yield parseCodexJsonLine(line);
      }
      const exitCode = await waitForExit(child);
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `Codex CLI exited with code ${exitCode}.`);
      }
    } finally {
      rl.close();
      if (this.activeProcess === child) {
        this.activeProcess = null;
      }
    }
  }

  async steerCurrentTurn(): Promise<void> {
    throw new Error("Codex steering requires the Codex app-server runtime.");
  }

  cancelActiveRequest(): void {
    this.activeProcess?.kill();
    this.activeProcess = null;
  }

  answerApproval(_approvalId: string, _decision: "accept" | "acceptForSession" | "decline" | "cancel"): void {
    throw new Error("Codex approval actions require the Codex app-server runtime.");
  }

  answerUserInput(_requestId: string, _answers: Record<string, string>): void {
    throw new Error("Codex user input actions require the Codex app-server runtime.");
  }

  close(): void {
    this.cancelActiveRequest();
  }
}

export function buildCodexExecCommand(options: CodexRunOptions): { command: string; args: string[] } {
  const args = ["exec", "--json", "--model", options.model, "-c", `model_reasoning_effort=${options.reasoningEffort}`];
  for (const imagePath of options.imagePaths ?? []) {
    args.push("--image", imagePath);
  }
  if (options.permissionMode !== "full_access" && options.approvalMode !== "default") {
    args.push("-c", `approval_policy=${options.approvalMode}`);
  }
  if (options.permissionMode === "full_access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push(options.prompt);
  return { command: "codex", args };
}

export function parseCodexJsonLine(line: string): CodexThreadEvent {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Codex JSONL event is missing a type.");
  }
  const event = parsed as CodexThreadEvent;
  if (!isCodexThreadEvent(event)) {
    throw new Error(`Unsupported Codex JSONL event: ${(parsed as { type?: unknown }).type}`);
  }
  return event;
}

export function codexItemToTimelineBlock(eventType: CodexThreadEvent["type"], item: CodexThreadItem): ChatTimelineBlock | null {
  const id = item.id ?? `${item.type}-${eventType}`;
  const itemStatus = "status" in item ? item.status : undefined;
  const status = itemStatus ?? (eventType === "item.completed" ? "completed" : eventType === "item.started" ? "started" : "updated");
  if (item.type === "command_execution") {
    return {
      kind: "tool",
      id,
      toolName: "command",
      status,
      command: item.command,
      directory: item.directory,
      output: item.aggregated_output,
      summary: item.exit_code === null || item.exit_code === undefined ? item.command : `${item.command ?? "Command"} exited ${item.exit_code}`,
      initiallyExpanded: item.initiallyExpanded
    };
  }
  if (item.type === "file_change") {
    return {
      kind: "diff",
      id,
      status,
      summary: item.summary ?? item.path ?? "File change",
      preview: item.diff,
      addedLines: item.added_lines,
      deletedLines: item.deleted_lines,
      filesChanged: item.files_changed,
      changes: item.changes,
      initiallyExpanded: item.initiallyExpanded
    };
  }
  if (item.type === "mcp_tool_call") {
    return {
      kind: "tool",
      id,
      toolName: item.tool_name ?? "mcp",
      status,
      output: typeof item.result === "string" ? item.result : item.result ? JSON.stringify(item.result) : undefined
    };
  }
  if (item.type === "web_search") {
    return {
      kind: "tool",
      id,
      toolName: "web_search",
      status,
      summary: item.query
    };
  }
  if (item.type === "todo_list") {
    return {
      kind: "plan",
      id,
      status,
      steps: item.items?.map((entry) => ({ status: entry.status ?? "pending", text: entry.text ?? "" })).filter((entry) => entry.text)
    };
  }
  if (item.type === "approval_request") {
    return {
      kind: "approval",
      id,
      status,
      title: item.title ?? "Approval required",
      details: item.details,
      requestMethod: item.request_method,
      toolCallId: item.tool_call_id
    };
  }
  if (item.type === "user_question") {
    return {
      kind: "question",
      id,
      status,
      title: item.title ?? "Input requested",
      question: item.question,
      questions: item.questions,
      answers: item.answers
    };
  }
  if (item.type === "status") {
    return {
      kind: "status",
      id,
      level: item.level ?? "info",
      message: item.message ?? "",
      code: item.code,
      initiallyExpanded: item.initiallyExpanded
    };
  }
  if (item.type === "error") {
    return {
      kind: "status",
      id,
      level: "error",
      message: item.message ?? "Codex reported an error."
    };
  }
  return null;
}

function codexInputItems(options: CodexRunOptions): Array<Record<string, unknown>> {
  return codexInputItemsFrom(options.prompt, options.imagePaths ?? []);
}

export function collaborationModePayload(options: CodexRunOptions): Record<string, unknown> {
  return {
    mode: options.planModeEnabled ? "plan" : "default",
    settings: {
      model: options.model,
      developer_instructions: options.planModeEnabled ? PLAN_COLLABORATION_INSTRUCTIONS : DEFAULT_COLLABORATION_INSTRUCTIONS,
      reasoning_effort: options.reasoningEffort ?? null
    }
  };
}

function codexInputItemsFrom(prompt: string, imagePaths: string[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (prompt.trim()) {
    items.push({ type: "text", text: prompt.trim() });
  }
  for (const imagePath of imagePaths) {
    items.push({ type: "localImage", path: imagePath });
  }
  return items;
}

export function codexAppServerItemEvents(type: Extract<CodexThreadEvent["type"], "item.started" | "item.completed">, item: Record<string, unknown>): CodexThreadEvent[] {
  const itemType = String(item.type ?? "");
  const id = String(item.id ?? item.itemId ?? `${itemType}-${type}`);
  const initiallyExpanded = codexInitiallyExpanded(item);
  const status = String(item.status ?? (type === "item.completed" ? "completed" : "started"));
  if (itemType === "commandExecution") {
    return [{
      type,
      item: {
        id,
        type: "command_execution",
        command: String(item.command ?? ""),
        directory: String(item.cwd ?? item.directory ?? ""),
        aggregated_output: String(item.aggregatedOutput ?? item.aggregated_output ?? item.output ?? ""),
        exit_code: typeof item.exitCode === "number" ? item.exitCode : typeof item.exit_code === "number" ? item.exit_code : null,
        status,
        initiallyExpanded
      }
    }];
  }
  if (itemType === "fileChange") {
    const structured = structuredFileChangeDetails(item.changes);
    const diff = fileChangeDiffText(item, structured.preview);
    const hasPatchText = typeof item.diff === "string" || typeof item.delta === "string" || typeof item.patch === "string";
    const counts = hasPatchText ? countDiffLines(diff) : { added: structured.addedLines, deleted: structured.deletedLines };
    return [{
      type,
      item: {
        id,
        type: "file_change",
        path: typeof item.path === "string" ? item.path : undefined,
        summary: String(item.summary ?? item.path ?? "File change"),
        diff,
        added_lines: numericField(item.addedLines, item.added_lines) ?? counts.added,
        deleted_lines: numericField(item.deletedLines, item.deleted_lines) ?? counts.deleted,
        files_changed: numericField(item.filesChanged, item.files_changed) ?? structured.filesChanged,
        changes: structured.changes,
        status,
        initiallyExpanded
      }
    }];
  }
  if (itemType === "mcpToolCall") {
    return [{ type, item: { id, type: "mcp_tool_call", tool_name: [item.server, item.tool].map((value) => String(value ?? "")).filter(Boolean).join(":") || "mcp", result: item.result, status } }];
  }
  if (itemType === "assistantMessage") {
    return [{ type, item: { id, type: "agent_message", text: String(item.text ?? item.content ?? ""), initiallyExpanded } }];
  }
  if (itemType === "reasoning") {
    const summarySections = reasoningSectionsFromValue(item.summary, id, "summary");
    const contentSections = reasoningSectionsFromValue(item.content, id, "content");
    const sections = summarySections.length > 0 ? summarySections : contentSections;
    const text = sections.length > 0
      ? sections.map((section) => section.text.trim()).filter(Boolean).join("\n\n")
      : String(item.text ?? item.summary ?? item.content ?? "");
    return [{ type, item: { id, type: "reasoning", text, sections: sections.length > 0 ? sections : undefined, initiallyExpanded } }];
  }
  return [{ type, item: { id, type: "status", level: "info", message: itemType || "Codex event" } }];
}

function reasoningSectionsFromValue(value: unknown, id: string, fieldName: "summary" | "content"): ChatTimelineReasoningSection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const text = isRecord(entry)
      ? String(entry.text ?? entry.content ?? entry.summary ?? "")
      : String(entry ?? "");
    const defaultKey = fieldName === "content" && index === 0 ? id : `${id}:${fieldName}:${index}`;
    const key = isRecord(entry)
      ? String(entry.id ?? entry.key ?? defaultKey)
      : defaultKey;
    return { key, text };
  });
}

function codexInitiallyExpanded(item: Record<string, unknown>): boolean | undefined {
  const direct = item.codex_initially_expanded ?? item.initiallyExpanded ?? item.initially_expanded;
  if (typeof direct === "boolean") {
    return direct;
  }
  const extraPayload = isRecord(item.extra_payload) ? item.extra_payload : isRecord(item.extraPayload) ? item.extraPayload : null;
  const nested = extraPayload?.codex_initially_expanded;
  return typeof nested === "boolean" ? nested : undefined;
}

function fileChangeDiffText(item: Record<string, unknown>, structuredPreview = ""): string {
  if (typeof item.diff === "string") {
    return item.diff;
  }
  if (typeof item.delta === "string") {
    return item.delta;
  }
  if (typeof item.patch === "string") {
    return item.patch;
  }
  return structuredPreview;
}

function countDiffLines(diff: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deleted += 1;
    }
  }
  return { added, deleted };
}

function numericField(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function structuredFileChangeDetails(value: unknown): {
  preview: string;
  addedLines: number;
  deletedLines: number;
  filesChanged: number;
  changes: ChatTimelineFileChange[] | undefined;
} {
  if (!Array.isArray(value)) {
    return { preview: "", addedLines: 0, deletedLines: 0, filesChanged: 0, changes: undefined };
  }
  const changes: ChatTimelineFileChange[] = [];
  const previewLines: string[] = [];
  let addedLines = 0;
  let deletedLines = 0;
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      return;
    }
    const path = textField(entry.path, entry.file, entry.filePath, entry.relativePath);
    const kind = textField(entry.kind, entry.type, entry.action, entry.status) ?? "modified";
    const summary = textField(entry.summary, entry.description);
    const added = numericField(entry.addedLines, entry.added_lines, entry.additions) ?? 0;
    const deleted = numericField(entry.deletedLines, entry.deleted_lines, entry.deletions) ?? 0;
    addedLines += added;
    deletedLines += deleted;
    changes.push({ path, kind, summary, addedLines: added, deletedLines: deleted });
    const label = path || summary || `change-${index + 1}`;
    const countSuffix = added || deleted ? ` (+${added} -${deleted})` : "";
    previewLines.push(`${kind}: ${label}${countSuffix}`);
  });
  return {
    preview: previewLines.join("\n"),
    addedLines,
    deletedLines,
    filesChanged: changes.length,
    changes: changes.length ? changes : undefined
  };
}

function textField(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function parseQuestions(value: unknown): Array<{ id: string; label: string; options?: string[]; allowsCustomAnswer?: boolean }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const questions: Array<{ id: string; label: string; options?: string[]; allowsCustomAnswer?: boolean }> = [];
  value.forEach((raw, index) => {
      if (!isRecord(raw)) {
        return;
      }
      const id = String(raw.id ?? raw.questionId ?? `question-${index + 1}`);
      const label = String(raw.label ?? raw.question ?? raw.prompt ?? "").trim();
      const rawOptions = Array.isArray(raw.options) ? raw.options : [];
      const options = rawOptions.map((option) => isRecord(option) ? String(option.label ?? option.value ?? "") : String(option)).filter(Boolean);
      if (label) {
        questions.push({ id, label, options, allowsCustomAnswer: Boolean(raw.allowsCustomAnswer ?? raw.allowCustomAnswer) });
      }
    });
  return questions;
}

function codexAccountFromResponses(accountResponse: Record<string, unknown>, rateLimitResponse: Record<string, unknown>): ChatCodexAccountState {
  const account = isRecord(accountResponse.account) ? accountResponse.account : null;
  const requiresOpenaiAuth = Boolean(accountResponse.requiresOpenaiAuth);
  if (!account) {
    return requiresOpenaiAuth
      ? { status: "error", error: "Codex requires OpenAI authentication." }
      : { status: "ready", authMode: null, email: "", planType: null, requiresOpenaiAuth, rateLimits: codexRateLimitsFromResponse(rateLimitResponse) };
  }
  return {
    status: "ready",
    authMode: String(account.type ?? accountResponse.authMode ?? ""),
    email: String(account.email ?? ""),
    planType: typeof account.planType === "string" ? account.planType : typeof accountResponse.planType === "string" ? accountResponse.planType : null,
    requiresOpenaiAuth,
    rateLimits: codexRateLimitsFromResponse(rateLimitResponse)
  };
}

function codexModelsFromResponse(modelResponse: Record<string, unknown>): ChatCodexModel[] {
  const rawModels = Array.isArray(modelResponse.models)
    ? modelResponse.models
    : Array.isArray(modelResponse.availableModels)
      ? modelResponse.availableModels
      : Array.isArray(modelResponse.data)
        ? modelResponse.data
        : [];
  const models = rawModels
    .filter(isRecord)
    .map((model, index) => {
      const id = String(model.id ?? model.model ?? model.name ?? "").trim();
      const label = String(model.displayName ?? model.name ?? model.label ?? id).trim();
      const rawEfforts = Array.isArray(model.reasoningEfforts)
        ? model.reasoningEfforts
        : Array.isArray(model.reasoning_efforts)
          ? model.reasoning_efforts
          : Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
            : [];
      const reasoningEfforts = rawEfforts
        .map((effort) => isRecord(effort) ? String(effort.reasoningEffort ?? effort.id ?? effort.value ?? "").toLowerCase() : String(effort).toLowerCase())
        .filter((effort): effort is ChatReasoningEffort => effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh");
      const inputModalities = Array.isArray(model.inputModalities) ? model.inputModalities.map((value) => String(value)) : [];
      return id ? {
        id,
        label: label || id,
        isDefault: Boolean(model.isDefault ?? model.default ?? index === 0),
        reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : ["low", "medium", "high"],
        supportsImageInput: inputModalities.length > 0 ? inputModalities.includes("image") : model.supportsImageInput !== false
      } : null;
    })
    .filter((model): model is ChatCodexModel => Boolean(model));
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0] = { ...models[0], isDefault: true };
  }
  return models;
}

export function codexRateLimitsFromResponse(rateLimitResponse: Record<string, unknown>): ChatCodexRateLimits | null {
  const byLimitId = isRecord(rateLimitResponse.rateLimitsByLimitId) ? rateLimitResponse.rateLimitsByLimitId : null;
  if (byLimitId && isRecord(byLimitId.codex)) {
    return parseRateLimits(byLimitId.codex);
  }
  const singleBucket = isRecord(rateLimitResponse.rateLimits) ? rateLimitResponse.rateLimits : null;
  if (!singleBucket) {
    return null;
  }
  const limitId = singleBucket.limitId;
  if (limitId !== undefined && limitId !== null && String(limitId) !== "codex") {
    return null;
  }
  return parseRateLimits(singleBucket);
}

function parseRateLimits(value: unknown): ChatCodexRateLimits | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    primary: parseRateLimitWindow(value.primary),
    secondary: parseRateLimitWindow(value.secondary),
    rateLimitReachedType: typeof value.rateLimitReachedType === "string" ? value.rateLimitReachedType : null
  };
}

function parseRateLimitWindow(value: unknown): ChatCodexRateLimits["primary"] {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = Number(value.usedPercent);
  const windowDurationMins = Number(value.windowDurationMins);
  const resetsAt = Number(value.resetsAt);
  return {
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0,
    windowDurationMins: Number.isFinite(windowDurationMins) ? windowDurationMins : 0,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0
  };
}

function resolveCodexCommand(): string {
  const explicitPath = process.env.CODEX_CLI_PATH?.trim();
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (isExecutableFile(resolved)) {
      return resolved;
    }
    throw new Error(`CODEX_CLI_PATH does not point to an executable Codex CLI: ${resolved}`);
  }

  const candidates = process.platform === "win32"
    ? [
        path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin", "codex.exe"),
        path.join(os.homedir(), "AppData", "Roaming", "npm", "codex.cmd")
      ]
    : [];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  const pathCommand = findCodexCommandOnPath();
  if (pathCommand) {
    return pathCommand;
  }

  throw new Error("Codex CLI executable was not found. Install Codex or set CODEX_CLI_PATH to the Codex executable.");
}

function findCodexCommandOnPath(): string | null {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  const commandNames = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim();
    if (!directory) {
      continue;
    }
    for (const commandName of commandNames) {
      const candidate = path.join(directory, commandName);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCodexThreadEvent(event: CodexThreadEvent): boolean {
  if (event.type === "thread.started") {
    return typeof event.thread_id === "string";
  }
  if (event.type === "turn.started" || event.type === "turn.completed") {
    return true;
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return true;
  }
  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    return Boolean(event.item && typeof event.item === "object" && "type" in event.item);
  }
  return false;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
