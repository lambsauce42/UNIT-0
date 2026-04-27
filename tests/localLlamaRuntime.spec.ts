import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildLlamaServerCommand, LocalLlamaRuntime, resolveBundledLlamaServerBinary } from "../src/main/localLlamaRuntime";

test("builds a llama-server command for one local slot", () => {
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
    "C:\\runtime\\slots"
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
