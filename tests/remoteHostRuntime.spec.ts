import { expect, test } from "@playwright/test";
import {
  DEFAULT_SYSTEM_PROMPT,
  RemoteHostRuntime,
  remoteJsonResponseSignature,
  remoteStreamEventSignature,
  remoteStreamOpenSignature
} from "../src/main/remoteHostRuntime";
import type { ChatAppSettings, ChatRuntimeSettings } from "../src/shared/types";

const settings: ChatAppSettings = {
  usageIndicatorPlacement: "footer",
  usageIndicatorOrder: ["git_diff", "context", "week", "five_hour"],
  usageIndicatorPreferences: {
    git_diff: { displayMode: "bar", placement: "bottom", order: 1 },
    context: { displayMode: "bar", placement: "bottom", order: 2 },
    week: { displayMode: "circle", placement: "left", order: 1 },
    five_hour: { displayMode: "circle", placement: "right", order: 1 }
  },
  actionButtons: [],
  expandedProjectIds: [],
  autoExpandCodexDisclosures: true,
  tokenizerModelPath: "",
  remoteHostAddress: "127.0.0.1",
  remoteHostPort: 14555,
  remotePairingCode: "ABCD-1234",
  remoteHostId: "host-1",
  remoteHostIdentity: "identity-1",
  remoteProtocolVersion: "1"
};

const runtimeSettings: ChatRuntimeSettings = {
  nCtx: 4096,
  nGpuLayers: 0,
  temperature: 0.7,
  repeatPenalty: 1.1,
  maxTokens: 256,
  reasoningEffort: "medium",
  permissionMode: "full_access",
  trimReserveTokens: 2000,
  trimReservePercent: 15,
  trimAmountTokens: 4000,
  trimAmountPercent: 30,
  systemPrompt: "Use concise answers."
};

test("validates signed remote discovery and model catalog responses", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requestedUrls.push(String(input));
    const nonce = new Headers(init?.headers).get("X-Unit0-Auth-Nonce") ?? "";
    const body = url.pathname === "/v1/discover"
      ? JSON.stringify({
        host_identity: "identity-1",
        protocol_version: "1",
        capabilities: ["model_catalog", "chat_stream", "runtime_status", "runtime_logs", "model_prewarm", "context_prepare"]
      })
      : JSON.stringify({ models: [{ id: "remote::identity-1::abc", label: "Remote Model", reference: "local-alias", prompt_format: "gpt-oss", context_tokens: 2048, source_label: "Remote Inference" }] });
    return signedJsonResponse(url.pathname, nonce, body);
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);

  const discovered = await runtime.discover({ ...settings, remoteHostAddress: "http://127.0.0.1:14555/v1/discover", remoteHostPort: 1 });

  expect(discovered.hostIdentity).toBe("identity-1");
  expect(discovered.models[0]).toMatchObject({ id: "remote::identity-1::abc", providerId: "remote", hostId: "host-1", reference: "local-alias", promptFormat: "gpt-oss", contextTokens: 2048 });
  expect(requestedUrls[0]).toBe("http://127.0.0.1:14555/v1/discover");
});

test("rejects unsigned remote JSON responses", async () => {
  const runtime = new RemoteHostRuntime((async () => new Response(JSON.stringify({ host_identity: "identity-1" }), { status: 200 })) as typeof fetch);

  await expect(runtime.discover(settings)).rejects.toThrow(/host identity|signature/);
});

