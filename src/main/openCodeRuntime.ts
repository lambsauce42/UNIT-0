import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import type { ChatPermissionMode, ChatRuntimeSettings, ChatTimelineBlock } from "../shared/types.js";
import { GptOssChannelParser, type LocalLlamaOpenAiEndpoint } from "./localLlamaRuntime.js";

const requireFromOpenCodeRuntime = createRequire(__filename);
const OPENCODE_PROVIDER_ID = "unit0-local";
const OPENCODE_MODEL_ID = "unit0-model";

export type OpenCodeRunOptions = {
  cwd: string;
  prompt: string;
  sessionId?: string;
  modelLabel: string;
  nativeGptOss: boolean;
  endpoint: LocalLlamaOpenAiEndpoint;
  settings: ChatRuntimeSettings;
  permissionMode: ChatPermissionMode;
};

export type OpenCodeRuntimeEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "assistant.delta"; id: string; status: string; text: string; replace?: boolean; sessionId?: string }
  | { type: "reasoning.delta"; id: string; status: string; text: string; replace?: boolean; sessionId?: string }
  | { type: "timeline"; eventType: "item.started" | "item.updated" | "item.completed"; block: ChatTimelineBlock; sessionId?: string }
  | { type: "final.snapshot"; content: string; reasoning: string }
  | { type: "turn.completed"; sessionId?: string }
  | { type: "error"; message: string; details?: string; sessionId?: string };

type OpenCodeConfig = Record<string, unknown>;

type OpenCodeServer = {
  url: string;
  process: ChildProcess;
};

type QueuedOpenCodeEvent =
  | { kind: "event"; event: OpenCodeRuntimeEvent }
  | { kind: "stream.closed" }
  | { kind: "error"; error: Error };

type OpenCodePart = {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  delta?: string;
  tool?: string;
  callID?: string;
  state?: Record<string, unknown>;
  files?: string[];
  hash?: string;
  reason?: string;
  cost?: number;
  tokens?: unknown;
};

type OpenCodePartSnapshotState = Map<string, { text: string; streamed: boolean }>;
type OpenCodePartTextUpdate = { text: string; replace: boolean };

type PendingPermission = {
  serverUrl: string;
  cwd: string;
};

type OpenCodeHarmonyState = {
  parser: GptOssChannelParser;
  rawText: string;
  sawHarmonyMarker: boolean;
  completed: boolean;
  streamedFlattenedReasoningLength: number;
  streamedFlattenedReasoning: string;
  flattenedContentStartIndex: number | null;
  streamedFlattenedContentLength: number;
  harmonyParserStarted: boolean;
};

export interface OpenCodeRuntime {
  runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent>;
  answerApproval(permissionId: string, decision: "approve" | "deny"): Promise<void>;
  cancelActiveRequest(): void;
  close(): void;
}

