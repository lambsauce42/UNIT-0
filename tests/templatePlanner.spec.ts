import { expect, test } from "@playwright/test";
import { planWorkspaceTemplate } from "../src/shared/templatePlanner";
import type { AppletSession, Workspace } from "../src/shared/types";
import { workspaceTemplateById } from "../src/shared/workspaceTemplates";

const sessions: Record<string, AppletSession> = {
  "session-terminal-a": { id: "session-terminal-a", kind: "terminal", title: "Terminal A" },
  "session-terminal-b": { id: "session-terminal-b", kind: "terminal", title: "Terminal B" },
  "session-browser": { id: "session-browser", kind: "browser", title: "Browser" },
  "session-chat": { id: "session-chat", kind: "chat", title: "Chat" },
  "session-files": { id: "session-files", kind: "fileViewer", title: "Files" },
  "session-sandbox": { id: "session-sandbox", kind: "sandbox", title: "Sandbox" },
  "session-wsl": { id: "session-wsl", kind: "wslTerminal", title: "WSL" }
};

function workspace(apps: Array<{ id: string; sessionId: string }>, layoutIds: string[] = apps.map((app) => app.id)): Workspace {
  return {
    id: "workspace-test",
    title: "Test",
    applets: apps,
    shelfAppletIds: [],
    layout: layoutIds.length === 0 ? null : layoutFromIds(layoutIds)
  };
}

function layoutFromIds([first, ...rest]: string[]) {
  if (!first) {
    return null;
  }
  if (rest.length === 0) {
    return { id: `leaf-${first}`, type: "leaf" as const, appletInstanceId: first };
  }
  return {
    id: `split-${first}-${rest.length}`,
    type: "split" as const,
    direction: "row" as const,
    ratio: 0.5,
    first: { id: `leaf-${first}`, type: "leaf" as const, appletInstanceId: first },
    second: layoutFromIds(rest)!
  };
}

test("blank workspace creates every template cell", () => {
  const plan = planWorkspaceTemplate(workspace([], []), sessions, workspaceTemplateById("grid-2x2"));

  expect(Object.values(plan.assignments).every((assignment) => assignment.mode === "create")).toBe(true);
  expect(plan.createdCellIds).toEqual(["grid-2x2-1", "grid-2x2-2", "grid-2x2-3", "grid-2x2-4"]);
  expect(plan.shelfAppletIds).toEqual([]);
});

test("existing matching applets are reused and extras are shelved", () => {
  const plan = planWorkspaceTemplate(
    workspace([
      { id: "files", sessionId: "session-files" },
      { id: "browser", sessionId: "session-browser" },
      { id: "terminal", sessionId: "session-terminal-a" },
      { id: "chat", sessionId: "session-chat" },
      { id: "sandbox", sessionId: "session-sandbox" }
    ]),
    sessions,
    workspaceTemplateById("grid-2x2")
  );

  expect(plan.assignments["grid-2x2-1"]).toEqual({ mode: "reuse", appletInstanceId: "files" });
  expect(plan.assignments["grid-2x2-2"]).toEqual({ mode: "reuse", appletInstanceId: "browser" });
  expect(plan.assignments["grid-2x2-3"]).toEqual({ mode: "reuse", appletInstanceId: "terminal" });
  expect(plan.assignments["grid-2x2-4"]).toEqual({ mode: "reuse", appletInstanceId: "chat" });
  expect(plan.shelfAppletIds).toEqual(["sandbox"]);
});

test("duplicate compatible applet kinds map in visual order", () => {
  const plan = planWorkspaceTemplate(
    workspace(
      [
        { id: "term-a", sessionId: "session-terminal-a" },
        { id: "term-b", sessionId: "session-terminal-b" },
        { id: "browser", sessionId: "session-browser" },
        { id: "chat", sessionId: "session-chat" }
      ],
      ["term-b", "term-a", "browser", "chat"]
    ),
    sessions,
    workspaceTemplateById("grid-2x2")
  );

  expect(plan.assignments["grid-2x2-1"]).toEqual({ mode: "reuse", appletInstanceId: "term-b" });
  expect(plan.assignments["grid-2x2-2"]).toEqual({ mode: "reuse", appletInstanceId: "term-a" });
  expect(plan.shelfAppletIds).toEqual([]);
});

test("compatible non-preferred kind can fill a template cell", () => {
  const plan = planWorkspaceTemplate(
    workspace([{ id: "wsl", sessionId: "session-wsl" }]),
    sessions,
    workspaceTemplateById("grid-2x2")
  );

  expect(plan.assignments["grid-2x2-1"]).toEqual({ mode: "reuse", appletInstanceId: "wsl" });
});