test("validates signed remote chat streams and sends only inference context", async () => {
  let requestedBody: Record<string, unknown> = {};
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requestedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const nonce = new Headers(init?.headers).get("X-Unit0-Auth-Nonce") ?? "";
    const headers = streamHeaders(nonce, url.pathname);
    const first = { type: "chunk", content: "\n\n```ts\n", reasoning: "\n  Needs " };
    const second = { type: "chunk", content: "  const value = 42;\n", reasoning: "spaces.\n" };
    const third = { type: "chunk", content: "```\nAfter", reasoning: "  indent" };
    const complete = { type: "complete", metrics: {} };
    const lines = [signEvent(nonce, 1, first), signEvent(nonce, 2, second), signEvent(nonce, 3, third), signEvent(nonce, 4, complete)]
      .map((event) => JSON.stringify(event))
      .join("\n");
    return new Response(lines, { status: 200, headers });
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);
  let content = "";
  let reasoning = "";

  await runtime.streamChat({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", contextTokens: 1024, createdAt: "" },
    runtimeSettings: { ...runtimeSettings, nCtx: 4096, maxTokens: 2048, trimReserveTokens: 1000, trimAmountTokens: 2000 },
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "hi", attachments: [], status: "complete", createdAt: "", updatedAt: "" }],
    builtinAgenticFramework: "document_analysis",
    documentTitle: "Local Notes",
    contextKey: "ctx-1",
    onToken: (token) => {
      content += token;
    },
    onReasoning: (token) => {
      reasoning += token;
    }
  });

  expect(content).toBe("\n\n```ts\n  const value = 42;\n```\nAfter");
  expect(reasoning).toBe("\n  Needs spaces.\n  indent");
  expect(requestedBody).toMatchObject({
    model_id: "remote-model",
    builtin_agentic_framework: "document_analysis",
    document_title: "Local Notes",
    context_key: "ctx-1"
  });
  expect(requestedBody.settings).toMatchObject({
    n_ctx: 1024,
    max_tokens: 1024,
    trim_trigger_remaining_tokens: 250,
    trim_target_cleared_tokens: 500
  });
  expect(requestedBody.messages).toEqual([{ role: "user", content: "hi", reasoning: "" }]);
  expect(requestedBody).not.toHaveProperty("document_index_id");
});

test("rejects remote stream events with invalid signatures", async () => {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const nonce = new Headers(init?.headers).get("X-Unit0-Auth-Nonce") ?? "";
    const event = { type: "chunk", content: "bad", signature: "bad" };
    return new Response(`${JSON.stringify(event)}\n`, { status: 200, headers: streamHeaders(nonce, url.pathname) });
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);

  await expect(runtime.streamChat({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", createdAt: "" },
    runtimeSettings,
    messages: [],
    onToken: () => undefined
  })).rejects.toThrow(/stream event signature/);
});

test("prewarms and prepares reusable context with signed JSON endpoints", async () => {
  const requestedPaths: string[] = [];
  const requestedBodies: Record<string, unknown>[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    requestedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const nonce = new Headers(init?.headers).get("X-Unit0-Auth-Nonce") ?? "";
    return signedJsonResponse(url.pathname, nonce, JSON.stringify({ ok: true }));
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);

  await runtime.prewarm({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", createdAt: "" },
    runtimeSettings
  });
  await runtime.prepareContext({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", createdAt: "" },
    runtimeSettings: { ...runtimeSettings, systemPrompt: DEFAULT_SYSTEM_PROMPT },
    messages: [{ id: "m1", threadId: "t1", role: "assistant", content: "answer", reasoning: "thinking", attachments: [], status: "complete", createdAt: "", updatedAt: "" }],
    contextKey: "ctx-1",
    builtinAgenticFramework: "chat"
  });

  expect(requestedPaths).toEqual(["/v1/prewarm", "/v1/context/prepare"]);
  expect(requestedBodies[0].settings).toMatchObject({ n_ctx: runtimeSettings.nCtx });
  expect((requestedBodies[0].settings as Record<string, unknown>).system_prompt_customized).toBe(true);
  expect((requestedBodies[1].settings as Record<string, unknown>).system_prompt_customized).toBe(false);
  expect(requestedBodies[1].messages).toEqual([{ role: "assistant", content: "answer", reasoning: "thinking" }]);
});

function signedJsonResponse(requestPath: string, requestNonce: string, body: string) {
  return new Response(body, {
    status: 200,
    headers: {
      "X-Unit0-Host-Identity": settings.remoteHostIdentity,
      "X-Unit0-Response-Signature": remoteJsonResponseSignature(settings.remotePairingCode, requestPath, 200, requestNonce, settings.remoteHostIdentity, body)
    }
  });
}

function streamHeaders(requestNonce: string, requestPath: string) {
  const signedHeaders = {
    "X-Unit0-Protocol-Version": "1",
    "X-Unit0-Host-Identity": settings.remoteHostIdentity,
    "X-Unit0-Remote-Host-Id": settings.remoteHostId,
    "X-Unit0-Remote-Session-Id": "session-1",
    "X-Unit0-Remote-Slot-Id": "0",
    "X-Unit0-Remote-Session-Status": "warm"
  };
  return {
    ...signedHeaders,
    "X-Unit0-Response-Signature": remoteStreamOpenSignature(settings.remotePairingCode, requestPath, requestNonce, signedHeaders)
  };
}

function signEvent(requestNonce: string, sequence: number, event: Record<string, unknown>) {
  return {
    ...event,
    signature: remoteStreamEventSignature(settings.remotePairingCode, requestNonce, sequence, event)
  };
}
