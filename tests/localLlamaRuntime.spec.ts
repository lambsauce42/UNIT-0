import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildEmbeddingServerCommand } from "../src/main/embeddingRuntime";
import { buildLlamaServerCommand, GptOssChannelParser, LocalLlamaRuntime, resolveBundledLlamaServerBinary } from "../src/main/localLlamaRuntime";

test("builds a llama-server command for one local chat slot by default", () => {
  const command = buildLlamaServerCommand({
    binaryPath: "C:\\runtime\\llama-server.exe",
    port: 12345,
    modelPath: "C:\\models\\model.gguf",
    settings: {
      nCtx: 8192,
      nGpuLayers: -1,
      temperature: 0.7,
      repeatPenalty: 1.1,
      maxTokens: 512,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: "You are a helpful local assistant."
    }
  });

  expect(command.command).toBe("C:\\runtime\\llama-server.exe");
  expect(command.cwd).toBe("C:\\runtime");
  expect(command.args).toEqual([
    "--host",
    "127.0.0.1",
    "--port",
    "12345",
    "--model",
    "C:\\models\\model.gguf",
    "--ctx-size",
    "8192",
    "--n-gpu-layers",
    "auto",
    "-np",
    "1",
    "--slots",
    "--slot-save-path",
    "C:\\runtime\\slots",
    "--no-webui"
  ]);
});

test("builds a llama-server command for multiple explicit slots", () => {
  const command = buildLlamaServerCommand({
    binaryPath: "C:\\runtime\\llama-server.exe",
    port: 12345,
    modelPath: "C:\\models\\model.gguf",
    parallelSlots: 2,
    settings: {
      nCtx: 8192,
      nGpuLayers: -1,
      temperature: 0.7,
      repeatPenalty: 1.1,
      maxTokens: 512,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: "You are a helpful local assistant."
    }
  });

  expect(command.args).toContain("--ctx-size");
  expect(command.args[command.args.indexOf("--ctx-size") + 1]).toBe("16384");
  expect(command.args).toContain("-np");
  expect(command.args[command.args.indexOf("-np") + 1]).toBe("2");
});

test("enables special token output for native GPT-OSS llama-server sessions", () => {
  const command = buildLlamaServerCommand({
    binaryPath: "C:\\runtime\\llama-server.exe",
    port: 12345,
    modelPath: "C:\\models\\gpt-oss-20b-mxfp4.gguf",
    settings: {
      nCtx: 8192,
      nGpuLayers: -1,
      temperature: 0.7,
      repeatPenalty: 1.1,
      maxTokens: 512,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: ""
    }
  });

  expect(command.args).toContain("--special");
});

test("enables special token output when GPT-OSS is detected outside the file path", () => {
  const command = buildLlamaServerCommand({
    binaryPath: "C:\\runtime\\llama-server.exe",
    port: 12345,
    modelPath: "C:\\models\\renamed-model.gguf",
    nativeGptOss: true,
    settings: {
      nCtx: 8192,
      nGpuLayers: -1,
      temperature: 0.7,
      repeatPenalty: 1.1,
      maxTokens: 512,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: ""
    }
  });

  expect(command.args).toContain("--special");
});

test("stops GPT-OSS channel parsing after terminal return and call markers", () => {
  const finalParser = new GptOssChannelParser({ defaultChannel: "analysis" });
  expect(finalParser.push("<|channel|>final<|message|>ok<|return|>leaked")).toEqual({
    content: "ok",
    reasoning: ""
  });
  expect(finalParser.finish()).toEqual({ content: "", reasoning: "" });

  const toolParser = new GptOssChannelParser({ defaultChannel: "analysis", toolRecipients: ["glob"] });
  expect(toolParser.push('<|channel|>commentary to=glob code<|message|>{"pattern":"*"}<|call|>leaked')).toEqual({
    content: '<tool_call>{"pattern":"*","tool":"glob"}</tool_call>',
    reasoning: "",
    toolCallContent: '<tool_call>{"pattern":"*","tool":"glob"}</tool_call>'
  });
  expect(toolParser.finish()).toEqual({ content: "", reasoning: "" });
});

