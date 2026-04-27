import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatService } from "../src/main/chatService";
import { ChatStore } from "../src/main/chatStore";
import { MockCodexRuntime } from "../src/main/codexRuntime";
import { LocalLlamaRuntime } from "../src/main/localLlamaRuntime";
import { RemoteHostRuntime } from "../src/main/remoteHostRuntime";

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit0-chat-service-test-"));
  const store = new ChatStore(path.join(dir, "chat.sqlite"));
  const service = new ChatService(store, new LocalLlamaRuntime(), new RemoteHostRuntime(), new MockCodexRuntime(), () => undefined);
  return { service, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("blocks switching a local-history thread to Codex", () => {
  const { service, store, cleanup } = makeService();
  try {
    const state = store.loadState();
    store.createMessage(state.selectedThreadId, "assistant", "local answer", "complete", {
      sourceLabel: "Built-in"
    });

    const blocked = service.updateThreadSettings({
      threadId: state.selectedThreadId,
      providerMode: "codex"
    });

    expect(blocked.generation).toMatchObject({
      status: "error",
      error: expect.stringContaining("Local to Codex is not yet supported")
    });
    expect(blocked.threads.find((thread) => thread.id === state.selectedThreadId)?.providerMode).toBe("builtin");
  } finally {
    store.close();
    cleanup();
  }
});

test("handles local /reset without starting generation", async () => {
  const { service, store, cleanup } = makeService();
  try {
    const state = store.loadState();
    store.createMessage(state.selectedThreadId, "user", "hello", "complete");
    store.createMessage(state.selectedThreadId, "assistant", "answer", "complete");

    const next = await service.submit({ text: "/reset", attachments: [] });
    const thread = next.threads.find((item) => item.id === state.selectedThreadId);

    expect(next.generation.status).toBe("idle");
    expect(thread?.activeContextStartMessageIndex).toBe(2);
    expect(thread?.contextMarkers[0]).toMatchObject({ kind: "reset", boundaryMessageCount: 2 });
    expect(next.messages.at(-1)?.content).toContain("Local context reset");
  } finally {
    store.close();
    cleanup();
  }
});
