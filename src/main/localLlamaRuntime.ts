import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ChatMessage, ChatModel, ChatRuntimeSettings } from "../shared/types.js";

export class LocalLlamaRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalLlamaRuntimeError";
  }
}

export type LlamaServerCommand = {
  command: string;
  args: string[];
  cwd: string;
};

export type LocalLlamaRuntimeOptions = {
  binaryPath?: string;
  runtimeRoot?: string;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
};

type ServerKey = {
  modelPath: string;
  nCtx: number;
  nGpuLayers: number;
};

type ActiveServer = {
  key: ServerKey;
  baseUrl: string;
  modelId: string;
  process: ChildProcess;
};

export class LocalLlamaRuntime {
  private activeServer: ActiveServer | null = null;
  private activeAbortController: AbortController | null = null;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: LocalLlamaRuntimeOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 240_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async streamChat(
    options: {
      model: ChatModel;
      settings: ChatRuntimeSettings;
      messages: ChatMessage[];
      onToken: (token: string) => void;
    }
  ): Promise<void> {
    const server = await this.ensureServer(options.model, options.settings);
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    try {
      const response = await this.fetchImpl(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Accept": "text/event-stream",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: server.modelId,
          messages: options.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          stream: true,
          stream_options: { include_usage: true },
          temperature: options.settings.temperature,
          repeat_penalty: options.settings.repeatPenalty,
          max_tokens: options.settings.maxTokens
        }),
        signal: abortController.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LocalLlamaRuntimeError(`Bundled llama-server request failed (${response.status}): ${body || response.statusText}`);
      }
      if (!response.body) {
        throw new LocalLlamaRuntimeError("Bundled llama-server did not return a streaming response body.");
      }
      await readServerSentEvents(response.body, (payload) => {
        if (payload === "[DONE]") {
          return;
        }
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; thinking?: unknown } }>;
        };
        const delta = parsed.choices?.[0]?.delta ?? {};
        const content = extractText(delta.content);
        if (content) {
          options.onToken(content);
        }
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new LocalLlamaRuntimeError("Bundled llama-server request was cancelled.");
      }
      throw error;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  cancelActiveRequest(): void {
    this.activeAbortController?.abort();
  }

  close(): void {
    this.cancelActiveRequest();
    if (this.activeServer && this.activeServer.process.exitCode === null) {
      this.activeServer.process.kill();
    }
    this.activeServer = null;
  }

  private async ensureServer(model: ChatModel, settings: ChatRuntimeSettings): Promise<ActiveServer> {
    const modelPath = path.resolve(model.path);
    if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile()) {
      throw new LocalLlamaRuntimeError(`Model file not found: ${modelPath}`);
    }
    const key: ServerKey = {
      modelPath,
      nCtx: settings.nCtx,
      nGpuLayers: settings.nGpuLayers
    };
    if (this.activeServer && serverKeyMatches(this.activeServer.key, key) && this.activeServer.process.exitCode === null) {
      return this.activeServer;
    }
    this.close();
    const binaryPath = this.options.binaryPath ? path.resolve(this.options.binaryPath) : resolveBundledLlamaServerBinary(this.options.runtimeRoot);
    if (!binaryPath) {
      throw new LocalLlamaRuntimeError("Bundled llama-server binary was not found. Expected runtime/llama.cpp/llama-server(.exe).");
    }
    if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
      throw new LocalLlamaRuntimeError(`Bundled llama-server binary was not found: ${binaryPath}`);
    }
    const port = await reserveLocalPort();
    const command = buildLlamaServerCommand({
      binaryPath,
      port,
      modelPath,
      settings
    });
    const process = this.spawnImpl(command.command, command.args, {
      cwd: command.cwd,
      windowsHide: true,
      stdio: "ignore"
    } as SpawnOptions);
    const baseUrl = `http://127.0.0.1:${port}`;
    const modelId = await this.waitUntilReady(process, baseUrl, binaryPath);
    this.activeServer = { key, baseUrl, modelId, process };
    return this.activeServer;
  }

  private async waitUntilReady(process: ChildProcess, baseUrl: string, binaryPath: string): Promise<string> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = "server did not become ready";
    while (Date.now() < deadline) {
      if (process.exitCode !== null) {
        throw new LocalLlamaRuntimeError(`Bundled llama-server exited during startup with code ${process.exitCode}. Binary: ${binaryPath}`);
      }
      try {
        const health = await this.fetchJson(`${baseUrl}/health`, 2_000);
        const status = String((health as { status?: unknown }).status ?? "").toLowerCase();
        if (status && status !== "ok") {
          lastError = `health status ${status}`;
        }
        const models = await this.fetchJson(`${baseUrl}/v1/models`, 3_000);
        const data = (models as { data?: unknown }).data;
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
          const modelId = String((data[0] as { id?: unknown }).id ?? "").trim();
          if (modelId) {
            return modelId;
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(500);
    }
    throw new LocalLlamaRuntimeError(`Bundled llama-server startup timed out: ${lastError}`);
  }

  private async fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: abortController.signal });
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildLlamaServerCommand(options: {
  binaryPath: string;
  port: number;
  modelPath: string;
  settings: ChatRuntimeSettings;
}): LlamaServerCommand {
  return {
    command: options.binaryPath,
    cwd: path.dirname(options.binaryPath),
    args: [
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--model",
      options.modelPath,
      "--ctx-size",
      String(options.settings.nCtx),
      "--n-gpu-layers",
      options.settings.nGpuLayers < 0 ? "auto" : String(options.settings.nGpuLayers),
      "-np",
      "1"
    ]
  };
}

export function resolveBundledLlamaServerBinary(runtimeRoot?: string): string | null {
  const names = process.platform === "win32" ? ["llama-server.exe", "llama-server"] : ["llama-server", "llama-server.exe"];
  const roots = runtimeRoot
    ? [runtimeRoot]
    : [
        path.resolve(process.cwd()),
        path.resolve(__dirname, "../..")
      ];
  const seen = new Set<string>();
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (seen.has(resolvedRoot)) {
      continue;
    }
    seen.add(resolvedRoot);
    const bases = [
      path.join(resolvedRoot, "runtime", "llama.cpp"),
      path.join(resolvedRoot, "third_party", "llama.cpp", "build"),
      resolvedRoot
    ];
    for (const base of bases) {
      for (const name of names) {
        const direct = path.join(base, name);
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
          return direct;
        }
      }
    }
  }
  return null;
}

async function readServerSentEvents(body: ReadableStream<Uint8Array>, onPayload: (payload: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      onPayload(trimmed.slice(5).trim());
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    onPayload(tail.slice(5).trim());
  }
}

function serverKeyMatches(left: ServerKey, right: ServerKey): boolean {
  return left.modelPath === right.modelPath && left.nCtx === right.nCtx && left.nGpuLayers === right.nGpuLayers;
}

function extractText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local llama-server port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
