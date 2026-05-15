import { expect, test } from "@playwright/test";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { gptOssOpenCodeRequestMaxTokens, openCodeConfig, RealOpenCodeRuntime, renderGptOssOpenCodeProxyPrompt, type OpenCodeRuntimeEvent, type OpenCodeRunOptions } from "../src/main/openCodeRuntime";
import type { ChatRuntimeSettings } from "../src/shared/types";

const baseSettings: ChatRuntimeSettings = {
  nCtx: 32768,
  nGpuLayers: 0,
  temperature: 0,
  repeatPenalty: 1,
  maxTokens: 512,
  reasoningEffort: "medium",
  permissionMode: "full_access",
  trimReserveTokens: 2000,
  trimReservePercent: 15,
  trimAmountTokens: 4000,
  trimAmountPercent: 30,
  systemPrompt: ""
};

type FakeChunk = string | { content: string; pauseAfter: string };

test("OpenCode config maps Unit-0 full access to OpenCode web permissions", () => {
  const fullAccess = openCodeConfig({
    cwd: "C:\\Project",
    prompt: "hi",
    modelLabel: "fake-gpt-oss",
    nativeGptOss: true,
    endpoint: { baseUrl: "http://127.0.0.1:1234", modelId: "fake-gpt-oss" },
    settings: baseSettings,
    permissionMode: "full_access"
  });
  expect(fullAccess.permission).toBe("allow");

  const defaultPermissions = openCodeConfig({
    cwd: "C:\\Project",
    prompt: "hi",
    modelLabel: "fake-gpt-oss",
    nativeGptOss: true,
    endpoint: { baseUrl: "http://127.0.0.1:1234", modelId: "fake-gpt-oss" },
    settings: baseSettings,
    permissionMode: "default_permissions"
  });
  expect(defaultPermissions.permission).toMatchObject({
    bash: "ask",
    doom_loop: "ask",
    external_directory: "ask",
    lsp: "allow",
    skill: "allow",
    webfetch: "ask",
    websearch: "ask"
  });
});