test("optionally treats final channel end as the assistant message boundary", () => {
  const parser = new GptOssChannelParser({ defaultChannel: "analysis", stopAfterFinalEnd: true });
  expect(parser.push("<|channel|>analysis<|message|>Need answer.<|end|><|start|>assistant<|channel|>final<|message|>ok<|end|><|start|>assistant<|channel|>analysis<|message|>leaked")).toEqual({
    content: "ok",
    reasoning: "Need answer."
  });
  expect(parser.finish()).toEqual({ content: "", reasoning: "" });
});

test("parses GPT-OSS commentary prose separately from final and tool calls", () => {
  const bareCommentaryParser = new GptOssChannelParser({ defaultChannel: "analysis", toolRecipients: ["glob"] });
  expect(bareCommentaryParser.push("<|channel|>analysis<|message|>Need acknowledge.<|end|><|start|>assistant<|channel|>commentary<|message|>Ok<|return|>")).toEqual({
    content: "",
    reasoning: "Need acknowledge.",
    commentary: "Ok"
  });
  expect(bareCommentaryParser.finish()).toEqual({ content: "", reasoning: "" });

  const redundantCommentaryParser = new GptOssChannelParser({ defaultChannel: "analysis", toolRecipients: ["glob"] });
  expect(redundantCommentaryParser.push("<|channel|>analysis<|message|>Need acknowledge.<|end|><|start|>assistant<|channel|>commentary to=commentary<|message|>Got it.<|return|>")).toEqual({
    content: "",
    reasoning: "Need acknowledge.",
    commentary: "Got it."
  });

  const toolPreambleParser = new GptOssChannelParser({ defaultChannel: "analysis", toolRecipients: ["glob"] });
  expect(toolPreambleParser.push('<|channel|>analysis<|message|>Need files.<|end|><|start|>assistant<|channel|>commentary<|message|>I will list files.<|end|><|start|>assistant<|channel|>commentary to=glob code<|message|>{"pattern":"*"}<|call|>')).toEqual({
    content: '<tool_call>{"pattern":"*","tool":"glob"}</tool_call>',
    reasoning: "Need files.",
    commentary: "I will list files.",
    toolCallContent: '<tool_call>{"pattern":"*","tool":"glob"}</tool_call>'
  });
});

test("rejects malformed GPT-OSS constrained JSON instead of exposing it as text", () => {
  const finalParser = new GptOssChannelParser({ defaultChannel: "analysis" });
  expect(() => finalParser.push("<|channel|>commentary to=final <|constrain|>json<|message|>{not-json}<|return|>")).toThrow("malformed constrained final JSON");

  const toolParser = new GptOssChannelParser({ defaultChannel: "analysis", toolRecipients: ["glob"] });
  expect(() => toolParser.push("<|channel|>commentary to=glob code<|message|>{not-json}<|call|>")).toThrow("malformed tool-call JSON");

  const unknownRecipientParser = new GptOssChannelParser({ defaultChannel: "analysis", toolRecipients: ["glob"] });
  expect(() => unknownRecipientParser.push('<|channel|>commentary to=shell code<|message|>{"command":"dir"}<|call|>')).toThrow("unsupported commentary recipient");
});

test("builds a dedicated embedding llama-server command", () => {
  const command = buildEmbeddingServerCommand({
    binaryPath: "C:\\runtime\\llama-server.exe",
    port: 12345,
    modelPath: "C:\\models\\nomic-embed.gguf",
    nCtx: 2048,
    nGpuLayers: -1
  });

  expect(command.command).toBe("C:\\runtime\\llama-server.exe");
  expect(command.cwd).toBe("C:\\runtime");
  expect(command.args).toEqual([
    "--host",
    "127.0.0.1",
    "--port",
    "12345",
    "--model",
    "C:\\models\\nomic-embed.gguf",
    "--ctx-size",
    "2048",
    "--ubatch-size",
    "2048",
    "--n-gpu-layers",
    "auto",
    "--embedding",
    "--pooling",
    "mean",
    "-np",
    "1",
    "--no-webui"
  ]);
});

