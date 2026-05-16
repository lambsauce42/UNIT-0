import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { gptOssOpenCodeRequestMaxTokensForPromptTokens, renderGptOssOpenCodeProxyPrompt } from "../src/main/openCodeRuntime";
import type { ChatRuntimeSettings } from "../src/shared/types";
import { estimatedTokens, memorySnapshot, nowMs, writePerfRecord } from "./perfHarness";

const perfSettings: ChatRuntimeSettings = {
  nCtx: 8192,
  nGpuLayers: 0,
  temperature: 0,
  repeatPenalty: 1,
  maxTokens: 256,
  reasoningEffort: "medium",
  permissionMode: "full_access",
  trimReserveTokens: 2000,
  trimReservePercent: 15,
  trimAmountTokens: 4000,
  trimAmountPercent: 30,
  systemPrompt: ""
};

test("@perf OpenCode native GPT-OSS proxy records cache policy and prompt budget", () => {
  const started = nowMs();
  const memoryBefore = memorySnapshot();
  const source = fs.readFileSync("src/main/openCodeRuntime.ts", "utf8");
  const cachePromptMatch = /cache_prompt:\s*(true|false)/u.exec(source);
  const slotMatch = /id_slot:\s*options\.endpoint\.rawCompletionSlotId\s*\?\?\s*(\d+)/u.exec(source);
  const cachePrompt = cachePromptMatch?.[1] === "true";
  const prompt = renderGptOssOpenCodeProxyPrompt({
    messages: [
      { role: "system", content: "OpenCode system prompt" },
      { role: "user", content: "List files and answer briefly." },
      {
        role: "assistant",
        content: "[[UNIT0_ANALYSIS]]Need files.",
        tool_calls: [{
          id: "call_glob",
          type: "function",
          function: { name: "glob", arguments: "{\"pattern\":\"*\"}" }
        }]
      },
      { role: "tool", tool_call_id: "call_glob", content: "alpha.txt\nbeta.txt\n" }
    ],
    tools: [{ type: "function", function: { name: "glob", parameters: { type: "object" } } }]
  }, {
    cwd: "C:\\Project",
    prompt: "List files and answer briefly.",
    modelLabel: "fake-gpt-oss",
    nativeGptOss: true,
    endpoint: { baseUrl: "http://127.0.0.1:1234", modelId: "fake-gpt-oss" },
    settings: perfSettings,
    permissionMode: "full_access"
  });
  const totalMs = nowMs() - started;
  const memoryAfter = memorySnapshot();
  const simulatedPrefillMs = cachePrompt ? 15 : 90;
  const simulatedDecodeMs = 40;
  const simulatedTtftMs = simulatedPrefillMs + 8;
  const simulatedTotalMs = simulatedPrefillMs + simulatedDecodeMs;
  const nPredict = gptOssOpenCodeRequestMaxTokensForPromptTokens(estimatedTokens(prompt), perfSettings, 80);

  expect(cachePromptMatch).toBeTruthy();
  expect(slotMatch?.[1]).toBe("0");
  expect(prompt).toContain("# OpenCode Tool Result");
  expect(nPredict).toBeGreaterThan(0);
  writePerfRecord("opencode-native-gptoss-proxy-cache-policy", {
    measured_harness_ms: totalMs,
    simulated_total_ms: simulatedTotalMs,
    simulated_ttft_ms: simulatedTtftMs,
    simulated_prefill_ms: simulatedPrefillMs,
    simulated_decode_ms: simulatedDecodeMs,
    prompt_chars: prompt.length,
    prompt_tokens_estimated: estimatedTokens(prompt),
    n_predict: nPredict,
    request_count: 1,
    cache_prompt: cachePrompt,
    id_slot: Number(slotMatch?.[1] ?? 0),
    rss_delta_bytes: memoryAfter.rss - memoryBefore.rss,
    heap_delta_bytes: memoryAfter.heapUsed - memoryBefore.heapUsed
  });
});
