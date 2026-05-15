import { expect, test } from "@playwright/test";
import http from "node:http";
import net from "node:net";
import { RemoteHostRuntime } from "../src/main/remoteHostRuntime";
import type { ChatAppSettings, ChatRuntimeSettings } from "../src/shared/types";

const { createRemoteInferenceServer } = require("../remote-inference-server/server.js") as {
  createRemoteInferenceServer: (config: unknown) => { start: () => Promise<void>; stop: () => Promise<void> };
};

const appSettings: ChatAppSettings = {
  usageIndicatorPlacement: "footer",
  usageIndicatorOrder: ["context"],
  usageIndicatorPreferences: {
    context: { displayMode: "bar", placement: "bottom", order: 1 }
  },
  actionButtons: [],
  expandedProjectIds: [],
  autoExpandCodexDisclosures: true,
  tokenizerModelPath: "",
  remoteHostAddress: "127.0.0.1",
  remoteHostPort: 14555,
  remotePairingCode: "ABCD-1234",
  remoteHostId: "",
  remoteHostIdentity: "",
  remoteProtocolVersion: ""
};

const runtimeSettings: ChatRuntimeSettings = {
  nCtx: 8192,
  nGpuLayers: 0,
  temperature: 0.7,
  repeatPenalty: 1.1,
  maxTokens: 512,
  reasoningEffort: "medium",
  permissionMode: "full_access",
  trimReserveTokens: 2000,
  trimReservePercent: 15,
  trimAmountTokens: 4000,
  trimAmountPercent: 30,
  systemPrompt: "Keep formatting intact."
};

test("remote GPT-OSS chat preserves spaces, linebreaks, and reasoning split", async () => {
  const harness = await startRemoteHarness([
    "<|channel|>analysis<|message|>\n  Need space.\nNext thought.",
    "<|end|><|start|>assistant<|channel|>final<|message|>\n\n```ts\n",
    "  const value = 42;\n",
    "```\nHello",
    ", world!\n\nLine two with  double spaces.",
    "<|ret",
    "urn|>",
    "leaked"
  ]);
  try {
    const result = await runRemoteChat(harness.remotePort, "chat", [
      { role: "user", content: "hi" }
    ]);

    expect(result.content).toBe("\n\n```ts\n  const value = 42;\n```\nHello, world!\n\nLine two with  double spaces.");
    expect(result.reasoning).toBe("\n  Need space.\nNext thought.");
    expect(result.content).not.toContain("leaked");
    expect(result.content).not.toContain("<|");
    expect(harness.requests[0].body.prompt).toContain("No tools or external recipients are available in this chat.");
    expect(harness.requests[0].body.prompt).toContain("Do not emit commentary to tools, files, browsers, functions, repo_browser, or any recipient other than final.");
  } finally {
    await harness.close();
  }
});

test("remote GPT-OSS document analysis uses local-equivalent prompt and search tool parsing", async () => {
  const harness = await startRemoteHarness([
    '<|channel|>commentary to=search <|constrain|>json<|message|>{"query":"pdf links","top_k":8}<|call|>'
  ]);
  try {
    const result = await runRemoteChat(harness.remotePort, "document_analysis", [
      { role: "user", content: "Find pdf links" },
      { role: "user", content: "Tool result:\nsource.pdf p. 1 says hello" }
    ], "Knowledge Base");

    expect(result.content).toBe('<tool_call>{"query":"pdf links","top_k":8,"tool":"search"}</tool_call>');
    expect(result.reasoning).toBe("");
    const prompt = harness.requests[0].body.prompt;
    expect(prompt).toContain("In document analysis mode, commentary may target only the host-managed tool recipients `search` and `modify_results`.");
    expect(prompt).toContain('The selected indexed document index is "Knowledge Base".');
    expect(prompt).toContain("# Host Search Result\nThis tool output was injected by the host, not authored by the user.\n<tool_result>\nTool result:\nsource.pdf p. 1 says hello\n</tool_result>");
  } finally {
    await harness.close();
  }
});

