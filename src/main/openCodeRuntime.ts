import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type Server } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import type { ChatPermissionMode, ChatRuntimeSettings, ChatTimelineBlock } from "../shared/types.js";
import { GptOssChannelParser, renderGptOssOpenCodeSystemPrompt, type GptOssChannelParserResult, type LocalLlamaOpenAiEndpoint } from "./localLlamaRuntime.js";

const requireFromOpenCodeRuntime = createRequire(__filename);
const OPENCODE_PROVIDER_ID = "unit0-local";
const OPENCODE_MODEL_ID = "unit0-model";
const OPENCODE_DEBUG_LOG = process.env.UNIT0_OPENCODE_DEBUG_LOG;
const OPENCODE_MIN_COMPLETION_TOKENS = 64;
const OPENCODE_FINAL_CONTINUATION_PREFIX = "<|start|>assistant<|channel|>final<|message|>";
const OPENCODE_FINAL_CONTINUATION_MARKER = `<|end|>${OPENCODE_FINAL_CONTINUATION_PREFIX}`;

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

type OpenCodeConfigOptions = Omit<OpenCodeRunOptions, "endpoint"> & {
  endpoint: { baseUrl: string; modelId: string };
};

export type OpenCodeRuntimeEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "assistant.delta"; id: string; status: string; text: string; replace?: boolean; sessionId?: string }
  | { type: "reasoning.delta"; id: string; status: string; text: string; replace?: boolean; sessionId?: string }
  | { type: "timeline"; eventType: "item.started" | "item.updated" | "item.completed"; block: ChatTimelineBlock; sessionId?: string }
  | { type: "final.snapshot"; content: string; reasoning: string; strict?: boolean; malformed?: boolean; messageId?: string }
  | { type: "turn.completed"; sessionId?: string }
  | { type: "error"; message: string; details?: string; sessionId?: string };

type OpenCodeConfig = Record<string, unknown>;

type OpenCodeServer = {
  url: string;
  process: ChildProcess;
};

type OpenCodeProviderEndpoint = {
  baseUrl: string;
  modelId: string;
  markerSecret?: string;
  close(): void;
};

type QueuedOpenCodeEvent =
  | { kind: "event"; event: OpenCodeRuntimeEvent }
  | { kind: "stream.closed" }
  | { kind: "error"; error: Error };

type OpenCodeEventReader = {
  connected: Promise<void>;
  done: Promise<void>;
};

type OpenCodeProxyToolCallRecord = {
  id: string;
  name: string;
  argumentsText: string;
  cwd?: string;
  secret?: string;
  output?: string;
};

type OpenCodeProxyToolEventSink = {
  cwd: string;
  queue: AsyncEventQueue;
  pending: Map<string, OpenCodeProxyToolCallRecord>;
  completed: OpenCodeProxyToolCallRecord[];
  sawReasoning: boolean;
  markerSecret: string;
};

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

type PendingQuestion = {
  serverUrl: string;
  cwd: string;
  questionIds: string[];
};

type OpenCodeHarmonyState = {
  parser: GptOssChannelParser;
  rawText: string;
  sawHarmonyMarker: boolean;
  completed: boolean;
  sawPlainProtocolMarker: boolean;
  plainProtocolInvalid: boolean;
  streamedPlainReasoningLength: number;
  streamedFlattenedContentLength: number;
  harmonyParserStarted: boolean;
  emittedToolMarkerIds: Set<string>;
  sawReasoning: boolean;
};

type OpenCodeReasoningSourceState = {
  nativeText: string;
  parsedText: string;
};

type OpenCodeDelimitedSegment =
  | { type: "reasoning"; text: string; start: number; end: number }
  | { type: "content"; text: string; start: number; end: number }
  | { type: "commentary"; text: string; start: number; end: number }
  | { type: "toolStart"; toolCall: OpenCodeProxyToolCallRecord }
  | { type: "toolComplete"; toolCall: OpenCodeProxyToolCallRecord };

const openCodeReasoningSourceStates = new WeakMap<Map<string, OpenCodeHarmonyState>, Map<string, OpenCodeReasoningSourceState>>();
const openCodeToolMarkerIds = new WeakMap<Map<string, OpenCodeHarmonyState>, Set<string>>();
const openCodeCompletedToolMarkerIds = new WeakMap<Map<string, OpenCodeHarmonyState>, Set<string>>();
const openCodeReasoningSeen = new WeakMap<Map<string, OpenCodeHarmonyState>, { value: boolean }>();

export interface OpenCodeRuntime {
  runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent>;
  answerApproval(permissionId: string, decision: "approve" | "deny"): Promise<void>;
  answerUserInput(requestId: string, answers: Record<string, string>): Promise<void>;
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
  private readonly pendingQuestions = new Map<string, PendingQuestion>();

