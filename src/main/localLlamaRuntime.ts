import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChatBuiltinAgenticFramework, ChatMessage, ChatModel, ChatRuntimeSettings } from "../shared/types.js";

const GPTOSS_END_MARKER = "<|end|>";
const GPTOSS_CALL_MARKER = "<|call|>";
const GPTOSS_RETURN_MARKER = "<|return|>";
const GPTOSS_CHANNEL_TERMINATORS = [GPTOSS_END_MARKER, GPTOSS_CALL_MARKER, GPTOSS_RETURN_MARKER];
const DOCUMENT_ANALYSIS_TOOL_RESULT_PREFIX = "Tool result:\n";
const GPTOSS_SYSTEM_PROMPT = [
  "You are ChatGPT, a large language model trained by OpenAI.",
  "Knowledge cutoff: 2024-06",
  "Current date: {current_date}",
  "",
  "Reasoning: {reasoning_effort}",
  "",
  "# Valid channels: analysis, commentary, final. Channel must be included for every message.",
  "No tools or external recipients are available in this chat.",
  "Do not emit commentary to tools, files, browsers, functions, repo_browser, or any recipient other than final.",
  "After reasoning, respond to the user in final, or use commentary to=final only when a constrained final format is required."
].join("\n");
const GPTOSS_DOCUMENT_ANALYSIS_SYSTEM_PROMPT = [
  "You are ChatGPT, a large language model trained by OpenAI.",
  "Knowledge cutoff: 2024-06",
  "Current date: {current_date}",
  "",
  "Reasoning: {reasoning_effort}",
  "",
  "# Valid channels: analysis, commentary, final. Channel must be included for every message.",
  "In document analysis mode, commentary may target only the host-managed tool recipients `search` and `modify_results`.",
  "This framework is for analyzing one selected indexed document index or corpus, which may contain multiple PDFs.",
  "{document_title_line}You have exactly two host-managed tools available for that selected corpus: `search` and `modify_results`.",
  "The host calls tools. The user never calls tools directly.",
  "Any later `Tool result:` message is host-injected search output, not user-authored input.",
  "Do not ask the user to wrap queries in `<tool_call>`, and do not suggest that they need to use the tool themselves.",
  "For questions about the selected document's contents, retrieve evidence with `search` before answering. This includes PDFs inside the selected document index.",
  "Use `modify_results` only to refine the latest tool result by dropping weak hits or expanding a promising hit with adjacent same-source chunks.",
  "For meta questions about this framework, the system prompt, or tool behavior, answer directly without calling `search` unless document evidence is actually needed.",
  "Do not mention the tool unless the user is explicitly asking about capabilities or tool behavior.",
  "Preferred native GPT-OSS tool calls:",
  "Use commentary to=search with constrained JSON arguments, for example {\"query\":\"pdf links\",\"top_k\":8}.",
  "Use commentary to=modify_results with constrained JSON arguments only after a search result exists.",
  "If retrieval is needed, output exactly one of these syntaxes and nothing else in that message:",
  "<tool_call>",
  "{\"tool\":\"search\",\"query\":\"...\", \"top_k\":8}",
  "</tool_call>",
  "<tool_call>",
  "{\"tool\":\"modify_results\",\"drop_result_ids\":[\"r2\"],\"expand\":[{\"result_id\":\"r1\",\"before\":1,\"after\":1}]}",
  "</tool_call>",
  "Emit that `<tool_call>` block in the final channel, not in analysis or reasoning.",
  "Do not put raw tool-call JSON in reasoning.",
  "Never mix tool calls and the final answer in the same message.",
  "If you do not have enough evidence, call `search` first. Narrow later searches instead of repeating broad ones.",
  "After a non-empty relevant search result, answer from that evidence instead of searching again.",
  "Search again only when the result is empty, unrelated, contradictory, missing a specifically requested detail, or the user asked for exhaustive or comparative coverage.",
  "Do not search again merely to find a better citation, exact section title, narrower wording, or additional supporting excerpt.",
  "For simple explanatory prompts like 'tell me about X', one relevant search result is sufficient.",
  "Search results are excerpts, not the full corpus. Use them to ground the answer.",
  "Cite the source PDF filename plus the returned page and section metadata in the final answer.",
  "Do not emit commentary to files, browsers, functions, repo_browser, or any recipient other than final, search, or modify_results."
].join("\n");
const GPTOSS_OPENCODE_SYSTEM_PROMPT = [
  "You are ChatGPT, a large language model trained by OpenAI.",
  "Knowledge cutoff: 2024-06",
  "Current date: {current_date}",
  "",
  "Reasoning: {reasoning_effort}",
  "",
  "# Valid channels: analysis, commentary, final. Channel must be included for every message.",
  "OpenCode mode is for coding work inside the selected project directory.",
  "You may use exactly one host-managed tool recipient: `shell`.",
  "Use shell commands to inspect files, run tests, and make focused edits.",
  "Never claim that you changed or verified something unless the tool output supports it.",
  "Preferred native GPT-OSS tool calls:",
  "Use commentary to=shell with constrained JSON arguments, for example {\"command\":\"rg -n \\\"TODO\\\" src\"}.",
  "If a tool is needed, output exactly one of these syntaxes and nothing else in that message:",
  "<tool_call>",
  "{\"tool\":\"shell\",\"command\":\"rg -n \\\"TODO\\\" src\"}",
  "</tool_call>",
  "Emit that `<tool_call>` block in the final channel, not in analysis or reasoning.",
  "Do not put raw tool-call JSON in reasoning.",
  "Never mix tool calls and the final answer in the same message.",
  "After the host returns a `Tool result:` message, use it to decide the next step.",
  "Do not emit commentary to files, browsers, functions, repo_browser, search, modify_results, or any recipient other than final or shell."
].join("\n");

