import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore } from "../src/main/chatStore";

function makeStore(): { store: ChatStore; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-chat-store-"));
  const dbPath = path.join(dir, "unit0.sqlite");
  return { store: new ChatStore(dbPath), dir, dbPath };
}

test("seeds a default global chat project and thread", () => {
  const { store } = makeStore();
  const state = store.loadState();

  expect(state.projects).toHaveLength(1);
  expect(state.threads).toHaveLength(1);
  expect(state.selectedProjectId).toBe(state.projects[0].id);
  expect(state.selectedThreadId).toBe(state.threads[0].id);
  expect(state.messages).toEqual([]);
  expect(state.models).toEqual([]);
  store.close();
});

test("creates and selects threads with persisted messages", () => {
  const { store, dbPath } = makeStore();
  const thread = store.createThread();
  store.createMessage(thread.id, "user", "hello", "complete");
  const assistant = store.createMessage(thread.id, "assistant", "", "streaming");
  store.appendToMessage(assistant.id, "world");
  store.updateMessageStatus(assistant.id, "complete");
  store.close();

  const restarted = new ChatStore(dbPath);
  const state = restarted.loadState();
  expect(state.selectedThreadId).toBe(thread.id);
  expect(state.messages.map((message) => [message.role, message.content, message.status])).toEqual([
    ["user", "hello", "complete"],
    ["assistant", "world", "complete"]
  ]);
  restarted.close();
});

test("adds only GGUF local models and selects duplicate paths", () => {
  const { store, dir } = makeStore();
  const modelPath = path.join(dir, "test-model.gguf");
  fs.writeFileSync(modelPath, "not a real model");
  const model = store.addLocalModel(modelPath);
  const duplicate = store.addLocalModel(modelPath);

  expect(duplicate.id).toBe(model.id);
  expect(store.loadState().selectedModelId).toBe(model.id);
  expect(() => store.addLocalModel(path.join(dir, "missing.gguf"))).toThrow(/Model file not found/);
  const textPath = path.join(dir, "model.txt");
  fs.writeFileSync(textPath, "not a gguf");
  expect(() => store.addLocalModel(textPath)).toThrow(/GGUF/);
  store.close();
});