  async *runTurn(options: OpenCodeRunOptions): AsyncIterable<OpenCodeRuntimeEvent> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    let server: OpenCodeServer | null = null;
    let eventStream: Promise<void> | null = null;
    const eventQueue = new AsyncEventQueue();
    let sessionId = options.sessionId?.trim() ?? "";
    let latestAssistantMessageId = "";
    let providerEndpoint: OpenCodeProviderEndpoint | null = null;
    const harmonyStates = new Map<string, OpenCodeHarmonyState>();
    const normalizeGptOss = options.nativeGptOss;
    const onAbort = () => eventQueue.push({ kind: "stream.closed" });
    try {
      server = await startOpenCodeServer({
        config: openCodeConfig({
          ...options,
          endpoint: providerEndpoint = await openCodeProviderEndpoint(options, eventQueue)
        }),
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
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      const eventReader = readOpenCodeEvents(server.url, options.cwd, abortController.signal, (event) => {
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
        if (event.type === "timeline" && server) {
          if (shouldTrackOpenCodePendingApproval(event)) {
            this.pendingPermissions.set(event.block.id, {
              serverUrl: server.url,
              cwd: options.cwd
            });
          } else if (event.block.kind === "question") {
            this.pendingQuestions.set(event.block.id, {
              serverUrl: server.url,
              cwd: options.cwd,
              questionIds: event.block.questions?.map((question) => question.id) ?? []
            });
          }
        }
        for (const normalizedEvent of normalizeOpenCodeHarmonyEvent(event, harmonyStates, normalizeGptOss, providerEndpoint?.markerSecret)) {
          eventQueue.push({ kind: "event", event: normalizedEvent });
        }
      }, (message, details) => {
        eventQueue.push({ kind: "event", event: { type: "error", message, details } });
      });
      eventStream = eventReader.done.then(() => eventQueue.push({ kind: "stream.closed" }), (error) => {
        if (!abortController.signal.aborted) {
          eventQueue.push({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
        } else {
          eventQueue.push({ kind: "stream.closed" });
        }
      });
      await eventReader.connected;
      yield { type: "session.started", sessionId };
      await openCodeJson<void>(server.url, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        cwd: options.cwd,
        body: {
          model: { providerID: OPENCODE_PROVIDER_ID, modelID: OPENCODE_MODEL_ID },
          agent: "build",
          system: openCodeSystemPrompt(options),
          parts: [{ type: "text", text: openCodePrompt(options) }]
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
        yield finalSnapshotEvent(snapshot.parts, normalizeGptOss, latestAssistantMessageId);
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
      providerEndpoint?.close();
      if (server && this.activeServer === server) {
        this.activeServer = null;
      }
      abortController.signal.removeEventListener("abort", onAbort);
    }
  }

  async answerApproval(permissionId: string, decision: "approve" | "deny"): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`Unknown OpenCode permission id: ${permissionId}`);
    }
    await openCodeJson<boolean>(pending.serverUrl, `/permission/${encodeURIComponent(permissionId)}/reply`, {
      method: "POST",
      cwd: pending.cwd,
      body: { reply: decision === "approve" ? "once" : "reject" },
      emptyOk: true
    });
    this.pendingPermissions.delete(permissionId);
  }

  async answerUserInput(requestId: string, answers: Record<string, string>): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) {
      throw new Error(`Unknown OpenCode question id: ${requestId}`);
    }
    const answerIds = pending.questionIds.length ? pending.questionIds : Object.keys(answers);
    const orderedAnswers = answerIds.map((id) => {
      const answer = answers[id]?.trim();
      return answer ? [answer] : [];
    });
    await openCodeJson<boolean>(pending.serverUrl, `/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      cwd: pending.cwd,
      body: { answers: orderedAnswers },
      emptyOk: true
    });
    this.pendingQuestions.delete(requestId);
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
    this.pendingQuestions.clear();
  }
}

export function shouldTrackOpenCodePendingApproval(event: OpenCodeRuntimeEvent): boolean {
  return event.type === "timeline" && event.block.kind === "approval" && event.eventType === "item.started" && event.block.status === "requested";
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

export function openCodeConfig(options: OpenCodeConfigOptions): OpenCodeConfig {
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
              maxTokens: options.settings.maxTokens,
              reasoningEffort: options.settings.reasoningEffort
            }
          }
        }
      }
    },
    permission: openCodePermissions(options.permissionMode)
  };
}

function openCodeSystemPrompt(options: OpenCodeRunOptions): string | undefined {
  const userSystemPrompt = options.settings.systemPrompt.trim();
  if (!options.nativeGptOss) {
    return userSystemPrompt || undefined;
  }
  return [
    renderGptOssOpenCodeSystemPrompt(options.settings),
    userSystemPrompt ? `# User Instructions\n\n${userSystemPrompt}` : ""
  ].filter(Boolean).join("\n\n");
}

function openCodePrompt(options: OpenCodeRunOptions): string {
  return options.prompt;
}

function openCodePermissions(permissionMode: ChatPermissionMode): unknown {
  if (permissionMode === "full_access") {
    return "allow";
  }
  return {
    read: "allow",
    edit: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    todowrite: "allow",
    task: "allow",
    skill: "allow",
    lsp: "allow",
    doom_loop: "ask",
    bash: "ask",
    external_directory: "ask",
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

async function openCodeProviderEndpoint(options: OpenCodeRunOptions, eventQueue: AsyncEventQueue): Promise<OpenCodeProviderEndpoint> {
  if (!options.nativeGptOss || !options.endpoint.rawCompletionUrl) {
    return {
      baseUrl: options.endpoint.baseUrl,
      modelId: options.endpoint.modelId,
      close: () => undefined
    };
  }
  return startGptOssOpenCodeProxy(options, eventQueue);
}

async function startGptOssOpenCodeProxy(options: OpenCodeRunOptions, eventQueue: AsyncEventQueue): Promise<OpenCodeProviderEndpoint> {
  const port = await reserveLocalPort();
  const toolSink: OpenCodeProxyToolEventSink = { cwd: options.cwd, queue: eventQueue, pending: new Map(), completed: [], sawReasoning: false, markerSecret: randomUUID() };
  const upstreamAbortControllers = new Set<AbortController>();
  const server = http.createServer((request, response) => {
    void handleGptOssOpenCodeProxyRequest(request, response, options, toolSink, upstreamAbortControllers).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: errorMessage(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    modelId: OPENCODE_MODEL_ID,
    markerSecret: toolSink.markerSecret,
    close: () => {
      for (const controller of upstreamAbortControllers) {
        controller.abort();
      }
      server.close();
    }
  };
}

async function handleGptOssOpenCodeProxyRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: OpenCodeRunOptions,
  toolSink: OpenCodeProxyToolEventSink,
  upstreamAbortControllers: Set<AbortController>
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  debugOpenCode("proxy.request", { method: request.method, path: url.pathname });
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: OPENCODE_MODEL_ID, object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }
  const body = await readJsonRequestBody(request);
  debugOpenCode("proxy.chat.body", body);
  emitCompletedOpenCodeProxyToolEvents(body, toolSink);
  const prompt = renderGptOssOpenCodeProxyPrompt(body, options);
  debugOpenCode("proxy.prompt", { prompt: prompt.slice(0, 2000) });
  const upstreamAbortController = new AbortController();
  upstreamAbortControllers.add(upstreamAbortController);
  response.once("close", () => upstreamAbortController.abort());
  const requestRawCompletion = async (rawPrompt: string, nPredict: number): Promise<ReadableStream<Uint8Array>> => {
    if (nPredict <= 0) {
      throw new Error("OpenCode GPT-OSS prompt exceeded the local model context window.");
    }
    const upstream = await fetch(options.endpoint.rawCompletionUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: upstreamAbortController.signal,
      body: JSON.stringify({
        prompt: rawPrompt,
        stream: true,
        temperature: options.settings.temperature,
        repeat_penalty: options.settings.repeatPenalty,
        n_predict: nPredict,
        cache_prompt: false,
        id_slot: 0
      })
    });
    if (!upstream.ok || !upstream.body) {
      const errorBody = await upstream.text().catch(() => "");
      throw new Error(errorBody || upstream.statusText);
    }
    return upstream.body;
  };
  try {
    const upstreamBody = await requestRawCompletion(prompt, gptOssOpenCodeRequestMaxTokens(prompt, options.settings, true));
    const shouldStream = !(isRecord(body) && body.stream === false);
    if (shouldStream) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
    }
    try {
      await streamGptOssOpenCodeProxyResponse(upstreamBody, response, openCodeProxyToolRecipientNames(body), toolSink, shouldStream, async (generatedText) => {
        const continuationPrompt = gptOssOpenCodeFinalContinuationPrompt(prompt, generatedText);
        debugOpenCode("proxy.final_continuation.prompt", { prompt: continuationPrompt.slice(-2000) });
        return requestRawCompletion(continuationPrompt, gptOssOpenCodeFinalContinuationMaxTokens(continuationPrompt, options.settings));
      });
    } catch (error) {
      toolSink.queue.push({ kind: "event", event: { type: "error", message: errorMessage(error) } });
      if (!response.writableEnded) {
        if (response.headersSent) {
          response.write("data: [DONE]\n\n");
          response.end();
        } else {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: errorMessage(error) } }));
        }
      }
    }
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: errorMessage(error) } }));
    } else if (!response.writableEnded) {
      response.write("data: [DONE]\n\n");
      response.end();
    }
  } finally {
    upstreamAbortControllers.delete(upstreamAbortController);
  }
}

