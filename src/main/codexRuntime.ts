import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { ChatCodexAccountState, ChatCodexApprovalMode, ChatCodexModel, ChatCodexRateLimits, ChatReasoningEffort, ChatTimelineBlock } from "../shared/types.js";

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
  | { id?: string; type: "agent_message"; text?: string }
  | { id?: string; type: "reasoning"; text?: string }
  | { id?: string; type: "command_execution"; command?: string; aggregated_output?: string; exit_code?: number | null; status?: string }
  | { id?: string; type: "file_change"; path?: string; summary?: string; diff?: string; status?: string }
  | { id?: string; type: "mcp_tool_call"; tool_name?: string; arguments?: unknown; result?: unknown; status?: string }
  | { id?: string; type: "web_search"; query?: string; status?: string }
  | { id?: string; type: "todo_list"; items?: Array<{ text?: string; status?: string }>; status?: string }
  | { id?: string; type: "approval_request"; title?: string; details?: string; status?: string; request_method?: string; tool_call_id?: string }
  | { id?: string; type: "user_question"; title?: string; question?: string; status?: string; questions?: Array<{ id: string; label: string; options?: string[]; allowsCustomAnswer?: boolean }>; answers?: Record<string, string> }
  | { id?: string; type: "status"; level?: string; message?: string; code?: string }
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
    yield {
      type: "item.completed",
      item: {
        id: "mock-reasoning",
        type: "reasoning",
        text: `Using ${options.model} with ${options.reasoningEffort} reasoning, ${options.approvalMode} approvals, and ${options.imagePaths?.length ?? 0} image attachment(s) in mocked Codex mode.\n`
      }
    };
    yield {
      type: "item.started",
      item: { id: "mock-command", type: "command_execution", command: "npm test", aggregated_output: "", exit_code: null, status: "in_progress" }
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
  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    this.values.push(value);
  }

  shift(timeoutMs = 60000): Promise<T> {
    const value = this.values.shift();
    if (value) {
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(resolve);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("Timed out waiting for Codex app-server events."));
      }, timeoutMs);
      this.waiters.push((nextValue) => {
        clearTimeout(timer);
        resolve(nextValue);
      });
    });
  }
}

class JsonRpcAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly notifications = new AsyncMessageQueue<JsonRpcMessage>();
  private readonly responses = new Map<string, { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextRequestId = 1;
  private stderr = "";

  constructor(command = "codex") {
    this.child = spawn(command, ["app-server"], {
      env: process.env,
      windowsHide: true
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
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const id = this.nextRequestId++;
    const payload = { jsonrpc: "2.0", id, method, params };
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
    const turn = await connection.request("turn/start", {
      threadId,
      input: codexInputItems(options),
      model: options.model,
      effort: options.reasoningEffort,
      approvalPolicy: options.approvalMode === "default" ? undefined : options.approvalMode,
      sandboxPolicy: options.permissionMode === "full_access" ? { type: "dangerFullAccess" } : undefined,
      collaborationMode: collaborationModePayload(options)
    });
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
    const connection = this.ensureConnection();
    await this.ensureInitialized(connection);
    const [accountResponse, rateLimitResponse, modelResponse] = await Promise.all([
      connection.request("account/read", { refreshToken: force }),
      connection.request("account/rateLimits/read", {}),
      connection.request("model/list", { includeHidden: false })
    ]);
    return {
      account: codexAccountFromResponses(accountResponse, rateLimitResponse),
      models: codexModelsFromResponse(modelResponse)
    };
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
    await connection.request("initialize", {
      clientInfo: { name: "UNIT-0", version: "0.0.0" }
    });
    this.initialized = true;
  }

  private async startThread(connection: JsonRpcAppServerConnection, options: CodexRunOptions): Promise<string> {
    const response = await connection.request("thread/start", {
      cwd: options.cwd,
      model: options.model,
      baseInstructions: options.baseInstructions?.trim() || undefined,
      approvalPolicy: options.approvalMode === "default" ? undefined : options.approvalMode
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
      approvalPolicy: options.approvalMode === "default" ? undefined : options.approvalMode
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
      return { completed: false, events: [{ type: "item.updated", item: { id: String(params.itemId ?? "reasoning"), type: "reasoning", text: String(params.delta ?? "") } }] };
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
      return { completed: false, events: [codexAppServerItemEvent("item.started", params.item)] };
    }
    if (method === "item/completed" && isRecord(params.item)) {
      return { completed: false, events: [codexAppServerItemEvent("item.completed", params.item)] };
    }
    if (method === "thread/compacted") {
      return { completed: false, events: [{ type: "item.completed", item: { id: `${threadId}:${turnId}:compaction`, type: "status", level: "info", message: "Context compacted.", code: "context_compacted" } }] };
    }
    return { events: [], completed: false };
  }
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
  if (options.approvalMode !== "default") {
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
  const status = eventType === "item.completed" ? "completed" : eventType === "item.started" ? "started" : itemStatus ?? "updated";
  if (item.type === "command_execution") {
    return {
      kind: "tool",
      id,
      toolName: "command",
      status,
      command: item.command,
      output: item.aggregated_output,
      summary: item.exit_code === null || item.exit_code === undefined ? item.command : `${item.command ?? "Command"} exited ${item.exit_code}`
    };
  }
  if (item.type === "file_change") {
    return {
      kind: "diff",
      id,
      status,
      summary: item.summary ?? item.path ?? "File change",
      preview: item.diff
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
      code: item.code
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

function codexAppServerItemEvent(type: Extract<CodexThreadEvent["type"], "item.started" | "item.completed">, item: Record<string, unknown>): CodexThreadEvent {
  const itemType = String(item.type ?? "");
  const id = String(item.id ?? item.itemId ?? `${itemType}-${type}`);
  if (itemType === "commandExecution") {
    return { type, item: { id, type: "command_execution", command: String(item.command ?? ""), status: type === "item.completed" ? "completed" : "started" } };
  }
  if (itemType === "fileChange") {
    return { type, item: { id, type: "file_change", summary: "File change", diff: JSON.stringify(item.changes ?? ""), status: type === "item.completed" ? "completed" : "started" } };
  }
  if (itemType === "mcpToolCall") {
    return { type, item: { id, type: "mcp_tool_call", tool_name: [item.server, item.tool].map((value) => String(value ?? "")).filter(Boolean).join(":") || "mcp", result: item.result, status: type === "item.completed" ? "completed" : "started" } };
  }
  if (itemType === "assistantMessage") {
    return { type, item: { id, type: "agent_message", text: String(item.text ?? item.content ?? "") } };
  }
  if (itemType === "reasoning") {
    return { type, item: { id, type: "reasoning", text: String(item.text ?? item.summary ?? "") } };
  }
  return { type, item: { id, type: "status", level: "info", message: itemType || "Codex event" } };
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
      : { status: "ready", authMode: null, email: "", planType: null, requiresOpenaiAuth, rateLimits: parseRateLimits(rateLimitResponse.rateLimits) };
  }
  return {
    status: "ready",
    authMode: String(account.type ?? accountResponse.authMode ?? ""),
    email: String(account.email ?? ""),
    planType: typeof account.planType === "string" ? account.planType : typeof accountResponse.planType === "string" ? accountResponse.planType : null,
    requiresOpenaiAuth,
    rateLimits: parseRateLimits(rateLimitResponse.rateLimits)
  };
}

function codexModelsFromResponse(modelResponse: Record<string, unknown>): ChatCodexModel[] {
  const rawModels = Array.isArray(modelResponse.models) ? modelResponse.models : Array.isArray(modelResponse.availableModels) ? modelResponse.availableModels : [];
  const models = rawModels
    .filter(isRecord)
    .map((model, index) => {
      const id = String(model.id ?? model.model ?? model.name ?? "").trim();
      const label = String(model.name ?? model.label ?? model.displayName ?? id).trim();
      const rawEfforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : Array.isArray(model.reasoning_efforts) ? model.reasoning_efforts : [];
      const reasoningEfforts = rawEfforts
        .map((effort) => String(effort).toLowerCase())
        .filter((effort): effort is ChatReasoningEffort => effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh");
      return id ? {
        id,
        label: label || id,
        isDefault: Boolean(model.isDefault ?? model.default ?? index === 0),
        reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : ["low", "medium", "high"],
        supportsImageInput: model.supportsImageInput !== false
      } : null;
    })
    .filter((model): model is ChatCodexModel => Boolean(model));
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0] = { ...models[0], isDefault: true };
  }
  return models;
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