export class RealOpenCodeRuntime implements OpenCodeRuntime {
  private activeAbortController: AbortController | null = null;
  private activeSessionId = "";
  private activeServerUrl = "";
  private activeCwd = "";
  private activeServer: OpenCodeServer | null = null;
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  async *runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    let server: OpenCodeServer | null = null;
    let eventStream: Promise<void> | null = null;
    const eventQueue = new AsyncEventQueue();
    let sessionId = options.sessionId?.trim() ?? "";
    let latestAssistantMessageId = "";
    const harmonyStates = new Map<string, OpenCodeHarmonyState>();
    const normalizeGptOss = options.nativeGptOss;
    try {
      server = await startOpenCodeServer({
        config: openCodeConfig(options),
        signal: abortController.signal
      });
      this.activeServer = server;
      this.activeServerUrl = server.url;
      this.activeCwd = options.cwd;
      if (!sessionId) {
        const session = await openCodeJson<{ id?: string }>(server.url, "/session", {
          method: "POST",
          cwd: options.cwd,
          body: { title: options.prompt.slice(0, 80) || "OpenCode session" },
          signal: abortController.signal
        });
        sessionId = String(session.id ?? "");
        if (!sessionId) {
          throw new Error("OpenCode did not return a session id.");
        }
      }
      this.activeSessionId = sessionId;
      eventStream = readOpenCodeEvents(server.url, options.cwd, abortController.signal, (event) => {
        const eventSessionId = eventSessionIdOf(event);
        if (eventSessionId && eventSessionId !== sessionId) {
          return;
        }
        if (event.type === "session.started") {
          return;
        }
        if ((event.type === "assistant.delta" || event.type === "reasoning.delta") && event.id) {
          latestAssistantMessageId = messageIdFromPartId(event.id);
        }
        if (event.type === "timeline" && event.block.kind === "approval" && server) {
          this.pendingPermissions.set(event.block.id, {
            serverUrl: server.url,
            cwd: options.cwd
          });
        }
        for (const normalizedEvent of normalizeOpenCodeHarmonyEvent(event, harmonyStates, normalizeGptOss)) {
          eventQueue.push({ kind: "event", event: normalizedEvent });
        }
      }, (message, details) => {
        eventQueue.push({ kind: "event", event: { type: "error", message, details } });
      }).then(() => eventQueue.push({ kind: "stream.closed" }), (error) => {
        if (!abortController.signal.aborted) {
          eventQueue.push({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
        }
      });
      yield { type: "session.started", sessionId };
      await openCodeJson<void>(server.url, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        cwd: options.cwd,
        body: {
          model: { providerID: OPENCODE_PROVIDER_ID, modelID: OPENCODE_MODEL_ID },
          agent: "build",
          system: options.settings.systemPrompt.trim() || undefined,
          parts: [{ type: "text", text: options.prompt }]
        },
        signal: abortController.signal,
          emptyOk: true
        });
      let sawTurnCompleted = false;
      const consumeQueuedEvent = (queued: QueuedOpenCodeEvent): OpenCodeRuntimeEvent | null => {
        if (queued.kind === "stream.closed") {
          if (sawTurnCompleted) {
            return null;
          }
          throw new Error("OpenCode event stream closed before turn completion.");
        }
        if (queued.kind === "error") {
          throw queued.error;
        }
        if (!isSessionScopedEvent(queued.event, sessionId)) {
          return null;
        }
        if (queued.event.type === "turn.completed") {
          sawTurnCompleted = true;
          return null;
        }
        return queued.event;
      };
      while (!sawTurnCompleted) {
        const next = await eventQueue.shift();
        const event = consumeQueuedEvent(next);
        if (event) {
          yield event;
        }
      }
      let queued: QueuedOpenCodeEvent | null;
      while ((queued = eventQueue.tryShift())) {
        const event = consumeQueuedEvent(queued);
        if (event) {
          yield event;
        }
      }
      const snapshot = latestAssistantMessageId
        ? await openCodeJson<{ info?: unknown; parts?: OpenCodePart[] }>(server.url, `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(latestAssistantMessageId)}`, {
          method: "GET",
          cwd: options.cwd,
          signal: abortController.signal
        }).catch(() => null)
        : null;
      if (snapshot?.parts) {
        yield finalSnapshotEvent(snapshot.parts, normalizeGptOss);
      }
      yield { type: "turn.completed" };
      abortController.abort();
      await eventStream.catch(() => undefined);
    } finally {
      abortController.abort();
      await eventStream?.catch(() => undefined);
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
        this.activeSessionId = "";
        this.activeServerUrl = "";
        this.activeCwd = "";
      }
      if (server) {
        stopOpenCodeServer(server);
      }
      if (server && this.activeServer === server) {
        this.activeServer = null;
      }
    }
  }

  async answerApproval(permissionId: string, decision: "approve" | "deny"): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`Unknown OpenCode permission id: ${permissionId}`);
    }
    this.pendingPermissions.delete(permissionId);
    await openCodeJson<boolean>(pending.serverUrl, `/permission/${encodeURIComponent(permissionId)}/reply`, {
      method: "POST",
      cwd: pending.cwd,
      body: { reply: decision === "approve" ? "once" : "reject" },
      emptyOk: true
    });
  }

  cancelActiveRequest(): void {
    if (this.activeServerUrl && this.activeSessionId) {
      void openCodeJson<boolean>(this.activeServerUrl, `/session/${encodeURIComponent(this.activeSessionId)}/abort`, {
        method: "POST",
        cwd: this.activeCwd,
        emptyOk: true
      }).catch(() => undefined);
    }
    this.activeAbortController?.abort();
  }

  close(): void {
    this.cancelActiveRequest();
    if (this.activeServer) {
      stopOpenCodeServer(this.activeServer);
      this.activeServer = null;
    }
    this.pendingPermissions.clear();
  }
}

