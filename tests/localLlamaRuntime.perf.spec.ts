import { expect, test } from "@playwright/test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalLlamaRuntime } from "../src/main/localLlamaRuntime";
import type { ChatRuntimeSettings } from "../src/shared/types";
import { estimatedTokens, memorySnapshot, nowMs, writePerfRecord } from "./perfHarness";

const perfSettings: ChatRuntimeSettings = {
  nCtx: 4096,
  nGpuLayers: 0,
  temperature: 0,
  repeatPenalty: 1,
  maxTokens: 128,
  reasoningEffort: "medium",
  permissionMode: "full_access",
  trimReserveTokens: 2000,
  trimReservePercent: 15,
  trimAmountTokens: 4000,
  trimAmountPercent: 30,
  systemPrompt: "You are concise."
};

test("@perf local llama normal chat records cache, slot, TTFT, and throughput metrics", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-local-llama-perf-"));
  const binaryPath = path.join(dir, "llama-server.exe");
  const modelPath = path.join(dir, "model.gguf");
  fs.writeFileSync(binaryPath, "");
  fs.writeFileSync(modelPath, "");
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => undefined
  });
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const slotActions: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, body });
    if (url.endsWith("/health")) {
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "local-model" }] });
    }
    if (url.includes("/slots/0?action=")) {
      slotActions.push(new URL(url).searchParams.get("action") ?? "");
      return Response.json({ ok: true });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await sleep(35);
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"alpha"}}]}\n\n'));
        await sleep(10);
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" beta"}}]}\n\n'));
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
  const memoryBefore = memorySnapshot();
  const started = nowMs();
  let output = "";
  let firstTokenMs: number | null = null;
  try {
    await runtime.streamChat({
      model: { id: "model", label: "Model", path: modelPath, createdAt: new Date().toISOString() },
      settings: perfSettings,
      messages: [{ id: "m1", threadId: "t1", role: "user", content: "Hi", status: "complete", createdAt: "", updatedAt: "" }],
      cacheKey: "thread-1",
      onToken: (token) => {
        output += token;
        firstTokenMs ??= nowMs() - started;
      }
    });
    const totalMs = nowMs() - started;
    const memoryAfter = memorySnapshot();
    const chatRequest = requests.find((request) => request.url.endsWith("/v1/chat/completions"));
    expect(output).toBe("alpha beta");
    expect(chatRequest?.body).toMatchObject({ cache_prompt: true, id_slot: 0 });
    expect(slotActions).toContain("save");
    writePerfRecord("local-llama-normal-cache", {
      total_ms: totalMs,
      ttft_ms: firstTokenMs,
      tokens_per_second: estimatedTokens(output) / Math.max(0.001, (totalMs - (firstTokenMs ?? totalMs)) / 1000),
      prompt_tokens_estimated: estimatedTokens(JSON.stringify(chatRequest?.body?.messages ?? [])),
      request_count: requests.filter((request) => request.url.endsWith("/v1/chat/completions")).length,
      slot_save_count: slotActions.filter((action) => action === "save").length,
      slot_restore_count: slotActions.filter((action) => action === "restore").length,
      cache_prompt: Boolean(chatRequest?.body?.cache_prompt),
      rss_delta_bytes: memoryAfter.rss - memoryBefore.rss,
      heap_delta_bytes: memoryAfter.heapUsed - memoryBefore.heapUsed
    });
  } finally {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