test("remote GPT-OSS OpenCode uses local-equivalent prompt and shell tool parsing", async () => {
  const harness = await startRemoteHarness([
    '<|channel|>commentary to=shell <|constrain|>json<|message|>{"command":"rg -n TODO src"}<|call|>'
  ]);
  try {
    const result = await runRemoteChat(harness.remotePort, "opencode", [
      { role: "user", content: "Inspect TODOs" },
      { role: "user", content: "Tool result:\nstdout:\nnone\nstderr: (empty)" }
    ]);

    expect(result.content).toBe('<tool_call>{"command":"rg -n TODO src","tool":"shell"}</tool_call>');
    expect(result.reasoning).toBe("");
    const prompt = harness.requests[0].body.prompt;
    expect(prompt).toContain("OpenCode mode is for coding work inside the selected project directory.");
    expect(prompt).toContain("You may use exactly one host-managed tool recipient: `shell`.");
    expect(prompt).toContain("# Host Shell Result\nThis tool output was injected by the host, not authored by the user.\n<tool_result>\nTool result:\nstdout:\nnone\nstderr: (empty)\n</tool_result>");
  } finally {
    await harness.close();
  }
});

test("remote GPT-OSS parser stops after terminal tool-call markers", async () => {
  const harness = await startRemoteHarness([
    '<|channel|>commentary to=shell <|constrain|>json<|message|>{"command":"rg -n TODO src"}<|call|>leaked'
  ]);
  try {
    const result = await runRemoteChat(harness.remotePort, "opencode", [
      { role: "user", content: "Inspect TODOs" }
    ]);

    expect(result.content).toBe('<tool_call>{"command":"rg -n TODO src","tool":"shell"}</tool_call>');
    expect(result.content).not.toContain("leaked");
  } finally {
    await harness.close();
  }
});

test("remote GPT-OSS parser rejects malformed constrained JSON", async () => {
  const malformedFinal = await startRemoteHarness([
    "<|channel|>commentary to=final <|constrain|>json<|message|>{not-json}<|return|>"
  ]);
  try {
    await expect(runRemoteChat(malformedFinal.remotePort, "chat", [
      { role: "user", content: "hi" }
    ])).rejects.toThrow("malformed constrained final JSON");
  } finally {
    await malformedFinal.close();
  }

  const malformedTool = await startRemoteHarness([
    "<|channel|>commentary to=shell <|constrain|>json<|message|>{not-json}<|call|>"
  ]);
  try {
    await expect(runRemoteChat(malformedTool.remotePort, "opencode", [
      { role: "user", content: "Inspect TODOs" }
    ])).rejects.toThrow("malformed tool-call JSON");
  } finally {
    await malformedTool.close();
  }

  const unknownTool = await startRemoteHarness([
    '<|channel|>commentary to=unknown <|constrain|>json<|message|>{"command":"dir"}<|call|>'
  ]);
  try {
    await expect(runRemoteChat(unknownTool.remotePort, "opencode", [
      { role: "user", content: "Inspect TODOs" }
    ])).rejects.toThrow("unsupported commentary recipient");
  } finally {
    await unknownTool.close();
  }
});

test("remote OpenAI-compatible chat matches local request shape and reasoning deltas", async () => {
  const harness = await startRemoteHarness([], {
    reference: "plain-remote-model",
    promptFormat: "",
    openAiChunks: [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world", reasoning: " reason" } }] },
      { choices: [{ delta: { thinking: " thinking" } }] }
    ]
  });
  try {
    const result = await runRemoteChat(harness.remotePort, "chat", [
      { role: "user", content: "hi" }
    ]);

    expect(result.content).toBe("Hello world");
    expect(result.reasoning).toBe(" reason thinking");
    expect(harness.requests[0].path).toBe("/v1/chat/completions");
    expect(harness.requests[0].body.model).toBe("plain-remote-model");
    expect(harness.requests[0].body.stream_options).toEqual({ include_usage: true });
    expect(harness.requests[0].body.messages[0]).toEqual({ role: "system", content: "Keep formatting intact." });
  } finally {
    await harness.close();
  }
});