export class LocalLlamaRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalLlamaRuntimeError";
  }
}

export type LlamaServerCommand = {
  command: string;
  args: string[];
  cwd: string;
};

export type LocalLlamaRuntimeOptions = {
  binaryPath?: string;
  runtimeRoot?: string;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
};

export type LocalLlamaOpenAiEndpoint = {
  baseUrl: string;
  modelId: string;
  rawCompletionUrl?: string;
};

type ServerKey = {
  modelPath: string;
  nCtx: number;
  nGpuLayers: number;
  nativeGptOss: boolean;
};

type ActiveServer = {
  key: ServerKey;
  baseUrl: string;
  modelId: string;
  process: ChildProcess;
  slotSavePath: string;
  activeSlotCacheKey: string;
};

export class LocalLlamaRuntime {
  private activeServer: ActiveServer | null = null;
  private pendingServer: Promise<ActiveServer> | null = null;
  private pendingServerKey: ServerKey | null = null;
  private startingProcess: ChildProcess | null = null;
  private serverGeneration = 0;
  private slotLock: Promise<void> = Promise.resolve();
  private activeAbortController: AbortController | null = null;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: LocalLlamaRuntimeOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 240_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async streamChat(
    options: {
      model: ChatModel;
      settings: ChatRuntimeSettings;
      messages: ChatMessage[];
      onToken: (token: string) => void;
      onReasoning?: (token: string) => void;
      builtinAgenticFramework?: ChatBuiltinAgenticFramework;
      documentTitle?: string;
      cacheKey?: string;
    }
  ): Promise<void> {
    return this.withSlotLock(() => this.streamChatLocked(options));
  }

