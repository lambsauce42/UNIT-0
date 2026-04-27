import type {
  ChatActionButton,
  ChatAttachment,
  ChatCodexAccountState,
  ChatCodexModel,
  ChatGenerationState,
  ChatGitState,
  ChatModel,
  ChatQueuedSubmission,
  ChatState,
  ChatSubmitPayload,
  ChatTimelineActionPayload,
  ChatTimelineBlock,
  ChatCreateDocumentIndexPayload,
  ChatSelectDocumentIndexPayload,
  ChatApplySettingsPresetPayload,
  ChatSaveSettingsPresetPayload,
  ChatDeleteSettingsPresetPayload,
  ChatRefreshCodexAccountPayload,
  ChatUpdateThreadSettingsPayload
} from "../shared/types.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFParse } from "pdf-parse";
import { codexItemToTimelineBlock, type CodexRuntime } from "./codexRuntime.js";
import { ChatStore, DEFAULT_CODEX_MODELS, type ChatDocumentSearchEntry } from "./chatStore.js";
import { LocalLlamaRuntime } from "./localLlamaRuntime.js";
import { RemoteHostRuntime, type RemoteStreamMetrics } from "./remoteHostRuntime.js";

const execFileAsync = promisify(execFile);
const CODEX_ATTACHMENT_TEMP_PREFIX = "unit0-codex-attachments-";
type RemoteDocumentSearchResult = { document_id?: string; entries?: unknown[] };

export class ChatService {
  private generation: ChatGenerationState = { status: "idle" };
  private cancelRequested = false;
  private closed = false;
  private codexModels: ChatCodexModel[] = DEFAULT_CODEX_MODELS;
  private codexAccount: ChatCodexAccountState = { status: "unknown" };
  private queuedSubmissions: ChatQueuedSubmission[] = [];
  private queuedSubmissionPayloads = new Map<string, { text: string; attachments: ChatAttachment[] }>();

  constructor(
    private readonly store: ChatStore,
    private readonly runtime: LocalLlamaRuntime,
    private readonly remoteRuntime: RemoteHostRuntime,
    private readonly codexRuntime: CodexRuntime,
    private readonly broadcast: () => void
  ) {}

  state(): ChatState {
    return {
      ...this.store.loadState(),
      codexModels: this.codexModels,
      codexAccount: this.codexAccount,
      queuedSubmissions: this.queuedSubmissions,
      generation: this.generation
    };
  }

  createProject(): ChatState {
    this.store.createProject();
    this.clearError();
    this.broadcast();
    return this.state();
  }

