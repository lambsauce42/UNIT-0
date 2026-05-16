import { expect, test } from "@playwright/test";
import {
  buildCodexExecCommand,
  collaborationModePayload,
  codexAppServerItemEvents,
  codexItemToTimelineBlock,
  codexRateLimitsFromResponse,
  codexTurnStartPayload,
  effectiveCodexApprovalPolicy,
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

test("maps app-server reasoning summaries into one sectioned reasoning item", () => {
  expect(codexAppServerItemEvents("item.completed", {
    type: "reasoning",
    id: "reason-1",
    summary: ["**Crafting**", "**Finalizing**"],
    extra_payload: { codex_initially_expanded: false }
  })).toEqual([{
    type: "item.completed",
    item: {
      id: "reason-1",
      type: "reasoning",
      text: "**Crafting**\n\n**Finalizing**",
      sections: [
        { key: "reason-1:summary:0", text: "**Crafting**" },
        { key: "reason-1:summary:1", text: "**Finalizing**" }
      ],
      initiallyExpanded: false
    }
  }]);
  expect(codexAppServerItemEvents("item.completed", {
    type: "reasoning",
    id: "reason-content",
    content: ["Inspecting repository"]
  })).toEqual([{
    type: "item.completed",
    item: {
      id: "reason-content",
      type: "reasoning",
      text: "Inspecting repository",
      sections: [{ key: "reason-content", text: "Inspecting repository" }],
      initiallyExpanded: undefined
    }
  }]);
});

test("maps app-server command and file-change completion details", () => {
  expect(codexAppServerItemEvents("item.completed", {
    type: "commandExecution",
    id: "cmd-1",
    command: "npm test",
    cwd: "C:\\Workspace",
    aggregatedOutput: "ok\n",
    exitCode: 0
  })[0]).toMatchObject({
    type: "item.completed",
    item: {
      id: "cmd-1",
      type: "command_execution",
      command: "npm test",
      directory: "C:\\Workspace",
      aggregated_output: "ok\n",
      exit_code: 0,
      status: "completed"
    }
  });
  expect(codexAppServerItemEvents("item.completed", {
    type: "commandExecution",
    id: "cmd-failed",
    command: "npm test",
    status: "failed",
    exitCode: 1
  })[0]).toMatchObject({
    item: {
      type: "command_execution",
      status: "failed",
      exit_code: 1
    }
  });
  expect(codexAppServerItemEvents("item.completed", {
    type: "fileChange",
    id: "diff-1",
    path: "src/app.ts",
    diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new"
  })[0]).toMatchObject({
    type: "item.completed",
    item: {
      id: "diff-1",
      type: "file_change",
      summary: "src/app.ts",
      diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new",
      added_lines: 1,
      deleted_lines: 1,
      status: "completed"
    }
  });
  expect(codexAppServerItemEvents("item.completed", {
    type: "fileChange",
    id: "diff-structured",
    status: "failed",
    changes: [
      { type: "modified", path: "src/app.ts", addedLines: 3, deletedLines: 1 },
      { type: "created", path: "src/new.ts", additions: 5, deletions: 0 }
    ]
  })[0]).toMatchObject({
    item: {
      id: "diff-structured",
      type: "file_change",
      diff: "modified: src/app.ts (+3 -1)\ncreated: src/new.ts (+5 -0)",
      added_lines: 8,
      deleted_lines: 1,
      files_changed: 2,
      status: "failed",
      changes: [
        { path: "src/app.ts", kind: "modified", addedLines: 3, deletedLines: 1 },
        { path: "src/new.ts", kind: "created", addedLines: 5, deletedLines: 0 }
      ]
    }
  });
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
    id: "failed-cmd",
    type: "command_execution",
    command: "npm test",
    status: "failed",
    exit_code: 1
  })).toMatchObject({
    kind: "tool",
    status: "failed"
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
    expect(snapshot.account.rateLimits?.primary?.usedPercent).toBe(34);
    expect(snapshot.account.rateLimits?.primary?.windowDurationMins).toBe(299);
    expect(snapshot.account.rateLimits?.secondary?.usedPercent).toBe(12);
    expect(snapshot.account.rateLimits?.secondary?.windowDurationMins).toBe(10079);
  }
  expect(snapshot.models.some((model) => model.isDefault)).toBe(true);
});

test("parses the Codex CLI rate-limit bucket from app-server responses", () => {
  const rateLimits = codexRateLimitsFromResponse({
    rateLimits: {
      limitId: "other",
      primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: 1778424330 },
      secondary: { usedPercent: 77, windowDurationMins: 10080, resetsAt: 1779011130 },
      rateLimitReachedType: null
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 9, windowDurationMins: 299, resetsAt: 1778424330 },
        secondary: { usedPercent: 1, windowDurationMins: 10079, resetsAt: 1779011130 },
        rateLimitReachedType: null
      }
    }
  });

  expect(rateLimits?.primary?.usedPercent).toBe(9);
  expect(rateLimits?.primary?.windowDurationMins).toBe(299);
  expect(rateLimits?.secondary?.usedPercent).toBe(1);
  expect(rateLimits?.secondary?.windowDurationMins).toBe(10079);
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
      "--dangerously-bypass-approvals-and-sandbox",
      "hello"
    ]
  });
  expect(buildCodexExecCommand({
    cwd: process.cwd(),
    prompt: "hello",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    permissionMode: "default_permissions",
    approvalMode: "on-request",
    planModeEnabled: false
  }).args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
});

test("normalizes full access approval policy for app-server payloads", () => {
  expect(effectiveCodexApprovalPolicy({
    permissionMode: "full_access",
    approvalMode: "on-failure"
  })).toBe("never");
  expect(effectiveCodexApprovalPolicy({
    permissionMode: "default_permissions",
    approvalMode: "on-request"
  })).toBe("on-request");
  expect(effectiveCodexApprovalPolicy({
    permissionMode: "default_permissions",
    approvalMode: "default"
  })).toBeUndefined();
  expect(codexTurnStartPayload("thread-1", {
    cwd: process.cwd(),
    prompt: "hello",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    permissionMode: "full_access",
    approvalMode: "on-request",
    planModeEnabled: false
  })).toMatchObject({
    threadId: "thread-1",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" }
  });
  expect(codexTurnStartPayload("thread-1", {
    cwd: process.cwd(),
    prompt: "hello",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    permissionMode: "default_permissions",
    approvalMode: "on-request",
    planModeEnabled: false
  })).toMatchObject({
    threadId: "thread-1",
    approvalPolicy: "on-request",
    sandboxPolicy: undefined
  });
});