  private async streamChatLocked(
    options: {
      model: ChatModel;
      settings: ChatRuntimeSettings;
      messages: ChatMessage[];
      onToken: (token: string) => void;
      onReasoning?: (token: string) => void;
      builtinAgenticFramework?: ChatBuiltinAgenticFramework;
      documentTitle?: string;
      cacheKey?: string;
    }
  ): Promise<void> {
    const server = await this.ensureServer(options.model, options.settings);
    await this.restoreSlotIfNeeded(server, options.cacheKey);
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    try {
      const nativeGptOss = isNativeGptOssModel(options.model);
      const gptOssPrompt = nativeGptOss
        ? renderGptOssPrompt(options.messages, options.settings, {
          builtinAgenticFramework: options.builtinAgenticFramework ?? "chat",
          documentTitle: options.documentTitle ?? ""
        })
        : "";
      const response = nativeGptOss
        ? await this.fetchImpl(`${server.baseUrl}/completion`, {
          method: "POST",
          headers: {
            "Accept": "text/event-stream",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            prompt: gptOssPrompt,
            stream: true,
            n_predict: gptOssRequestMaxTokens(gptOssPrompt, options.settings),
            temperature: options.settings.temperature,
            repeat_penalty: options.settings.repeatPenalty,
            cache_prompt: true,
            id_slot: 0
          }),
          signal: abortController.signal
        })
        : await this.fetchImpl(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Accept": "text/event-stream",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: server.modelId,
            messages: localRuntimeMessages(options.settings, options.messages),
            stream: true,
            stream_options: { include_usage: true },
            temperature: options.settings.temperature,
            repeat_penalty: options.settings.repeatPenalty,
            max_tokens: options.settings.maxTokens,
            cache_prompt: true,
            id_slot: 0
          }),
          signal: abortController.signal
        });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LocalLlamaRuntimeError(`Bundled llama-server request failed (${response.status}): ${body || response.statusText}`);
      }
      if (!response.body) {
        throw new LocalLlamaRuntimeError("Bundled llama-server did not return a streaming response body.");
      }
      const channelParser = nativeGptOss ? new GptOssChannelParser({
        toolRecipients: gptOssToolRecipients(options.builtinAgenticFramework ?? "chat")
      }) : null;
      await readServerSentEvents(response.body, (payload) => {
        if (payload === "[DONE]") {
          return;
        }
        if (channelParser) {
          const parsed = JSON.parse(payload) as { content?: unknown };
          const rawText = extractText(parsed.content);
          if (!rawText) {
            return;
          }
          const { content, reasoning } = channelParser.push(rawText);
          if (content) {
            options.onToken(content);
          }
          if (reasoning) {
            options.onReasoning?.(reasoning);
          }
          return;
        }
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; thinking?: unknown } }>;
        };
        const delta = parsed.choices?.[0]?.delta ?? {};
        const content = extractText(delta.content);
        if (content) {
          options.onToken(content);
        }
        const reasoning = extractText(delta.reasoning_content) || extractText(delta.reasoning) || extractText(delta.thinking);
        if (reasoning) {
          options.onReasoning?.(reasoning);
        }
      });
      if (channelParser) {
        const { content, reasoning } = channelParser.finish();
        if (content) {
          options.onToken(content);
        }
        if (reasoning) {
          options.onReasoning?.(reasoning);
        }
      }
      await this.saveSlotIfNeeded(server, options.cacheKey);
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new LocalLlamaRuntimeError("Bundled llama-server request was cancelled.");
      }
      throw error;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  async warmChatSession(options: {
    model: ChatModel;
    settings: ChatRuntimeSettings;
    cacheKey?: string;
    shouldCancel?: () => boolean;
  }): Promise<void> {
    await this.withSlotLock(async () => {
      if (options.shouldCancel?.()) {
        return;
      }
      const server = await this.ensureServer(options.model, options.settings);
      if (options.shouldCancel?.()) {
        return;
      }
      await this.restoreSlotIfNeeded(server, options.cacheKey);
    });
  }

  async openAiEndpoint(options: {
    model: ChatModel;
    settings: ChatRuntimeSettings;
  }): Promise<LocalLlamaOpenAiEndpoint> {
    const server = await this.ensureServer(options.model, options.settings);
    return {
      baseUrl: server.baseUrl,
      modelId: server.modelId,
      rawCompletionUrl: `${server.baseUrl}/completion`
    };
  }

  cancelActiveRequest(): void {
    this.activeAbortController?.abort();
  }

  close(): void {
    this.serverGeneration += 1;
    this.cancelActiveRequest();
    if (this.startingProcess && this.startingProcess.exitCode === null) {
      this.startingProcess.kill();
    }
    this.startingProcess = null;
    if (this.activeServer && this.activeServer.process.exitCode === null) {
      this.activeServer.process.kill();
    }
    this.activeServer = null;
    this.pendingServer = null;
    this.pendingServerKey = null;
  }

  private async ensureServer(model: ChatModel, settings: ChatRuntimeSettings): Promise<ActiveServer> {
    const modelPath = path.resolve(model.path);
    const nativeGptOss = isNativeGptOssModel(model);
    if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile()) {
      throw new LocalLlamaRuntimeError(`Model file not found: ${modelPath}`);
    }
    const key: ServerKey = {
      modelPath,
      nCtx: settings.nCtx,
      nGpuLayers: settings.nGpuLayers,
      nativeGptOss
    };
    if (this.activeServer && serverKeyMatches(this.activeServer.key, key) && this.activeServer.process.exitCode === null) {
      return this.activeServer;
    }
    if (this.pendingServer && this.pendingServerKey && serverKeyMatches(this.pendingServerKey, key)) {
      return this.pendingServer;
    }
    this.close();
    const startGeneration = ++this.serverGeneration;
    this.pendingServerKey = key;
    this.pendingServer = this.startServer(key, settings, startGeneration);
    try {
      this.activeServer = await this.pendingServer;
      return this.activeServer;
    } finally {
      if (this.pendingServerKey && serverKeyMatches(this.pendingServerKey, key)) {
        this.pendingServer = null;
        this.pendingServerKey = null;
      }
    }
  }

  private async startServer(key: ServerKey, settings: ChatRuntimeSettings, startGeneration: number): Promise<ActiveServer> {
    const binaryPath = this.options.binaryPath ? path.resolve(this.options.binaryPath) : resolveBundledLlamaServerBinary(this.options.runtimeRoot);
    if (!binaryPath) {
      throw new LocalLlamaRuntimeError("Bundled llama-server binary was not found. Expected runtime/llama.cpp/llama-server(.exe).");
    }
    if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
      throw new LocalLlamaRuntimeError(`Bundled llama-server binary was not found: ${binaryPath}`);
    }
    const port = await reserveLocalPort();
    this.assertCurrentServerGeneration(startGeneration);
    const slotSavePath = this.slotSavePath(binaryPath);
    const command = buildLlamaServerCommand({
      binaryPath,
      port,
      modelPath: key.modelPath,
      settings,
      nativeGptOss: key.nativeGptOss,
      slotSavePath
    });
    const process = this.spawnImpl(command.command, command.args, {
      cwd: command.cwd,
      windowsHide: true,
      stdio: "ignore"
    } as SpawnOptions);
    this.startingProcess = process;
    if (this.serverGeneration !== startGeneration) {
      if (process.exitCode === null) {
        process.kill();
      }
      throw new LocalLlamaRuntimeError("Bundled llama-server startup was superseded.");
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    const modelId = await this.waitUntilReady(process, baseUrl, binaryPath, startGeneration);
    if (this.startingProcess === process) {
      this.startingProcess = null;
    }
    if (this.serverGeneration !== startGeneration) {
      if (process.exitCode === null) {
        process.kill();
      }
      throw new LocalLlamaRuntimeError("Bundled llama-server startup was superseded.");
    }
    return { key, baseUrl, modelId, process, slotSavePath, activeSlotCacheKey: "" };
  }

  private async waitUntilReady(process: ChildProcess, baseUrl: string, binaryPath: string, startGeneration: number): Promise<string> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = "server did not become ready";
    let pollDelayMs = 100;
    while (Date.now() < deadline) {
      if (process.exitCode !== null) {
        throw new LocalLlamaRuntimeError(`Bundled llama-server exited during startup with code ${process.exitCode}. Binary: ${binaryPath}`);
      }
      this.assertCurrentServerGeneration(startGeneration);
      try {
        const health = await this.fetchJson(`${baseUrl}/health`, 2_000);
        const status = String((health as { status?: unknown }).status ?? "").toLowerCase();
        if (status && status !== "ok") {
          lastError = `health status ${status}`;
          await sleep(pollDelayMs);
          pollDelayMs = Math.min(500, Math.round(pollDelayMs * 1.35));
          continue;
        }
        const models = await this.fetchJson(`${baseUrl}/v1/models`, 3_000);
        const data = (models as { data?: unknown }).data;
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
          const modelId = String((data[0] as { id?: unknown }).id ?? "").trim();
          if (modelId) {
            return modelId;
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(pollDelayMs);
      pollDelayMs = Math.min(500, Math.round(pollDelayMs * 1.35));
    }
    throw new LocalLlamaRuntimeError(`Bundled llama-server startup timed out: ${lastError}`);
  }

  private async fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: abortController.signal });
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private slotSavePath(binaryPath: string): string {
    const slotDir = this.options.runtimeRoot
      ? path.join(path.resolve(this.options.runtimeRoot), "runtime", "llama.cpp", "slots")
      : path.join(path.dirname(binaryPath), "slots");
    fs.mkdirSync(slotDir, { recursive: true });
    return slotDir;
  }

  private async restoreSlotIfNeeded(server: ActiveServer, cacheKey?: string): Promise<void> {
    const normalizedKey = normalizeSlotCacheKey(cacheKey);
    if (!normalizedKey || server.activeSlotCacheKey === normalizedKey) {
      return;
    }
    if (server.activeSlotCacheKey) {
      await this.saveSlot(server, slotCacheFilename(server, server.activeSlotCacheKey));
      server.activeSlotCacheKey = "";
    }
    const filename = slotCacheFilename(server, normalizedKey);
    if (fs.existsSync(path.join(server.slotSavePath, filename))) {
      await this.slotAction(server.baseUrl, "restore", filename);
      server.activeSlotCacheKey = normalizedKey;
    }
  }

  private async saveSlotIfNeeded(server: ActiveServer, cacheKey?: string): Promise<void> {
    const normalizedKey = normalizeSlotCacheKey(cacheKey);
    if (!normalizedKey) {
      return;
    }
    await this.saveSlot(server, slotCacheFilename(server, normalizedKey));
    server.activeSlotCacheKey = normalizedKey;
  }

  private async saveSlot(server: ActiveServer, filename: string): Promise<void> {
    await this.slotAction(server.baseUrl, "save", filename);
  }

  private async slotAction(baseUrl: string, action: "save" | "restore", filename: string): Promise<void> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 30_000);
    try {
      const response = await this.fetchImpl(`${baseUrl}/slots/0?action=${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
        signal: abortController.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LocalLlamaRuntimeError(`Bundled llama-server slot ${action} failed (${response.status}): ${body || response.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private assertCurrentServerGeneration(startGeneration: number): void {
    if (this.serverGeneration !== startGeneration) {
      throw new LocalLlamaRuntimeError("Bundled llama-server startup was superseded.");
    }
  }

  private async withSlotLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.slotLock;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.slotLock = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function buildLlamaServerCommand(options: {
  binaryPath: string;
  port: number;
  modelPath: string;
  settings: ChatRuntimeSettings;
  nativeGptOss?: boolean;
  slotSavePath?: string;
}): LlamaServerCommand {
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--model",
    options.modelPath,
    "--ctx-size",
    String(options.settings.nCtx),
    "--n-gpu-layers",
    options.settings.nGpuLayers < 0 ? "auto" : String(options.settings.nGpuLayers),
    "-np",
    "1",
    "--slots",
    "--slot-save-path",
    options.slotSavePath ?? path.join(path.dirname(options.binaryPath), "slots"),
    "--no-webui"
  ];
  if (options.nativeGptOss ?? isNativeGptOssReference(options.modelPath)) {
    args.push("--special");
  }
  return {
    command: options.binaryPath,
    cwd: path.dirname(options.binaryPath),
    args
  };
}

export function resolveBundledLlamaServerBinary(runtimeRoot?: string): string | null {
  const names = process.platform === "win32" ? ["llama-server.exe", "llama-server"] : ["llama-server", "llama-server.exe"];
  const roots = runtimeRoot ? [runtimeRoot] : defaultRuntimeRoots();
  const seen = new Set<string>();
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (seen.has(resolvedRoot)) {
      continue;
    }
    seen.add(resolvedRoot);
    const bases = [
      path.join(resolvedRoot, "runtime", "llama.cpp"),
      path.join(resolvedRoot, "third_party", "llama.cpp", "build"),
      resolvedRoot
    ];
    for (const base of bases) {
      for (const name of names) {
        const direct = path.join(base, name);
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
          return direct;
        }
      }
    }
  }
  return null;
}