test("resolves the bundled llama-server binary from runtime/llama.cpp", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-runtime-"));
  const runtimeDir = path.join(dir, "runtime", "llama.cpp");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const binaryPath = path.join(runtimeDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  fs.writeFileSync(binaryPath, "");

  expect(resolveBundledLlamaServerBinary(dir)).toBe(binaryPath);
});

test("opens OpenCode endpoint on the local cache slot without increasing parallel slots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-opencode-endpoint-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  let spawnArgs: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    return Response.json({});
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: ((_command: string, args: readonly string[]) => {
      spawnArgs = [...args];
      return spawned;
    }) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });

  const endpoint = await runtime.openAiEndpoint({
    model: { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() },
    settings: {
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
      systemPrompt: "You are a helpful local assistant."
    }
  });

  expect(endpoint.rawCompletionSlotId).toBe(0);
  expect(spawnArgs[spawnArgs.indexOf("--ctx-size") + 1]).toBe("4096");
  expect(spawnArgs[spawnArgs.indexOf("-np") + 1]).toBe("1");
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("warms OpenCode endpoint without dirtying the local cache slot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-opencode-warm-endpoint-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  let spawnCount = 0;
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    return Response.json({});
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => {
      spawnCount += 1;
      return spawned;
    }) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  const model = { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() };
  const settings = {
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
    systemPrompt: "You are a helpful local assistant."
  } as const;

  await runtime.openAiEndpoint({ model, settings, reserveForGeneration: false });
  const endpoint = await runtime.openAiEndpoint({ model, settings });

  expect(endpoint.rawCompletionSlotId).toBe(0);
  expect(spawnCount).toBe(1);
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reuses the raw OpenCode slot after successful OpenCode endpoint use", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-opencode-reuse-endpoint-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  let spawnCount = 0;
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    return Response.json({});
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => {
      spawnCount += 1;
      return spawned;
    }) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  const model = { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() };
  const settings = {
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
    systemPrompt: "You are a helpful local assistant."
  } as const;

  await runtime.openAiEndpoint({ model, settings });
  await runtime.openAiEndpoint({ model, settings });

  expect(spawnCount).toBe(1);
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("streams content from llama-server SSE responses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-stream-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => spawned) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  let output = "";

  await runtime.streamChat({
    model: { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() },
    settings: {
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
      systemPrompt: "You are a helpful local assistant."
    },
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "Hi", status: "complete", createdAt: "", updatedAt: "" }],
    onToken: (token) => {
      output += token;
    }
  });

  expect(output).toBe("hello");
  const chatRequest = requests.find((request) => request.url.endsWith("/v1/chat/completions"));
  expect(chatRequest?.body).toMatchObject({ cache_prompt: true, id_slot: 0 });
  runtime.close();
});