async function readJsonRequestBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function streamGptOssOpenCodeProxyResponse(
  body: ReadableStream<Uint8Array>,
  response: http.ServerResponse,
  toolRecipients: string[],
  toolSink: OpenCodeProxyToolEventSink,
  stream: boolean,
  continueToFinal: (generatedText: string) => Promise<ReadableStream<Uint8Array>>
): Promise<void> {
  let parser = new GptOssChannelParser({ defaultChannel: "analysis", toolRecipients });
  let rawGeneratedText = "";
  let content = "";
  const markerState = { sentAnalysis: false, sentCommentary: false, sentFinal: false, sentToolCompletion: false };
  let finishedWithToolCall = false;
  let toolCallFinishPending = false;
  let sawReasoning = false;
  let sawCommentaryContent = false;
  let sawFinalContent = false;
  const pendingChunks: Record<string, unknown>[] = [];
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const writeDelta = (delta: Record<string, unknown>, finishReason?: string) => {
    if (stream) {
      writeOpenCodeProxyDelta(response, delta, finishReason, completionId, created);
    } else {
      pendingChunks.push({ delta, finishReason: finishReason ?? null });
    }
  };
  if (stream) {
    writeOpenCodeProxyDelta(response, { role: "assistant" }, undefined, completionId, created);
  }
  for (const completedToolCall of toolSink.completed.splice(0)) {
    writeDelta({ content: openCodeToolCompleteMarker(completedToolCall) });
    markerState.sentToolCompletion = true;
  }
  const applyParsedDelta = (delta: GptOssChannelParserResult) => {
    if (delta.reasoning) {
      const prefix = markerState.sentAnalysis ? "" : "[[UNIT0_ANALYSIS]]";
      markerState.sentAnalysis = true;
      toolSink.sawReasoning = true;
      sawReasoning = true;
      writeDelta({ content: `${prefix}${delta.reasoning}` });
    }
    if (delta.commentary) {
      sawCommentaryContent = true;
      writeOpenCodeProxyCommentaryDelta(writeDelta, delta.commentary, markerState);
    }
    if (delta.toolCallContent) {
      const result = writeOpenCodeProxyContentOrToolDelta(writeDelta, delta.toolCallContent, markerState, toolSink, toolRecipients, true);
      finishedWithToolCall = result.toolCall || finishedWithToolCall;
      toolCallFinishPending = result.toolCall || toolCallFinishPending;
    } else if (delta.content) {
      content += delta.content;
      sawFinalContent = true;
      const result = writeOpenCodeProxyContentOrToolDelta(writeDelta, delta.content, markerState, toolSink, toolRecipients, false);
      finishedWithToolCall = result.toolCall || finishedWithToolCall;
      toolCallFinishPending = result.toolCall || toolCallFinishPending;
    }
  };
  const consumeBody = async (streamBody: ReadableStream<Uint8Array>) => {
    await readOpenCodeProxyServerSentEvents(streamBody, (payload) => {
      debugOpenCode("proxy.upstream", payload.slice(0, 1000));
      if (payload === "[DONE]") {
        return;
      }
      const parsed = JSON.parse(payload) as { content?: unknown };
      const text = typeof parsed.content === "string" ? parsed.content : "";
      if (!text) {
        return;
      }
      rawGeneratedText += text;
      applyParsedDelta(parser.push(text));
    });
    applyParsedDelta(parser.finish());
  };
  await consumeBody(body);
  for (let continuationAttempts = 0; continuationAttempts < 4 && sawReasoning && !sawCommentaryContent && !sawFinalContent && !finishedWithToolCall; continuationAttempts += 1) {
    parser = new GptOssChannelParser({ defaultChannel: "final", toolRecipients });
    await consumeBody(await continueToFinal(rawGeneratedText));
  }
  if (toolCallFinishPending) {
    writeDelta({}, "tool_calls");
  } else if (!finishedWithToolCall) {
    writeDelta({}, "stop");
  }
  if (!stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(openCodeProxyNonStreamResponse(pendingChunks)));
    return;
  }
  response.write("data: [DONE]\n\n");
  response.end();
  void content;
}

function gptOssOpenCodeFinalContinuationPrompt(prompt: string, generatedText: string): string {
  const withoutTerminal = generatedText.replace(/(?:<\|return\|>|<\|call\|>)\s*$/u, "");
  const ended = withoutTerminal.endsWith("<|end|>") ? withoutTerminal : `${withoutTerminal}<|end|>`;
  return `${prompt}${ended}${OPENCODE_FINAL_CONTINUATION_PREFIX}`;
}

function gptOssOpenCodeFinalContinuationMaxTokens(prompt: string, settings: ChatRuntimeSettings): number {
  return Math.min(gptOssOpenCodeRequestMaxTokens(prompt, settings), Math.min(settings.maxTokens, 512));
}

function writeOpenCodeProxyCommentaryDelta(
  writeDelta: (delta: Record<string, unknown>, finishReason?: string) => void,
  content: string,
  markerState: { sentAnalysis: boolean; sentCommentary: boolean; sentFinal: boolean; sentToolCompletion: boolean }
): void {
  if (markerState.sentFinal) {
    throw new Error("OpenCode GPT-OSS emitted commentary after final output.");
  }
  if (!markerState.sentAnalysis && !markerState.sentToolCompletion) {
    throw new Error("OpenCode GPT-OSS emitted commentary before streamed reasoning.");
  }
  const prefix = markerState.sentCommentary ? "" : "[[UNIT0_COMMENTARY]]";
  markerState.sentCommentary = true;
  writeDelta({ content: `${prefix}${content}` });
}

function writeOpenCodeProxyContentOrToolDelta(
  writeDelta: (delta: Record<string, unknown>, finishReason?: string) => void,
  content: string,
  markerState: { sentAnalysis: boolean; sentCommentary: boolean; sentFinal: boolean; sentToolCompletion: boolean },
  toolSink: OpenCodeProxyToolEventSink,
  toolRecipients: string[],
  allowToolCall: boolean
): { toolCall: boolean } {
  const toolCall = allowToolCall ? parseOpenCodeToolCallContent(content, toolRecipients) : null;
  if (toolCall) {
    const callId = `call_${randomUUID().replace(/-/g, "")}`;
    const record = {
      id: callId,
      name: toolCall.name,
      argumentsText: toolCall.arguments,
      cwd: toolSink.cwd,
      secret: toolSink.markerSecret
    };
    toolSink.pending.set(callId, record);
    writeDelta({ content: openCodeToolStartMarker(record) });
    writeDelta({
      tool_calls: [{
        index: 0,
        id: callId,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }]
    });
    return { toolCall: true };
  }
  if (!markerState.sentFinal && !markerState.sentAnalysis && !markerState.sentToolCompletion) {
    throw new Error("OpenCode GPT-OSS emitted final output before streamed reasoning.");
  }
  const prefix = markerState.sentFinal ? "" : "[[UNIT0_FINAL]]";
  markerState.sentFinal = true;
  writeDelta({ content: `${prefix}${content}` });
  return { toolCall: false };
}