function defaultRuntimeRoots(): string[] {
  const electronResourcesPath = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  const roots = typeof electronResourcesPath === "string" && electronResourcesPath.trim()
    ? [electronResourcesPath]
    : [];
  roots.push(process.cwd(), path.resolve(__dirname, "../.."));
  return roots;
}

async function readServerSentEvents(body: ReadableStream<Uint8Array>, onPayload: (payload: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      onPayload(trimmed.slice(5).trim());
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    onPayload(tail.slice(5).trim());
  }
}

function serverKeyMatches(left: ServerKey, right: ServerKey): boolean {
  return left.modelPath === right.modelPath && left.nCtx === right.nCtx && left.nGpuLayers === right.nGpuLayers && left.nativeGptOss === right.nativeGptOss;
}

function normalizeSlotCacheKey(value: string | undefined): string {
  return value?.trim() ?? "";
}

function slotCacheFilename(server: ActiveServer, cacheKey: string): string {
  return `${createHash("sha256").update(JSON.stringify({ server: server.key, cacheKey })).digest("hex")}.slot`;
}

function extractText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isNativeGptOssModel(model: ChatModel): boolean {
  return isNativeGptOssReference([model.label, model.path, model.reference].filter(Boolean).join(" "));
}

function isNativeGptOssReference(value: string): boolean {
  return value.toLowerCase().includes("gpt-oss");
}