test("restores the saved slot after a same-key stream fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-dirty-slot-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  const slotDir = path.join(dir, "slots");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  fs.mkdirSync(slotDir, { recursive: true });
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const slotActions: string[] = [];
  let completionCount = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    if (url.includes("/slots/0?action=")) {
      const parsedUrl = new URL(url);
      const action = parsedUrl.searchParams.get("action") ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) as { filename?: string } : {};
      slotActions.push(action);
      if (action === "save" && body.filename) {
        fs.writeFileSync(path.join(slotDir, body.filename), "slot");
      }
      return Response.json({ ok: true });
    }
    completionCount += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (completionCount === 2) {
          controller.enqueue(new TextEncoder().encode("data: {bad-json}\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => spawned) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  const model = { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() };
  const settings = {
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
    systemPrompt: "You are a helpful local assistant."
  } as const;
  const messages = [{ id: "m1", threadId: "t1", role: "user" as const, content: "Hi", status: "complete" as const, createdAt: "", updatedAt: "" }];

  await runtime.streamChat({ model, settings, messages, cacheKey: "thread-1", onToken: () => undefined });
  await expect(runtime.streamChat({ model, settings, messages, cacheKey: "thread-1", onToken: () => undefined })).rejects.toThrow();
  await runtime.streamChat({ model, settings, messages, cacheKey: "thread-1", onToken: () => undefined });

  expect(slotActions).toEqual(["save", "restore", "save"]);
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restarts the server after a dirty same-key stream without a saved slot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-dirty-unsaved-slot-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  let spawnCount = 0;
  let completionCount = 0;
  const spawnedProcesses: Array<EventEmitter & { exitCode: number | null; kill: () => void }> = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    if (url.includes("/slots/0?action=")) {
      return Response.json({ ok: true });
    }
    completionCount += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (completionCount === 1) {
          controller.enqueue(new TextEncoder().encode("data: {bad-json}\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => {
      spawnCount += 1;
      const spawned = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        kill: () => {
          spawned.exitCode = 1;
        }
      });
      spawnedProcesses.push(spawned);
      return spawned;
    }) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  const model = { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() };
  const settings = {
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
    systemPrompt: "You are a helpful local assistant."
  } as const;
  const messages = [{ id: "m1", threadId: "t1", role: "user" as const, content: "Hi", status: "complete" as const, createdAt: "", updatedAt: "" }];
  let output = "";

  await expect(runtime.streamChat({ model, settings, messages, cacheKey: "thread-1", onToken: () => undefined })).rejects.toThrow();
  await runtime.streamChat({ model, settings, messages, cacheKey: "thread-1", onToken: (token) => { output += token; } });

  expect(output).toBe("ok");
  expect(spawnCount).toBe(2);
  expect(spawnedProcesses[0]?.exitCode).toBe(1);
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restarts before handing OpenCode a raw endpoint when the active slot is dirty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-opencode-dirty-endpoint-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  let spawnCount = 0;
  let completionCount = 0;
  const spawnedProcesses: Array<EventEmitter & { exitCode: number | null; kill: () => void }> = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    if (url.includes("/slots/0?action=")) {
      return Response.json({ ok: true });
    }
    completionCount += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {bad-json}\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => {
      spawnCount += 1;
      const spawned = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        kill: () => {
          spawned.exitCode = 1;
        }
      });
      spawnedProcesses.push(spawned);
      return spawned;
    }) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  const model = { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() };
  const settings = {
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
    systemPrompt: "You are a helpful local assistant."
  } as const;
  const messages = [{ id: "m1", threadId: "t1", role: "user" as const, content: "Hi", status: "complete" as const, createdAt: "", updatedAt: "" }];

  await expect(runtime.streamChat({ model, settings, messages, cacheKey: "thread-1", onToken: () => undefined })).rejects.toThrow();
  const endpoint = await runtime.openAiEndpoint({ model, settings });

  expect(endpoint.rawCompletionSlotId).toBe(0);
  expect(completionCount).toBe(1);
  expect(spawnCount).toBe(2);
  expect(spawnedProcesses[0]?.exitCode).toBe(1);
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("uses native GPT-OSS prompt channels for document analysis", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-gptoss-stream-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "gpt-oss-20b-mxfp4.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"content":"<|channel|>analysis<|message|>Need search.<|end|><|start|>assistant<|channel|>final<|message|><tool_call>{\\"tool\\":\\"search\\",\\"query\\":\\"pdf links\\",\\"top_k\\":8}</tool_call><|call|>"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => spawned) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  let content = "";
  let reasoning = "";

  await runtime.streamChat({
    model: { id: "model", label: "gpt-oss-20b-mxfp4", path: modelPath, createdAt: new Date().toISOString() },
    settings: {
      nCtx: 4096,
      nGpuLayers: 0,
      temperature: 1,
      repeatPenalty: 1,
      maxTokens: 1024,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: "Keep answers concise."
    },
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "Tell me sth about pdf links", status: "complete", createdAt: "", updatedAt: "" }],
    builtinAgenticFramework: "document_analysis",
    documentTitle: "test",
    onToken: (token) => {
      content += token;
    },
    onReasoning: (token) => {
      reasoning += token;
    }
  });

  const completionRequest = requests.find((request) => request.url.endsWith("/completion"));
  expect(requests.some((request) => request.url.endsWith("/v1/chat/completions"))).toBe(false);
  expect(completionRequest?.body?.prompt).toContain("This framework is for analyzing one selected indexed document index");
  expect(completionRequest?.body?.prompt).toContain('The selected indexed document index is "test".');
  expect(completionRequest?.body?.prompt).toContain("commentary may target only the host-managed tool recipients `search` and `modify_results`");
  expect(completionRequest?.body?.prompt).toContain("After a non-empty relevant search result, answer from that evidence instead of searching again.");
  expect(completionRequest?.body?.prompt).toContain("# Instructions\n\nKeep answers concise.");
  expect(completionRequest?.body?.prompt).toMatch(/<\|start\|>assistant$/u);
  expect(completionRequest?.body?.n_predict).toBe(1024);
  expect(reasoning).toBe("Need search.");
  expect(content).toBe('<tool_call>{"tool":"search","query":"pdf links","top_k":8}</tool_call>');
  runtime.close();
});

