import type { ChatGenerationState, ChatModel, ChatState, ChatSubmitPayload } from "../shared/types.js";
import { ChatStore } from "./chatStore.js";
import { LocalLlamaRuntime } from "./localLlamaRuntime.js";

export class ChatService {
  private generation: ChatGenerationState = { status: "idle" };
  private cancelRequested = false;
  private closed = false;

  constructor(
    private readonly store: ChatStore,
    private readonly runtime: LocalLlamaRuntime,
    private readonly broadcast: () => void
  ) {}

  state(): ChatState {
    return {
      ...this.store.loadState(),
      generation: this.generation
    };
  }

  createThread(): ChatState {
    this.store.createThread();
    this.clearError();
    this.broadcast();
    return this.state();
  }

  selectThread(threadId: string): ChatState {
    this.store.selectThread(threadId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  addLocalModel(modelPath: string): ChatState {
    this.store.addLocalModel(modelPath);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  selectModel(modelId: string): ChatState {
    this.store.selectModel(modelId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  submit(payload: ChatSubmitPayload): ChatState {
    const text = payload.text.trim();
    if (!text) {
      this.setError("Cannot submit an empty chat message.");
      return this.state();
    }
    if (this.generation.status === "running") {
      this.setError("A chat response is already running.");
      return this.state();
    }
    const state = this.store.loadState();
    const threadId = state.selectedThreadId;
    const selectedModel = state.models.find((model) => model.id === state.selectedModelId);
    if (!threadId) {
      this.setError("No chat thread is selected.");
      return this.state();
    }
    if (!selectedModel) {
      this.setError("Add and select a local GGUF model before sending.");
      return this.state();
    }
    if (this.store.messageCount(threadId) === 0) {
      this.store.renameThread(threadId, text);
    }
    this.store.createMessage(threadId, "user", text, "complete");
    const assistantMessage = this.store.createMessage(threadId, "assistant", "", "streaming");
    this.cancelRequested = false;
    this.generation = { status: "running", threadId, assistantMessageId: assistantMessage.id };
    this.broadcast();
    void this.runGeneration({ threadId, assistantMessageId: assistantMessage.id, model: selectedModel });
    return this.state();
  }

  cancel(): ChatState {
    if (this.generation.status !== "running") {
      return this.state();
    }
    this.cancelRequested = true;
    this.runtime.cancelActiveRequest();
    this.store.updateMessageStatus(this.generation.assistantMessageId, "interrupted");
    this.generation = { status: "idle" };
    this.broadcast();
    return this.state();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.runtime.close();
    this.store.close();
  }

  private async runGeneration(options: { threadId: string; assistantMessageId: string; model: ChatModel }): Promise<void> {
    const state = this.store.loadState();
    const messages = state.messages.filter((message) => message.threadId === options.threadId && message.id !== options.assistantMessageId);
    try {
      await this.runtime.streamChat({
        model: options.model,
        settings: state.runtimeSettings,
        messages,
        onToken: (token) => {
          this.store.appendToMessage(options.assistantMessageId, token);
          this.broadcast();
        }
      });
      if (this.cancelRequested) {
        this.store.updateMessageStatus(options.assistantMessageId, "interrupted");
      } else {
        this.store.updateMessageStatus(options.assistantMessageId, "complete");
      }
      this.generation = { status: "idle" };
    } catch (error) {
      const message = errorMessage(error);
      this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "error");
      this.generation = this.cancelRequested ? { status: "idle" } : { status: "error", error: message };
    } finally {
      this.cancelRequested = false;
      this.broadcast();
    }
  }

  private setError(error: string): void {
    this.generation = { status: "error", error };
    this.broadcast();
  }

  private clearError(): void {
    if (this.generation.status === "error") {
      this.generation = { status: "idle" };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