export function renderGptOssOpenCodeSystemPrompt(settings: ChatRuntimeSettings): string {
  return [
    "You are ChatGPT, a large language model trained by OpenAI.",
    "Knowledge cutoff: 2024-06",
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Reasoning: ${settings.reasoningEffort.trim().toLowerCase() || "medium"}`,
    "",
    "# Valid channels: analysis, commentary, final. Channel must be included for every message.",
    "OpenCode mode is for coding work inside the selected project directory.",
    "Use OpenCode's provided tools when inspection is needed.",
    "Use the analysis channel for your complete reasoning, even for short prompts.",
    "Use the commentary channel for tool calls.",
    "Use the final channel only for the final user-visible answer.",
    "After the final answer, immediately end the assistant message with the native return token.",
    "Do not put final-answer text in analysis.",
    "Do not put reasoning text in final."
  ].join("\n");
}

function renderGptOssPrompt(
  messages: ChatMessage[],
  settings: ChatRuntimeSettings,
  options: { builtinAgenticFramework: ChatBuiltinAgenticFramework; documentTitle: string }
): string {
  const framework = options.builtinAgenticFramework;
  const documentTitle = options.documentTitle.trim();
  const systemTemplate = framework === "document_analysis"
    ? GPTOSS_DOCUMENT_ANALYSIS_SYSTEM_PROMPT
    : framework === "opencode"
      ? GPTOSS_OPENCODE_SYSTEM_PROMPT
      : GPTOSS_SYSTEM_PROMPT;
  const systemPrompt = systemTemplate
    .replace("{current_date}", new Date().toISOString().slice(0, 10))
    .replace("{reasoning_effort}", settings.reasoningEffort.trim().toLowerCase() || "medium")
    .replace(
      "{document_title_line}",
      framework === "document_analysis" && documentTitle
        ? `The selected indexed document index is "${documentTitle.replace(/[{}]/g, "")}".\n`
        : ""
    );
  const parts = [`<|start|>system<|message|>${systemPrompt}${GPTOSS_END_MARKER}`];
  const developerPrompt = settings.systemPrompt.trim();
  if (developerPrompt) {
    parts.push(`<|start|>developer<|message|># Instructions\n\n${developerPrompt}${GPTOSS_END_MARKER}`);
  }
  const lastUserIndex = messages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  for (const [index, message] of messages.entries()) {
    if (message.role === "user" && message.content.trim()) {
      if ((framework === "document_analysis" || framework === "opencode") && message.content.startsWith(DOCUMENT_ANALYSIS_TOOL_RESULT_PREFIX)) {
        parts.push([
          `<|start|>developer<|message|># Host ${framework === "opencode" ? "Shell" : "Search"} Result`,
          "This tool output was injected by the host, not authored by the user.",
          "<tool_result>",
          message.content,
          "</tool_result>"
        ].join("\n") + GPTOSS_END_MARKER);
      } else {
        parts.push(`<|start|>user<|message|>${message.content}${GPTOSS_END_MARKER}`);
      }
      continue;
    }
    if (message.role === "assistant") {
      if (message.reasoning?.trim() && index > lastUserIndex) {
        parts.push(`<|start|>assistant<|channel|>analysis<|message|>${message.reasoning}${GPTOSS_END_MARKER}`);
      }
      if (message.content.trim()) {
        parts.push(`<|start|>assistant<|channel|>final<|message|>${message.content}${GPTOSS_END_MARKER}`);
      }
    }
  }
  parts.push("<|start|>assistant");
  return parts.join("");
}

