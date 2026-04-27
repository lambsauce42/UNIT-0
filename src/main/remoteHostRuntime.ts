import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatAppSettings, ChatDocumentIndex, ChatMessage, ChatModel, ChatRuntimeSettings } from "../shared/types.js";

const PROTOCOL_VERSION = "1";
const REQUIRED_CAPABILITIES = new Set([
  "model_catalog",
  "chat_stream",
  "document_catalog",
  "document_upload",
  "document_cancel",
  "document_search",
  "document_analysis_budget",
  "document_analysis_stream"
]);

type RemoteHostConfig = Pick<ChatAppSettings, "remoteHostAddress" | "remoteHostPort" | "remotePairingCode" | "remoteHostId" | "remoteHostIdentity">;
type RemoteSearchResult = {
  document_id?: string;
  entries?: unknown[];
};

export class RemoteHostRuntime {
  private activeAbortController: AbortController | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async discover(settings: ChatAppSettings): Promise<{ hostId: string; hostIdentity: string; protocolVersion: string; models: ChatModel[] }> {
    const config = remoteConfig(settings);
    const discover = await this.fetchJson(config, "/v1/discover");
    const hostIdentity = stringField(discover.host_identity);
    const protocolVersion = stringField(discover.protocol_version);
    if (!hostIdentity) {
      throw new Error("Remote host did not report a host identity.");
    }
    if (settings.remoteHostIdentity && settings.remoteHostIdentity !== hostIdentity) {
      throw new Error("Remote host identity changed and must be re-approved before reconnecting.");
    }
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Remote host protocol ${protocolVersion || "(missing)"} is incompatible with client protocol ${PROTOCOL_VERSION}.`);
    }
    const capabilities = Array.isArray(discover.capabilities) ? discover.capabilities.map(String) : [];
    const missing = [...REQUIRED_CAPABILITIES].filter((capability) => !capabilities.includes(capability));
    if (missing.length > 0) {
      throw new Error(`Remote host is missing required capabilities: ${missing.join(", ")}.`);
    }
    const hostId = settings.remoteHostId || hostIdentity;
    const catalog = await this.fetchJson({ ...config, remoteHostId: hostId, remoteHostIdentity: hostIdentity }, "/v1/models");
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    return {
      hostId,
      hostIdentity,
      protocolVersion,
      models: models
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const id = stringField(item.id);
          return {
            id,
            label: stringField(item.label) || id,
            path: "",
            providerId: "remote" as const,
            reference: stringField(item.reference),
            sourceLabel: stringField(item.source_label) || "Remote Built-in",
            hostId,
            createdAt: new Date().toISOString()
          };
        })
        .filter((model) => model.id)
    };
  }

  async streamChat(options: {
    settings: ChatAppSettings;
    model: ChatModel;
    runtimeSettings: ChatRuntimeSettings;
    messages: ChatMessage[];
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
  }): Promise<void> {
    const config = remoteConfig(options.settings);
    if (!config.remoteHostIdentity || !config.remoteHostId) {
      throw new Error("Remote host is not configured or trusted.");
    }
    const body = JSON.stringify({
      model_id: options.model.id,
      messages: options.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        created_at: message.createdAt,
        reasoning: message.reasoning ?? "",
        model_label: message.label ?? "",
        provider_id: message.sourceLabel === "Remote Built-in" ? "remote" : "local"
      })),
      settings: remoteRuntimeSettings(options.runtimeSettings),
      remote_session_id: "",
      runtime_slot_id: 0,
      runtime_settings_signature: "",
      request_id: randomUUID(),
      builtin_agentic_framework: "chat",
      document_title: ""
    });
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    try {
      const { response, nonce } = await this.signedFetch(config, "/v1/chat", {
        method: "POST",
        body,
        headers: { "Accept": "application/x-ndjson", "Content-Type": "application/json" },
        signal: abortController.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`Remote host request failed (${response.status}): ${await response.text().catch(() => response.statusText)}`);
      }
      this.validateStreamOpen(config, response, nonce, "/v1/chat");
      let completed = false;
      await readNdjson(response.body, (event, sequence) => {
        this.validateStreamEvent(config, nonce, sequence, event);
        const type = stringField(event.type);
        if (type === "chunk") {
          options.onToken(stringField(event.content));
          options.onReasoning?.(stringField(event.reasoning));
        }
        if (type === "complete") {
          completed = true;
        }
        if (type === "error") {
          throw new Error(stringField(event.message) || "Remote host request failed.");
        }
      });
      if (!completed && !abortController.signal.aborted) {
        throw new Error("Remote host stream ended unexpectedly.");
      }
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  async listDocumentIndexes(settings: ChatAppSettings): Promise<ChatDocumentIndex[]> {
    const config = remoteConfig(settings);
    if (!config.remoteHostIdentity || !config.remoteHostId) {
      throw new Error("Remote host is not configured or trusted.");
    }
    const payload = await this.fetchJson(config, "/v1/documents");
    const documents = Array.isArray(payload.documents) ? payload.documents : [];
    return documents
      .filter(isRecord)
      .map((item) => remoteDocumentIndexFromPayload(settings, item))
      .filter((item): item is ChatDocumentIndex => Boolean(item));
  }

  async createDocumentIndex(options: {
    settings: ChatAppSettings;
    projectId: string;
    title: string;
    sourcePaths: string[];
    remoteModelId: string;
  }): Promise<ChatDocumentIndex> {
    const config = remoteConfig(options.settings);
    if (!config.remoteHostIdentity || !config.remoteHostId) {
      throw new Error("Remote host is not configured or trusted.");
    }
    const documents = options.sourcePaths.map((sourcePath) => {
      const resolved = path.resolve(sourcePath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`Document file not found: ${resolved}`);
      }
      return {
        title: path.basename(resolved) || "document.pdf",
        original_path: path.basename(resolved) || "document.pdf",
        content_base64: fs.readFileSync(resolved).toString("base64")
      };
    });
    const payload = await this.postJson(config, "/v1/documents", {
      remote_model_id: options.remoteModelId,
      title: options.title.trim(),
      documents
    });
    const document = isRecord(payload.document) ? remoteDocumentIndexFromPayload(options.settings, payload.document) : null;
    if (document) {
      return { ...document, projectId: options.projectId, sourcePath: options.sourcePaths.join("\n") };
    }
    const remoteDocumentId = stringField(payload.document_id);
    const wrappedId = buildRemoteDocumentId(options.settings.remoteHostIdentity, remoteDocumentId);
    if (!wrappedId) {
      throw new Error("Remote host did not return a valid document id.");
    }
    const now = new Date().toISOString();
    return {
      id: wrappedId,
      projectId: options.projectId,
      title: options.title.trim() || "Remote document",
      sourcePath: options.sourcePaths.join("\n"),
      state: "building",
      progress: 0,
      message: "Remote index queued",
      createdAt: now,
      updatedAt: now
    };
  }

  async searchDocumentIndex(options: {
    settings: ChatAppSettings;
    documentIndexId: string;
    query: string;
    topK: number;
    budgetTokens: number;
  }): Promise<RemoteSearchResult> {
    const config = remoteConfig(options.settings);
    const remoteDocumentId = unwrapRemoteDocumentId(config, options.documentIndexId);
    const payload = await this.postJson(config, `/v1/documents/${encodeURIComponent(remoteDocumentId)}/search`, {
      query: options.query.trim(),
      top_k: Math.max(1, options.topK),
      budget_tokens: Math.max(0, options.budgetTokens)
    });
    return isRecord(payload.result) ? payload.result as RemoteSearchResult : {};
  }

  async modifyDocumentSearchResults(options: {
    settings: ChatAppSettings;
    documentIndexId: string;
    result: RemoteSearchResult;
    dropResultIds: string[];
    expand: Array<{ resultId: string; before: number; after: number }>;
  }): Promise<RemoteSearchResult> {
    const config = remoteConfig(options.settings);
    const remoteDocumentId = unwrapRemoteDocumentId(config, options.documentIndexId);
    const payload = await this.postJson(config, `/v1/documents/${encodeURIComponent(remoteDocumentId)}/modify-results`, {
      result: unwrapRemoteSearchResult(config, options.result),
      drop_result_ids: options.dropResultIds,
      expand: options.expand.map((item) => ({
        result_id: item.resultId,
        before: Math.max(0, item.before),
        after: Math.max(0, item.after)
      }))
    });
    return isRecord(payload.result) ? payload.result as RemoteSearchResult : {};
  }

  cancelActiveRequest(): void {
    this.activeAbortController?.abort();
  }

  private async fetchJson(config: RemoteHostConfig, path: string): Promise<Record<string, unknown>> {
    const { response, nonce } = await this.signedFetch(config, path, { method: "GET" });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Remote host request failed (${response.status}): ${text || response.statusText}`);
    }
    this.validateJsonResponse(config, response, nonce, path, text);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object response.");
    }
    return parsed as Record<string, unknown>;
  }

  private async postJson(config: RemoteHostConfig, requestPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const { response, nonce } = await this.signedFetch(config, requestPath, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Remote host request failed (${response.status}): ${text || response.statusText}`);
    }
    this.validateJsonResponse(config, response, nonce, requestPath, text);
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("Expected a JSON object response.");
    }
    return parsed;
  }

  private async signedFetch(config: RemoteHostConfig, requestPath: string, init: RequestInit): Promise<{ response: Response; nonce: string }> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID().replace(/-/g, "");
    const body = typeof init.body === "string" ? init.body : "";
    const headers = new Headers(init.headers);
    headers.set("X-Unit0-Auth-Timestamp", timestamp);
    headers.set("X-Unit0-Auth-Nonce", nonce);
    headers.set("X-Unit0-Auth-Signature", remoteRequestSignature(config.remotePairingCode, init.method ?? "GET", requestPath, timestamp, nonce, body));
    const response = await this.fetchImpl(`${remoteBaseUrl(config)}${requestPath}`, { ...init, headers });
    return { response, nonce };
  }

  private validateJsonResponse(config: RemoteHostConfig, response: Response, requestNonce: string, requestPath: string, body: string): void {
    const hostIdentity = response.headers.get("X-Unit0-Host-Identity")?.trim() ?? "";
    if (!hostIdentity) {
      throw new Error("Remote host did not report a host identity.");
    }
    if (config.remoteHostIdentity && config.remoteHostIdentity !== hostIdentity) {
      throw new Error("Remote host identity changed and must be re-approved before reconnecting.");
    }
    const signature = response.headers.get("X-Unit0-Response-Signature")?.trim() ?? "";
    const expectedSignature = remoteJsonResponseSignature(config.remotePairingCode, requestPath, response.status, requestNonce, hostIdentity, body);
    if (!signature || signature !== expectedSignature) {
      throw new Error("Remote host response signature was invalid.");
    }
  }

  private validateStreamOpen(config: RemoteHostConfig, response: Response, requestNonce: string, requestPath: string): void {
    const hostIdentity = response.headers.get("X-Unit0-Host-Identity")?.trim() ?? "";
    if (!hostIdentity) {
      throw new Error("Remote host did not report a host identity.");
    }
    if (config.remoteHostIdentity && config.remoteHostIdentity !== hostIdentity) {
      throw new Error("Remote host identity changed and must be re-approved before reconnecting.");
    }
    const signedHeaders = {
      "X-Unit0-Protocol-Version": response.headers.get("X-Unit0-Protocol-Version")?.trim() ?? "",
      "X-Unit0-Host-Identity": hostIdentity,
      "X-Unit0-Remote-Host-Id": response.headers.get("X-Unit0-Remote-Host-Id")?.trim() ?? "",
      "X-Unit0-Remote-Session-Id": response.headers.get("X-Unit0-Remote-Session-Id")?.trim() ?? "",
      "X-Unit0-Remote-Slot-Id": response.headers.get("X-Unit0-Remote-Slot-Id")?.trim() ?? "",
      "X-Unit0-Remote-Session-Status": response.headers.get("X-Unit0-Remote-Session-Status")?.trim() ?? ""
    };
    const signature = response.headers.get("X-Unit0-Response-Signature")?.trim() ?? "";
    const expectedSignature = remoteStreamOpenSignature(config.remotePairingCode, requestPath, requestNonce, signedHeaders);
    if (!signature || signature !== expectedSignature) {
      throw new Error("Remote host response signature was invalid.");
    }
  }

  private validateStreamEvent(config: RemoteHostConfig, requestNonce: string, sequence: number, event: Record<string, unknown>): void {
    const signature = stringField(event.signature);
    delete event.signature;
    const expectedSignature = remoteStreamEventSignature(config.remotePairingCode, requestNonce, sequence, event);
    if (!signature || signature !== expectedSignature) {
      throw new Error("Remote host stream event signature was invalid.");
    }
  }
}

function remoteConfig(settings: ChatAppSettings): RemoteHostConfig {
  if (!settings.remoteHostAddress.trim()) {
    throw new Error("Remote host address is not configured.");
  }
  if (!settings.remotePairingCode.trim()) {
    throw new Error("Remote host pairing code is required.");
  }
  return settings;
}

function remoteBaseUrl(config: RemoteHostConfig): string {
  const address = config.remoteHostAddress.includes(":") && !config.remoteHostAddress.startsWith("[") ? `[${config.remoteHostAddress}]` : config.remoteHostAddress;
  return `http://${address}:${config.remoteHostPort}`;
}

function remoteRequestSignature(secret: string, method: string, path: string, timestamp: string, nonce: string, body: string): string {
  return hmac(secret, ["request", method.toUpperCase(), path, timestamp, nonce, sha256(body)].join("\n"));
}

export function remoteJsonResponseSignature(secret: string, path: string, statusCode: number, requestNonce: string, hostIdentity: string, body: string): string {
  return hmac(secret, ["json-response", path, String(statusCode), requestNonce, hostIdentity, sha256(body)].join("\n"));
}

export function remoteStreamOpenSignature(secret: string, path: string, requestNonce: string, headers: Record<string, string>): string {
  return hmac(secret, ["stream-open", path, requestNonce, sha256(canonicalJson(headers))].join("\n"));
}

export function remoteStreamEventSignature(secret: string, requestNonce: string, sequence: number, payload: Record<string, unknown>): string {
  return hmac(secret, ["stream-event", requestNonce, String(Math.max(1, sequence)), sha256(canonicalJson(payload))].join("\n"));
}

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret.replace(/[^a-z0-9]/giu, "").toLowerCase()).update(payload).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function remoteRuntimeSettings(settings: ChatRuntimeSettings): Record<string, unknown> {
  return {
    n_ctx: settings.nCtx,
    n_gpu_layers: settings.nGpuLayers,
    reasoning_effort: settings.reasoningEffort,
    permission_mode: settings.permissionMode,
    system_prompt: settings.systemPrompt,
    system_prompt_customized: Boolean(settings.systemPrompt),
    temperature: settings.temperature,
    repeat_penalty: settings.repeatPenalty,
    trim_trigger_remaining_tokens: settings.trimReserveTokens,
    trim_trigger_remaining_ratio: settings.trimReservePercent,
    trim_target_cleared_tokens: settings.trimAmountTokens,
    trim_target_cleared_ratio: settings.trimAmountPercent,
    max_tokens: settings.maxTokens
  };
}