test("streams native GPT-OSS final channel tokens before the completion ends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-gptoss-final-stream-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "gpt-oss-20b-mxfp4.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  let resolveFirstFinalToken: (() => void) | null = null;
  const firstFinalTokenSeen = new Promise<void>((resolve) => {
    resolveFirstFinalToken = resolve;
  });
  let releaseRemainingTokens: (() => void) | null = null;
  const remainingTokensGate = new Promise<void>((resolve) => {
    releaseRemainingTokens = resolve;
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const content of [
          "<|channel|>",
          "analysis",
          "<|message|>",
          "Need",
          " exactly",
          " six",
          " words",
          ".",
          "<|end|>",
          "<|start|>",
          "assistant",
          "<|channel|>",
          "final",
          "<|message|>",
          "hello"
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
        }
        await remainingTokensGate;
        for (const content of [" from", " streaming", " probe", " now", " please", "<|return|>"]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => spawned) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  let content = "";
  let reasoning = "";
  const run = runtime.streamChat({
    model: { id: "model", label: "gpt-oss-20b-mxfp4", path: modelPath, createdAt: new Date().toISOString() },
    settings: {
      nCtx: 4096,
      nGpuLayers: 0,
      temperature: 1,
      repeatPenalty: 1,
      maxTokens: 1024,
      reasoningEffort: "low",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: ""
    },
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "Reply with exactly six words.", status: "complete", createdAt: "", updatedAt: "" }],
    builtinAgenticFramework: "opencode",
    onToken: (token) => {
      content += token;
      if (content === "hello") {
        resolveFirstFinalToken?.();
      }
    },
    onReasoning: (token) => {
      reasoning += token;
    }
  });

  await firstFinalTokenSeen;
  expect(content).toBe("hello");
  expect(reasoning).toBe("Need exactly six words.");

  releaseRemainingTokens?.();
  await run;
  expect(content).toBe("hello from streaming probe now please");
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("decodes GPT-OSS commentary final JSON", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-gptoss-json-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "gpt-oss-20b-mxfp4.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"content":"<|channel|>commentary to=final <|constrain|>json<|message|>{\\"final\\":\\"JSON final\\"}<|end|>"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => spawned) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  let output = "";

  await runtime.streamChat({
    model: { id: "model", label: "gpt-oss-20b-mxfp4", path: modelPath, createdAt: new Date().toISOString() },
    settings: {
      nCtx: 4096,
      nGpuLayers: 0,
      temperature: 1,
      repeatPenalty: 1,
      maxTokens: 1024,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: ""
    },
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "Return JSON final", status: "complete", createdAt: "", updatedAt: "" }],
    onToken: (token) => {
      output += token;
    }
  });

  expect(output).toBe("JSON final");
  runtime.close();
});