function gptOssRequestMaxTokens(prompt: string, settings: ChatRuntimeSettings): number {
  const promptChars = prompt.length;
  const estimatedPromptTokens = Math.ceil(promptChars / 3);
  const remainingContextTokens = Math.max(0, settings.nCtx - estimatedPromptTokens);
  const configuredMaxTokens = settings.maxTokens > 0 ? settings.maxTokens : remainingContextTokens;
  return Math.min(configuredMaxTokens, remainingContextTokens);
}

function gptOssToolRecipients(framework: ChatBuiltinAgenticFramework): string[] {
  if (framework === "document_analysis") {
    return ["search", "modify_results"];
  }
  if (framework === "opencode") {
    return ["shell"];
  }
  return [];
}

function localRuntimeMessages(settings: ChatRuntimeSettings, messages: ChatMessage[]): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const payload = messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
  const systemPrompt = settings.systemPrompt.trim();
  return systemPrompt ? [{ role: "system", content: systemPrompt }, ...payload] : payload;
}

export class GptOssChannelParser {
  private buffer = "";
  private activeChannel: "analysis" | "final" | "final_json" | "tool_json" | null = null;
  private activeToolRecipient = "";
  private done = false;

  constructor(private readonly options: { defaultChannel?: "analysis" | "final"; toolRecipients?: string[] } = {}) {}