class AsyncEventQueue {
  private readonly values: QueuedOpenCodeEvent[] = [];
  private readonly resolvers: Array<(value: QueuedOpenCodeEvent) => void> = [];

  push(value: QueuedOpenCodeEvent): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve(value);
      return;
    }
    this.values.push(value);
  }

  shift(): Promise<QueuedOpenCodeEvent> {
    const value = this.values.shift();
    if (value) {
      return Promise.resolve(value);
    }
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  tryShift(): QueuedOpenCodeEvent | null {
    return this.values.shift() ?? null;
  }
}

function openCodeConfig(options: OpenCodeRunOptions): OpenCodeConfig {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model: `${OPENCODE_PROVIDER_ID}/${OPENCODE_MODEL_ID}`,
    small_model: `${OPENCODE_PROVIDER_ID}/${OPENCODE_MODEL_ID}`,
    enabled_providers: [OPENCODE_PROVIDER_ID],
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Unit-0 local llama.cpp",
        options: {
          baseURL: `${options.endpoint.baseUrl}/v1`,
          apiKey: "unit0-local"
        },
        models: {
          [OPENCODE_MODEL_ID]: {
            name: options.modelLabel || options.endpoint.modelId,
            options: {
              temperature: options.settings.temperature,
              maxTokens: options.settings.maxTokens
            }
          }
        }
      }
    },
    permission: openCodePermissions(options.permissionMode)
  };
}

function openCodePermissions(permissionMode: ChatPermissionMode): Record<string, unknown> {
  const bash = permissionMode === "full_access" ? "allow" : "ask";
  return {
    read: "allow",
    edit: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    todowrite: "allow",
    task: "allow",
    bash,
    external_directory: permissionMode === "full_access" ? "allow" : "ask",
    webfetch: "ask",
    websearch: "ask",
    question: "allow"
  };
}

async function startOpenCodeServer(options: { config: OpenCodeConfig; signal: AbortSignal }): Promise<OpenCodeServer> {
  const port = await reserveLocalPort();
  const command = resolveOpenCodeBinary();
  const server = spawn(command, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config)
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const url = await waitForOpenCodeServer(server, port, options.signal);
  return { url, process: server };
}

