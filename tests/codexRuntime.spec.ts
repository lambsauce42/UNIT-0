import { expect, test } from "@playwright/test";
import {
  buildCodexExecCommand,
  collaborationModePayload,
  codexItemToTimelineBlock,
  MockCodexRuntime,
  parseCodexJsonLine
} from "../src/main/codexRuntime";

test("parses official Codex JSONL-style thread events", () => {
  expect(parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-test-1"}')).toEqual({
    type: "thread.started",
    thread_id: "thread-test-1"
  });
  expect(parseCodexJsonLine('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done."}}')).toEqual({
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: "Done." }
  });
  expect(() => parseCodexJsonLine('{"event":"missing-type"}')).toThrow(/missing a type/);
});

test("maps Codex command and todo items into chat timeline blocks", () => {
  expect(codexItemToTimelineBlock("item.completed", {
    id: "cmd",
    type: "command_execution",
    command: "npm test",
    aggregated_output: "ok\n",
    exit_code: 0,
    status: "completed"
  })).toMatchObject({
    kind: "tool",
    id: "cmd",
    toolName: "command",
    status: "completed",
    command: "npm test",
    output: "ok\n"
  });
  expect(codexItemToTimelineBlock("item.completed", {
    id: "plan",
    type: "todo_list",
    items: [{ text: "Check UX", status: "complete" }]
  })).toMatchObject({
    kind: "plan",
    id: "plan",
    steps: [{ text: "Check UX", status: "complete" }]
  });
});

test("mock Codex runtime emits deterministic events without shelling out", async () => {
  const runtime = new MockCodexRuntime();
  const events = [];
  for await (const event of runtime.runTurn({
    cwd: process.cwd(),
    prompt: "hello",
    imagePaths: ["C:\\screens\\mock.png"],
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    permissionMode: "default_permissions",
    approvalMode: "on-request",
    planModeEnabled: true
  })) {
    events.push(event);
  }
  expect(events.map((event) => event.type)).toContain("thread.started");
  expect(events.some((event) => event.type === "item.completed" && event.item.type === "agent_message")).toBe(true);
});

test("mock Codex runtime accepts active-turn steering without shelling out", async () => {
  const runtime = new MockCodexRuntime();
  const iterator = runtime.runTurn({
    cwd: process.cwd(),
    prompt: "initial",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    permissionMode: "default_permissions",
    approvalMode: "default",
    planModeEnabled: false
  })[Symbol.asyncIterator]();

  expect((await iterator.next()).value).toMatchObject({ type: "thread.started" });
  expect((await iterator.next()).value).toMatchObject({ type: "turn.started" });
  await runtime.steerCurrentTurn({ text: "focus on failing tests" });

  const remaining = [];
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    remaining.push(event);
  }
  expect(remaining.some((event) => (
    event.type === "item.completed"
    && event.item.type === "agent_message"
    && event.item.text?.includes("focus on failing tests")
  ))).toBe(true);
});

test("mock Codex runtime exposes account, rate limits, and models without shelling out", async () => {
  const runtime = new MockCodexRuntime();
  const snapshot = await runtime.readAccount(true);
  expect(snapshot.account.status).toBe("ready");
  if (snapshot.account.status === "ready") {
    expect(snapshot.account.rateLimits?.primary?.usedPercent).toBe(12);
  }
  expect(snapshot.models.some((model) => model.isDefault)).toBe(true);
});

test("builds legacy Codex collaboration mode payload without shelling out", () => {
  expect(collaborationModePayload({
    cwd: process.cwd(),
    prompt: "inspect",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    permissionMode: "default_permissions",
    approvalMode: "default",
    planModeEnabled: true
  })).toMatchObject({
    mode: "plan",
    settings: {
      model: "gpt-5.5",
      reasoning_effort: "medium"
    }
  });
  const payload = collaborationModePayload({
    cwd: process.cwd(),
    prompt: "inspect",
    model: "gpt-5.5",
    reasoningEffort: "low",
    permissionMode: "full_access",
    approvalMode: "never",
    planModeEnabled: false
  });
  expect(payload).toMatchObject({ mode: "default", settings: { reasoning_effort: "low" } });
  expect((payload.settings as Record<string, unknown>).developer_instructions).toContain("Default mode");
});

test("builds codex exec command without executing Codex in unit tests", () => {
  expect(buildCodexExecCommand({
    cwd: process.cwd(),
    prompt: "hello",
    imagePaths: ["C:\\screens\\mock.png"],
    model: "gpt-5.3-codex",
    reasoningEffort: "high",
    permissionMode: "full_access",
    approvalMode: "on-failure",
    planModeEnabled: false
  })).toEqual({
    command: "codex",
    args: [
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "-c",
      "model_reasoning_effort=high",
      "--image",
      "C:\\screens\\mock.png",
      "-c",
      "approval_policy=on-failure",
      "--dangerously-bypass-approvals-and-sandbox",
      "hello"
    ]
  });
});