  push(text: string): { content: string; reasoning: string; toolCallContent?: string } {
    if (this.done || !text) {
      return { content: "", reasoning: "" };
    }
    this.buffer += text;
    const content: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: string[] = [];
    while (true) {
      if (!this.activeChannel) {
        const nextChannel = this.consumeChannelPrefix();
        if (!nextChannel) {
          return { content: content.join(""), reasoning: reasoning.join("") };
        }
        this.activeChannel = nextChannel;
        continue;
      }
      const terminator = firstSpecialTerminator(this.buffer);
      if (terminator) {
        const endIndex = terminator.index;
        if (this.activeChannel === "final_json") {
          appendCommentaryFinalJson(this.buffer.slice(0, endIndex), content);
        } else if (this.activeChannel === "tool_json") {
          appendCommentaryToolCallJson(this.activeToolRecipient, this.buffer.slice(0, endIndex), content, toolCalls);
        } else {
          this.appendChannelText(this.buffer.slice(0, endIndex), content, reasoning);
        }
        this.buffer = this.buffer.slice(endIndex + terminator.marker.length);
        this.activeChannel = null;
        this.activeToolRecipient = "";
        if (terminator.marker === GPTOSS_RETURN_MARKER || terminator.marker === GPTOSS_CALL_MARKER) {
          this.buffer = "";
          this.done = true;
          return channelParserResult(content, reasoning, toolCalls);
        }
        if (!this.buffer) {
          return channelParserResult(content, reasoning, toolCalls);
        }
        continue;
      }
      if (this.activeChannel === "final_json" || this.activeChannel === "tool_json") {
        return channelParserResult(content, reasoning, toolCalls);
      }
      const partialEndLength = trailingPartialSpecialTerminatorLength(this.buffer);
      const emitText = partialEndLength > 0 ? this.buffer.slice(0, -partialEndLength) : this.buffer;
      this.appendChannelText(emitText, content, reasoning);
      this.buffer = partialEndLength > 0 ? this.buffer.slice(-partialEndLength) : "";
      return channelParserResult(content, reasoning, toolCalls);
    }
  }

  finish(): { content: string; reasoning: string; toolCallContent?: string } {
    if (this.done || !this.buffer) {
      return { content: "", reasoning: "" };
    }
    const content: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: string[] = [];
    if (this.activeChannel === "final_json") {
      appendCommentaryFinalJson(this.buffer, content);
      this.buffer = "";
      this.activeChannel = null;
      return channelParserResult(content, reasoning, toolCalls);
    }
    if (this.activeChannel === "tool_json") {
      appendCommentaryToolCallJson(this.activeToolRecipient, this.buffer, content, toolCalls);
      this.buffer = "";
      this.activeChannel = null;
      this.activeToolRecipient = "";
      return channelParserResult(content, reasoning, toolCalls);
    }
    if ((this.activeChannel === "analysis" || this.activeChannel === "final") && !this.buffer.startsWith("<|")) {
      this.appendChannelText(this.buffer, content, reasoning);
    }
    this.buffer = "";
    this.activeChannel = null;
    return channelParserResult(content, reasoning, toolCalls);
  }

  private consumeChannelPrefix(): "analysis" | "final" | "final_json" | "tool_json" | null {
    while (this.buffer.startsWith("<|start|>assistant")) {
      this.buffer = this.buffer.slice("<|start|>assistant".length);
      if (!this.buffer) {
        return null;
      }
    }
    const analysisPrefix = "<|channel|>analysis<|message|>";
    const finalPrefix = "<|channel|>final<|message|>";
    if (this.buffer.startsWith(analysisPrefix)) {
      this.buffer = this.buffer.slice(analysisPrefix.length);
      return "analysis";
    }
    if (this.buffer.startsWith(finalPrefix)) {
      this.buffer = this.buffer.slice(finalPrefix.length);
      return "final";
    }
    const commentaryChannel = this.consumeCommentaryPrefix();
    if (commentaryChannel === "await_commentary") {
      return null;
    }
    if (commentaryChannel) {
      return commentaryChannel;
    }
    if (this.buffer && !this.buffer.startsWith("<|")) {
      return this.options.defaultChannel ?? "analysis";
    }
    if (this.buffer && awaitingKnownPrefix(this.buffer, ["<|start|>assistant", analysisPrefix, finalPrefix, "<|channel|>commentary"])) {
      return null;
    }
    this.done = true;
    return null;
  }