function waitForOpenCodeServer(server: ChildProcess, port: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/g)) {
        if (line.startsWith("opencode server listening")) {
          const match = /on\s+(https?:\/\/[^\s]+)/u.exec(line);
          settle(() => resolve(match?.[1] ?? `http://127.0.0.1:${port}`));
          return;
        }
      }
    };
    const onAbort = () => {
      stopOpenCodeProcess(server);
      settle(() => reject(new Error("OpenCode server startup was cancelled.")));
    };
    const timer = setTimeout(() => {
      stopOpenCodeProcess(server);
      settle(() => reject(new Error(`OpenCode server startup timed out.${output.trim() ? `\n${output.trim()}` : ""}`)));
    }, 30_000);
    server.stdout?.on("data", onData);
    server.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    server.on("error", (error) => settle(() => reject(error)));
    server.on("exit", (code) => settle(() => reject(new Error(`OpenCode server exited during startup with code ${code}.${output.trim() ? `\n${output.trim()}` : ""}`))));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readOpenCodeEvents(
  serverUrl: string,
  cwd: string,
  signal: AbortSignal,
  onEvent: (event: OpenCodeRuntimeEvent) => void,
  onErrorEvent: (message: string, details?: string) => void
): Promise<void> {
  const response = await fetch(openCodeUrl(serverUrl, "/event", cwd), {
    headers: { Accept: "text/event-stream" },
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`OpenCode event stream failed (${response.status}): ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const partSnapshots: OpenCodePartSnapshotState = new Map();
  const processChunk = (chunk: string) => {
    const data = sseData(chunk);
    if (!data) {
      return;
    }
    try {
      for (const event of mapOpenCodeEvent(JSON.parse(data) as Record<string, unknown>, onErrorEvent, partSnapshots)) {
        onEvent(event);
      }
    } catch (error) {
      onErrorEvent("OpenCode emitted an event that Unit-0 could not parse.", error instanceof Error ? error.message : String(error));
    }
  };
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      const drained = splitSseFrames(buffer, true);
      buffer = drained.rest;
      for (const chunk of drained.frames) {
        processChunk(chunk);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const drained = splitSseFrames(buffer);
    buffer = drained.rest;
    for (const chunk of drained.frames) {
      processChunk(chunk);
    }
  }
}

export function splitSseFrames(buffer: string, flush = false): { frames: string[]; rest: string } {
  const frames: string[] = [];
  const separator = /\r?\n\r?\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(buffer))) {
    frames.push(buffer.slice(start, match.index));
    start = match.index + match[0].length;
  }
  const rest = buffer.slice(start);
  if (flush && rest.trim()) {
    frames.push(rest);
    return { frames, rest: "" };
  }
  return { frames, rest };
}

export function* mapOpenCodeEvent(raw: Record<string, unknown>, onErrorEvent: (message: string, details?: string) => void, partSnapshots?: OpenCodePartSnapshotState): Iterable<OpenCodeRuntimeEvent> {
  const type = String(raw.type ?? "");
  const properties = isRecord(raw.properties) ? raw.properties : {};
  if (type === "message.part.delta") {
    const sessionId = String(properties.sessionID ?? "");
    const messageId = String(properties.messageID ?? "message");
    const partId = String(properties.partID ?? randomUUID());
    const field = String(properties.field ?? "");
    const delta = typeof properties.delta === "string" ? properties.delta : "";
    if (delta && field === "text") {
      appendPartSnapshotDelta(partSnapshots, `${sessionId}:${messageId}:${partId}:text`, delta);
      yield { type: "assistant.delta", id: `${messageId}:${partId}`, status: "updated", text: delta, sessionId };
    }
    if (delta && field === "reasoning") {
      appendPartSnapshotDelta(partSnapshots, `${sessionId}:${messageId}:${partId}:reasoning`, delta);
      yield { type: "reasoning.delta", id: `${messageId}:${partId}`, status: "updated", text: delta, sessionId };
    }
    return;
  }
  if (type === "message.part.updated") {
    const part = isRecord(properties.part) ? properties.part as OpenCodePart : {};
    const sessionId = String(properties.sessionID ?? part.sessionID ?? "");
    const delta = typeof properties.delta === "string" ? properties.delta : undefined;
    const event = partToRuntimeEvent(part, delta, sessionId, partSnapshots);
    if (event) {
      if (event.type === "assistant.delta" || event.type === "reasoning.delta" || event.type === "timeline" || event.type === "turn.completed" || event.type === "error") {
        yield { ...event, sessionId };
      } else {
        yield event;
      }
    }
    return;
  }
  if (type === "permission.asked") {
    const request = properties;
    const sessionId = String(request.sessionID ?? "");
    const permissionId = String(request.id ?? randomUUID());
    yield {
      type: "timeline",
      eventType: "item.started",
      block: {
        kind: "approval",
        id: permissionId,
        status: "requested",
        title: `OpenCode approval required: ${String(request.permission ?? "permission")}`,
        details: formatPermissionDetails(request),
        requestMethod: "opencode",
        toolCallId: sessionId
      },
      sessionId
    };
    return;
  }
  if (type === "permission.replied") {
    const sessionId = String(properties.sessionID ?? "");
    const permissionId = String(properties.requestID ?? "");
    if (permissionId) {
      yield {
        type: "timeline",
        eventType: "item.completed",
        block: {
          kind: "approval",
          id: permissionId,
          status: "completed",
          title: "Approval answered",
          decision: String(properties.reply ?? "")
        },
        sessionId
      };
    }
    return;
  }
  if (type === "session.idle") {
    yield { type: "turn.completed", sessionId: String(properties.sessionID ?? "") };
    return;
  }
  if (type === "session.error") {
    onErrorEvent("OpenCode session failed.", JSON.stringify(properties.error ?? properties));
  }
}

function partToRuntimeEvent(part: OpenCodePart, delta?: string, sessionId = "", partSnapshots?: OpenCodePartSnapshotState): OpenCodeRuntimeEvent | null {
  const partId = `${part.messageID ?? "message"}:${part.id ?? randomUUID()}`;
  if (part.type === "text") {
    const update = partTextDelta(partSnapshots, `${sessionId}:${partId}:text`, typeof part.text === "string" ? part.text : undefined, delta);
    if (!update) {
      return null;
    }
    return update.text || update.replace ? { type: "assistant.delta", id: partId, status: "updated", text: update.text, replace: update.replace || undefined } : null;
  }
  if (part.type === "reasoning") {
    const update = partTextDelta(partSnapshots, `${sessionId}:${partId}:reasoning`, typeof part.text === "string" ? part.text : undefined, delta);
    if (!update) {
      return null;
    }
    return update.text || update.replace ? { type: "reasoning.delta", id: partId, status: "updated", text: update.text, replace: update.replace || undefined } : null;
  }
  if (part.type === "tool") {
    const state = part.state ?? {};
    const status = mapToolStatus(String(state.status ?? ""));
    const input = isRecord(state.input) ? state.input : {};
    const output = typeof state.output === "string"
      ? state.output
      : typeof state.error === "string"
        ? state.error
        : undefined;
    const title = typeof state.title === "string" ? state.title : "";
    const command = typeof input.command === "string" ? input.command : undefined;
    return {
      type: "timeline",
      eventType: status === "completed" || status === "failed" ? "item.completed" : status === "started" ? "item.started" : "item.updated",
      block: {
        kind: "tool",
        id: part.callID ?? partId,
        toolName: part.tool ?? "tool",
        status,
        summary: title || command || part.tool,
        command,
        output,
        initiallyExpanded: status === "started"
      }
    };
  }
  if (part.type === "patch") {
    const files = Array.isArray(part.files) ? part.files.filter((item): item is string => typeof item === "string") : [];
    return {
      type: "timeline",
      eventType: "item.completed",
      block: {
        kind: "diff",
        id: partId,
        status: "completed",
        summary: files.length === 1 ? files[0] : `${files.length} file changes`,
        filesChanged: files.length,
        changes: files.map((file) => ({ path: file }))
      }
    };
  }
  if (part.type === "step-finish") {
    return {
      type: "timeline",
      eventType: "item.completed",
      block: {
        kind: "status",
        id: partId,
        level: "info",
        message: `OpenCode step finished: ${part.reason ?? "done"}`
      }
    };
  }
  return null;
}

function partSnapshotDelta(partSnapshots: OpenCodePartSnapshotState | undefined, key: string, text: string | undefined): OpenCodePartTextUpdate | undefined {
  if (!partSnapshots || text === undefined) {
    return undefined;
  }
  const previous = partSnapshots.get(key);
  if (previous === undefined) {
    partSnapshots.set(key, { text, streamed: false });
    return undefined;
  }
  if (!previous.streamed) {
    partSnapshots.set(key, { text, streamed: false });
    return undefined;
  }
  if (text.startsWith(previous.text)) {
    partSnapshots.set(key, { text, streamed: true });
    return { text: text.slice(previous.text.length), replace: false };
  }
  if (previous.text.startsWith(text)) {
    partSnapshots.set(key, { text, streamed: true });
    return { text, replace: true };
  }
  partSnapshots.set(key, { text, streamed: true });
  return { text, replace: true };
}

function partTextDelta(partSnapshots: OpenCodePartSnapshotState | undefined, key: string, fullText: string | undefined, delta: string | undefined): OpenCodePartTextUpdate | undefined {
  if (delta !== undefined) {
    const previous = partSnapshots?.get(key);
    if (partSnapshots && previous !== undefined && fullText !== undefined && fullText !== `${previous.text}${delta}`) {
      partSnapshots.set(key, { text: fullText, streamed: true });
      return { text: fullText, replace: true };
    }
    if (partSnapshots) {
      partSnapshots.set(key, { text: fullText ?? `${partSnapshots.get(key)?.text ?? ""}${delta}`, streamed: true });
    }
    return { text: delta, replace: false };
  }
  return partSnapshotDelta(partSnapshots, key, fullText);
}

function appendPartSnapshotDelta(partSnapshots: OpenCodePartSnapshotState | undefined, key: string, delta: string): void {
  if (!partSnapshots) {
    return;
  }
  partSnapshots.set(key, { text: `${partSnapshots.get(key)?.text ?? ""}${delta}`, streamed: true });
}

export function normalizeOpenCodeHarmonyEvent(event: OpenCodeRuntimeEvent, states: Map<string, OpenCodeHarmonyState>, nativeGptOss = true): OpenCodeRuntimeEvent[] {
  if (event.type !== "assistant.delta") {
    return [event];
  }
  if (!nativeGptOss) {
    return [event];
  }
  const state = states.get(event.id) ?? {
    parser: new GptOssChannelParser({ defaultChannel: "final", toolRecipients: ["shell"] }),
    rawText: "",
    sawHarmonyMarker: false,
    completed: false,
    streamedFlattenedReasoningLength: 0,
    streamedFlattenedReasoning: "",
    flattenedContentStartIndex: null,
    streamedFlattenedContentLength: 0,
    harmonyParserStarted: false
  };
  states.set(event.id, state);
  if (event.replace) {
    state.parser = new GptOssChannelParser({ defaultChannel: "final", toolRecipients: ["shell"] });
    state.rawText = "";
    state.sawHarmonyMarker = false;
    state.completed = false;
    state.streamedFlattenedReasoningLength = 0;
    state.streamedFlattenedReasoning = "";
    state.flattenedContentStartIndex = null;
    state.streamedFlattenedContentLength = 0;
    state.harmonyParserStarted = false;
  } else if (state.completed) {
    return [];
  }
  state.rawText += event.text;
  state.sawHarmonyMarker = state.sawHarmonyMarker || containsHarmonyChannelMarker(event.text) || containsHarmonyChannelMarker(state.rawText);
  if (!state.sawHarmonyMarker) {
    const parsed = parseFlattenedGptOssText(state.rawText);
    const live = parseLiveFlattenedGptOssText(state.rawText, state.flattenedContentStartIndex);
    if (!live.hasBoundary) {
      if (!parsed.complete) {
        return [];
      }
      state.completed = true;
      return parsed.content ? [{ ...event, text: parsed.content, replace: event.replace || undefined }] : [];
    }
    const nextReasoning = parsed.complete ? parsed.reasoning : live.reasoning;
    if (!nextReasoning && !parsed.complete) {
      return [];
    }
    const events: OpenCodeRuntimeEvent[] = [];
    if (nextReasoning.startsWith(state.streamedFlattenedReasoning)) {
      const reasoningDelta = nextReasoning.slice(state.streamedFlattenedReasoningLength);
      state.streamedFlattenedReasoning = nextReasoning;
      state.streamedFlattenedReasoningLength = nextReasoning.length;
      if (reasoningDelta) {
        events.push({
          type: "reasoning.delta",
          id: `${event.id}:reasoning`,
          status: event.status,
          text: reasoningDelta,
          replace: event.replace || undefined,
          sessionId: event.sessionId
        });
      }
    }
    if (parsed.complete) {
      state.completed = true;
      const finalContentDelta = parsed.content.slice(state.streamedFlattenedContentLength);
      if (finalContentDelta) {
        state.streamedFlattenedContentLength = parsed.content.length;
        events.push({ ...event, text: finalContentDelta, replace: event.replace || undefined });
      }
      events.sort((left, right) => (left.type === "assistant.delta" ? 1 : 0) - (right.type === "assistant.delta" ? 1 : 0));
    }
    return events;
  }
  const textForParser = state.harmonyParserStarted ? event.text : state.rawText;
  state.harmonyParserStarted = true;
  const parsed = state.parser.push(textForParser);
  const events: OpenCodeRuntimeEvent[] = [];
  if (parsed.reasoning) {
    events.push({
      type: "reasoning.delta",
      id: `${event.id}:reasoning`,
      status: event.status,
      text: parsed.reasoning,
      replace: event.replace || undefined,
      sessionId: event.sessionId
    });
  }
  if (parsed.content) {
    events.push({ ...event, text: parsed.content, replace: event.replace || undefined });
  }
  return events;
}

function finalSnapshotEvent(parts: OpenCodePart[], nativeGptOss: boolean): OpenCodeRuntimeEvent {
  const text = partsText(parts, "text");
  const nativeReasoning = partsText(parts, "reasoning");
  if (!nativeGptOss) {
    return {
      type: "final.snapshot",
      content: text,
      reasoning: nativeReasoning
    };
  }
  const parsed = parseOpenCodeHarmonySnapshot(text);
  return {
    type: "final.snapshot",
    content: parsed.content,
    reasoning: `${nativeReasoning}${parsed.reasoning}`
  };
}

export function parseOpenCodeHarmonySnapshot(text: string): { content: string; reasoning: string } {
  if (!text) {
    return { content: "", reasoning: "" };
  }
  if (!containsHarmonyChannelMarker(text) && text.includes("<|return|>")) {
    return splitFlattenedGptOssReturnText(text);
  }
  const parser = new GptOssChannelParser({ defaultChannel: "final", toolRecipients: ["shell"] });
  const first = parser.push(text);
  const last = parser.finish();
  return {
    content: `${first.content}${last.content}`,
    reasoning: `${first.reasoning}${last.reasoning}`
  };
}

function splitFlattenedGptOssReturnText(text: string): { content: string; reasoning: string } {
  const parsed = parseFlattenedGptOssText(text);
  return { content: parsed.content, reasoning: parsed.reasoning };
}

function parseFlattenedGptOssText(text: string): { content: string; reasoning: string; hasBoundary: boolean; complete: boolean } {
  const returnIndex = text.indexOf("<|return|>");
  const complete = returnIndex >= 0;
  const beforeReturn = complete ? text.slice(0, returnIndex) : text;
  const cleanedRaw = stripIncompleteHarmonyMarker(stripHarmonyMarkers(beforeReturn));
  const cleaned = cleanedRaw.trim();
  if (!cleaned) {
    return { content: "", reasoning: "", hasBoundary: false, complete };
  }
  const paragraphSplit = /\r?\n\s*\r?\n/u;
  const hasParagraphBoundary = paragraphSplit.test(cleanedRaw);
  const endsWithParagraphBoundary = /\r?\n\s*\r?\n\s*$/u.test(cleanedRaw);
  if (!complete && endsWithParagraphBoundary) {
    return {
      reasoning: cleaned,
      content: "",
      hasBoundary: true,
      complete
    };
  }
  const paragraphs = cleanedRaw.split(paragraphSplit).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length > 1) {
    return {
      reasoning: paragraphs.slice(0, -1).join("\n\n"),
      content: paragraphs.at(-1) ?? "",
      hasBoundary: true,
      complete
    };
  }
  return {
    content: complete ? cleaned : "",
    reasoning: "",
    hasBoundary: hasParagraphBoundary,
    complete
  };
}

function parseLiveFlattenedGptOssText(text: string, lockedContentStartIndex: number | null): { content: string; reasoning: string; hasBoundary: boolean; contentStartIndex: number } {
  const returnIndex = text.indexOf("<|return|>");
  const beforeReturn = returnIndex >= 0 ? text.slice(0, returnIndex) : text;
  const cleanedRaw = stripIncompleteHarmonyMarker(stripHarmonyMarkers(beforeReturn));
  void lockedContentStartIndex;
  const paragraphSplit = /\r?\n\s*\r?\n/u;
  const hasBoundary = paragraphSplit.test(cleanedRaw);
  if (!hasBoundary) {
    return { content: "", reasoning: "", hasBoundary: false, contentStartIndex: 0 };
  }
  const paragraphs = cleanedRaw.split(paragraphSplit).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    return { content: "", reasoning: "", hasBoundary: false, contentStartIndex: 0 };
  }
  const endsWithBoundary = /\r?\n\s*\r?\n\s*$/u.test(cleanedRaw);
  const reasoningParagraphs = paragraphs.length === 1 && endsWithBoundary ? paragraphs : paragraphs.slice(0, -1);
  const reasoning = reasoningParagraphs.join("\n\n");
  const content = paragraphs.length > reasoningParagraphs.length ? paragraphs.at(-1) ?? "" : "";
  const contentStartIndex = Math.max(0, cleanedRaw.length - content.length);
  return { content, reasoning, hasBoundary: true, contentStartIndex };
}

function stripHarmonyMarkers(text: string): string {
  return text
    .replace(/<\|start\|>assistant/g, "")
    .replace(/<\|channel\|>(?:analysis|final|commentary)(?:\s+to=[^<\s]+)?(?:\s+<\|constrain\|>json)?<\|message\|>/g, "")
    .replace(/<\|(?:end|call|return)\|>/g, "");
}

function stripIncompleteHarmonyMarker(text: string): string {
  return text.replace(/<\|?[^>]*$/u, "");
}

async function openCodeJson<T>(serverUrl: string, route: string, options: {
  method: "GET" | "POST";
  cwd: string;
  body?: unknown;
  signal?: AbortSignal;
  emptyOk?: boolean;
}): Promise<T> {
  const response = await fetch(openCodeUrl(serverUrl, route, options.cwd), {
    method: options.method,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenCode request failed (${response.status}): ${body || response.statusText}`);
  }
  if (response.status === 204 || !response.headers.get("content-type")?.includes("application/json")) {
    return undefined as T;
  }
  return await response.json() as T;
}