test("real OpenCode GPT-OSS proxy rejects final-only output before rendering it", async () => {
  test.setTimeout(90_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-final-"));
  const fakeLlama = await startFakeRawCompletionServer([
    ["<|channel|>final<|message|>", { content: "o", pauseAfter: "first-final-token" }, "k", "<|return|>"]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "Answer exactly ok. Treat literal <|return|> as text.",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("first-final-token");
    await expect.poll(() => events.some((event) => event.type === "error" && event.message.includes("final output before streamed reasoning"))).toBe(true);
    expect(events.some((event) => event.type === "assistant.delta")).toBe(false);
    fakeLlama.release("first-final-token");
    await run;

    const assistantText = events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("");
    expect(assistantText).toBe("");
    expect(fakeLlama.requests[0]?.prompt).toContain("<|start|>assistant");
    expect(fakeLlama.requests[0]?.prompt).toContain("< |return|>");
    expect(fakeLlama.requests[0]?.prompt).not.toContain("literal <|return|>");
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy streams valid final tokens before upstream completion", async () => {
  test.setTimeout(90_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-valid-final-"));
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>",
      { content: "Need ", pauseAfter: "first-reasoning-token" },
      "answer.",
      "<|end|><|start|>assistant<|channel|>final<|message|>",
      { content: "o", pauseAfter: "first-valid-final-token" },
      "k",
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "Answer exactly ok.",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("first-reasoning-token");
    await expect.poll(() => events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("Need ");
    expect(events.some((event) => event.type === "assistant.delta")).toBe(false);
    fakeLlama.release("first-reasoning-token");
    await fakeLlama.waitForPause("first-valid-final-token");
    await expect.poll(() => events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("Need answer.");
    await expect.poll(() => events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("o");
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    fakeLlama.release("first-valid-final-token");
    await run;

    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("ok");
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({ type: "final.snapshot", content: "ok", strict: true, malformed: undefined });
    expect(events.find((event) => event.type === "final.snapshot" && event.messageId)).toBeTruthy();
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy continues analysis-only turns into final channel", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-analysis-only-"));
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need greeting.",
      "<|return|>"
    ],
    [
      { content: "Hel", pauseAfter: "continued-final-token" },
      "lo!",
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "hi",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("continued-final-token");
    await expect.poll(() => fakeLlama.requests.length).toBe(2);
    await expect.poll(() => events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("Need greeting.");
    await expect.poll(() => events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Hel");
    fakeLlama.release("continued-final-token");
    await run;

    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Hello!");
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({ type: "final.snapshot", content: "Hello!", malformed: undefined });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(fakeLlama.requests[1]?.prompt).toContain("<|channel|>analysis<|message|>Need greeting.<|end|><|start|>assistant<|channel|>final<|message|>");
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy continues analysis-only turns when llama suppresses terminal return", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-analysis-no-return-"));
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need acknowledgement."
    ],
    [
      { content: "Sure", pauseAfter: "continued-final-token-without-return" },
      ".",
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "Cool!",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("continued-final-token-without-return");
    await expect.poll(() => fakeLlama.requests.length).toBe(2);
    await expect.poll(() => events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("Need acknowledgement.");
    await expect.poll(() => events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Sure");
    fakeLlama.release("continued-final-token-without-return");
    await run;

    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Sure.");
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({ type: "final.snapshot", content: "Sure.", malformed: undefined });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(fakeLlama.requests[1]?.prompt).toContain("<|channel|>analysis<|message|>Need acknowledgement.<|end|><|start|>assistant<|channel|>final<|message|>");
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy repeats final continuation when the model keeps emitting analysis", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-repeated-analysis-"));
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Must keep concise, "
    ],
    [
      "<|channel|>analysis<|message|>answer with greeting."
    ],
    [
      { content: "Hi", pauseAfter: "repeated-final-token" },
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "hi potato",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("repeated-final-token");
    await expect.poll(() => fakeLlama.requests.length).toBe(3);
    await expect.poll(() => events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("Must keep concise, answer with greeting.");
    await expect.poll(() => events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Hi");
    fakeLlama.release("repeated-final-token");
    await run;

    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Hi");
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({ type: "final.snapshot", content: "Hi", reasoning: "Must keep concise, answer with greeting.", malformed: undefined });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(fakeLlama.requests[1]?.prompt).toContain("<|channel|>analysis<|message|>Must keep concise, <|end|><|start|>assistant<|channel|>final<|message|>");
    expect(fakeLlama.requests[2]?.prompt).toContain("<|channel|>analysis<|message|>answer with greeting.<|end|><|start|>assistant<|channel|>final<|message|>");
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy does not invent final content after repeated analysis continuations", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-repeated-analysis-empty-"));
  const fakeLlama = await startFakeRawCompletionServer([
    ["<|channel|>analysis<|message|>Need greeting, "],
    ["<|channel|>analysis<|message|>keep concise, "],
    ["<|channel|>analysis<|message|>answer now, "],
    ["<|channel|>analysis<|message|>still thinking, "],
    ["<|channel|>analysis<|message|>no final."]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events = await collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "hi potato",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    });

    expect(fakeLlama.requests).toHaveLength(5);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("");
    expect(events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("Need greeting, keep concise, answer now, still thinking, no final.");
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({
      type: "final.snapshot",
      content: "",
      reasoning: "Need greeting, keep concise, answer now, still thinking, no final.",
      malformed: undefined
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy streams commentary prose as visible content", async () => {
  test.setTimeout(90_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-commentary-"));
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need acknowledgement.",
      "<|end|><|start|>assistant<|channel|>commentary to=commentary<|message|>",
      { content: "Ok", pauseAfter: "commentary-token" },
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "use caveman speak during reasoning",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("commentary-token");
    await expect.poll(() => events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("Need acknowledgement.");
    await expect.poll(() => events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Ok");
    fakeLlama.release("commentary-token");
    await run;

    expect(fakeLlama.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("Ok");
    expect(events.some((event) => event.type === "timeline" && event.block.kind === "tool")).toBe(false);
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({ type: "final.snapshot", content: "Ok", malformed: undefined });
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy executes and renders tool calls once", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-tool-"));
  fs.writeFileSync(path.join(projectDir, "benchmark_report.md"), "# Benchmark\n");
  fs.writeFileSync(path.join(projectDir, "hello.c"), "int main(void) { return 0; }\n");
  fs.writeFileSync(path.join(projectDir, "hello.exe"), "");
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need files.",
      "<|end|><|start|>assistant<|channel|>commentary to=glob code<|message|>",
      "{\"pattern\":\"*\"}",
      { content: "<|call|>", pauseAfter: "tool-call" }
    ],
    [
      "<|channel|>analysis<|message|>Got files.",
      "<|end|><|start|>assistant<|channel|>final<|message|>",
      "benchmark_report.md hello.c hello.exe",
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "Use search to list files here, then answer with the file names.",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("tool-call");
    await expect.poll(() => events.some((event) => event.type === "timeline" && event.eventType === "item.started" && event.block.kind === "tool")).toBe(true);
    expect(events.findIndex((event) => event.type === "reasoning.delta")).toBeLessThan(events.findIndex((event) => event.type === "timeline" && event.eventType === "item.started"));
    expect(events.some((event) => event.type === "assistant.delta")).toBe(false);
    expect(fakeLlama.requests).toHaveLength(1);
    fakeLlama.release("tool-call");
    await run;

    const assistantText = events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("");
    expect(assistantText).toContain("benchmark_report.md");
    expect(assistantText).toContain("hello.c");
    expect(assistantText).toContain("hello.exe");
    expect(assistantText).not.toContain("[[UNIT0_");
    expect(assistantText).not.toContain("<|");
    const toolEvents = events.filter((event) => event.type === "timeline" && event.block.kind === "tool");
    const started = toolEvents.filter((event) => event.eventType === "item.started");
    const completed = toolEvents.filter((event) => event.eventType === "item.completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]?.block.id).toBe(completed[0]?.block.id);
    expect(started[0]?.block.toolName).toBe("glob");
    expect(started[0]?.block.command).toBe("{\"pattern\":\"*\"}");
    expect(started[0]?.block.directory).toBe(projectDir);
    expect(started[0]?.block.status).toBe("started");
    expect(completed[0]?.block.status).toBe("completed");
    expect(completed[0]?.block.output).toContain("benchmark_report.md");
    const firstReasoningIndex = events.findIndex((event) => event.type === "reasoning.delta");
    const toolStartedIndex = events.findIndex((event) => event.type === "timeline" && event.eventType === "item.started");
    const toolCompletedIndex = events.findIndex((event) => event.type === "timeline" && event.eventType === "item.completed");
    const firstFinalIndex = events.findIndex((event) => event.type === "assistant.delta");
    expect(firstReasoningIndex).toBeGreaterThanOrEqual(0);
    expect(toolStartedIndex).toBeGreaterThan(firstReasoningIndex);
    expect(toolCompletedIndex).toBeGreaterThan(toolStartedIndex);
    expect(firstFinalIndex).toBeGreaterThan(toolCompletedIndex);
    expect(fakeLlama.requests).toHaveLength(2);
    expect(fakeLlama.requests[1]?.prompt).toContain("# OpenCode Tool Result");
    expect(fakeLlama.requests[1]?.prompt).toContain("benchmark_report.md");
    expect(fakeLlama.requests[1]?.prompt).not.toContain("[[UNIT0_");
    const snapshot = events.find((event) => event.type === "final.snapshot");
    expect(snapshot).toMatchObject({ type: "final.snapshot", malformed: undefined });
    expect(snapshot && "content" in snapshot ? snapshot.content : "").toContain("benchmark_report.md");
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy budgets large webfetch output before post-tool final streaming", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-tool-budget-"));
  const contentServer = await startTextServer(Array.from({ length: 2200 }, (_, index) => `Peanut butter source line ${index.toString().padStart(4, "0")} ${"x".repeat(80)}`).join("\n"));
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need web source.",
      "<|end|><|start|>assistant<|channel|>commentary to=webfetch code<|message|>",
      JSON.stringify({ url: contentServer.url, format: "markdown" }),
      { content: "<|call|>", pauseAfter: "large-webfetch-call" }
    ],
    [
      "<|channel|>analysis<|message|>Tool output enough.",
      "<|end|><|start|>assistant<|channel|>final<|message|>",
      { content: "George Washington Carver is often associated with peanut products, but peanut butter predates him.", pauseAfter: "large-webfetch-final" },
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "Search the web to see who invented peanut butter, then answer briefly.",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: { ...baseSettings, nCtx: 4096, maxTokens: 256 },
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await fakeLlama.waitForPause("large-webfetch-call");
    await expect.poll(() => events.some((event) => event.type === "timeline" && event.eventType === "item.started" && event.block.kind === "tool" && event.block.toolName === "webfetch")).toBe(true);
    fakeLlama.release("large-webfetch-call");
    await fakeLlama.waitForPause("large-webfetch-final");
    await expect.poll(() => fakeLlama.requests.length).toBe(2);
    expect(fakeLlama.requests[1]?.prompt).toContain("# OpenCode Tool Result");
    expect(fakeLlama.requests[1]?.prompt).toContain("OpenCode tool result truncated to fit the local model context window");
    expect(fakeLlama.requests[1]?.nPredict).toBeGreaterThan(0);
    await expect.poll(() => events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toContain("peanut butter predates him");
    fakeLlama.release("large-webfetch-final");
    await run;

    const toolEvents = events.filter((event) => event.type === "timeline" && event.block.kind === "tool");
    expect(toolEvents.filter((event) => event.eventType === "item.started")).toHaveLength(1);
    expect(toolEvents.filter((event) => event.eventType === "item.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toContain("peanut butter predates him");
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({ type: "final.snapshot", malformed: undefined });
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    runtime.close();
    await fakeLlama.close();
    await contentServer.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode GPT-OSS proxy prompt keeps completion budget when tool results are huge", () => {
  const prompt = renderGptOssOpenCodeProxyPrompt({
    messages: [
      { role: "user", content: "search the web to see who invented peanut butter" },
      {
        role: "assistant",
        content: "[[UNIT0_ANALYSIS]]Need web info.[[UNIT0_FINAL]]",
        tool_calls: [{
          id: "call_large",
          type: "function",
          function: { name: "webfetch", arguments: "{\"url\":\"https://example.com\",\"format\":\"markdown\"}" }
        }]
      },
      { role: "tool", tool_call_id: "call_large", content: "A".repeat(80_000) }
    ],
    tools: [{ type: "function", function: { name: "webfetch", parameters: { type: "object" } } }]
  }, {
    cwd: "C:\\Project",
    prompt: "search the web to see who invented peanut butter",
    modelLabel: "fake-gpt-oss",
    nativeGptOss: true,
    endpoint: { baseUrl: "http://127.0.0.1:1234", modelId: "fake-gpt-oss" },
    settings: { ...baseSettings, nCtx: 4096, maxTokens: 256 },
    permissionMode: "full_access"
  });

  expect(prompt).toContain("# OpenCode Tool Result");
  expect(prompt).toContain("OpenCode tool result truncated to fit the local model context window");
  expect(gptOssOpenCodeRequestMaxTokens(prompt, { ...baseSettings, nCtx: 4096, maxTokens: 256 })).toBeGreaterThan(0);
});

test("real OpenCode GPT-OSS proxy does not force final continuation after terminal-suppressed tool calls", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-tool-no-call-"));
  fs.writeFileSync(path.join(projectDir, "alpha.txt"), "alpha\n");
  fs.writeFileSync(path.join(projectDir, "beta.txt"), "beta\n");
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need files.",
      "<|end|><|start|>assistant<|channel|>commentary to=glob code<|message|>",
      "{\"pattern\":\"*\"}"
    ],
    [
      "<|channel|>analysis<|message|>Got files.",
      "<|end|><|start|>assistant<|channel|>final<|message|>",
      "alpha.txt beta.txt",
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    await collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "Use search to list files here, then answer with the file names.",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    const assistantText = events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("");
    expect(assistantText).toContain("alpha.txt");
    expect(assistantText).toContain("beta.txt");
    const toolEvents = events.filter((event) => event.type === "timeline" && event.block.kind === "tool");
    expect(toolEvents.filter((event) => event.eventType === "item.started")).toHaveLength(1);
    expect(toolEvents.filter((event) => event.eventType === "item.completed")).toHaveLength(1);
    expect(fakeLlama.requests).toHaveLength(2);
    expect(fakeLlama.requests[1]?.prompt).toContain("# OpenCode Tool Result");
    expect(fakeLlama.requests[1]?.prompt).toContain("alpha.txt");
    expect(fakeLlama.requests[1]?.prompt).not.toContain("<|channel|>final<|message|>");
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy streams commentary preambles before tool calls", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-tool-preamble-"));
  fs.writeFileSync(path.join(projectDir, "alpha.txt"), "alpha\n");
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need files.",
      "<|end|><|start|>assistant<|channel|>commentary<|message|>",
      "I will list files.",
      "<|end|><|start|>assistant<|channel|>commentary to=glob code<|message|>",
      "{\"pattern\":\"*\"}<|call|>"
    ],
    [
      "<|channel|>analysis<|message|>Got files.",
      "<|end|><|start|>assistant<|channel|>final<|message|>",
      "alpha.txt",
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    await collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "List files here.",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    const assistantText = events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("");
    expect(assistantText).toContain("I will list files.");
    expect(assistantText).toContain("alpha.txt");
    const preambleIndex = events.findIndex((event) => event.type === "assistant.delta" && event.text.includes("I will list files."));
    const toolStartedIndex = events.findIndex((event) => event.type === "timeline" && event.eventType === "item.started" && event.block.kind === "tool");
    const postToolReasoningIndex = events.findIndex((event) => event.type === "reasoning.delta" && event.text.includes("Got files."));
    const finalIndex = events.findIndex((event) => event.type === "assistant.delta" && event.text.includes("alpha.txt"));
    expect(preambleIndex).toBeGreaterThan(-1);
    expect(toolStartedIndex).toBeGreaterThan(preambleIndex);
    expect(postToolReasoningIndex).toBeGreaterThan(toolStartedIndex);
    expect(finalIndex).toBeGreaterThan(postToolReasoningIndex);
    expect(fakeLlama.requests).toHaveLength(2);
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("real OpenCode GPT-OSS proxy renders question tool calls as questions", async () => {
  test.setTimeout(120_000);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-opencode-runtime-question-"));
  const fakeLlama = await startFakeRawCompletionServer([
    [
      "<|channel|>analysis<|message|>Need a grep pattern.",
      "<|end|><|start|>assistant<|channel|>commentary to=question code<|message|>",
      "{\"questions\":[{\"question\":\"What pattern should I grep for?\",\"header\":\"Pattern\",\"options\":[{\"label\":\"TODO\",\"description\":\"Search for TODO markers\"}],\"custom\":true}]}",
      "<|call|>"
    ],
    [
      "<|channel|>analysis<|message|>User picked TODO.",
      "<|end|><|start|>assistant<|channel|>final<|message|>",
      "I will grep for TODO.",
      "<|return|>"
    ]
  ]);
  const runtime = new RealOpenCodeRuntime();
  try {
    const events: OpenCodeRuntimeEvent[] = [];
    const run = collectOpenCodeEvents(runtime, {
      cwd: projectDir,
      prompt: "can you use gep once?",
      modelLabel: "fake-gpt-oss",
      nativeGptOss: true,
      endpoint: {
        baseUrl: fakeLlama.url,
        modelId: "fake-gpt-oss",
        rawCompletionUrl: `${fakeLlama.url}/completion`
      },
      settings: baseSettings,
      permissionMode: "full_access"
    }, (event) => events.push(event));

    await expect.poll(() => events.find((event) => event.type === "timeline" && event.block.kind === "question")).toBeTruthy();
    const questionEvent = events.find((event) => event.type === "timeline" && event.block.kind === "question");
    expect(questionEvent).toMatchObject({
      type: "timeline",
      eventType: "item.started",
      block: {
        kind: "question",
        title: "Pattern",
        question: "What pattern should I grep for?",
        requestMethod: "opencode"
      }
    });
    expect(events.some((event) => event.type === "timeline" && event.block.kind === "tool")).toBe(false);
    const requestId = questionEvent && questionEvent.type === "timeline" ? questionEvent.block.id : "";
    const firstQuestionId = questionEvent && questionEvent.type === "timeline" && questionEvent.block.kind === "question"
      ? questionEvent.block.questions?.[0]?.id ?? ""
      : "";
    await runtime.answerUserInput(requestId, { [firstQuestionId]: "TODO" });
    await run;

    expect(events.some((event) => event.type === "timeline" && event.block.kind === "tool")).toBe(false);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.text).join("")).toBe("I will grep for TODO.");
    expect(events.find((event) => event.type === "final.snapshot")).toMatchObject({ type: "final.snapshot", content: "I will grep for TODO.", malformed: undefined });
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    runtime.close();
    await fakeLlama.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

async function collectOpenCodeEvents(runtime: RealOpenCodeRuntime, options: OpenCodeRunOptions, onEvent?: (event: OpenCodeRuntimeEvent) => void): Promise<OpenCodeRuntimeEvent[]> {
  const events: OpenCodeRuntimeEvent[] = [];
  for await (const event of runtime.runTurn(options)) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

async function startFakeRawCompletionServer(responses: FakeChunk[][]): Promise<{
  url: string;
  requests: Array<{ prompt: string; nPredict: number }>;
  waitForPause: (label: string) => Promise<void>;
  release: (label: string) => void;
  close: () => Promise<void>;
}> {
  const requests: Array<{ prompt: string; nPredict: number }> = [];
  const pauses = new Map<string, { paused: Promise<void>; released: Promise<void>; release: () => void; resolvePaused: () => void }>();
  let requestIndex = 0;
  const pauseState = (label: string) => {
    let state = pauses.get(label);
    if (!state) {
      let release!: () => void;
      let resolvePaused!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        resolvePaused = resolve;
      });
      state = { paused, released, release, resolvePaused };
      pauses.set(label, state);
    }
    return state;
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/completion") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const body = await readRequestJson(request);
      requests.push({ prompt: typeof body.prompt === "string" ? body.prompt : "", nPredict: typeof body.n_predict === "number" ? body.n_predict : 0 });
      const chunks = responses[Math.min(requestIndex, responses.length - 1)] ?? [];
      requestIndex += 1;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      for (const chunk of chunks) {
        const content = typeof chunk === "string" ? chunk : chunk.content;
        response.write(`data: ${JSON.stringify({ content })}\n\n`);
        if (typeof chunk !== "string") {
          const state = pauseState(chunk.pauseAfter);
          state.resolvePaused();
          await state.released;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      response.write("data: [DONE]\n\n");
      response.end();
    })().catch((error) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake llama server did not bind a TCP port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    waitForPause: (label: string) => pauseState(label).paused,
    release: (label: string) => pauseState(label).release(),
    close: () => closeServer(server)
  };
}

async function startTextServer(content: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    response.end(content);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Text server did not bind a TCP port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/large.md`,
    close: () => closeServer(server)
  };
}

async function readRequestJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