function openCodeProxyNonStreamResponse(chunks: Record<string, unknown>[]): Record<string, unknown> {
  let content = "";
  let finishReason = "stop";
  const toolCalls: unknown[] = [];
  for (const chunk of chunks) {
    const delta = isRecord(chunk.delta) ? chunk.delta : {};
    if (typeof delta.content === "string") {
      content += delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      toolCalls.push(...delta.tool_calls);
    }
    if (typeof chunk.finishReason === "string" && chunk.finishReason) {
      finishReason = chunk.finishReason;
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: OPENCODE_MODEL_ID,
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
}

function writeOpenCodeProxyDelta(response: http.ServerResponse, delta: Record<string, unknown>, finishReason: string | undefined, id: string, created: number): void {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model: OPENCODE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }]
  };
  debugOpenCode("proxy.delta", payload);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseOpenCodeToolCallContent(content: string, toolRecipients: string[]): { name: string; arguments: string } | null {
  const match = /^\s*<tool_call>\s*([\s\S]*?)\s*<\/tool_call>\s*$/u.exec(content);
  if (!match) {
    return null;
  }
  const decoded = JSON.parse(match[1]) as unknown;
  if (!isRecord(decoded) || typeof decoded.tool !== "string" || !toolRecipients.includes(decoded.tool)) {
    throw new Error("OpenCode GPT-OSS emitted an invalid tool call.");
  }
  const args = { ...decoded };
  const tool = decoded.tool;
  delete args.tool;
  return { name: tool, arguments: JSON.stringify(args) };
}

function emitStartedOpenCodeProxyToolEvent(toolSink: OpenCodeProxyToolEventSink, toolCall: OpenCodeProxyToolCallRecord): void {
  toolSink.queue.push({ kind: "event", event: openCodeProxyToolStartedRuntimeEvent({ ...toolCall, cwd: toolCall.cwd ?? toolSink.cwd }) });
}

function openCodeProxyToolStartedRuntimeEvent(toolCall: OpenCodeProxyToolCallRecord, sessionId?: string): OpenCodeRuntimeEvent {
  return {
    type: "timeline",
    eventType: "item.started",
    block: {
      kind: "tool",
      id: toolCall.id,
      toolName: toolCall.name,
      status: "started",
      summary: `${toolCall.name} ${toolCall.argumentsText}`.trim(),
      command: toolCall.argumentsText,
      directory: toolCall.cwd,
      initiallyExpanded: true
    },
    sessionId
  };
}

function openCodeProxyToolCompletedRuntimeEvent(toolCall: OpenCodeProxyToolCallRecord, sessionId?: string): OpenCodeRuntimeEvent {
  return {
    type: "timeline",
    eventType: "item.completed",
    block: {
      kind: "tool",
      id: toolCall.id,
      toolName: toolCall.name,
      status: "completed",
      summary: `${toolCall.name} ${toolCall.argumentsText}`.trim(),
      command: toolCall.argumentsText,
      directory: toolCall.cwd,
      output: toolCall.output,
      initiallyExpanded: false
    },
    sessionId
  };
}

function isOpenCodeQuestionToolCall(toolCall: { name?: string }): boolean {
  return toolCall.name === "question";
}

function openCodeToolStartMarker(toolCall: OpenCodeProxyToolCallRecord): string {
  return `[[UNIT0_TOOL_START:${Buffer.from(JSON.stringify(toolCall), "utf8").toString("base64url")}]]`;
}

function openCodeToolCompleteMarker(toolCall: OpenCodeProxyToolCallRecord): string {
  return `[[UNIT0_TOOL_COMPLETE:${Buffer.from(JSON.stringify(toolCall), "utf8").toString("base64url")}]]`;
}

function decodeOpenCodeToolStartMarker(encoded: string): OpenCodeProxyToolCallRecord | null {
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded) || typeof decoded.id !== "string" || typeof decoded.name !== "string" || typeof decoded.argumentsText !== "string") {
      return null;
    }
    return {
      id: decoded.id,
      name: decoded.name,
      argumentsText: decoded.argumentsText,
      cwd: typeof decoded.cwd === "string" ? decoded.cwd : undefined,
      secret: typeof decoded.secret === "string" ? decoded.secret : undefined,
      output: typeof decoded.output === "string" ? decoded.output : undefined
    };
  } catch {
    return null;
  }
}

function emitCompletedOpenCodeProxyToolEvents(body: unknown, toolSink: OpenCodeProxyToolEventSink): void {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return;
  }
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== "tool") {
      continue;
    }
    const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    const toolCall = callId ? toolSink.pending.get(callId) : undefined;
    if (!toolCall) {
      continue;
    }
    toolSink.pending.delete(callId);
    const output = openCodeProxyMessageContent(message.content);
    toolSink.completed.push({ ...toolCall, cwd: toolCall.cwd ?? toolSink.cwd, output });
  }
}

export function renderGptOssOpenCodeProxyPrompt(body: unknown, options: OpenCodeRunOptions): string {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const parts: OpenCodeProxyPromptPart[] = [
    `<|start|>system<|message|>${renderGptOssOpenCodeSystemPrompt(options.settings)}<|end|>`,
    `<|start|>developer<|message|># Environment\nWorking directory: ${escapeGptOssTranscriptText(options.cwd)}\nPlatform: win32<|end|>`,
    options.settings.systemPrompt.trim() ? `<|start|>developer<|message|>${escapeGptOssTranscriptText(options.settings.systemPrompt.trim())}<|end|>` : "",
    renderOpenCodeProxyToolInstructions(body)
  ].filter(Boolean);
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = String(message.role ?? "user");
    const content = openCodeProxyMessageContent(message.content);
    if (!content.trim()) {
      if (role !== "assistant") {
        continue;
      }
    }
    if (role === "assistant") {
      parts.push(...renderOpenCodeProxyAssistantTranscript(message, content));
    } else if (role === "tool") {
      parts.push({ kind: "toolResult", content });
    } else {
      parts.push(`<|start|>${role === "system" ? "developer" : "user"}<|message|>${escapeGptOssTranscriptText(content)}<|end|>`);
    }
  }
  parts.push("<|start|>assistant");
  return renderOpenCodeProxyPromptParts(parts, options.settings);
}

type OpenCodeProxyPromptPart = string | { kind: "toolResult"; content: string };

function renderOpenCodeProxyPromptParts(parts: OpenCodeProxyPromptPart[], settings: ChatRuntimeSettings): string {
  const toolResultPrefix = "<|start|>developer<|message|># OpenCode Tool Result\n";
  const toolResultSuffix = "<|end|>";
  const rendered = parts.map((part) => typeof part === "string"
    ? part
    : {
        prefix: toolResultPrefix,
        content: escapeGptOssTranscriptText(part.content),
        suffix: toolResultSuffix
      });
  const promptBudget = gptOssOpenCodePromptBudgetCharacters(settings);
  const fixedLength = rendered.reduce((total, part) =>
    total + (typeof part === "string" ? part.length : part.prefix.length + part.suffix.length), 0);
  if (fixedLength > promptBudget) {
    throw new Error("OpenCode GPT-OSS prompt overhead exceeded the local model context window.");
  }
  let remainingToolResultChars = promptBudget - fixedLength;
  const toolResultIndexes = rendered
    .map((part, index) => typeof part === "string" ? -1 : index)
    .filter((index) => index >= 0)
    .reverse();
  const contentByIndex = new Map<number, string>();
  for (const index of toolResultIndexes) {
    const part = rendered[index];
    if (typeof part === "string") {
      continue;
    }
    const content = fitOpenCodeToolResultContent(part.content, remainingToolResultChars);
    contentByIndex.set(index, content);
    remainingToolResultChars -= content.length;
  }
  return rendered.map((part, index) => {
    if (typeof part === "string") {
      return part;
    }
    return `${part.prefix}${contentByIndex.get(index) ?? ""}${part.suffix}`;
  }).join("");
}