function openCodeUrl(serverUrl: string, route: string, cwd: string): string {
  const url = new URL(route, serverUrl);
  url.searchParams.set("directory", cwd);
  return url.toString();
}

function resolveOpenCodeBinary(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" || process.arch === "arm64" || process.arch === "arm" ? process.arch : process.arch;
  const binary = process.platform === "win32" ? "opencode.exe" : "opencode";
  const packageNames = [
    `opencode-${platform}-${arch}`,
    `opencode-${platform}-${arch}-baseline`,
    `opencode-${platform}-${arch}-musl`,
    `opencode-${platform}-${arch}-baseline-musl`
  ];
  for (const packageName of packageNames) {
    try {
      const packageJsonPath = requireFromOpenCodeRuntime.resolve(`${packageName}/package.json`);
      return path.join(path.dirname(packageJsonPath), "bin", binary);
    } catch {
      // Try the next platform package.
    }
  }
  throw new Error(`OpenCode binary package was not installed for ${platform}/${arch}.`);
}

function stopOpenCodeServer(server: OpenCodeServer): void {
  stopOpenCodeProcess(server.process);
}

function stopOpenCodeProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill();
}

function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve an OpenCode server port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function sseData(chunk: string): string {
  return chunk
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/u, ""))
    .join("\n")
    .trim();
}