  private consumeCommentaryPrefix(): "analysis" | "final" | "final_json" | "tool_json" | "await_commentary" | null {
    const commentaryPrefix = "<|channel|>commentary";
    if (!this.buffer.startsWith(commentaryPrefix)) {
      return null;
    }
    const messageMarker = "<|message|>";
    const messageIndex = this.buffer.indexOf(messageMarker);
    if (messageIndex < 0) {
      return "await_commentary";
    }
    const prefix = this.buffer.slice(0, messageIndex + messageMarker.length);
    this.buffer = this.buffer.slice(messageIndex + messageMarker.length);
    const commentaryTarget = commentaryRecipient(prefix);
    const toolRecipient = this.commentaryToolRecipient(commentaryTarget);
    if (toolRecipient) {
      this.activeToolRecipient = toolRecipient;
      return "tool_json";
    }
    if (commentaryTarget === "final" && prefix.includes("<|constrain|>json")) {
      return "final_json";
    }
    if (commentaryTarget === "final") {
      return "final";
    }
    throw new Error(`GPT-OSS emitted unsupported commentary recipient: ${commentaryTarget || "(none)"}.`);
  }

  private commentaryToolRecipient(commentaryTarget: string): string {
    const recipients = this.options.toolRecipients ?? [];
    if (recipients.length === 0) {
      return "";
    }
    for (const recipient of recipients) {
      if (commentaryTarget === recipient) {
        return recipient;
      }
    }
    return "";
  }

  private appendChannelText(text: string, content: string[], reasoning: string[]): void {
    if (!text) {
      return;
    }
    if (this.activeChannel === "analysis") {
      reasoning.push(text);
      return;
    }
    content.push(text);
  }
}

function channelParserResult(content: string[], reasoning: string[], toolCalls: string[]): { content: string; reasoning: string; toolCallContent?: string } {
  const result: { content: string; reasoning: string; toolCallContent?: string } = {
    content: content.join(""),
    reasoning: reasoning.join("")
  };
  if (toolCalls.length > 0) {
    result.toolCallContent = toolCalls.join("");
  }
  return result;
}

function awaitingKnownPrefix(text: string, markers: string[]): boolean {
  return Boolean(text) && markers.some((marker) => marker.startsWith(text));
}

function commentaryRecipient(prefix: string): string {
  const markerIndex = prefix.indexOf("<|message|>");
  const header = markerIndex >= 0 ? prefix.slice(0, markerIndex) : prefix;
  const match = /(?:^|\s)to=([^\s<]+)/u.exec(header);
  return match?.[1] ?? "";
}

function firstSpecialTerminator(text: string): { index: number; marker: string } | null {
  let first: { index: number; marker: string } | null = null;
  for (const marker of GPTOSS_CHANNEL_TERMINATORS) {
    const index = text.indexOf(marker);
    if (index >= 0 && (!first || index < first.index)) {
      first = { index, marker };
    }
  }
  return first;
}

function trailingPartialSpecialTerminatorLength(text: string): number {
  return Math.max(...GPTOSS_CHANNEL_TERMINATORS.map((marker) => trailingPartialMarkerLength(text, marker)));
}

function trailingPartialMarkerLength(text: string, marker: string): number {
  const maxSuffix = Math.min(text.length, marker.length - 1);
  for (let suffixLength = maxSuffix; suffixLength > 0; suffixLength -= 1) {
    if (marker.startsWith(text.slice(-suffixLength))) {
      return suffixLength;
    }
  }
  return 0;
}

function appendCommentaryFinalJson(text: string, content: string[]): void {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }
  try {
    const decoded = JSON.parse(normalized) as unknown;
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const record = decoded as Record<string, unknown>;
      for (const key of ["final", "response", "content"]) {
        if (typeof record[key] === "string") {
          content.push(record[key]);
          return;
        }
      }
    }
  } catch {
    throw new Error("GPT-OSS emitted malformed constrained final JSON.");
  }
  throw new Error("GPT-OSS emitted constrained final JSON without final content.");
}

function appendCommentaryToolCallJson(toolRecipient: string, text: string, content: string[], toolCalls?: string[]): void {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }
  try {
    const decoded = JSON.parse(normalized) as unknown;
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const payload = { ...(decoded as Record<string, unknown>), tool: toolRecipient };
      const toolCall = `<tool_call>${JSON.stringify(payload)}</tool_call>`;
      content.push(toolCall);
      toolCalls?.push(toolCall);
      return;
    }
  } catch {
    throw new Error("GPT-OSS emitted malformed tool-call JSON.");
  }
  throw new Error("GPT-OSS emitted malformed tool-call JSON.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local llama-server port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