async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (event: Record<string, unknown>, sequence: number) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sequence = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/g);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        sequence += 1;
        onEvent(JSON.parse(line) as Record<string, unknown>, sequence);
      }
    }
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function buildRemoteDocumentId(hostIdentity: string, remoteDocumentId: string): string {
  return hostIdentity.trim() && remoteDocumentId.trim() ? `remote-doc::${hostIdentity.trim()}::${remoteDocumentId.trim()}` : "";
}

function unwrapRemoteDocumentId(config: RemoteHostConfig, identifier: string): string {
  const prefix = `remote-doc::${config.remoteHostIdentity}::`;
  if (!identifier.startsWith(prefix)) {
    throw new Error("Selected remote document index does not belong to this host.");
  }
  return identifier.slice(prefix.length).trim();
}

function unwrapRemoteSearchResult(config: RemoteHostConfig, result: RemoteSearchResult): RemoteSearchResult {
  const remoteId = result.document_id ? unwrapRemoteDocumentId(config, result.document_id) : "";
  return remoteId ? { ...result, document_id: remoteId } : result;
}

function remoteDocumentIndexFromPayload(settings: ChatAppSettings, payload: Record<string, unknown>): ChatDocumentIndex | null {
  const remoteDocumentId = stringField(payload.id) || stringField(payload.document_id);
  const id = buildRemoteDocumentId(settings.remoteHostIdentity, remoteDocumentId);
  if (!id) {
    return null;
  }
  const now = new Date().toISOString();
  const sourceTitles = Array.isArray(payload.source_titles) ? payload.source_titles.map(String).filter(Boolean) : [];
  const state = stringField(payload.state);
  return {
    id,
    projectId: "",
    title: stringField(payload.title) || "Remote document",
    sourcePath: sourceTitles.join("\n"),
    state: state === "error" ? "error" : state === "ready" ? "ready" : "building",
    progress: boundedNumber(payload.progress, 0, 1),
    message: stringField(payload.message) || stringField(payload.status_message),
    createdAt: stringField(payload.created_at) || now,
    updatedAt: stringField(payload.updated_at) || now
  };
}

function boundedNumber(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
}