function fitOpenCodeToolResultContent(content: string, maxCharacters: number): string {
  if (maxCharacters <= 0) {
    return "";
  }
  if (content.length <= maxCharacters) {
    return content;
  }
  const marker = "\n\n[OpenCode tool result truncated to fit the local model context window.]\n\n";
  if (maxCharacters <= marker.length) {
    return marker.slice(0, maxCharacters);
  }
  const retained = maxCharacters - marker.length;
  const headLength = Math.ceil(retained / 2);
  const tailLength = Math.floor(retained / 2);
  return `${content.slice(0, headLength)}${marker}${content.slice(content.length - tailLength)}`;
}

function renderOpenCodeProxyToolInstructions(body: unknown): string {
  const tools = openCodeProxyToolDefinitions(body);
  if (tools.length === 0) {
    return "";
  }
  return [
    "<|start|>developer<|message|># OpenCode Tool Calling",
    "When a tool is needed, emit exactly one native GPT-OSS tool call in the commentary channel.",
    "The tool call form is `<|channel|>commentary to=<tool_name> code<|message|>{json_arguments}<|call|>`.",
    "Use only the tool names listed below. Do not invent `ls`, `list`, or `shell` recipients.",
    "For listing files, use `glob` with a pattern such as `*`.",
    "After receiving the tool result, continue with analysis if needed and then answer in the final channel.",
    "",
    JSON.stringify(tools),
    "<|end|>"
  ].join("\n");
}

function openCodeProxyToolRecipientNames(body: unknown): string[] {
  return openCodeProxyToolDefinitions(body).map((tool) => tool.name);
}

function openCodeProxyToolDefinitions(body: unknown): Array<{ name: string; description?: string; parameters?: unknown }> {
  if (!isRecord(body) || !Array.isArray(body.tools)) {
    return [];
  }
  const tools: Array<{ name: string; description?: string; parameters?: unknown }> = [];
  for (const tool of body.tools) {
    if (!isRecord(tool)) {
      continue;
    }
    const fn = isRecord(tool.function) ? tool.function : tool;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) {
      continue;
    }
    tools.push({
      name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: isRecord(fn.parameters) ? fn.parameters : undefined
    });
  }
  return tools;
}

function renderOpenCodeProxyAssistantTranscript(message: Record<string, unknown>, content: string): string[] {
  const parts: string[] = [];
  const parsed = parseDelimitedPlainOpenCodeText(content);
  if (parsed.hasMarker && !parsed.malformed) {
    if (parsed.reasoning.trim()) {
      parts.push(`<|start|>assistant<|channel|>analysis<|message|>${escapeGptOssTranscriptText(parsed.reasoning)}<|end|>`);
    }
    if (parsed.content.trim()) {
      parts.push(`<|start|>assistant<|channel|>final<|message|>${escapeGptOssTranscriptText(parsed.content)}<|end|>`);
    }
  } else if (content.trim()) {
    const visible = plainGptOssTextWithoutProtocolMarkers(content).trim();
    if (visible) {
      parts.push(`<|start|>assistant<|channel|>final<|message|>${escapeGptOssTranscriptText(visible)}<|end|>`);
    }
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) {
      continue;
    }
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    const args = typeof fn.arguments === "string" ? fn.arguments : "";
    if (name) {
      parts.push(`<|start|>assistant<|channel|>commentary to=${name} code<|message|>${escapeGptOssTranscriptText(args || "{}")}<|call|>`);
    }
  }
  return parts;
}

function openCodeProxyMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
  }
  return "";
}

function escapeGptOssTranscriptText(text: string): string {
  return text.replace(/<\|/g, "< |");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function gptOssOpenCodeRequestMaxTokens(prompt: string, settings: ChatRuntimeSettings, reserveContinuation = false): number {
  const estimatedPromptTokens = Math.ceil(prompt.length / 3);
  const remainingContextTokens = Math.max(0, settings.nCtx - estimatedPromptTokens);
  const configuredMaxTokens = settings.maxTokens > 0 ? settings.maxTokens : remainingContextTokens;
  const continuationReserveTokens = OPENCODE_MIN_COMPLETION_TOKENS + Math.ceil(OPENCODE_FINAL_CONTINUATION_MARKER.length / 3);
  const continuationReserve = reserveContinuation
    ? Math.min(continuationReserveTokens, Math.max(0, remainingContextTokens - 1))
    : 0;
  return Math.min(configuredMaxTokens, Math.max(0, remainingContextTokens - continuationReserve));
}

function gptOssOpenCodePromptBudgetCharacters(settings: ChatRuntimeSettings): number {
  const configuredMaxTokens = settings.maxTokens > 0 ? settings.maxTokens : settings.nCtx;
  const reservedCompletionTokens = Math.min(
    Math.max(OPENCODE_MIN_COMPLETION_TOKENS, configuredMaxTokens),
    Math.max(OPENCODE_MIN_COMPLETION_TOKENS, settings.nCtx - 1)
  );
  const promptTokens = Math.max(1, settings.nCtx - reservedCompletionTokens);
  return promptTokens * 3;
}

async function readOpenCodeProxyServerSentEvents(body: ReadableStream<Uint8Array>, onPayload: (payload: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        onPayload(trimmed.slice(5).trim());
      }
    }
  }
  const trimmed = buffer.trim();
  if (trimmed.startsWith("data:")) {
    onPayload(trimmed.slice(5).trim());
  }
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