test("maps native GPT-OSS document tool commentary to strict tool-call content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-gptoss-doc-commentary-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "gpt-oss-20b-mxfp4.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"content":"<|channel|>commentary to=search <|constrain|>json<|message|>{\\"tool\\":\\"modify_results\\",\\"query\\":\\"pdf links\\",\\"top_k\\":8}<|call|>"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => spawned) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  let content = "";
  let reasoning = "";

  await runtime.streamChat({
    model: { id: "model", label: "gpt-oss-20b-mxfp4", path: modelPath, createdAt: new Date().toISOString() },
    settings: {
      nCtx: 4096,
      nGpuLayers: 0,
      temperature: 1,
      repeatPenalty: 1,
      maxTokens: 1024,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: ""
    },
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "Tell me sth about pdf links", status: "complete", createdAt: "", updatedAt: "" }],
    builtinAgenticFramework: "document_analysis",
    documentTitle: "test",
    onToken: (token) => {
      content += token;
    },
    onReasoning: (token) => {
      reasoning += token;
    }
  });

  expect(content).toBe('<tool_call>{"tool":"search","query":"pdf links","top_k":8}</tool_call>');
  expect(reasoning).toBe("");
  runtime.close();
});

test("maps native GPT-OSS modify-results commentary to strict tool-call content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-gptoss-doc-modify-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "gpt-oss-20b-mxfp4.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"content":"<|channel|>commentary to=modify_results <|constrain|>json<|message|>{\\"drop_result_ids\\":[\\"r2\\"],\\"expand\\":[{\\"result_id\\":\\"r1\\",\\"before\\":1,\\"after\\":0}]}<|call|>"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const runtime = new LocalLlamaRuntime({
    binaryPath,
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl: (() => spawned) as unknown as typeof import("node:child_process").spawn,
    startupTimeoutMs: 1000
  });
  let content = "";

  await runtime.streamChat({
    model: { id: "model", label: "gpt-oss-20b-mxfp4", path: modelPath, createdAt: new Date().toISOString() },
    settings: {
      nCtx: 4096,
      nGpuLayers: 0,
      temperature: 1,
      repeatPenalty: 1,
      maxTokens: 1024,
      reasoningEffort: "medium",
      permissionMode: "full_access",
      trimReserveTokens: 2000,
      trimReservePercent: 15,
      trimAmountTokens: 4000,
      trimAmountPercent: 30,
      systemPrompt: ""
    },
    messages: [{ id: "m1", threadId: "t1", role: "user", content: "Refine the results", status: "complete", createdAt: "", updatedAt: "" }],
    builtinAgenticFramework: "document_analysis",
    documentTitle: "test",
    onToken: (token) => {
      content += token;
    }
  });

  expect(content).toBe('<tool_call>{"drop_result_ids":["r2"],"expand":[{"result_id":"r1","before":1,"after":0}],"tool":"modify_results"}</tool_call>');
  runtime.close();
});

test("fails visibly when the bundled binary is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-llama-missing-"));
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(modelPath, "");
  const runtime = new LocalLlamaRuntime({ runtimeRoot: dir, startupTimeoutMs: 10 });

  await expect(
    runtime.streamChat({
      model: { id: "model", label: "Model", path: modelPath, createdAt: "" },
      settings: {
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
        systemPrompt: "You are a helpful local assistant."
      },
      messages: [],
      onToken: () => undefined
    })
  ).rejects.toThrow(/Bundled llama-server binary was not found/);
});
