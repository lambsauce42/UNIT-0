#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PROTOCOL_VERSION = "1";
const CAPABILITIES = ["model_catalog", "chat_stream", "runtime_status", "runtime_logs", "model_prewarm", "context_prepare"];
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
const GPTOSS_END_MARKER = "<|end|>";
const GPTOSS_CALL_MARKER = "<|call|>";
const GPTOSS_RETURN_MARKER = "<|return|>";
const GPTOSS_CHANNEL_TERMINATORS = [GPTOSS_END_MARKER, GPTOSS_CALL_MARKER, GPTOSS_RETURN_MARKER];
const CLIENT_TTL_MS = 5 * 60 * 1000;

class RemoteInferenceServer {
  constructor(config) {
    this.config = normalizeConfig(config);
    this.logs = [];
    this.clients = new Map();
    this.activeRequests = new Map();
    this.preparedContexts = new Map();
    this.warmedModels = new Set();
    this.managedServers = new Map();
    this.server = null;
  }

  updateConfig(config) {
    this.stopManagedServers();
    this.config = normalizeConfig(config);
    this.warmedModels.clear();
    this.preparedContexts.clear();
  }

  async start() {
    if (this.server) {
      return;
    }
    if (this.config.models.length === 0) {
      throw new Error("Configure at least one model before starting the remote inference server.");
    }
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.log("error", "Unhandled request error", { error: errorMessage(error), path: request.url || "" });
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "application/json" });
        }
        response.end(JSON.stringify({ error: errorMessage(error) }));
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.log("info", "Remote inference server started", {
      host: this.config.host,
      port: this.config.port,
      identity: this.config.hostIdentity,
      models: this.config.models.map((model) => model.id),
      addresses: localNetworkAddresses()
    });
    try {
      await this.prewarmStartupModels();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (!this.server) {
      return;
    }
    const current = this.server;
    this.server = null;
    await new Promise((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
    this.stopManagedServers();
    this.activeRequests.clear();
    this.log("info", "Remote inference server stopped", {});
  }

  isRunning() {
    return Boolean(this.server?.listening);
  }

  statusSnapshot() {
    this.pruneClients();
    return {
      running: this.isRunning(),
      host: this.config.host,
      port: this.config.port,
      hostIdentity: this.config.hostIdentity,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
      addresses: localNetworkAddresses(),
      models: this.config.models.map((model) => ({
        id: model.id,
        label: model.label,
        reference: model.reference || model.id,
        backend: model.backend,
        launchMode: model.launchMode,
        url: model.url || "",
        modelPath: model.modelPath || "",
        binaryPath: model.binaryPath || "",
        runtimeHost: model.runtimeHost,
        runtimePort: model.runtimePort,
        nCtx: model.nCtx,
        nGpuLayers: model.nGpuLayers,
        parallelSlots: model.parallelSlots,
        prewarmOnStart: model.prewarmOnStart,
        promptFormat: model.promptFormat || "",
        runtimeRunning: this.managedServers.has(model.id),
        warmed: this.warmedModels.has(model.id)
      })),
      clients: [...this.clients.values()],
      activeRequests: [...this.activeRequests.values()],
      preparedContexts: [...this.preparedContexts.entries()].map(([contextKey, value]) => ({
        contextKey,
        modelId: value.modelId,
        messageCount: value.messages.length,
        preparedAt: value.preparedAt
      })),
      logs: this.logs
    };
  }

  async handleRequest(request, response) {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, renderStatusPage(this.statusSnapshot()));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/status") {
      sendJson(response, request, url.pathname, this.config, this.statusSnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/discover") {
      verifyRequest(request, url.pathname, "", this.config);
      this.rememberClient(request);
      sendJson(response, request, url.pathname, this.config, {
        host_identity: this.config.hostIdentity,
        protocol_version: PROTOCOL_VERSION,
        capabilities: CAPABILITIES
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      verifyRequest(request, url.pathname, "", this.config);
      this.rememberClient(request);
      sendJson(response, request, url.pathname, this.config, {
        models: this.config.models.map((model) => ({
          id: model.id,
          label: model.label,
          reference: model.reference || model.id,
          prompt_format: model.promptFormat || "",
          context_tokens: model.nCtx,
          source_label: model.sourceLabel || "Remote Inference",
          warmed: this.warmedModels.has(model.id)
        }))
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/prewarm") {
      const body = await readBody(request);
      verifyRequest(request, url.pathname, body, this.config);
      this.rememberClient(request);
      const payload = parseBody(body);
      const model = this.requireModel(payload.model_id);
      await this.prewarmModel(model);
      sendJson(response, request, url.pathname, this.config, { ok: true, model_id: model.id, warmed: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/context/prepare") {
      const body = await readBody(request);
      verifyRequest(request, url.pathname, body, this.config);
      this.rememberClient(request);
      const payload = parseBody(body);
      const model = this.requireModel(payload.model_id);
      const contextKey = stringField(payload.context_key);
      if (!contextKey) {
        sendError(response, request, url.pathname, this.config, 400, "context_key is required.");
        return;
      }
      this.preparedContexts.set(contextKey, {
        modelId: model.id,
        messages: normalizedMessages(payload.messages),
        settings: payload.settings || {},
        framework: stringField(payload.builtin_agentic_framework) || "chat",
        documentTitle: stringField(payload.document_title),
        preparedAt: new Date().toISOString()
      });
      this.log("info", "Prepared reusable context", { modelId: model.id, contextKey, messageCount: this.preparedContexts.get(contextKey).messages.length });
      sendJson(response, request, url.pathname, this.config, { ok: true, context_key: contextKey });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat") {
      const body = await readBody(request);
      verifyRequest(request, url.pathname, body, this.config);
      this.rememberClient(request);
      await this.streamChat(request, response, parseBody(body), url.pathname);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  }

  async streamChat(request, response, payload, requestPath) {
    const model = this.requireModel(payload.model_id);
    const requestId = stringField(payload.request_id) || crypto.randomUUID();
    const clientId = clientKey(request);
    const sessionId = stringField(payload.remote_session_id) || crypto.randomUUID();
    const slotId = Number.isFinite(Number(payload.runtime_slot_id)) ? Math.max(0, Number(payload.runtime_slot_id)) : 0;
    const startedAt = Date.now();
    this.activeRequests.set(requestId, {
      requestId,
      clientId,
      modelId: model.id,
      sessionId,
      startedAt: new Date(startedAt).toISOString()
    });
    this.log("info", "Serving inference request", { requestId, clientId, modelId: model.id, sessionId });
    const signedHeaders = {
      "X-Unit0-Protocol-Version": PROTOCOL_VERSION,
      "X-Unit0-Host-Identity": this.config.hostIdentity,
      "X-Unit0-Remote-Host-Id": this.config.hostIdentity,
      "X-Unit0-Remote-Session-Id": sessionId,
      "X-Unit0-Remote-Slot-Id": String(slotId),
      "X-Unit0-Remote-Session-Status": this.warmedModels.has(model.id) ? "warm" : "cold"
    };
    const nonce = String(request.headers["x-unit0-auth-nonce"] || "");
    response.writeHead(200, {
      ...signedHeaders,
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Unit0-Response-Signature": remoteStreamOpenSignature(this.config.pairingCode, requestPath, nonce, signedHeaders)
    });
    let sequence = 0;
    const sendEvent = (event) => {
      sequence += 1;
      response.write(`${JSON.stringify({ ...event, signature: remoteStreamEventSignature(this.config.pairingCode, nonce, sequence, event) })}\n`);
    };
    try {
      await this.prewarmModel(model);
      const context = stringField(payload.context_key) ? this.preparedContexts.get(stringField(payload.context_key)) : null;
      const messages = context?.modelId === model.id ? context.messages : normalizedMessages(payload.messages);
      if (context?.modelId === model.id) {
        this.log("info", "Using prepared context", { requestId, contextKey: stringField(payload.context_key) });
      }
      await this.generate(model, {
        messages,
        settings: payload.settings || {},
        slotId,
        framework: stringField(payload.builtin_agentic_framework) || context?.framework || "chat",
        documentTitle: stringField(payload.document_title) || context?.documentTitle || "",
        onToken: (content, reasoning = "") => sendEvent({ type: "chunk", content, reasoning })
      });
      sendEvent({
        type: "complete",
        metrics: {
          model_id: model.id,
          backend: model.backend,
          duration_ms: Date.now() - startedAt,
          prepared_context: Boolean(context?.modelId === model.id),
          cache_prompt: true,
          kv_cache_policy: "session-slot"
        }
      });
      this.log("info", "Completed inference request", { requestId, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = errorMessage(error);
      sendEvent({ type: "error", message });
      this.log("error", "Inference request failed", { requestId, error: message });
    } finally {
      this.activeRequests.delete(requestId);
      response.end();
    }
  }

  async generate(model, options) {
    if (model.backend !== "llama-server") {
      throw new Error(`Unsupported remote model backend: ${model.backend}`);
    }
    const baseUrl = await this.resolveLlamaBaseUrl(model);
    if (model.promptFormat === "gpt-oss" || String(model.reference || "").toLowerCase().includes("gpt-oss")) {
      await streamLlamaCompletion(
        baseUrl,
        renderGptOssPrompt(options.messages, options.settings, options),
        options.settings,
        positiveInteger(options.slotId, 0),
        gptOssToolRecipients(options.framework),
        options.onToken
      );
      return;
    }
    await streamOpenAiChat(model, baseUrl, options.messages, options.settings, positiveInteger(options.slotId, 0), options.onToken);
  }

  async prewarmModel(model) {
    if (this.warmedModels.has(model.id)) {
      return;
    }
    if (model.backend === "llama-server") {
      const baseUrl = await this.resolveLlamaBaseUrl(model);
      const health = await fetch(`${baseUrl}/health`);
      if (!health.ok) {
        throw new Error(`llama-server health failed for ${model.id}: ${health.status}`);
      }
    }
    this.warmedModels.add(model.id);
    this.log("info", "Model prewarmed", { modelId: model.id, backend: model.backend });
  }

  requireModel(modelId) {
    const id = stringField(modelId);
    const model = this.config.models.find((candidate) => candidate.id === id);
    if (!model) {
      throw new Error(`Remote model is not configured: ${id}`);
    }
    return model;
  }

  rememberClient(request) {
    const key = clientKey(request);
    const existing = this.clients.get(key);
    this.clients.set(key, {
      id: key,
      address: request.socket.remoteAddress || "",
      userAgent: String(request.headers["user-agent"] || ""),
      connectedAt: existing?.connectedAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    });
  }

  pruneClients(now = Date.now()) {
    for (const [key, client] of this.clients.entries()) {
      const lastSeen = Date.parse(client.lastSeenAt);
      if (!Number.isFinite(lastSeen) || now - lastSeen > CLIENT_TTL_MS) {
        this.clients.delete(key);
      }
    }
  }

  log(level, message, details = {}) {
    this.logs.push({ time: new Date().toISOString(), level, message, details });
    while (this.logs.length > 500) {
      this.logs.shift();
    }
    const line = `[unit0-remote] ${level} ${message} ${JSON.stringify(details)}`;
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  async prewarmStartupModels() {
    for (const model of this.config.models) {
      if (model.backend === "llama-server" && model.prewarmOnStart) {
        await this.prewarmModel(model);
      }
    }
  }

  async resolveLlamaBaseUrl(model) {
    if (model.launchMode === "external") {
      const baseUrl = stringField(model.url).replace(/\/+$/g, "");
      if (!baseUrl) {
        throw new Error(`Model ${model.id} is missing external llama-server url.`);
      }
      return baseUrl;
    }
    if (model.launchMode !== "managed") {
      throw new Error(`Unsupported llama-server launch mode for ${model.id}: ${model.launchMode}`);
    }
    const managed = await this.ensureManagedServer(model);
    return managed.baseUrl;
  }

  async ensureManagedServer(model) {
    const existing = this.managedServers.get(model.id);
    if (existing && existing.process.exitCode === null) {
      return existing;
    }
    const binaryPath = path.resolve(model.binaryPath);
    if (!binaryPath || !fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
      throw new Error(`llama-server executable not found for ${model.id}: ${binaryPath}`);
    }
    const modelPath = path.resolve(model.modelPath);
    if (!modelPath || !fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile()) {
      throw new Error(`GGUF model file not found for ${model.id}: ${modelPath}`);
    }
    if (path.extname(modelPath).toLowerCase() !== ".gguf") {
      throw new Error(`Model ${model.id} must point to a .gguf file: ${modelPath}`);
    }
    const command = buildManagedLlamaCommand(model, binaryPath, modelPath);
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const managed = {
      process: child,
      baseUrl: `http://${model.runtimeHost}:${model.runtimePort}`,
      command,
      startedAt: new Date().toISOString()
    };
    this.managedServers.set(model.id, managed);
    child.stdout?.on("data", (chunk) => this.log("info", "llama-server stdout", { modelId: model.id, text: String(chunk).trim() }));
    child.stderr?.on("data", (chunk) => this.log("info", "llama-server stderr", { modelId: model.id, text: String(chunk).trim() }));
    child.once("exit", (code, signal) => {
      this.managedServers.delete(model.id);
      this.warmedModels.delete(model.id);
      this.log("info", "llama-server exited", { modelId: model.id, code, signal });
    });
    this.log("info", "Starting managed llama-server", { modelId: model.id, command: command.command, args: command.args });
    await this.waitForManagedServer(model, managed);
    return managed;
  }

  async waitForManagedServer(model, managed) {
    const deadline = Date.now() + 240_000;
    let lastError = "server did not become ready";
    while (Date.now() < deadline) {
      if (managed.process.exitCode !== null) {
        throw new Error(`llama-server exited during startup for ${model.id} with code ${managed.process.exitCode}`);
      }
      try {
        const health = await fetchWithTimeout(`${managed.baseUrl}/health`, 2_000);
        if (health.ok) {
          const models = await fetchWithTimeout(`${managed.baseUrl}/v1/models`, 3_000);
          if (models.ok) {
            this.log("info", "Managed llama-server ready", { modelId: model.id, url: managed.baseUrl });
            return;
          }
          lastError = `/v1/models returned ${models.status}`;
        } else {
          lastError = `/health returned ${health.status}`;
        }
      } catch (error) {
        lastError = errorMessage(error);
      }
      await sleep(250);
    }
    throw new Error(`llama-server startup timed out for ${model.id}: ${lastError}`);
  }

  stopManagedServers() {
    for (const [modelId, managed] of this.managedServers.entries()) {
      if (managed.process.exitCode === null) {
        managed.process.kill();
      }
      this.log("info", "Stopped managed llama-server", { modelId });
    }
    this.managedServers.clear();
  }
}

function createRemoteInferenceServer(config) {
  return new RemoteInferenceServer(config);
}

function loadConfig(configPath, options = {}) {
  const resolved = path.resolve(configPath);
  const raw = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, "utf8")) : {};
  return normalizeConfig(raw, options);
}

function saveConfig(configPath, config) {
  const normalized = normalizeConfig(config, { allowEmptyModels: true });
  fs.mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true });
  fs.writeFileSync(path.resolve(configPath), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function normalizeConfig(raw, options = {}) {
  const models = Array.isArray(raw.models) ? raw.models.map(normalizeModel).filter(Boolean) : [];
  if (!options.allowEmptyModels && models.length === 0) {
    throw new Error("Remote inference config must define at least one model.");
  }
  const pairingCode = stringField(raw.pairingCode || process.env.UNIT0_REMOTE_PAIRING_CODE);
  if (!pairingCode) {
    throw new Error("Remote inference config requires pairingCode.");
  }
  return {
    host: stringField(raw.host) || "0.0.0.0",
    port: positiveInteger(raw.port, 14555),
    pairingCode,
    hostIdentity: stringField(raw.hostIdentity) || os.hostname(),
    models
  };
}

function normalizeModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const id = stringField(value.id);
  const backend = stringField(value.backend);
  if (!id || !backend) {
    return null;
  }
  return {
    id,
    label: stringField(value.label) || id,
    reference: stringField(value.reference) || id,
    sourceLabel: stringField(value.sourceLabel) || "Remote Inference",
    backend,
    launchMode: normalizeLaunchMode(value.launchMode, value),
    url: stringField(value.url),
    modelPath: stringField(value.modelPath),
    binaryPath: stringField(value.binaryPath),
    runtimeHost: stringField(value.runtimeHost) || "127.0.0.1",
    runtimePort: positiveInteger(value.runtimePort, 8080),
    nCtx: positiveInteger(value.nCtx, 8192),
    nGpuLayers: normalizeGpuLayers(value.nGpuLayers),
    parallelSlots: positiveInteger(value.parallelSlots, 1),
    prewarmOnStart: value.prewarmOnStart === "false" ? false : value.prewarmOnStart !== false,
    promptFormat: stringField(value.promptFormat)
  };
}

function normalizeLaunchMode(value, model) {
  const launchMode = stringField(value);
  if (launchMode === "managed" || launchMode === "external") {
    return launchMode;
  }
  return stringField(model?.modelPath) ? "managed" : "external";
}

function normalizeGpuLayers(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : -1;
}

function buildManagedLlamaCommand(model, binaryPath, modelPath) {
  const slotSavePath = path.join(path.dirname(binaryPath), "slots");
  fs.mkdirSync(slotSavePath, { recursive: true });
  const args = [
    "--host",
    model.runtimeHost,
    "--port",
    String(model.runtimePort),
    "--model",
    modelPath,
    "--ctx-size",
    String(model.nCtx),
    "--n-gpu-layers",
    model.nGpuLayers < 0 ? "auto" : String(model.nGpuLayers),
    "-np",
    String(model.parallelSlots),
    "--slots",
    "--slot-save-path",
    slotSavePath,
    "--no-webui"
  ];
  if (model.promptFormat === "gpt-oss" || String(model.reference || modelPath).toLowerCase().includes("gpt-oss")) {
    args.push("--special");
  }
  return {
    command: binaryPath,
    cwd: path.dirname(binaryPath),
    args
  };
}

async function streamLlamaCompletion(baseUrl, prompt, settings, slotId, toolRecipients, onToken) {
  const response = await fetch(`${baseUrl}/completion`, {
    method: "POST",
    headers: { "Accept": "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      stream: true,
      n_predict: gptOssRequestMaxTokens(prompt, settings),
      temperature: numberField(settings.temperature, 0.7),
      repeat_penalty: numberField(settings.repeat_penalty, 1.1),
      cache_prompt: true,
      id_slot: slotId
    })
  });
  const channelParser = new GptOssChannelParser({ toolRecipients });
  await readSseResponse(response, (payload) => {
    if (payload === "[DONE]") {
      return;
    }
    const parsed = JSON.parse(payload);
    const rawText = typeof parsed.content === "string" ? parsed.content : "";
    if (!rawText) {
      return;
    }
    const { content, reasoning } = channelParser.push(rawText);
    if (content || reasoning) {
      onToken(content, reasoning);
    }
  });
  const { content, reasoning } = channelParser.finish();
  if (content || reasoning) {
    onToken(content, reasoning);
  }
}

async function streamOpenAiChat(model, baseUrl, messages, settings, slotId, onToken) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Accept": "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.reference || model.id,
      messages: openAiRuntimeMessages(settings, messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: positiveInteger(settings.max_tokens, 512),
      temperature: numberField(settings.temperature, 0.7),
      repeat_penalty: numberField(settings.repeat_penalty, 1.1),
      cache_prompt: true,
      id_slot: slotId
    })
  });
  await readSseResponse(response, (payload) => {
    if (payload === "[DONE]") {
      return;
    }
    const parsed = JSON.parse(payload);
    const delta = parsed.choices?.[0]?.delta || {};
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoning = typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta.reasoning === "string"
        ? delta.reasoning
        : typeof delta.thinking === "string"
          ? delta.thinking
          : "";
    if (content || reasoning) {
      onToken(content, reasoning);
    }
  });
}

function openAiRuntimeMessages(settings, messages) {
  const payload = messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
  const systemPrompt = typeof settings.system_prompt === "string" ? settings.system_prompt.trim() : "";
  return systemPrompt ? [{ role: "system", content: systemPrompt }, ...payload] : payload;
}

async function readSseResponse(response, onPayload) {
  if (!response.ok || !response.body) {
    throw new Error(`llama-server request failed (${response.status}): ${await response.text().catch(() => response.statusText)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/g);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        onPayload(trimmed.slice(5).trim());
      }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    onPayload(tail.slice(5).trim());
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: abortController.signal });
  } finally {
    clearTimeout(timer);
  }
}

function renderGptOssPrompt(messages, settings, options) {
  const framework = options.framework || "chat";
  const documentTitle = String(options.documentTitle || "").trim();
  const systemTemplate = framework === "document_analysis"
    ? GPTOSS_DOCUMENT_ANALYSIS_SYSTEM_PROMPT
    : framework === "opencode"
      ? GPTOSS_OPENCODE_SYSTEM_PROMPT
      : GPTOSS_SYSTEM_PROMPT;
  const systemPrompt = systemTemplate
    .replace("{current_date}", new Date().toISOString().slice(0, 10))
    .replace("{reasoning_effort}", stringField(settings.reasoning_effort).toLowerCase() || "medium")
    .replace(
      "{document_title_line}",
      framework === "document_analysis" && documentTitle
        ? `The selected indexed document index is "${documentTitle.replace(/[{}]/g, "")}".\n`
        : ""
    );
  const parts = [`<|start|>system<|message|>${systemPrompt}${GPTOSS_END_MARKER}`];
  const developerPrompt = stringField(settings.system_prompt);
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

function gptOssToolRecipients(framework) {
  if (framework === "document_analysis") {
    return ["search", "modify_results"];
  }
  if (framework === "opencode") {
    return ["shell"];
  }
  return [];
}

function gptOssRequestMaxTokens(prompt, settings) {
  const promptChars = prompt.length;
  const estimatedPromptTokens = Math.ceil(promptChars / 3);
  const remainingContextTokens = Math.max(0, positiveInteger(settings.n_ctx, 8192) - estimatedPromptTokens);
  const configuredMaxTokens = positiveInteger(settings.max_tokens, remainingContextTokens);
  return Math.min(configuredMaxTokens, remainingContextTokens);
}

class GptOssChannelParser {
  constructor(options = {}) {
    this.options = options;
    this.buffer = "";
    this.activeChannel = null;
    this.activeToolRecipient = "";
    this.done = false;
  }

  push(text) {
    if (this.done || !text) {
      return { content: "", reasoning: "" };
    }
    this.buffer += text;
    const content = [];
    const reasoning = [];
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
          appendCommentaryToolCallJson(this.activeToolRecipient, this.buffer.slice(0, endIndex), content);
        } else {
          this.appendChannelText(this.buffer.slice(0, endIndex), content, reasoning);
        }
        this.buffer = this.buffer.slice(endIndex + terminator.marker.length);
        this.activeChannel = null;
        this.activeToolRecipient = "";
        if (terminator.marker === GPTOSS_RETURN_MARKER || terminator.marker === GPTOSS_CALL_MARKER) {
          this.buffer = "";
          this.done = true;
          return { content: content.join(""), reasoning: reasoning.join("") };
        }
        if (!this.buffer) {
          return { content: content.join(""), reasoning: reasoning.join("") };
        }
        continue;
      }
      if (this.activeChannel === "final_json" || this.activeChannel === "tool_json") {
        return { content: content.join(""), reasoning: reasoning.join("") };
      }
      const partialEndLength = trailingPartialSpecialTerminatorLength(this.buffer);
      const emitText = partialEndLength > 0 ? this.buffer.slice(0, -partialEndLength) : this.buffer;
      this.appendChannelText(emitText, content, reasoning);
      this.buffer = partialEndLength > 0 ? this.buffer.slice(-partialEndLength) : "";
      return { content: content.join(""), reasoning: reasoning.join("") };
    }
  }

  finish() {
    if (this.done || !this.buffer) {
      return { content: "", reasoning: "" };
    }
    const content = [];
    const reasoning = [];
    if (this.activeChannel === "final_json") {
      appendCommentaryFinalJson(this.buffer, content);
      this.buffer = "";
      this.activeChannel = null;
      return { content: content.join(""), reasoning: reasoning.join("") };
    }
    if (this.activeChannel === "tool_json") {
      appendCommentaryToolCallJson(this.activeToolRecipient, this.buffer, content);
      this.buffer = "";
      this.activeChannel = null;
      this.activeToolRecipient = "";
      return { content: content.join(""), reasoning: reasoning.join("") };
    }
    if ((this.activeChannel === "analysis" || this.activeChannel === "final") && !this.buffer.startsWith("<|")) {
      this.appendChannelText(this.buffer, content, reasoning);
    }
    this.buffer = "";
    this.activeChannel = null;
    return { content: content.join(""), reasoning: reasoning.join("") };
  }

  consumeChannelPrefix() {
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
      return this.options.defaultChannel || "analysis";
    }
    if (this.buffer && awaitingKnownPrefix(this.buffer, ["<|start|>assistant", analysisPrefix, finalPrefix, "<|channel|>commentary"])) {
      return null;
    }
    this.done = true;
    return null;
  }

  consumeCommentaryPrefix() {
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

  commentaryToolRecipient(commentaryTarget) {
    const recipients = this.options.toolRecipients || [];
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

  appendChannelText(text, content, reasoning) {
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

function awaitingKnownPrefix(text, markers) {
  return Boolean(text) && markers.some((marker) => marker.startsWith(text));
}

function commentaryRecipient(prefix) {
  const markerIndex = prefix.indexOf("<|message|>");
  const header = markerIndex >= 0 ? prefix.slice(0, markerIndex) : prefix;
  const match = /(?:^|\s)to=([^\s<]+)/u.exec(header);
  return match?.[1] ?? "";
}

function firstSpecialTerminator(text) {
  let first = null;
  for (const marker of GPTOSS_CHANNEL_TERMINATORS) {
    const index = text.indexOf(marker);
    if (index >= 0 && (!first || index < first.index)) {
      first = { index, marker };
    }
  }
  return first;
}

function trailingPartialSpecialTerminatorLength(text) {
  return Math.max(...GPTOSS_CHANNEL_TERMINATORS.map((marker) => trailingPartialMarkerLength(text, marker)));
}

function trailingPartialMarkerLength(text, marker) {
  const maxSuffix = Math.min(text.length, marker.length - 1);
  for (let suffixLength = maxSuffix; suffixLength > 0; suffixLength -= 1) {
    if (marker.startsWith(text.slice(-suffixLength))) {
      return suffixLength;
    }
  }
  return 0;
}

function appendCommentaryFinalJson(text, content) {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }
  try {
    const decoded = JSON.parse(normalized);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      for (const key of ["final", "response", "content"]) {
        if (typeof decoded[key] === "string") {
          content.push(decoded[key]);
          return;
        }
      }
    }
  } catch {
    throw new Error("GPT-OSS emitted malformed constrained final JSON.");
  }
  throw new Error("GPT-OSS emitted constrained final JSON without final content.");
}

function appendCommentaryToolCallJson(toolRecipient, text, content) {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }
  try {
    const decoded = JSON.parse(normalized);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      content.push(`<tool_call>${JSON.stringify({ ...decoded, tool: toolRecipient })}</tool_call>`);
      return;
    }
  } catch {
    throw new Error("GPT-OSS emitted malformed tool-call JSON.");
  }
  throw new Error("GPT-OSS emitted malformed tool-call JSON.");
}

function sendJson(response, request, requestPath, config, payload, statusCode = 200) {
  const body = JSON.stringify(payload);
  const nonce = String(request.headers["x-unit0-auth-nonce"] || "");
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "X-Unit0-Host-Identity": config.hostIdentity,
    "X-Unit0-Response-Signature": remoteJsonResponseSignature(config.pairingCode, requestPath, statusCode, nonce, config.hostIdentity, body)
  });
  response.end(body);
}

function sendError(response, request, requestPath, config, statusCode, message) {
  sendJson(response, request, requestPath, config, { error: message }, statusCode);
}

function sendHtml(response, body) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

function renderStatusPage(state) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unit 0 Remote Inference</title><style>
body{margin:0;background:#101820;color:#dbe7f3;font:14px/1.45 Segoe UI,Arial,sans-serif}main{max-width:1040px;margin:0 auto;padding:28px}h1{font-size:24px;margin:0 0 18px}h2{font-size:15px;margin:22px 0 8px;color:#92b2d2}table{width:100%;border-collapse:collapse;background:#14212d}td,th{border-bottom:1px solid #263747;padding:8px;text-align:left}code,pre{font-family:Consolas,monospace}pre{white-space:pre-wrap;background:#14212d;padding:12px;border:1px solid #263747}</style></head><body><main>
<h1>Unit 0 Remote Inference</h1>
<h2>Connection</h2><table><tbody><tr><th>Identity</th><td>${escapeHtml(state.hostIdentity)}</td></tr><tr><th>Protocol</th><td>${state.protocolVersion}</td></tr><tr><th>Clients</th><td>${state.clients.length}</td></tr><tr><th>Active Requests</th><td>${state.activeRequests.length}</td></tr></tbody></table>
<h2>Models</h2><table><thead><tr><th>ID</th><th>Label</th><th>Backend</th><th>Warmed</th></tr></thead><tbody>${state.models.map((model) => `<tr><td><code>${escapeHtml(model.id)}</code></td><td>${escapeHtml(model.label)}</td><td>${escapeHtml(model.backend)}</td><td>${model.warmed ? "yes" : "no"}</td></tr>`).join("")}</tbody></table>
<h2>Active Requests</h2><pre>${escapeHtml(JSON.stringify(state.activeRequests, null, 2))}</pre>
<h2>Connected Clients</h2><pre>${escapeHtml(JSON.stringify(state.clients, null, 2))}</pre>
<h2>Runtime Logs</h2><pre>${escapeHtml(state.logs.map((entry) => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message} ${JSON.stringify(entry.details)}`).join("\n"))}</pre>
</main></body></html>`;
}

function verifyRequest(request, requestPath, body, config) {
  const timestamp = String(request.headers["x-unit0-auth-timestamp"] || "");
  const nonce = String(request.headers["x-unit0-auth-nonce"] || "");
  const signature = String(request.headers["x-unit0-auth-signature"] || "");
  const expected = remoteRequestSignature(config.pairingCode, request.method || "GET", requestPath, timestamp, nonce, body);
  const now = Math.floor(Date.now() / 1000);
  const age = Math.abs(now - Number(timestamp));
  if (!timestamp || !nonce || !signature || signature !== expected || !Number.isFinite(age) || age > 300) {
    throw new Error("Invalid remote inference request signature.");
  }
}

function remoteRequestSignature(secret, method, requestPath, timestamp, nonce, body) {
  return hmac(secret, ["request", method.toUpperCase(), requestPath, timestamp, nonce, sha256(body)].join("\n"));
}

function remoteJsonResponseSignature(secret, requestPath, statusCode, requestNonce, hostIdentity, body) {
  return hmac(secret, ["json-response", requestPath, String(statusCode), requestNonce, hostIdentity, sha256(body)].join("\n"));
}

function remoteStreamOpenSignature(secret, requestPath, requestNonce, headers) {
  return hmac(secret, ["stream-open", requestPath, requestNonce, sha256(canonicalJson(headers))].join("\n"));
}

function remoteStreamEventSignature(secret, requestNonce, sequence, payload) {
  return hmac(secret, ["stream-event", requestNonce, String(Math.max(1, sequence)), sha256(canonicalJson(payload))].join("\n"));
}

function hmac(secret, payload) {
  return crypto.createHmac("sha256", String(secret).replace(/[^a-z0-9]/giu, "").toLowerCase()).update(payload).digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseBody(body) {
  if (!body.trim()) {
    return {};
  }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object body.");
  }
  return parsed;
}

function normalizedMessages(value) {
  return Array.isArray(value)
    ? value.map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: typeof message?.content === "string" ? message.content : "",
      reasoning: typeof message?.reasoning === "string" ? message.reasoning : ""
    })).filter((message) => message.content || message.reasoning)
    : [];
}

function clientKey(request) {
  const explicit = String(request.headers["x-unit0-client-id"] || "").trim();
  if (explicit) {
    return explicit.replace(/[^a-z0-9._:-]/giu, "").slice(0, 120) || "unit0-client";
  }
  return [
    request.socket.remoteAddress || "unknown",
    String(request.headers["user-agent"] || "unknown")
  ].join("|");
}

function localNetworkAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

function stringField(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberField(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveBundledLlamaServerBinary(runtimeRoot = path.resolve(__dirname, "..")) {
  const names = process.platform === "win32" ? ["llama-server.exe", "llama-server"] : ["llama-server", "llama-server.exe"];
  const roots = [
    path.resolve(runtimeRoot),
    process.resourcesPath ? path.resolve(process.resourcesPath) : "",
    process.cwd()
  ].filter(Boolean);
  const seen = new Set();
  for (const root of roots) {
    if (seen.has(root)) {
      continue;
    }
    seen.add(root);
    for (const base of [path.join(root, "runtime", "llama.cpp"), path.join(root, "third_party", "llama.cpp", "build"), root]) {
      for (const name of names) {
        const candidate = path.join(base, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
    }
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cliConfigPath() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  return configIndex >= 0 ? args[configIndex + 1] : process.env.UNIT0_REMOTE_CONFIG;
}

if (require.main === module) {
  const configPath = cliConfigPath();
  if (!configPath) {
    throw new Error("Remote inference server requires --config <path> or UNIT0_REMOTE_CONFIG.");
  }
  const server = createRemoteInferenceServer(loadConfig(configPath));
  server.start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  CAPABILITIES,
  PROTOCOL_VERSION,
  createRemoteInferenceServer,
  loadConfig,
  normalizeConfig,
  resolveBundledLlamaServerBinary,
  saveConfig
};