function readOpenCodeEvents(
  serverUrl: string,
  cwd: string,
  signal: AbortSignal,
  onEvent: (event: OpenCodeRuntimeEvent) => void,
  onErrorEvent: (message: string, details?: string) => void
): OpenCodeEventReader {
  let resolveConnected!: () => void;
  let rejectConnected!: (error: unknown) => void;
  const connected = new Promise<void>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const done = (async () => {
    try {
      const response = await fetch(openCodeUrl(serverUrl, "/event", cwd), {
        headers: { Accept: "text/event-stream" },
        signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream failed (${response.status}): ${response.statusText}`);
      }
      resolveConnected();
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
        const { value, done: readerDone } = await reader.read();
        if (readerDone) {
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
    } catch (error) {
      rejectConnected(error);
      throw error;
    }
  })();
  return { connected, done };
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
    debugOpenCode("opencode.event", raw);
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
    debugOpenCode("opencode.event", raw);
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
          decision: openCodeApprovalDecision(properties.reply)
        },
        sessionId
      };
    }
    return;
  }
  if (type === "question.asked") {
    const sessionId = String(properties.sessionID ?? "");
    const requestId = String(properties.id ?? randomUUID());
    const questions = parseOpenCodeQuestions(properties.questions, requestId);
    yield {
      type: "timeline",
      eventType: "item.started",
      block: {
        kind: "question",
        id: requestId,
        status: "requested",
        title: openCodeQuestionTitle(properties.questions) ?? "OpenCode question",
        question: questions.map((question) => question.label).join("\n"),
        questions,
        requestMethod: "opencode"
      },
      sessionId
    };
    return;
  }
  if (type === "question.replied" || type === "question.rejected") {
    const sessionId = String(properties.sessionID ?? "");
    const requestId = String(properties.requestID ?? "");
    if (requestId) {
      yield {
        type: "timeline",
        eventType: "item.completed",
        block: {
          kind: "question",
          id: requestId,
          status: "completed",
          title: type === "question.replied" ? "Question answered" : "Question rejected",
          answers: openCodeQuestionAnswers(properties.answers, requestId),
          requestMethod: "opencode"
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
    if (part.tool === "question") {
      return null;
    }
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

function openCodeApprovalDecision(value: unknown): string {
  const decision = String(value ?? "").trim().toLowerCase();
  if (decision === "once" || decision === "always" || decision === "approve" || decision === "approved" || decision === "accept" || decision === "accepted") {
    return "accepted";
  }
  if (decision === "reject" || decision === "rejected" || decision === "deny" || decision === "denied" || decision === "decline" || decision === "declined") {
    return "declined";
  }
  return decision;
}

function parseOpenCodeQuestions(value: unknown, requestId: string): Array<{ id: string; label: string; options?: string[]; allowsCustomAnswer?: boolean }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((raw, index) => {
    if (!isRecord(raw)) {
      return [];
    }
    const label = typeof raw.question === "string" ? raw.question.trim() : "";
    if (!label) {
      return [];
    }
    const options = Array.isArray(raw.options)
      ? raw.options.map((option) => isRecord(option) ? String(option.label ?? "") : String(option)).map((option) => option.trim()).filter(Boolean)
      : [];
    return [{
      id: `${requestId}:${index}`,
      label,
      options,
      allowsCustomAnswer: raw.custom !== false
    }];
  });
}

function openCodeQuestionTitle(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const first = value.find(isRecord);
  const header = first && typeof first.header === "string" ? first.header.trim() : "";
  return header || undefined;
}

function openCodeQuestionAnswers(value: unknown, requestId: string): Record<string, string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.map((answer, index) => {
    const labels = Array.isArray(answer) ? answer.map((item) => String(item).trim()).filter(Boolean) : [];
    return [`${requestId}:${index}`, labels.join(", ")] as const;
  }).filter(([, answer]) => answer);
  return entries.length ? Object.fromEntries(entries) : undefined;
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

export function normalizeOpenCodeHarmonyEvent(event: OpenCodeRuntimeEvent, states: Map<string, OpenCodeHarmonyState>, nativeGptOss = true, markerSecret = ""): OpenCodeRuntimeEvent[] {
  if (!nativeGptOss) {
    return [event];
  }
  if (event.type === "reasoning.delta") {
    return normalizeOpenCodeNativeReasoningEvent(event, states);
  }
  if (event.type !== "assistant.delta") {
    return [event];
  }
  const state = states.get(event.id) ?? {
    parser: new GptOssChannelParser({ defaultChannel: "final", toolRecipients: ["shell"] }),
    rawText: "",
    sawHarmonyMarker: false,
    completed: false,
    sawPlainProtocolMarker: false,
    plainProtocolInvalid: false,
    streamedPlainReasoningLength: 0,
    streamedFlattenedContentLength: 0,
    harmonyParserStarted: false,
    emittedToolMarkerIds: new Set(),
    sawReasoning: false
  };
  states.set(event.id, state);
  if (event.replace) {
    state.parser = new GptOssChannelParser({ defaultChannel: "final", toolRecipients: ["shell"] });
    state.rawText = "";
    state.sawHarmonyMarker = false;
    state.completed = false;
    state.sawPlainProtocolMarker = false;
    state.plainProtocolInvalid = false;
    state.streamedPlainReasoningLength = 0;
    state.streamedFlattenedContentLength = 0;
    state.harmonyParserStarted = false;
    state.sawReasoning = false;
  } else if (state.completed) {
    return [];
  }
  state.rawText += event.text;
  state.sawHarmonyMarker = state.sawHarmonyMarker || containsHarmonyChannelMarker(event.text) || containsHarmonyChannelMarker(state.rawText);
  if (!state.sawHarmonyMarker) {
    const parsed = parseDelimitedPlainOpenCodeText(state.rawText, markerSecret);
    if (parsed.malformed) {
      state.plainProtocolInvalid = true;
      return [{ type: "error", message: "OpenCode GPT-OSS emitted malformed channel delimiters." }];
    }
    state.sawPlainProtocolMarker = state.sawPlainProtocolMarker || parsed.hasMarker;
    if (state.rawText.includes("<|return|>")) {
      state.completed = true;
    }
    if (!parsed.hasMarker) {
      return [];
    }
    const events: OpenCodeRuntimeEvent[] = [];
    for (const segment of parsed.segments) {
      if (segment.type === "reasoning") {
        const from = event.replace ? segment.start : Math.max(segment.start, state.streamedPlainReasoningLength);
        const reasoningDelta = segment.text.slice(from - segment.start);
        state.streamedPlainReasoningLength = Math.max(state.streamedPlainReasoningLength, segment.end);
        if (reasoningDelta || event.replace) {
          state.sawReasoning = state.sawReasoning || reasoningDelta.trim().length > 0;
          if (reasoningDelta.trim()) {
            openCodeGlobalReasoningSeen(states).value = true;
          }
          events.push({
            type: "reasoning.delta",
            id: `${event.id}:reasoning`,
            status: event.status,
            text: reasoningDelta,
            replace: event.replace || undefined,
            sessionId: event.sessionId
          });
        }
      } else if (segment.type === "toolStart") {
        if (!openCodeGlobalReasoningSeen(states).value) {
          return [{ type: "error", message: "OpenCode GPT-OSS emitted a tool call before streamed reasoning." }];
        }
        const seenToolIds = openCodeSeenToolMarkerIds(states);
        if (!seenToolIds.has(segment.toolCall.id)) {
          seenToolIds.add(segment.toolCall.id);
          if (!isOpenCodeQuestionToolCall(segment.toolCall)) {
            events.push(openCodeProxyToolStartedRuntimeEvent(segment.toolCall, event.sessionId));
          }
        }
      } else if (segment.type === "toolComplete") {
        if (!openCodeSeenToolMarkerIds(states).has(segment.toolCall.id)) {
          return [{ type: "error", message: "OpenCode GPT-OSS emitted a tool result before the tool start." }];
        }
        const completedToolIds = openCodeSeenCompletedToolMarkerIds(states);
        if (!completedToolIds.has(segment.toolCall.id)) {
          completedToolIds.add(segment.toolCall.id);
          if (!isOpenCodeQuestionToolCall(segment.toolCall)) {
            events.push(openCodeProxyToolCompletedRuntimeEvent(segment.toolCall, event.sessionId));
          }
        }
      } else if (segment.type === "content" || segment.type === "commentary") {
        const from = event.replace ? segment.start : Math.max(segment.start, state.streamedFlattenedContentLength);
        const contentDelta = segment.text.slice(from - segment.start);
        state.streamedFlattenedContentLength = Math.max(state.streamedFlattenedContentLength, segment.end);
        if (contentDelta || event.replace) {
          if (!openCodeGlobalReasoningSeen(states).value) {
            return [{ type: "error", message: "OpenCode GPT-OSS emitted final output before streamed reasoning." }];
          }
          events.push({ ...event, text: contentDelta, replace: event.replace || undefined });
        }
      }
    }
    return events;
  }
  const textForParser = state.harmonyParserStarted ? event.text : state.rawText;
  state.harmonyParserStarted = true;
  const parsed = state.parser.push(textForParser);
  const events: OpenCodeRuntimeEvent[] = [];
  if (parsed.reasoning) {
    state.sawReasoning = true;
    openCodeGlobalReasoningSeen(states).value = true;
    const reasoningEvent = normalizeParsedOpenCodeReasoningEvent({
      type: "reasoning.delta",
      id: `${event.id}:reasoning`,
      status: event.status,
      text: parsed.reasoning,
      replace: event.replace || undefined,
      sessionId: event.sessionId
    }, states);
    if (reasoningEvent) {
      if (reasoningEvent.type === "error") {
        return [reasoningEvent];
      }
      events.push(reasoningEvent);
    }
  }
  if (parsed.commentary) {
    if (!openCodeGlobalReasoningSeen(states).value) {
      return [{ type: "error", message: "OpenCode GPT-OSS emitted commentary before streamed reasoning." }];
    }
    events.push({ ...event, text: parsed.commentary, replace: event.replace || undefined });
  }
  if (parsed.content) {
    if (!openCodeGlobalReasoningSeen(states).value) {
      return [{ type: "error", message: "OpenCode GPT-OSS emitted final output before streamed reasoning." }];
    }
    events.push({ ...event, text: parsed.content, replace: event.replace || undefined });
  }
  return events;
}

function normalizeOpenCodeNativeReasoningEvent(event: Extract<OpenCodeRuntimeEvent, { type: "reasoning.delta" }>, states: Map<string, OpenCodeHarmonyState>): OpenCodeRuntimeEvent[] {
  const source = openCodeReasoningSourceState(states, event);
  const nextNativeText = event.replace ? event.text : `${source.nativeText}${event.text}`;
  let visibleText = event.text;
  let replace = event.replace;
  if (source.parsedText) {
    if (source.parsedText === nextNativeText || source.parsedText.startsWith(nextNativeText)) {
      source.nativeText = nextNativeText;
      return [];
    }
    if (nextNativeText.startsWith(source.parsedText)) {
      visibleText = nextNativeText.slice(source.parsedText.length);
      replace = false;
    } else {
      return [{ type: "error", message: "OpenCode GPT-OSS emitted divergent native and parsed reasoning." }];
    }
  }
  source.nativeText = nextNativeText;
  if (visibleText.trim().length > 0) {
    openCodeGlobalReasoningSeen(states).value = true;
  }
  return visibleText || replace ? [{ ...event, text: visibleText, replace: replace || undefined }] : [];
}

function normalizeParsedOpenCodeReasoningEvent(event: Extract<OpenCodeRuntimeEvent, { type: "reasoning.delta" }>, states: Map<string, OpenCodeHarmonyState>): OpenCodeRuntimeEvent | null {
  const source = openCodeReasoningSourceState(states, event);
  const nextParsedText = event.replace ? event.text : `${source.parsedText}${event.text}`;
  if (source.nativeText) {
    source.parsedText = nextParsedText;
    if (source.nativeText === nextParsedText || source.nativeText.startsWith(nextParsedText)) {
      return null;
    }
    if (!nextParsedText.startsWith(source.nativeText)) {
      return { type: "error", message: "OpenCode GPT-OSS emitted divergent native and parsed reasoning." };
    }
    const text = nextParsedText.slice(source.nativeText.length);
    return text ? { ...event, text, replace: undefined } : null;
  }
  source.parsedText = nextParsedText;
  return event.text || event.replace ? event : null;
}

function openCodeReasoningSourceState(states: Map<string, OpenCodeHarmonyState>, event: Extract<OpenCodeRuntimeEvent, { type: "reasoning.delta" }>): OpenCodeReasoningSourceState {
  let sourceStates = openCodeReasoningSourceStates.get(states);
  if (!sourceStates) {
    sourceStates = new Map();
    openCodeReasoningSourceStates.set(states, sourceStates);
  }
  const key = `${event.sessionId ?? ""}:${messageIdFromPartId(event.id)}`;
  const state = sourceStates.get(key) ?? { nativeText: "", parsedText: "" };
  sourceStates.set(key, state);
  return state;
}

function openCodeSeenToolMarkerIds(states: Map<string, OpenCodeHarmonyState>): Set<string> {
  let ids = openCodeToolMarkerIds.get(states);
  if (!ids) {
    ids = new Set();
    openCodeToolMarkerIds.set(states, ids);
  }
  return ids;
}

function openCodeSeenCompletedToolMarkerIds(states: Map<string, OpenCodeHarmonyState>): Set<string> {
  let ids = openCodeCompletedToolMarkerIds.get(states);
  if (!ids) {
    ids = new Set();
    openCodeCompletedToolMarkerIds.set(states, ids);
  }
  return ids;
}

function openCodeGlobalReasoningSeen(states: Map<string, OpenCodeHarmonyState>): { value: boolean } {
  let seen = openCodeReasoningSeen.get(states);
  if (!seen) {
    seen = { value: false };
    openCodeReasoningSeen.set(states, seen);
  }
  return seen;
}

function finalSnapshotEvent(parts: OpenCodePart[], nativeGptOss: boolean, messageId = ""): OpenCodeRuntimeEvent {
  const text = partsText(parts, "text");
  const nativeReasoning = partsText(parts, "reasoning");
  if (!nativeGptOss) {
    return {
      type: "final.snapshot",
      content: text,
      reasoning: nativeReasoning,
      messageId
    };
  }
  if (!containsHarmonyChannelMarker(text)) {
    const delimited = parseDelimitedPlainOpenCodeText(text);
    return {
      type: "final.snapshot",
      content: delimited.malformed ? "" : delimited.content,
      reasoning: nativeReasoning || (delimited.malformed ? "" : delimited.reasoning),
      strict: true,
      malformed: delimited.malformed || undefined,
      messageId
    };
  }
  const parsed = parseOpenCodeHarmonySnapshot(text);
  const malformed = Boolean(parsed.content && !(nativeReasoning || parsed.reasoning));
  return {
    type: "final.snapshot",
    content: malformed ? "" : parsed.content,
    reasoning: malformed ? "" : nativeReasoning || parsed.reasoning,
    strict: nativeGptOss || undefined,
    malformed: malformed || undefined,
    messageId
  };
}

export function parseOpenCodeHarmonySnapshot(text: string): { content: string; reasoning: string } {
  if (!text) {
    return { content: "", reasoning: "" };
  }
  if (!containsHarmonyChannelMarker(text)) {
    const parsed = parseDelimitedPlainOpenCodeText(text);
    if (parsed.malformed) {
      return { content: "", reasoning: "" };
    }
    return { content: parsed.content, reasoning: parsed.reasoning };
  }
  const parser = new GptOssChannelParser({ defaultChannel: "final", toolRecipients: ["shell"] });
  const first = parser.push(text);
  const last = parser.finish();
  return {
    content: `${first.commentary ?? ""}${first.content}${last.commentary ?? ""}${last.content}`,
    reasoning: `${first.reasoning}${last.reasoning}`
  };
}

function plainGptOssTextWithoutProtocolMarkers(text: string): string {
  const returnIndex = text.indexOf("<|return|>");
  const beforeReturn = returnIndex >= 0 ? text.slice(0, returnIndex) : text;
  return stripIncompleteHarmonyMarker(stripHarmonyMarkers(beforeReturn));
}

function parseDelimitedPlainOpenCodeText(text: string, markerSecret = ""): {
  reasoning: string;
  content: string;
  hasMarker: boolean;
  malformed: boolean;
  toolStarts: OpenCodeProxyToolCallRecord[];
  toolCompletes: OpenCodeProxyToolCallRecord[];
  segments: OpenCodeDelimitedSegment[];
} {
  const analysisMarker = "[[UNIT0_ANALYSIS]]";
  const commentaryMarker = "[[UNIT0_COMMENTARY]]";
  const finalMarker = "[[UNIT0_FINAL]]";
  const markerPattern = /\[\[UNIT0_(ANALYSIS|COMMENTARY|FINAL|TOOL_START:([A-Za-z0-9_-]+)|TOOL_COMPLETE:([A-Za-z0-9_-]+))\]\]/gu;
  const withoutPartialMarkers = stripTrailingPartialOpenCodeMarker(plainGptOssTextWithoutProtocolMarkers(text));
  const markers = [...withoutPartialMarkers.matchAll(markerPattern)];
  const toolStarts: OpenCodeProxyToolCallRecord[] = [];
  const toolCompletes: OpenCodeProxyToolCallRecord[] = [];
  const segments: OpenCodeDelimitedSegment[] = [];
  if (markers.length === 0) {
    return { reasoning: "", content: "", hasMarker: false, malformed: false, toolStarts, toolCompletes, segments };
  }
  let reasoning = "";
  let content = "";
  let cursor = 0;
  let inAnalysis = false;
  let inCommentary = false;
  let inFinal = false;
  let sawAnalysis = false;
  let sawCommentary = false;
  let sawToolComplete = false;
  let sawFinal = false;
  let malformed = false;
  for (const marker of markers) {
    const markerStart = marker.index;
    const markerEnd = markerStart + marker[0].length;
    const precedingText = withoutPartialMarkers.slice(cursor, markerStart);
    if (inFinal) {
      const start = content.length;
      content += precedingText;
      if (precedingText) {
        segments.push({ type: "content", text: precedingText, start, end: content.length });
      }
    } else if (inAnalysis) {
      const start = reasoning.length;
      reasoning += precedingText;
      if (precedingText) {
        segments.push({ type: "reasoning", text: precedingText, start, end: reasoning.length });
      }
    } else if (inCommentary) {
      const start = content.length;
      content += precedingText;
      if (precedingText) {
        segments.push({ type: "commentary", text: precedingText, start, end: content.length });
      }
    } else if (precedingText.trim()) {
      malformed = true;
    }
    const kind = marker[1];
    if (kind === "ANALYSIS") {
      if (inFinal) {
        malformed = true;
      }
      inAnalysis = true;
      inCommentary = false;
      sawAnalysis = true;
    } else if (kind === "COMMENTARY") {
      if (inFinal || (!sawAnalysis && !sawToolComplete)) {
        malformed = true;
      }
      inAnalysis = false;
      inCommentary = true;
      sawCommentary = true;
    } else if (kind === "FINAL") {
      if ((!sawAnalysis && !sawCommentary && !sawToolComplete) || sawFinal) {
        malformed = true;
      }
      inAnalysis = false;
      inCommentary = false;
      inFinal = true;
      sawFinal = true;
    } else if (kind.startsWith("TOOL_START:")) {
      if (inFinal) {
        malformed = true;
      }
      inAnalysis = false;
      inCommentary = false;
      const decoded = decodeOpenCodeToolStartMarker(marker[2] ?? "");
      if (decoded && (!markerSecret || decoded.secret === markerSecret)) {
        toolStarts.push(decoded);
        segments.push({ type: "toolStart", toolCall: decoded });
      }
    } else if (kind.startsWith("TOOL_COMPLETE:")) {
      if (inFinal) {
        malformed = true;
      }
      inAnalysis = false;
      inCommentary = false;
      const decoded = decodeOpenCodeToolStartMarker(marker[3] ?? "");
      if (decoded && (!markerSecret || decoded.secret === markerSecret)) {
        toolCompletes.push(decoded);
        segments.push({ type: "toolComplete", toolCall: decoded });
        sawToolComplete = true;
      }
    }
    cursor = markerEnd;
  }
  const tail = withoutPartialMarkers.slice(cursor);
  if (inFinal) {
    const start = content.length;
    content += tail;
    if (tail) {
      segments.push({ type: "content", text: tail, start, end: content.length });
    }
  } else if (inAnalysis) {
    const start = reasoning.length;
    reasoning += tail;
    if (tail) {
      segments.push({ type: "reasoning", text: tail, start, end: reasoning.length });
    }
  } else if (inCommentary) {
    const start = content.length;
    content += tail;
    if (tail) {
      segments.push({ type: "commentary", text: tail, start, end: content.length });
    }
  } else if (tail.trim()) {
    malformed = true;
  }
  return {
    reasoning,
    content,
    hasMarker: true,
    malformed,
    toolStarts,
    toolCompletes,
    segments
  };
}

function stripTrailingPartialOpenCodeMarker(text: string): string {
  const partialToolIndex = text.lastIndexOf("[[UNIT0_TOOL_START:");
  if (partialToolIndex >= 0 && text.indexOf("]]", partialToolIndex) < 0) {
    return text.slice(0, partialToolIndex);
  }
  const partialToolCompleteIndex = text.lastIndexOf("[[UNIT0_TOOL_COMPLETE:");
  if (partialToolCompleteIndex >= 0 && text.indexOf("]]", partialToolCompleteIndex) < 0) {
    return text.slice(0, partialToolCompleteIndex);
  }
  const markers = ["[[UNIT0_ANALYSIS]]", "[[UNIT0_COMMENTARY]]", "[[UNIT0_FINAL]]", "[[UNIT0_TOOL_START:", "[[UNIT0_TOOL_COMPLETE:"];
  for (const marker of markers) {
    for (let length = Math.min(marker.length - 1, text.length); length > 0; length -= 1) {
      if (marker.startsWith(text.slice(-length))) {
        return text.slice(0, -length);
      }
    }
  }
  return text;
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

function debugOpenCode(label: string, data: unknown): void {
  if (!OPENCODE_DEBUG_LOG) {
    return;
  }
  fs.appendFileSync(OPENCODE_DEBUG_LOG, `${JSON.stringify({ ts: new Date().toISOString(), label, data })}\n`);
}
