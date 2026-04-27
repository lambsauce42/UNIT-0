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
  expandedProjectIds: [],
  autoExpandCodexDisclosures: true,
  documentIndexLocation: "local",
  documentToolExecutionLocation: "local",
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
        capabilities: ["model_catalog", "chat_stream", "document_catalog", "document_upload", "document_cancel", "document_search", "document_analysis_budget", "document_analysis_stream"]
      })
      : JSON.stringify({ models: [{ id: "remote::identity-1::abc", label: "Remote Model", reference: "Qwen", source_label: "Remote Built-in" }] });
    return signedJsonResponse(url.pathname, nonce, body);
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);

  const discovered = await runtime.discover({ ...settings, remoteHostAddress: "http://127.0.0.1:14555/v1/discover", remoteHostPort: 1 });

  expect(discovered.hostIdentity).toBe("identity-1");
  expect(discovered.models[0]).toMatchObject({ id: "remote::identity-1::abc", providerId: "remote", hostId: "host-1" });
  expect(requestedUrls[0]).toBe("http://127.0.0.1:14555/v1/discover");
});

test("rejects unsigned remote JSON responses", async () => {
  const runtime = new RemoteHostRuntime((async () => new Response(JSON.stringify({ host_identity: "identity-1" }), { status: 200 })) as typeof fetch);

  await expect(runtime.discover(settings)).rejects.toThrow(/host identity|signature/);
});

test("validates signed remote chat streams and requires completion", async () => {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const nonce = new Headers(init?.headers).get("X-Unit0-Auth-Nonce") ?? "";
    const headers = streamHeaders(nonce, url.pathname);
    const first = { type: "chunk", content: "he", reasoning: "" };
    const second = { type: "chunk", content: "llo", reasoning: "" };
    const complete = { type: "complete", metrics: {} };
    const lines = [signEvent(nonce, 1, first), signEvent(nonce, 2, second), signEvent(nonce, 3, complete)]
      .map((event) => JSON.stringify(event))
      .join("\n");
    return new Response(lines, { status: 200, headers });
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);
  let content = "";

  await runtime.streamChat({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", createdAt: "" },
    runtimeSettings,
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "hi", attachments: [], status: "complete", createdAt: "", updatedAt: "" }],
    onToken: (token) => {
      content += token;
    }
  });

  expect(content).toBe("hello");
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

test("streams remote document analysis from the dedicated endpoint", async () => {
  let requestedPath = "";
  let requestedBody: Record<string, unknown> = {};
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requestedPath = url.pathname;
    requestedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const nonce = new Headers(init?.headers).get("X-Unit0-Auth-Nonce") ?? "";
    const chunk = { type: "chunk", content: "answer", reasoning: "" };
    const events = { type: "agent_events", events: [{ type: "tool", id: "search", tool: "search", output: "r1" }], session_state: {} };
    const complete = { type: "complete", content: "", reasoning: "" };
    const lines = [signEvent(nonce, 1, chunk), signEvent(nonce, 2, events), signEvent(nonce, 3, complete)]
      .map((event) => JSON.stringify(event))
      .join("\n");
    return new Response(lines, { status: 200, headers: streamHeaders(nonce, url.pathname) });
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);
  let content = "";
  const agentEvents: unknown[] = [];

  await runtime.streamDocumentAnalysis({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", createdAt: "" },
    runtimeSettings,
    messages: [],
    documentIndexId: "remote-doc::identity-1::doc-1",
    onToken: (token) => {
      content += token;
    },
    onAgentEvents: (events) => agentEvents.push(...events)
  });

  expect(requestedPath).toBe("/v1/document-analysis");
  expect(requestedBody.document_index_id).toBe("doc-1");
  expect(content).toBe("answer");
  expect(agentEvents).toHaveLength(1);
});

test("uses dedicated remote document status, cancel, and evidence budget endpoints", async () => {
  const requestedPaths: string[] = [];
  const requestedBodies: Record<string, unknown>[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (init?.body) {
      requestedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    const nonce = new Headers(init?.headers).get("X-Unit0-Auth-Nonce") ?? "";
    const body = url.pathname.endsWith("/cancel")
      ? JSON.stringify({ cancelled: true })
      : url.pathname === "/v1/document-analysis/evidence-budget"
        ? JSON.stringify({ budget_tokens: 1234 })
        : JSON.stringify({
          document: {
            id: "doc-1",
            title: "Remote Doc",
            source_titles: ["a.pdf"],
            state: "ready",
            progress: 1,
            message: "Ready"
          }
        });
    return signedJsonResponse(url.pathname, nonce, body);
  };
  const runtime = new RemoteHostRuntime(fetchImpl as typeof fetch);

  const status = await runtime.documentIndexStatus({
    settings,
    projectId: "project-1",
    documentIndexId: "remote-doc::identity-1::doc-1"
  });
  const cancelled = await runtime.cancelDocumentIndex({
    settings,
    documentIndexId: "remote-doc::identity-1::doc-1"
  });
  const budget = await runtime.documentAnalysisEvidenceBudget({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", createdAt: "" },
    runtimeSettings: { ...runtimeSettings, systemPrompt: DEFAULT_SYSTEM_PROMPT },
    messages: [],
    documentTitle: "Remote Doc"
  });
  const customBudget = await runtime.documentAnalysisEvidenceBudget({
    settings,
    model: { id: "remote-model", label: "Remote", path: "", providerId: "remote", createdAt: "" },
    runtimeSettings,
    messages: [],
    documentTitle: "Remote Doc"
  });

  expect(status).toMatchObject({ id: "remote-doc::identity-1::doc-1", projectId: "project-1", state: "ready" });
  expect(cancelled).toBe(true);
  expect(budget).toBe(1234);
  expect(customBudget).toBe(1234);
  expect((requestedBodies.at(-2)?.settings as Record<string, unknown>).system_prompt_customized).toBe(false);
  expect((requestedBodies.at(-1)?.settings as Record<string, unknown>).system_prompt_customized).toBe(true);
  expect(requestedPaths).toEqual([
    "/v1/documents/doc-1",
    "/v1/documents/doc-1/cancel",
    "/v1/document-analysis/evidence-budget",
    "/v1/document-analysis/evidence-budget"
  ]);
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