  createThread(projectId?: string): ChatState {
    this.store.createThread(projectId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  selectProject(projectId: string): ChatState {
    this.store.selectProject(projectId);
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

  renameProject(projectId: string, title: string): ChatState {
    this.store.renameProject(projectId, title);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  updateProjectSettings(projectId: string, title: string, directory: string, actionButtons?: ChatActionButton[]): ChatState {
    this.store.updateProjectSettings(projectId, title, directory, actionButtons);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  renameThread(threadId: string, title: string): ChatState {
    this.store.renameThread(threadId, title);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  moveThread(threadId: string, projectId: string, targetThreadId?: string, position?: "before" | "after"): ChatState {
    this.store.moveThread(threadId, projectId, targetThreadId, position);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  moveProject(projectId: string, targetProjectId: string, position: "before" | "after"): ChatState {
    this.store.moveProject(projectId, targetProjectId, position);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  deleteProject(projectId: string): ChatState {
    this.store.deleteProject(projectId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  deleteThread(threadId: string): ChatState {
    this.store.deleteThread(threadId);
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

  updateRuntimeSettings(settings: Partial<ChatState["runtimeSettings"]>): ChatState {
    this.store.updateRuntimeSettings(settings);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  updateAppSettings(settings: Partial<ChatState["appSettings"]>): ChatState {
    this.store.updateAppSettings(settings);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  updateThreadSettings(payload: ChatUpdateThreadSettingsPayload): ChatState {
    if (payload.providerMode === "codex" && this.threadHasNonCodexAssistantHistory(payload.threadId)) {
      this.setError(localToCodexBlockReason());
      this.broadcast();
      return this.state();
    }
    this.store.updateThreadSettings(payload.threadId, {
      providerMode: payload.providerMode,
      selectedSettingsPresetId: payload.selectedSettingsPresetId,
      builtinModelId: payload.builtinModelId,
      runtimeSettings: payload.runtimeSettings,
      builtinAgenticFramework: payload.builtinAgenticFramework,
      documentAnalysisEmbeddingModelPath: payload.documentAnalysisEmbeddingModelPath,
      codexModelId: payload.codexModelId,
      codexReasoningEffort: payload.codexReasoningEffort,
      permissionMode: payload.permissionMode,
      codexApprovalMode: payload.codexApprovalMode,
      planModeEnabled: payload.planModeEnabled,
      documentIndexId: payload.documentIndexId,
      codexLastSessionId: payload.codexLastSessionId,
      remoteSessionId: payload.remoteSessionId,
      remoteSlotId: payload.remoteSlotId,
      remoteSettingsSignature: payload.remoteSettingsSignature,
      remoteHostIdentity: payload.remoteHostIdentity
    });
    this.clearError();
    this.broadcast();
    return this.state();
  }

  applySettingsPreset(payload: ChatApplySettingsPresetPayload): ChatState {
    const preset = this.store.loadState().settingsPresets.find((candidate) => candidate.id === payload.presetId);
    if (preset?.providerMode === "codex" && this.threadHasNonCodexAssistantHistory(payload.threadId)) {
      this.setError(localToCodexBlockReason());
      this.broadcast();
      return this.state();
    }
    this.store.applySettingsPreset(payload.threadId, payload.presetId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  saveSettingsPreset(payload: ChatSaveSettingsPresetPayload): ChatState {
    this.store.saveSettingsPreset({
      id: payload.presetId,
      label: payload.label,
      runtimeSettings: payload.runtimeSettings,
      providerMode: payload.providerMode,
      iconName: payload.iconName,
      builtinModelId: payload.builtinModelId,
      builtinAgenticFramework: payload.builtinAgenticFramework,
      documentAnalysisEmbeddingModelPath: payload.documentAnalysisEmbeddingModelPath,
      codexModelId: payload.codexModelId,
      codexReasoningEffort: payload.codexReasoningEffort
    });
    this.clearError();
    this.broadcast();
    return this.state();
  }

  deleteSettingsPreset(payload: ChatDeleteSettingsPresetPayload): ChatState {
    this.store.deleteSettingsPreset(payload.presetId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  async refreshCodexAccount(payload?: ChatRefreshCodexAccountPayload): Promise<ChatState> {
    try {
      const snapshot = await this.codexRuntime.readAccount(Boolean(payload?.force));
      this.codexAccount = snapshot.account;
      if (snapshot.models.length > 0) {
        this.codexModels = snapshot.models;
      }
      this.clearError();
    } catch (error) {
      this.codexAccount = { status: "error", error: errorMessage(error) };
      this.setError(errorMessage(error));
    }
    this.broadcast();
    return this.state();
  }

  refreshLocalModels(): ChatState {
    const refresh = this.store.refreshLocalModels();
    this.clearError();
    if (refresh.removedModelIds.length > 0) {
      this.generation = { status: "error", error: `Removed ${refresh.removedModelIds.length} unavailable local model${refresh.removedModelIds.length === 1 ? "" : "s"}.` };
    }
    void this.refreshRemoteModels();
    this.broadcast();
    return this.state();
  }

  private async refreshRemoteModels(): Promise<void> {
    const appSettings = this.store.loadState().appSettings;
    if (!appSettings.remoteHostAddress.trim() || !appSettings.remotePairingCode.trim()) {
      return;
    }
    try {
      const remote = await this.remoteRuntime.discover(appSettings);
      this.store.replaceRemoteModels(remote.models, {
        hostId: remote.hostId,
        hostIdentity: remote.hostIdentity,
        protocolVersion: remote.protocolVersion
      });
      this.clearError();
    } catch (error) {
      this.setError(errorMessage(error));
    } finally {
      this.broadcast();
    }
  }

  cancelQueuedSubmission(submissionId: string): ChatState {
    this.queuedSubmissions = this.queuedSubmissions.filter((submission) => submission.id !== submissionId);
    this.queuedSubmissionPayloads.delete(submissionId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  async submit(payload: ChatSubmitPayload): Promise<ChatState> {
    const text = payload.text.trim();
    const attachments = payload.attachments ?? [];
    if (!text && attachments.length === 0) {
      this.setError("Cannot submit an empty chat message.");
      return this.state();
    }
    const state = this.store.loadState();
    const threadId = state.selectedThreadId;
    const selectedThread = state.threads.find((thread) => thread.id === threadId);
    if (selectedThread && this.tryHandleLocalContextCommand(selectedThread, text, attachments)) {
      return this.state();
    }
    if (this.generation.status === "running") {
      if (selectedThread && this.generation.threadId === selectedThread.id && selectedThread.providerMode === "codex" && payload.submitMode !== "queue") {
        await this.steerCodexTurn(selectedThread.id, text, attachments);
        return this.state();
      }
      if (!threadId || !selectedThread) {
        this.setError("No chat thread is selected.");
        this.broadcast();
        return this.state();
      }
      this.queueSubmission(selectedThread?.id ?? threadId, text, attachments, selectedThread?.providerMode ?? "builtin");
      this.clearError();
      this.broadcast();
      return this.state();
    }
    return this.startSubmission({ threadId, text, attachments });
  }

  private tryHandleLocalContextCommand(selectedThread: ChatState["threads"][number], text: string, attachments: ChatAttachment[]): boolean {
    if (attachments.length > 0 || (text !== "/trim" && text !== "/reset")) {
      return false;
    }
    if (selectedThread.providerMode === "codex") {
      return false;
    }
    if (text === "/reset") {
      const messageCount = this.store.messageCount(selectedThread.id);
      if (messageCount <= selectedThread.activeContextStartMessageIndex) {
        this.store.createMessage(selectedThread.id, "assistant", "> Local context is already reset.", "complete", {
          sourceLabel: "Built-in"
        });
      } else {
        this.store.updateLocalContextBoundary(selectedThread.id, messageCount, "reset");
        this.store.createMessage(selectedThread.id, "assistant", "> Local context reset. Future built-in requests start after the current transcript.", "complete", {
          sourceLabel: "Built-in"
        });
      }
      this.clearError();
      this.broadcast();
      return true;
    }
    const state = this.store.loadState();
    const selectedModel = state.models.find((model) => model.id === (selectedThread.builtinModelId || state.selectedModelId));
    if (!selectedModel) {
      this.setError("Add and select a local GGUF model before trimming context.");
      this.broadcast();
      return true;
    }
    const messages = state.messages.filter((message) => message.threadId === selectedThread.id);
    const nextStart = plannedLocalContextStart(messages, selectedThread.activeContextStartMessageIndex, selectedThread.runtimeSettings);
    if (nextStart <= selectedThread.activeContextStartMessageIndex) {
      this.store.createMessage(selectedThread.id, "assistant", "> Local context is already within the configured budget.", "complete", {
        sourceLabel: "Built-in"
      });
    } else {
      this.store.updateLocalContextBoundary(selectedThread.id, nextStart, "trim");
      this.store.createMessage(selectedThread.id, "assistant", `> Local context trimmed. Future built-in requests start at message ${nextStart + 1}.`, "complete", {
        sourceLabel: "Built-in"
      });
    }
    this.clearError();
    this.broadcast();
    return true;
  }

  private startSubmission(options: { threadId: string; text: string; attachments: ChatAttachment[] }): ChatState {
    const state = this.store.loadState();
    const threadId = options.threadId;
    const selectedThread = state.threads.find((thread) => thread.id === threadId);
    const text = options.text.trim();
    const attachments = options.attachments;
    const selectedModel = state.models.find((model) => model.id === (selectedThread?.builtinModelId || state.selectedModelId));
    if (!threadId) {
      this.setError("No chat thread is selected.");
      return this.state();
    }
    if (!selectedThread) {
      this.setError("Selected chat thread could not be loaded.");
      return this.state();
    }
    if (selectedThread.providerMode === "builtin" && !selectedModel) {
      this.setError("Add and select a local GGUF model before sending.");
      return this.state();
    }
    if (selectedThread.providerMode === "codex" && this.threadHasNonCodexAssistantHistory(threadId)) {
      this.setError(localToCodexBlockReason());
      return this.state();
    }
    if (text && this.store.messageCount(threadId) === 0) {
      this.store.renameThread(threadId, text);
    }
    this.store.createMessage(threadId, "user", text, "complete", { attachments });
    const assistantMessage = this.store.createMessage(threadId, "assistant", "", "streaming", {
      label: selectedThread.providerMode === "codex"
        ? this.codexModels.find((model) => model.id === selectedThread.codexModelId)?.label ?? selectedThread.codexModelId
        : selectedModel?.label,
      sourceLabel: selectedThread.providerMode === "codex" ? "Codex" : "Built-in"
    });
    this.cancelRequested = false;
    this.generation = { status: "running", threadId, assistantMessageId: assistantMessage.id };
    this.broadcast();
    if (selectedThread.providerMode === "codex") {
      void this.runCodexGeneration({ threadId, assistantMessageId: assistantMessage.id });
    } else if (selectedModel) {
      void this.runGeneration({ threadId, assistantMessageId: assistantMessage.id, model: selectedModel });
    }
    return this.state();
  }

  cancel(): ChatState {
    if (this.generation.status !== "running") {
      return this.state();
    }
    this.cancelRequested = true;
    this.runtime.cancelActiveRequest();
    this.remoteRuntime.cancelActiveRequest();
    this.codexRuntime.cancelActiveRequest();
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
    this.remoteRuntime.cancelActiveRequest();
    this.codexRuntime.close();
    this.store.close();
  }

  private async runGeneration(options: { threadId: string; assistantMessageId: string; model: ChatModel }): Promise<void> {
    const state = this.store.loadState();
    const thread = state.threads.find((item) => item.id === options.threadId);
    const messages = state.messages
      .filter((message) => message.threadId === options.threadId && message.id !== options.assistantMessageId)
      .slice(thread?.activeContextStartMessageIndex ?? 0);
    if (thread?.builtinAgenticFramework === "document_analysis") {
      await this.runDocumentAnalysisGeneration({
        thread,
        messages,
        assistantMessageId: options.assistantMessageId,
        model: options.model
      });
      return;
    }
    if (options.model.providerId === "remote") {
      await this.runRemoteGeneration({
        thread,
        messages,
        assistantMessageId: options.assistantMessageId,
        model: options.model
      });
      return;
    }
    try {
      await this.runtime.streamChat({
        model: options.model,
        settings: thread?.runtimeSettings ?? state.runtimeSettings,
        messages,
        onToken: (token) => {
          this.store.appendToMessage(options.assistantMessageId, token);
          this.broadcast();
        },
        onReasoning: (token) => {
          this.store.appendToMessageReasoning(options.assistantMessageId, token);
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
      void this.drainNextQueuedSubmission();
    }
  }

  private async runRemoteGeneration(options: {
    thread: ChatState["threads"][number] | undefined;
    messages: ChatState["messages"];
    assistantMessageId: string;
    model: ChatModel;
  }): Promise<void> {
    const state = this.store.loadState();
    try {
      if (!options.thread) {
        throw new Error("Selected chat thread could not be loaded.");
      }
      const resume = remoteResumeState(options.thread, options.model, state.appSettings);
      const metrics = await this.remoteRuntime.streamChat({
        settings: state.appSettings,
        model: options.model,
        runtimeSettings: options.thread.runtimeSettings,
        messages: options.messages,
        remoteSessionId: resume.remoteSessionId,
        runtimeSlotId: resume.remoteSlotId,
        runtimeSettingsSignature: resume.remoteSettingsSignature,
        onToken: (token) => {
          this.store.appendToMessage(options.assistantMessageId, token);
          this.broadcast();
        },
        onReasoning: (token) => {
          this.store.appendToMessageReasoning(options.assistantMessageId, token);
          this.broadcast();
        }
      });
      this.store.updateThreadSettings(options.thread.id, remoteMetricsToThreadSettings(options.thread, options.model, state.appSettings, metrics));
      this.store.mergeMessageMetadata(options.assistantMessageId, { remoteMetrics: metrics.metrics });
      this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "complete");
      this.generation = { status: "idle" };
    } catch (error) {
      const message = errorMessage(error);
      this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "error");
      this.generation = this.cancelRequested ? { status: "idle" } : { status: "error", error: message };
    } finally {
      this.cancelRequested = false;
      this.broadcast();
      void this.drainNextQueuedSubmission();
    }
  }

  private async runDocumentAnalysisGeneration(options: {
    thread: ChatState["threads"][number];
    messages: ChatState["messages"];
    assistantMessageId: string;
    model: ChatModel;
  }): Promise<void> {
    try {
      const documentIndexId = options.thread.documentIndexId.trim();
      if (!documentIndexId) {
        throw new Error("No document index is selected for this thread.");
      }
      const documentIndex = this.store.documentIndex(documentIndexId);
      if (!documentIndex) {
        throw new Error("Selected document index was not found.");
      }
      if (documentIndex.state !== "ready") {
        throw new Error("Selected document index is not ready yet.");
      }
      const appSettings = this.store.loadState().appSettings;
      if (options.model.providerId === "remote" && documentIndex.id.startsWith("remote-doc::") && appSettings.documentToolExecutionLocation === "remote") {
        await this.runRemoteHostedDocumentAnalysisGeneration({ ...options, documentIndex });
        this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "complete");
        this.generation = { status: "idle" };
        return;
      }
      const workingMessages = [...options.messages];
      const timelineBlocks: ChatTimelineBlock[] = [];
      const useRemoteDocumentTools = documentIndex.id.startsWith("remote-doc::") || appSettings.documentToolExecutionLocation === "remote";
      if (useRemoteDocumentTools && !documentIndex.id.startsWith("remote-doc::")) {
        throw new Error("Remote document tool execution requires a remote document index.");
      }
      let latestResults: ChatDocumentSearchEntry[] = [];
      let latestRemoteResult: RemoteDocumentSearchResult | null = null;
      let forcedGroundingRetries = 0;
      let malformedAttempts = 0;
      for (let toolCallCount = 0; toolCallCount <= 8; toolCallCount += 1) {
        const pass = await this.runDocumentModelPass({
          model: options.model,
          settings: options.thread.runtimeSettings,
          messages: workingMessages,
          streamToAssistant: false
        });
        const parsed = parseDocumentToolCallResponse(pass.content, pass.reasoning);
        if (parsed.status === "final") {
          if (documentAnalysisRequiresSearchFirst(workingMessages)) {
            forcedGroundingRetries += 1;
            if (forcedGroundingRetries > 1) {
              throw new Error("Document analysis must ground answers in the selected document. Call `search` first.");
            }
            workingMessages.push(syntheticChatMessage("assistant", pass.content));
            workingMessages.push(syntheticChatMessage("user", "Grounding required: this request is about the selected document. Call `search` first with exactly one <tool_call> JSON block. Do not answer from general knowledge."));
            continue;
          }
          if (pass.reasoning) {
            this.store.appendToMessageReasoning(options.assistantMessageId, pass.reasoning);
          }
          this.store.appendToMessage(options.assistantMessageId, pass.content);
          break;
        }
        if (parsed.status !== "tool_call") {
          const errorText = parsed.status === "malformed" ? parsed.error : "Malformed tool call.";
          malformedAttempts += 1;
          timelineBlocks.push({ kind: "status", id: `document-warning-${randomUUID()}`, level: "warning", message: errorText, code: "document_analysis_tool_call_invalid" });
          this.store.updateMessageTimelineBlocks(options.assistantMessageId, timelineBlocks);
          this.broadcast();
          if (malformedAttempts >= 2) {
            throw new Error(errorText);
          }
          workingMessages.push(syntheticChatMessage("assistant", pass.content));
          workingMessages.push(syntheticChatMessage("user", `Tool call error: ${errorText}\nRetry with exactly one <tool_call> JSON block or answer normally.`));
          continue;
        }
        if (toolCallCount >= 8) {
          throw new Error("Document analysis exceeded the safe tool-call limit for one response. Narrow the request and try again.");
        }
        const toolBlockId = `document-tool-${randomUUID()}`;
        if (parsed.tool === "search") {
          if (useRemoteDocumentTools) {
            const budgetTokens = await this.documentEvidenceBudgetForRemoteTools(options.model, options.thread, workingMessages, documentIndex.title);
            if (budgetTokens <= 0) {
              throw new Error("Document analysis ran out of safe evidence budget. Start a new thread, reset local context, or use a larger context window.");
            }
            latestRemoteResult = await this.remoteRuntime.searchDocumentIndex({
              settings: appSettings,
              documentIndexId: documentIndex.id,
              query: parsed.query,
              topK: parsed.topK,
              budgetTokens
            });
            latestResults = remoteSearchEntriesToChat(latestRemoteResult);
          } else {
            const budgetTokens = documentEvidenceBudget(options.thread.runtimeSettings, workingMessages, documentIndex.title);
            if (budgetTokens <= 0) {
              throw new Error("Document analysis ran out of safe evidence budget. Start a new thread, reset local context, or use a larger context window.");
            }
            latestResults = this.store.searchDocumentIndex(documentIndex.id, parsed.query, parsed.topK, budgetTokens);
          }
        } else if (parsed.tool === "modify_results") {
          if (useRemoteDocumentTools) {
            if (!latestRemoteResult) {
              throw new Error("Document search results must exist before modify_results can run.");
            }
            const budgetTokens = await this.documentEvidenceBudgetForRemoteTools(options.model, options.thread, workingMessages, documentIndex.title);
            if (budgetTokens <= 0) {
              throw new Error("Document analysis ran out of safe evidence budget. Start a new thread, reset local context, or use a larger context window.");
            }
            latestRemoteResult = await this.remoteRuntime.modifyDocumentSearchResults({
              settings: appSettings,
              documentIndexId: documentIndex.id,
              result: latestRemoteResult,
              dropResultIds: parsed.dropResultIds,
              expand: parsed.expand,
              budgetTokens
            });
            latestResults = remoteSearchEntriesToChat(latestRemoteResult);
          } else {
            const budgetTokens = documentEvidenceBudget(options.thread.runtimeSettings, workingMessages, documentIndex.title);
            if (budgetTokens <= 0) {
              throw new Error("Document analysis ran out of safe evidence budget. Start a new thread, reset local context, or use a larger context window.");
            }
            latestResults = this.store.modifyDocumentSearchResults(documentIndex.id, latestResults, parsed.dropResultIds, parsed.expand, budgetTokens);
          }
        } else {
          throw new Error("Unsupported document-analysis tool call.");
        }
        const resultText = formatDocumentSearchResults(latestResults);
        timelineBlocks.push({
          kind: "tool",
          id: toolBlockId,
          toolName: parsed.tool,
          status: "completed",
          summary: parsed.tool === "search" ? parsed.query : "Refine latest search results",
          command: parsed.tool === "search" ? parsed.query : "modify_results",
          output: resultText
        });
        this.store.updateMessageTimelineBlocks(options.assistantMessageId, timelineBlocks);
        this.broadcast();
        workingMessages.push(syntheticChatMessage("assistant", pass.content));
        workingMessages.push(syntheticChatMessage("user", `Tool result:\n${resultText}\n${parsed.tool === "search" ? "Use this evidence to answer, or issue one narrower search if needed." : "Use this refined evidence to answer, or refine it again if needed."}`));
      }
      this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "complete");
      this.generation = { status: "idle" };
    } catch (error) {
      const message = errorMessage(error);
      this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "error");
      this.generation = this.cancelRequested ? { status: "idle" } : { status: "error", error: message };
    } finally {
      this.cancelRequested = false;
      this.broadcast();
      void this.drainNextQueuedSubmission();
    }
  }

  private async runDocumentModelPass(options: {
    model: ChatModel;
    settings: ChatState["runtimeSettings"];
    messages: ChatState["messages"];
    streamToAssistant: false;
  }): Promise<{ content: string; reasoning: string }> {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    if (options.model.providerId === "remote") {
      await this.remoteRuntime.streamChat({
        settings: this.store.loadState().appSettings,
        model: options.model,
        runtimeSettings: options.settings,
        messages: options.messages,
        onToken: (token) => contentParts.push(token),
        onReasoning: (token) => reasoningParts.push(token)
      });
      return { content: contentParts.join(""), reasoning: reasoningParts.join("") };
    }
    await this.runtime.streamChat({
      model: options.model,
      settings: options.settings,
      messages: options.messages,
      onToken: (token) => {
        contentParts.push(token);
      },
      onReasoning: (token) => {
        reasoningParts.push(token);
      }
    });
    return { content: contentParts.join(""), reasoning: reasoningParts.join("") };
  }

  private async runRemoteHostedDocumentAnalysisGeneration(options: {
    thread: ChatState["threads"][number];
    messages: ChatState["messages"];
    assistantMessageId: string;
    model: ChatModel;
    documentIndex: NonNullable<ReturnType<ChatStore["documentIndex"]>>;
  }): Promise<void> {
    const timelineBlocks: ChatTimelineBlock[] = [];
    const state = this.store.loadState();
    const resume = remoteResumeState(options.thread, options.model, state.appSettings, options.documentIndex.id);
    const metrics = await this.remoteRuntime.streamDocumentAnalysis({
      settings: state.appSettings,
      model: options.model,
      runtimeSettings: options.thread.runtimeSettings,
      messages: options.messages,
      documentIndexId: options.documentIndex.id,
      remoteSessionId: resume.remoteSessionId,
      runtimeSlotId: resume.remoteSlotId,
      runtimeSettingsSignature: resume.remoteSettingsSignature,
      onToken: (token) => {
        this.store.appendToMessage(options.assistantMessageId, token);
        this.broadcast();
      },
      onReasoning: (token) => {
        this.store.appendToMessageReasoning(options.assistantMessageId, token);
        this.broadcast();
      },
      onAgentEvents: (events) => {
        for (const event of events) {
          const block = remoteAgentEventToTimelineBlock(event);
          if (!block) {
            continue;
          }
          const existing = timelineBlocks.findIndex((item) => item.id === block.id);
          if (existing >= 0) {
            timelineBlocks[existing] = block;
          } else {
            timelineBlocks.push(block);
          }
        }
        this.store.updateMessageTimelineBlocks(options.assistantMessageId, timelineBlocks);
        this.broadcast();
      }
    });
    this.store.updateThreadSettings(options.thread.id, remoteMetricsToThreadSettings(options.thread, options.model, state.appSettings, metrics, options.documentIndex.id));
    this.store.mergeMessageMetadata(options.assistantMessageId, { remoteMetrics: metrics.metrics });
  }

  private async documentEvidenceBudgetForRemoteTools(
    model: ChatModel,
    thread: ChatState["threads"][number],
    messages: ChatState["messages"],
    documentTitle: string
  ): Promise<number> {
    const budget = await this.remoteRuntime.documentAnalysisEvidenceBudget({
      settings: this.store.loadState().appSettings,
      model,
      runtimeSettings: thread.runtimeSettings,
      messages,
      documentTitle
    });
    return Math.max(0, budget);
  }

  private async runCodexGeneration(options: { threadId: string; assistantMessageId: string }): Promise<void> {
    const state = this.store.loadState();
    const thread = state.threads.find((item) => item.id === options.threadId);
    const project = thread ? state.projects.find((item) => item.id === thread.projectId) : undefined;
    const lastUserMessage = [...state.messages].reverse().find((message) => message.threadId === options.threadId && message.role === "user");
    if (!thread || !lastUserMessage) {
      this.store.updateMessageStatus(options.assistantMessageId, "error");
      this.generation = { status: "error", error: "Codex thread state could not be loaded." };
      this.broadcast();
      return;
    }
    const selectedCodexModel = state.codexModels.find((model) => model.id === thread.codexModelId) ?? state.codexModels.find((model) => model.isDefault);
    const timelineBlocks: ChatTimelineBlock[] = [];
    let preparedImages: { imagePaths: string[]; cleanup: () => void } | null = null;
    try {
      if (!project?.directory) {
        throw new Error("Select a project directory before running a Codex thread.");
      }
      if (lastUserMessage.attachments.length > 0 && !selectedCodexModel?.supportsImageInput) {
        throw new Error("Selected Codex model does not support image input.");
      }
      preparedImages = prepareCodexImageAttachments(lastUserMessage.attachments);
      for await (const event of this.codexRuntime.runTurn({
        cwd: project.directory,
        prompt: lastUserMessage.content,
        imagePaths: preparedImages.imagePaths,
        baseInstructions: thread.runtimeSettings.systemPrompt,
        resumeThreadId: thread.codexLastSessionId,
        model: thread.codexModelId,
        reasoningEffort: thread.codexReasoningEffort,
        permissionMode: thread.permissionMode,
        approvalMode: thread.codexApprovalMode,
        planModeEnabled: thread.planModeEnabled
      })) {
        if (this.cancelRequested) {
          break;
        }
        if (event.type === "thread.started") {
          this.store.updateThreadSettings(options.threadId, { codexLastSessionId: event.thread_id });
          this.broadcast();
        } else if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.item) {
          if (event.item.type === "agent_message") {
            this.store.appendToMessage(options.assistantMessageId, event.item.text ?? "");
          } else if (event.item.type === "reasoning") {
            this.store.appendToMessageReasoning(options.assistantMessageId, event.item.text ?? "");
          } else {
            const block = codexItemToTimelineBlock(event.type, event.item);
            if (block) {
              const existingIndex = timelineBlocks.findIndex((item) => item.id === block.id);
              if (existingIndex >= 0) {
                timelineBlocks[existingIndex] = block;
              } else {
                timelineBlocks.push(block);
              }
              this.store.updateMessageTimelineBlocks(options.assistantMessageId, timelineBlocks);
            }
          }
          this.broadcast();
        } else if (event.type === "turn.failed" || event.type === "error") {
          throw new Error(event.type === "turn.failed" ? event.error?.message ?? "Codex turn failed." : event.message ?? "Codex reported an error.");
        } else if (event.type === "turn.completed" && event.usage) {
          this.store.mergeMessageMetadata(options.assistantMessageId, { codexUsage: event.usage });
        }
      }
      this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "complete");
      this.generation = { status: "idle" };
    } catch (error) {
      const message = errorMessage(error);
      this.store.updateMessageStatus(options.assistantMessageId, this.cancelRequested ? "interrupted" : "error");
      this.generation = this.cancelRequested ? { status: "idle" } : { status: "error", error: message };
    } finally {
      preparedImages?.cleanup();
      this.cancelRequested = false;
      this.broadcast();
      void this.drainNextQueuedSubmission();
    }
  }

  private async steerCodexTurn(threadId: string, text: string, attachments: ChatAttachment[]): Promise<void> {
    const state = this.store.loadState();
    const thread = state.threads.find((item) => item.id === threadId);
    const selectedCodexModel = thread ? this.codexModels.find((model) => model.id === thread.codexModelId) ?? this.codexModels.find((model) => model.isDefault) : undefined;
    if (!thread || thread.providerMode !== "codex") {
      this.setError("Codex steering requires an active Codex thread.");
      this.broadcast();
      return;
    }
    if (!text && attachments.length === 0) {
      return;
    }
    if (attachments.length > 0 && !selectedCodexModel?.supportsImageInput) {
      this.setError("Selected Codex model does not support image input.");
      this.broadcast();
      return;
    }
    let preparedImages: { imagePaths: string[]; cleanup: () => void } | null = null;
    try {
      preparedImages = prepareCodexImageAttachments(attachments);
      await this.codexRuntime.steerCurrentTurn({ text, imagePaths: preparedImages.imagePaths });
      const steeringId = `chat-steer-${randomUUID()}`;
      const preview = text || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;
      this.queuedSubmissions.push({
        id: steeringId,
        threadId,
        preview,
        attachmentCount: attachments.length,
        providerMode: "codex",
        inputMode: "steer",
        createdAt: new Date().toISOString()
      });
      this.store.createMessage(threadId, "user", text, "complete", {
        attachments,
        sourceLabel: "Codex",
        metadata: { inputMode: "steer" }
      });
      this.clearError();
      this.broadcast();
    } catch (error) {
      this.setError(errorMessage(error));
      this.broadcast();
    } finally {
      preparedImages?.cleanup();
    }
  }

  private queueSubmission(threadId: string, text: string, attachments: ChatAttachment[], providerMode: ChatQueuedSubmission["providerMode"]): void {
    if (!threadId) {
      this.setError("No chat thread is selected.");
      return;
    }
    const id = `chat-queue-${randomUUID()}`;
    const preview = text || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;
    this.queuedSubmissions.push({
      id,
      threadId,
      preview,
      attachmentCount: attachments.length,
      providerMode,
      inputMode: "queue",
      createdAt: new Date().toISOString()
    });
    this.queuedSubmissionPayloads.set(id, { text, attachments });
  }

  private drainNextQueuedSubmission(): void {
    if (this.generation.status === "idle") {
      const before = this.queuedSubmissions.length;
      this.queuedSubmissions = this.queuedSubmissions.filter((submission) => submission.inputMode !== "steer");
      if (this.queuedSubmissions.length !== before) {
        this.broadcast();
      }
    }
    if (this.generation.status === "running" || this.queuedSubmissions.length === 0 || this.closed) {
      return;
    }
    const queued = this.queuedSubmissions.shift();
    if (!queued) {
      return;
    }
    const payload = this.queuedSubmissionPayloads.get(queued.id);
    this.queuedSubmissionPayloads.delete(queued.id);
    this.broadcast();
    if (!payload) {
      return;
    }
    this.startSubmission({ threadId: queued.threadId, text: payload.text, attachments: payload.attachments });
  }

  private threadHasNonCodexAssistantHistory(threadId: string): boolean {
    const state = this.store.loadState();
    return state.messages.some((message) => (
      message.threadId === threadId
      && message.role === "assistant"
      && message.sourceLabel !== "Codex"
    ));
  }

  async gitState(projectId: string): Promise<ChatGitState> {
    const project = this.store.loadState().projects.find((item) => item.id === projectId);
    if (!project?.directory) {
      return { status: "no_directory", message: "Select a project to show git branches." };
    }
    try {
      await execFileAsync("git", ["-C", project.directory, "rev-parse", "--is-inside-work-tree"], { windowsHide: true });
    } catch {
      return { status: "no_repo", message: "Git branches are unavailable." };
    }
    const [branch, branches, status, diff, head, aheadBehind] = await Promise.all([
      execFileAsync("git", ["-C", project.directory, "branch", "--show-current"], { windowsHide: true }),
      execFileAsync("git", ["-C", project.directory, "branch", "--format=%(refname:short)"], { windowsHide: true }),
      execFileAsync("git", ["-C", project.directory, "status", "--porcelain"], { windowsHide: true }),
      execFileAsync("git", ["-C", project.directory, "diff", "--numstat"], { windowsHide: true }),
      execFileAsync("git", ["-C", project.directory, "rev-parse", "--verify", "HEAD"], { windowsHide: true }).then(() => true).catch(() => false),
      execFileAsync("git", ["-C", project.directory, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { windowsHide: true }).catch(() => ({ stdout: "0\t0" }))
    ]);
    const diffCounts = parseGitNumstat(diff.stdout);
    const [behindText = "0", aheadText = "0"] = aheadBehind.stdout.trim().split(/\s+/);
    return {
      status: "ready",
      currentBranch: branch.stdout.trim() || "HEAD",
      branches: branches.stdout.split(/\r?\n/g).map((item) => item.trim()).filter(Boolean),
      dirty: Boolean(status.stdout.trim()),
      ahead: Number.parseInt(aheadText, 10) || 0,
      behind: Number.parseInt(behindText, 10) || 0,
      addedLines: diffCounts.added,
      deletedLines: diffCounts.deleted,
      hasCommits: head
    };
  }

  async switchGitBranch(projectId: string, branch: string): Promise<ChatGitState> {
    const project = this.requireProjectDirectory(projectId);
    await execFileAsync("git", ["-C", project.directory, "switch", branch], { windowsHide: true });
    return this.gitState(projectId);
  }

  async createGitBranch(projectId: string, branch: string): Promise<ChatGitState> {
    const project = this.requireProjectDirectory(projectId);
    await execFileAsync("git", ["-C", project.directory, "switch", "-c", branch], { windowsHide: true });
    return this.gitState(projectId);
  }

  async runProjectAction(projectId: string, actionId: string): Promise<void> {
    const state = this.store.loadState();
    const project = state.projects.find((item) => item.id === projectId);
    const action = project?.actionButtons.find((item) => item.id === actionId);
    if (!project || !action) {
      throw new Error("Project action does not exist.");
    }
    const cwd = action.directory || project.directory;
    if (!cwd) {
      throw new Error("Project action requires a working directory.");
    }
    await execFileAsync(action.command, [], { cwd, shell: true, windowsHide: true });
  }

  async createDocumentIndex(payload: ChatCreateDocumentIndexPayload): Promise<ChatState> {
    const state = this.store.loadState();
    const selectedThread = state.threads.find((thread) => thread.id === state.selectedThreadId && thread.projectId === payload.projectId)
      ?? state.threads.find((thread) => thread.projectId === payload.projectId);
    if (!selectedThread || selectedThread.providerMode === "codex" || selectedThread.builtinAgenticFramework !== "document_analysis") {
      this.setError("Document indexes are only available for built-in document analysis threads.");
      this.broadcast();
      return this.state();
    }
    if (state.appSettings.documentIndexLocation === "remote") {
      const selectedModel = state.models.find((model) => model.id === (selectedThread.builtinModelId || state.selectedModelId));
      if (!selectedModel || selectedModel.providerId !== "remote") {
        this.setError("Remote document indexing requires a selected remote built-in model.");
        this.broadcast();
        return this.state();
      }
      try {
        const remoteIndex = await this.remoteRuntime.createDocumentIndex({
          settings: state.appSettings,
          projectId: payload.projectId,
          title: payload.title,
          sourcePaths: payload.sourcePath.split(/\r?\n/g).map((item) => item.trim()).filter(Boolean),
          remoteModelId: selectedModel.id
        });
        this.store.upsertDocumentIndex(remoteIndex);
        this.store.selectDocumentIndex(selectedThread.id, remoteIndex.id);
        this.clearError();
      } catch (error) {
        this.setError(errorMessage(error));
      }
      this.broadcast();
      return this.state();
    }
    if (!selectedThread.documentAnalysisEmbeddingModelPath.trim()) {
      this.setError("Document analysis requires an embedding GGUF path before creating an index.");
      this.broadcast();
      return this.state();
    }
    const tokenizerPath = state.appSettings.tokenizerModelPath.trim() || selectedThread.builtinModelId.trim();
    if (!tokenizerPath) {
      this.setError("Document analysis requires a tokenizer GGUF path before creating an index.");
      this.broadcast();
      return this.state();
    }
    const documentIndex = this.store.createDocumentIndex(payload.projectId, payload.title, payload.sourcePath);
    if (selectedThread) {
      this.store.selectDocumentIndex(selectedThread.id, documentIndex.id);
    }
    this.clearError();
    this.broadcast();
    void this.buildDocumentIndex(documentIndex.id);
    return this.state();
  }

  selectDocumentIndex(payload: ChatSelectDocumentIndexPayload): ChatState {
    this.store.selectDocumentIndex(payload.threadId, payload.documentIndexId);
    this.clearError();
    this.broadcast();
    return this.state();
  }

  private async buildDocumentIndex(documentIndexId: string): Promise<void> {
    const documentIndex = this.store.documentIndex(documentIndexId);
    if (!documentIndex) {
      return;
    }
    try {
      this.store.updateDocumentIndexStatus(documentIndexId, { state: "building", progress: 0.05, message: "Extracting text" });
      this.broadcast();
      const sourcePaths = documentIndex.sourcePath.split(/\r?\n/g).map((item) => item.trim()).filter(Boolean);
      const chunks: Array<Omit<ChatDocumentSearchEntry, "resultId" | "score">> = [];
      for (const [sourceIndex, sourcePath] of sourcePaths.entries()) {
        const pages = await extractDocumentPages(sourcePath);
        if (!pages.some((page) => page.trim())) {
          throw new Error(`The selected PDF "${path.basename(sourcePath)}" does not contain extractable text. Scanned/image-only PDFs are not supported.`);
        }
        for (const chunk of chunkDocumentPages(sourcePath, pages, chunks.length)) {
          chunks.push(chunk);
        }
        this.store.updateDocumentIndexStatus(documentIndexId, {
          state: "building",
          progress: 0.15 + (0.7 * ((sourceIndex + 1) / Math.max(1, sourcePaths.length))),
          message: "Chunking"
        });
        this.broadcast();
      }
      if (chunks.length === 0) {
        throw new Error("Document index did not produce any searchable text chunks.");
      }
      this.store.replaceDocumentIndexChunks(documentIndexId, chunks);
      this.store.updateDocumentIndexStatus(documentIndexId, {
        state: "ready",
        progress: 1,
        message: `Ready (${chunks.length} chunks)`
      });
    } catch (error) {
      this.store.updateDocumentIndexStatus(documentIndexId, {
        state: "error",
        progress: 0,
        message: errorMessage(error)
      });
      this.setError(errorMessage(error));
    } finally {
      this.broadcast();
    }
  }

  async timelineAction(payload: ChatTimelineActionPayload): Promise<ChatState> {
    this.store.updateMessageTimelineBlock(payload.messageId, payload.blockId, (block) => {
      if (block.kind === "approval") {
        if (payload.action === "approve" || payload.action === "deny") {
          this.codexRuntime.answerApproval(payload.blockId, payload.action === "approve" ? "accept" : "decline");
        }
        return {
          ...block,
          status: "completed",
          decision: payload.action === "approve" ? "accepted" : payload.action === "deny" ? "declined" : block.decision
        };
      }
      if (block.kind === "question") {
        if (payload.action === "answer" && payload.answer) {
          const questionId = block.questions?.[0]?.id ?? payload.blockId;
          this.codexRuntime.answerUserInput(payload.blockId, { [questionId]: payload.answer });
        }
        return {
          ...block,
          status: "completed",
          question: payload.answer ? `${block.question ?? ""}\n\nAnswer: ${payload.answer}` : block.question,
          answers: payload.answer ? { ...(block.answers ?? {}), [block.questions?.[0]?.id ?? payload.blockId]: payload.answer } : block.answers
        };
      }
      if (block.kind === "status" && (payload.action === "retry" || payload.action === "retry_new_thread")) {
        this.retryCodexTurnForMessage(payload.messageId, payload.action === "retry_new_thread");
        return {
          ...block,
          level: "info",
          message: payload.action === "retry" ? "Retry requested." : "Retry in new thread requested."
        };
      }
      return block;
    });
    this.clearError();
    this.broadcast();
    return this.state();
  }

  private retryCodexTurnForMessage(messageId: string, freshThread: boolean): void {
    const state = this.store.loadState();
    const failedMessage = state.messages.find((message) => message.id === messageId);
    if (!failedMessage) {
      throw new Error("Cannot retry a missing Codex message.");
    }
    const thread = state.threads.find((item) => item.id === failedMessage.threadId);
    if (!thread) {
      throw new Error("Cannot retry a missing Codex thread.");
    }
    if (freshThread) {
      this.store.updateThreadSettings(thread.id, { codexLastSessionId: "" });
    }
    const lastUserMessage = [...state.messages].reverse().find((message) => message.threadId === thread.id && message.role === "user");
    if (!lastUserMessage) {
      throw new Error("Cannot retry without a user message.");
    }
    const assistantMessage = this.store.createMessage(thread.id, "assistant", "", "streaming", {
      label: state.codexModels.find((model) => model.id === thread.codexModelId)?.label ?? thread.codexModelId,
      sourceLabel: "Codex"
    });
    this.cancelRequested = false;
    this.generation = { status: "running", threadId: thread.id, assistantMessageId: assistantMessage.id };
    void this.runCodexGeneration({ threadId: thread.id, assistantMessageId: assistantMessage.id });
  }

  private requireProjectDirectory(projectId: string): { directory: string } {
    const project = this.store.loadState().projects.find((item) => item.id === projectId);
    if (!project?.directory) {
      throw new Error("Select a project directory before using git branch actions.");
    }
    return { directory: project.directory };
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

function localToCodexBlockReason(): string {
  return "Local to Codex is not yet supported in the same thread. You cannot send messages with Codex models in a thread that already used built-in/local models.";
}

function plannedLocalContextStart(messages: ChatState["messages"], currentStart: number, settings: ChatState["runtimeSettings"]): number {
  const budget = Math.max(512, settings.nCtx - Math.max(settings.trimReserveTokens, Math.floor(settings.nCtx * (settings.trimReservePercent / 100))));
  const trimmedBudget = Math.max(256, budget - Math.max(settings.trimAmountTokens, Math.floor(settings.nCtx * (settings.trimAmountPercent / 100))));
  let total = 0;
  for (let index = messages.length - 1; index >= currentStart; index -= 1) {
    total += estimatedMessageTokens(messages[index]);
    if (total > trimmedBudget) {
      return Math.min(messages.length, index + 1);
    }
  }
  return currentStart;
}

function estimatedMessageTokens(message: ChatState["messages"][number]): number {
  const textTokens = Math.ceil(`${message.role}\n${message.content}\n${message.reasoning ?? ""}`.length / 4);
  const attachmentTokens = message.attachments.reduce((total, attachment) => total + Math.ceil(`${attachment.name}\n${attachment.path}`.length / 4) + 64, 0);
  return Math.max(1, textTokens + attachmentTokens);
}

async function extractDocumentPages(sourcePath: string): Promise<string[]> {
  const resolvedPath = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`Document source does not exist: ${resolvedPath}`);
  }
  if (path.extname(resolvedPath).toLowerCase() === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(resolvedPath)) });
    try {
      const parsed = await parser.getText();
      const pages = parsed.pages.map((page) => page.text.trim()).filter(Boolean);
      return pages.length > 0 ? pages : splitExtractedPdfText(parsed.text.trim());
    } finally {
      await parser.destroy();
    }
  }
  return [fs.readFileSync(resolvedPath, "utf8")];
}

function splitExtractedPdfText(text: string): string[] {
  const pages = text.split(/\f/g).map((page) => page.trim()).filter(Boolean);
  if (pages.length > 1) {
    return pages;
  }
  return [text];
}

function chunkDocumentPages(sourcePath: string, pages: string[], startOrdinal: number): Array<Omit<ChatDocumentSearchEntry, "resultId" | "score">> {
  const chunks: Array<Omit<ChatDocumentSearchEntry, "resultId" | "score">> = [];
  for (const [pageIndex, page] of pages.entries()) {
    const paragraphs = page.split(/\n{2,}/g).map((item) => item.trim()).filter(Boolean);
    let buffer = "";
    for (const paragraph of paragraphs.length > 0 ? paragraphs : [page]) {
      const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (estimatedTextTokens(next) > 900 && buffer) {
        chunks.push(documentChunk(sourcePath, buffer, pageIndex + 1, startOrdinal + chunks.length));
        buffer = paragraph;
      } else {
        buffer = next;
      }
    }
    if (buffer.trim()) {
      chunks.push(documentChunk(sourcePath, buffer, pageIndex + 1, startOrdinal + chunks.length));
    }
  }
  return chunks;
}

function documentChunk(sourcePath: string, text: string, page: number, ordinal: number): Omit<ChatDocumentSearchEntry, "resultId" | "score"> {
  return {
    chunkId: `chat-doc-chunk-${randomUUID()}`,
    sourceTitle: path.basename(sourcePath) || "Document",
    sourcePath,
    pageStart: page,
    pageEnd: page,
    text,
    tokenCount: estimatedTextTokens(text),
    ordinalStart: ordinal,
    ordinalEnd: ordinal
  };
}

function estimatedTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function latestUserText(messages: ChatState["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index].content.trim();
    }
  }
  return "";
}

function withDocumentEvidence(messages: ChatState["messages"], documentTitle: string, evidence: ChatDocumentSearchEntry[]): ChatState["messages"] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) {
    return messages;
  }
  const evidenceText = formatDocumentSearchResults(evidence);
  return messages.map((message, index) => index === latestUserIndex
    ? {
      ...message,
      content: [
        `Selected document: ${documentTitle}`,
        "Use only the document evidence below when answering. Cite result ids like [r1] when they support a claim.",
        evidenceText,
        "User request:",
        message.content
      ].join("\n\n")
    }
    : message);
}

function formatDocumentSearchResults(evidence: ChatDocumentSearchEntry[]): string {
  if (evidence.length === 0) {
    return "No matching document evidence was found.";
  }
  return evidence.map((entry) => [
    [
      `[${entry.resultId}]`,
      entry.sourceId ? `source_id=${entry.sourceId}` : "",
      `source_path=${path.basename(entry.sourcePath) || entry.sourcePath || "(remote)"}`,
      `title=${entry.sourceTitle}`,
      `section=${entry.sectionLabel ?? `page ${entry.pageStart}${entry.pageEnd !== entry.pageStart ? `-${entry.pageEnd}` : ""}`}`,
      entry.candidateCount !== undefined ? `candidate_count=${entry.candidateCount}` : "",
      entry.truncated ? "truncated=true" : "truncated=false"
    ].filter(Boolean).join(" "),
    entry.text
  ].join("\n")).join("\n\n");
}

function remoteSearchEntriesToChat(result: RemoteDocumentSearchResult): ChatDocumentSearchEntry[] {
  const entries = Array.isArray(result.entries) ? result.entries : [];
  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    .map((entry, index) => ({
      chunkId: String(entry.chunk_id ?? entry.id ?? `remote-chunk-${index + 1}`),
      resultId: String(entry.result_id ?? `r${index + 1}`),
      sourceId: String(entry.source_id ?? entry.sourceId ?? entry.document_id ?? result.document_id ?? ""),
      sourceTitle: String(entry.source_title ?? entry.sourceTitle ?? "Remote document"),
      sourcePath: String(entry.source_path ?? entry.sourcePath ?? ""),
      sectionLabel: String(entry.section_label ?? entry.sectionLabel ?? ""),
      candidateCount: boundedInteger(entry.candidate_count ?? entry.candidateCount, 1, 0, 999999),
      truncated: Boolean(entry.truncated),
      pageStart: boundedInteger(entry.page_start ?? entry.pageStart, 1, 1, 999999),
      pageEnd: boundedInteger(entry.page_end ?? entry.pageEnd, Number(entry.page_start ?? entry.pageStart ?? 1) || 1, 1, 999999),
      text: String(entry.text ?? ""),
      tokenCount: boundedInteger(entry.token_count ?? entry.tokenCount, estimatedTextTokens(String(entry.text ?? "")), 1, 999999),
      score: Number(entry.score ?? 0),
      ordinalStart: boundedInteger(entry.ordinal_start ?? entry.ordinalStart, index, 0, 999999),
      ordinalEnd: boundedInteger(entry.ordinal_end ?? entry.ordinalEnd, index, 0, 999999)
    }))
    .filter((entry) => entry.text.trim());
}

function remoteResumeState(thread: ChatState["threads"][number], model: ChatModel, appSettings: ChatState["appSettings"], documentIndexId = ""): {
  remoteSessionId: string;
  remoteSlotId: number;
  remoteSettingsSignature: string;
} {
  const signature = builtinRuntimeSettingsSignature(thread, model, appSettings, documentIndexId);
  if (!thread.remoteSessionId || thread.remoteSettingsSignature !== signature || thread.remoteHostIdentity !== appSettings.remoteHostIdentity) {
    return { remoteSessionId: "", remoteSlotId: 0, remoteSettingsSignature: "" };
  }
  return {
    remoteSessionId: thread.remoteSessionId,
    remoteSlotId: thread.remoteSlotId,
    remoteSettingsSignature: signature
  };
}

function remoteMetricsToThreadSettings(
  thread: ChatState["threads"][number],
  model: ChatModel,
  appSettings: ChatState["appSettings"],
  metrics: RemoteStreamMetrics,
  documentIndexId = ""
): Partial<ChatState["threads"][number]> {
  return {
    remoteSessionId: metrics.remoteSessionId,
    remoteSlotId: metrics.remoteSlotId,
    remoteHostIdentity: metrics.remoteHostIdentity,
    remoteSettingsSignature: builtinRuntimeSettingsSignature(thread, model, appSettings, documentIndexId)
  };
}

function builtinRuntimeSettingsSignature(thread: ChatState["threads"][number], model: ChatModel, appSettings: ChatState["appSettings"], documentIndexId = ""): string {
  const settings = thread.runtimeSettings;
  return JSON.stringify({
    backend: "remote_builtin",
    modelId: model.id,
    modelReference: model.reference ?? "",
    remoteHostId: appSettings.remoteHostId,
    remoteHostIdentity: appSettings.remoteHostIdentity,
    documentIndexId,
    contextRevision: thread.contextRevision,
    activeContextStartMessageIndex: thread.activeContextStartMessageIndex,
    nCtx: settings.nCtx,
    nGpuLayers: settings.nGpuLayers,
    temperature: settings.temperature,
    repeatPenalty: settings.repeatPenalty,
    maxTokens: settings.maxTokens,
    reasoningEffort: settings.reasoningEffort,
    permissionMode: settings.permissionMode,
    systemPrompt: settings.systemPrompt
  });
}

function remoteAgentEventToTimelineBlock(value: unknown): ChatTimelineBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  const type = String(event.type ?? event.kind ?? "").trim();
  const id = String(event.id ?? event.event_id ?? `remote-event-${randomUUID()}`);
  if (type.includes("tool") || type.includes("search")) {
    return {
      kind: "tool",
      id,
      toolName: String(event.tool_name ?? event.tool ?? "remote_document_analysis"),
      status: String(event.status ?? "completed"),
      summary: String(event.summary ?? event.command ?? ""),
      output: typeof event.output === "string" ? event.output : typeof event.result === "string" ? event.result : undefined
    };
  }
  if (type.includes("plan")) {
    return { kind: "plan", id, status: String(event.status ?? "updated"), markdown: String(event.markdown ?? event.summary ?? "") };
  }
  if (type.includes("status")) {
    return { kind: "status", id, level: String(event.level ?? "info"), message: String(event.message ?? event.summary ?? "") };
  }
  return null;
}

type ParsedDocumentToolCall =
  | { status: "final" | "empty" }
  | { status: "malformed"; error: string }
  | { status: "tool_call"; tool: "search"; query: string; topK: number }
  | { status: "tool_call"; tool: "modify_results"; query: ""; topK: number; dropResultIds: string[]; expand: Array<{ resultId: string; before: number; after: number }> };

function parseDocumentToolCallResponse(content: string, reasoning: string): ParsedDocumentToolCall {
  const parsedContent = parseDocumentToolCall(content);
  if (parsedContent.status === "tool_call" || content.trim()) {
    return parsedContent;
  }
  const parsedReasoning = parseDocumentToolCall(reasoning);
  if (parsedReasoning.status === "tool_call" || parsedReasoning.status === "malformed") {
    return parsedReasoning;
  }
  return parsedContent;
}

function parseDocumentToolCall(text: string): ParsedDocumentToolCall {
  const normalized = text.trim();
  if (!normalized) {
    return { status: "empty" };
  }
  const match = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/u.exec(normalized);
  const jsonText = match ? match[1] : extractJsonObjectText(normalized);
  if (!jsonText) {
    return { status: "final" };
  }
  try {
    const payload = JSON.parse(jsonText) as Record<string, unknown>;
    const tool = String(payload.tool ?? "").trim();
    if (tool === "search") {
      const query = String(payload.query ?? "").trim().split(/\s+/).join(" ");
      if (!query) {
        return { status: "malformed", error: "Tool call query must be non-empty." };
      }
      return { status: "tool_call", tool: "search", query, topK: boundedInteger(payload.top_k, 8, 1, 12) };
    }
    if (tool === "modify_results") {
      const dropResultIds = Array.isArray(payload.drop_result_ids)
        ? payload.drop_result_ids.map((item) => String(item).trim()).filter(Boolean)
        : [];
      const expand = Array.isArray(payload.expand)
        ? payload.expand
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
          .map((item) => ({
            resultId: String(item.result_id ?? "").trim(),
            before: boundedInteger(item.before, 0, 0, 4),
            after: boundedInteger(item.after, 0, 0, 4)
          }))
          .filter((item) => item.resultId)
        : [];
      if (dropResultIds.length === 0 && expand.length === 0) {
        return { status: "malformed", error: "`modify_results` requires at least one drop or expand instruction." };
      }
      return { status: "tool_call", tool: "modify_results", query: "", topK: 8, dropResultIds, expand };
    }
    return { status: "malformed", error: "Only the `search` and `modify_results` tools are available." };
  } catch {
    return { status: "malformed", error: "Tool call JSON could not be parsed." };
  }
}

function extractJsonObjectText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : "";
}

function documentAnalysisRequiresSearchFirst(messages: ChatState["messages"]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    const content = message.content.trim();
    if (content.startsWith("Tool result:")) {
      return false;
    }
    if (content.startsWith("Grounding required:") || content.startsWith("Tool call error:")) {
      continue;
    }
    const normalized = content.toLowerCase();
    if (isDocumentAnalysisMetaQuestion(normalized)) {
      return false;
    }
    return Boolean(normalized && !["hi", "hello", "hey", "thanks", "thank you", "ok", "okay", "cool"].includes(normalized));
  }
  return false;
}

function isDocumentAnalysisMetaQuestion(text: string): boolean {
  return [
    "what tool",
    "which tool",
    "available tool",
    "system prompt",
    "how does this",
    "how do you",
    "framework",
    "capabilit",
    "document analysis mode",
    "what can you do"
  ].some((needle) => text.includes(needle));
}

function documentEvidenceBudget(settings: ChatState["runtimeSettings"], messages: ChatState["messages"] = [], documentTitle = ""): number {
  const promptOverhead = estimatedTextTokens([
    "Selected document:",
    documentTitle,
    "Use only the document evidence below when answering. Cite result ids like [r1] when they support a claim."
  ].join("\n"));
  const usedByMessages = messages.reduce((total, message) => total + estimatedMessageTokens(message), 0);
  const reservedForAnswer = Math.min(settings.maxTokens || settings.nCtx, Math.max(Math.floor(settings.nCtx * 0.12), 1024));
  const remaining = settings.nCtx - usedByMessages - promptOverhead - reservedForAnswer;
  return Math.max(0, Math.min(12000, remaining));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function syntheticChatMessage(role: "user" | "assistant", content: string): ChatState["messages"][number] {
  const now = new Date().toISOString();
  return {
    id: `synthetic-${randomUUID()}`,
    threadId: "",
    role,
    content,
    attachments: [],
    status: "complete",
    createdAt: now,
    updatedAt: now
  };
}

function prepareCodexImageAttachments(attachments: ChatAttachment[] = []): { imagePaths: string[]; cleanup: () => void } {
  const imagePaths: string[] = [];
  const tempDirs: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      throw new Error(`Codex does not support attachment kind: ${attachment.kind}`);
    }
    if (attachment.path) {
      if (!fs.existsSync(attachment.path)) {
        throw new Error(`Image attachment not found: ${attachment.path}`);
      }
      imagePaths.push(attachment.path);
      continue;
    }
    if (!attachment.dataUrl) {
      throw new Error(`Image attachment has no readable path: ${attachment.name}`);
    }
    const match = /^data:([^;,]+);base64,(.+)$/u.exec(attachment.dataUrl);
    if (!match) {
      throw new Error(`Image attachment is not a base64 data URL: ${attachment.name}`);
    }
    const extension = extensionForMimeType(match[1]);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), CODEX_ATTACHMENT_TEMP_PREFIX));
    tempDirs.push(tempDir);
    const filename = `${sanitizeAttachmentName(attachment.name) || "pasted-image"}${extension}`;
    const tempPath = path.join(tempDir, filename);
    fs.writeFileSync(tempPath, Buffer.from(match[2], "base64"));
    imagePaths.push(tempPath);
  }
  return {
    imagePaths,
    cleanup: () => {
      for (const tempDir of tempDirs) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  };
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "image/gif") {
    return ".gif";
  }
  return ".png";
}

function sanitizeAttachmentName(name: string): string {
  return path.parse(name).name.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/g, "");
}

function parseGitNumstat(value: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of value.split(/\r?\n/g)) {
    const [rawAdded, rawDeleted] = line.trim().split(/\s+/);
    const addedValue = Number.parseInt(rawAdded, 10);
    const deletedValue = Number.parseInt(rawDeleted, 10);
    if (Number.isFinite(addedValue)) {
      added += addedValue;
    }
    if (Number.isFinite(deletedValue)) {
      deleted += deletedValue;
    }
  }
  return { added, deleted };
}