function mapToolStatus(status: string): string {
  if (status === "completed") {
    return "completed";
  }
  if (status === "error") {
    return "failed";
  }
  if (status === "running") {
    return "started";
  }
  return "updated";
}

function formatPermissionDetails(permission: Record<string, unknown>): string {
  const metadata = isRecord(permission.metadata) ? permission.metadata : {};
  const command = typeof metadata.command === "string" ? metadata.command : "";
  const patterns = Array.isArray(permission.patterns)
    ? permission.patterns.filter((item): item is string => typeof item === "string")
    : typeof permission.pattern === "string"
      ? [permission.pattern]
      : [];
  const always = Array.isArray(permission.always) ? permission.always.filter((item): item is string => typeof item === "string") : [];
  return [
    command ? `Command: ${command}` : "",
    patterns.length > 0 ? `Patterns: ${patterns.join(", ")}` : "",
    always.length > 0 ? `Always: ${always.join(", ")}` : "",
    Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : ""
  ].filter(Boolean).join("\n\n");
}

function partsText(parts: OpenCodePart[], type: "text" | "reasoning"): string {
  return parts
    .filter((part) => part.type === type && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function messageIdFromPartId(partId: string): string {
  return partId.split(":")[0] ?? "";
}

function containsHarmonyChannelMarker(text: string): boolean {
  return text.includes("<|channel|>") || text.includes("<|start|>assistant");
}

function isSessionScopedEvent(event: OpenCodeRuntimeEvent, sessionId: string): boolean {
  const eventSessionId = eventSessionIdOf(event);
  if (eventSessionId && eventSessionId !== sessionId) {
    return false;
  }
  if (event.type === "session.started" || event.type === "final.snapshot" || event.type === "turn.completed" || event.type === "error") {
    return true;
  }
  if (event.type === "timeline" && event.block.kind === "approval") {
    return event.block.toolCallId === sessionId || !event.block.toolCallId;
  }
  return true;
}

function eventSessionIdOf(event: OpenCodeRuntimeEvent): string {
  if (event.type === "session.started") {
    return event.sessionId;
  }
  if (event.type === "final.snapshot") {
    return "";
  }
  return event.sessionId ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