test("remote server counts repeated requests from the same app client once", async () => {
  const harness = await startRemoteHarness([
    "<|channel|>final<|message|>ok<|return|>"
  ]);
  const runtime = new RemoteHostRuntime();
  try {
    await runRemoteChat(harness.remotePort, "chat", [{ role: "user", content: "first" }], "", runtime);
    await runRemoteChat(harness.remotePort, "chat", [{ role: "user", content: "second" }], "", runtime);

    const status = await fetch(`http://127.0.0.1:${harness.remotePort}/v1/status`).then((response) => response.json()) as { clients?: Array<{ id?: string }> };
    expect(status.clients).toHaveLength(1);
    expect(status.clients?.[0].id).toContain("unit0-client-");
  } finally {
    await harness.close();
  }
});

test("remote model catalog exposes server context capacity", async () => {
  const harness = await startRemoteHarness([], { contextTokens: 3072 });
  try {
    const discovered = await new RemoteHostRuntime().discover({
      ...appSettings,
      remoteHostPort: harness.remotePort
    });

    expect(discovered.models[0]).toMatchObject({
      id: "gpt-oss-remote",
      contextTokens: 3072
    });
  } finally {
    await harness.close();
  }
});

async function runRemoteChat(
  remotePort: number,
  framework: "chat" | "document_analysis" | "opencode",
  messages: Array<{ role: "user" | "assistant"; content: string; reasoning?: string }>,
  documentTitle = "",
  runtime = new RemoteHostRuntime()
) {
  let content = "";
  let reasoning = "";
  await runtime.streamChat({
    settings: { ...appSettings, remoteHostPort: remotePort, remoteHostIdentity: "remote-test-host", remoteHostId: "remote-test-host" },
    model: { id: "gpt-oss-remote", label: "GPT-OSS Remote", path: "", providerId: "remote", reference: "gpt-oss", createdAt: "" },
    runtimeSettings,
    messages: messages.map((message, index) => ({
      id: `m${index}`,
      threadId: "t1",
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      attachments: [],
      status: "complete",
      createdAt: "",
      updatedAt: ""
    })),
    builtinAgenticFramework: framework,
    documentTitle,
    onToken: (token) => { content += token; },
    onReasoning: (token) => { reasoning += token; }
  });
  return { content, reasoning };
}

async function startRemoteHarness(chunks: string[], options: {
  reference?: string;
  promptFormat?: string;
  contextTokens?: number;
  openAiChunks?: Array<Record<string, unknown>>;
} = {}) {
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const llama = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-oss-remote" }] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/completion") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ path: url.pathname, body: JSON.parse(body) });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const content of chunks) {
          response.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ path: url.pathname, body: JSON.parse(body) });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const payload of options.openAiChunks ?? []) {
          response.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const llamaPort = await listen(llama);
  const remotePort = await reservePort();
  const remote = createRemoteInferenceServer({
    host: "127.0.0.1",
    port: remotePort,
    pairingCode: "ABCD-1234",
    hostIdentity: "remote-test-host",
    models: [{
      id: "gpt-oss-remote",
      label: "GPT-OSS Remote",
      reference: options.reference ?? "gpt-oss",
      backend: "llama-server",
      launchMode: "external",
      url: `http://127.0.0.1:${llamaPort}`,
      nCtx: options.contextTokens ?? 8192,
      promptFormat: options.promptFormat ?? "gpt-oss",
      prewarmOnStart: false
    }]
  });
  await remote.start();
  return {
    remotePort,
    requests,
    close: async () => {
      await remote.stop();
      await close(llama);
    }
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve server port.")));
        return;
      }
      resolve(address.port);
    });
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
