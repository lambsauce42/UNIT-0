import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolveBundledLlamaServerBinary } from "./localLlamaRuntime.js";

type EmbeddingServerKey = {
  modelPath: string;
  nCtx: number;
  nGpuLayers: number;
};

type ActiveEmbeddingServer = {
  key: EmbeddingServerKey;
  baseUrl: string;
  process: ChildProcess;
};

export interface DocumentEmbeddingRuntime {
  embedDocuments(options: { modelPath: string; texts: string[]; nCtx: number; nGpuLayers: number; onProgress?: (completed: number, total: number) => void }): Promise<number[][]>;
  embedQuery(options: { modelPath: string; text: string; nCtx: number; nGpuLayers: number }): Promise<number[]>;
  warm(options: { modelPath: string; nCtx: number; nGpuLayers: number; shouldCancel?: () => boolean }): Promise<void>;
  close(): void;
}

export class LocalEmbeddingRuntime implements DocumentEmbeddingRuntime {
  private activeServer: ActiveEmbeddingServer | null = null;
  private pendingServer: Promise<ActiveEmbeddingServer> | null = null;
  private pendingServerKey: EmbeddingServerKey | null = null;
  private startingProcess: ChildProcess | null = null;
  private serverGeneration = 0;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: { runtimeRoot?: string; binaryPath?: string; startupTimeoutMs?: number; fetchImpl?: typeof fetch; spawnImpl?: typeof spawn } = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 240_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async embedDocuments(options: { modelPath: string; texts: string[]; nCtx: number; nGpuLayers: number; onProgress?: (completed: number, total: number) => void }): Promise<number[][]> {
    const inputs = options.texts.map((text) => embeddingInput(options.modelPath, "document", text));
    const embeddings: number[][] = [];
    const batchSize = 16;
    for (let offset = 0; offset < inputs.length; offset += batchSize) {
      const batch = inputs.slice(offset, offset + batchSize);
      embeddings.push(...await this.embedBatch({ ...options, inputs: batch }));
      options.onProgress?.(Math.min(inputs.length, offset + batch.length), inputs.length);
    }
    return embeddings;
  }

  async embedQuery(options: { modelPath: string; text: string; nCtx: number; nGpuLayers: number }): Promise<number[]> {
    const [embedding] = await this.embedBatch({
      modelPath: options.modelPath,
      nCtx: options.nCtx,
      nGpuLayers: options.nGpuLayers,
      inputs: [embeddingInput(options.modelPath, "query", options.text)]
    });
    return embedding;
  }

  async warm(options: { modelPath: string; nCtx: number; nGpuLayers: number; shouldCancel?: () => boolean }): Promise<void> {
    if (options.shouldCancel?.()) {
      return;
    }
    await this.ensureServer(options.modelPath, options.nCtx, options.nGpuLayers);
    if (options.shouldCancel?.()) {
      return;
    }
  }

  close(): void {
    this.serverGeneration += 1;
    if (this.startingProcess && this.startingProcess.exitCode === null) {
      this.startingProcess.kill();
    }
    this.startingProcess = null;
    if (this.activeServer && this.activeServer.process.exitCode === null) {
      this.activeServer.process.kill();
    }
    this.activeServer = null;
    this.pendingServer = null;
    this.pendingServerKey = null;
  }

  private async embedBatch(options: { modelPath: string; inputs: string[]; nCtx: number; nGpuLayers: number }): Promise<number[][]> {
    const server = await this.ensureServer(options.modelPath, options.nCtx, options.nGpuLayers);
    const response = await this.fetchImpl(`${server.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "local-embedding", input: options.inputs })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Embedding request failed (${response.status}): ${body || response.statusText}`);
    }
    const parsed = await response.json() as { data?: Array<{ embedding?: unknown; index?: unknown }> };
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    const byIndex = new Map<number, number[]>();
    for (const [fallbackIndex, item] of data.entries()) {
      const vector = parseEmbeddingVector(item.embedding);
      byIndex.set(Number.isInteger(item.index) ? Number(item.index) : fallbackIndex, normalizeVector(vector));
    }
    return options.inputs.map((_, index) => {
      const vector = byIndex.get(index);
      if (!vector) {
        throw new Error("Embedding server returned an incomplete embedding response.");
      }
      return vector;
    });
  }

  private async ensureServer(modelPathValue: string, nCtx: number, nGpuLayers: number): Promise<ActiveEmbeddingServer> {
    const modelPath = path.resolve(modelPathValue);
    if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile()) {
      throw new Error(`Embedding model file not found: ${modelPath}`);
    }
    const key = { modelPath, nCtx, nGpuLayers };
    if (this.activeServer && embeddingServerKeyMatches(this.activeServer.key, key) && this.activeServer.process.exitCode === null) {
      return this.activeServer;
    }
    if (this.pendingServer && this.pendingServerKey && embeddingServerKeyMatches(this.pendingServerKey, key)) {
      return this.pendingServer;
    }
    this.close();
    const startGeneration = ++this.serverGeneration;
    this.pendingServerKey = key;
    this.pendingServer = this.startServer(key, startGeneration);
    try {
      this.activeServer = await this.pendingServer;
      return this.activeServer;
    } finally {
      if (this.pendingServerKey && embeddingServerKeyMatches(this.pendingServerKey, key)) {
        this.pendingServer = null;
        this.pendingServerKey = null;
      }
    }
  }

  private async startServer(key: EmbeddingServerKey, startGeneration: number): Promise<ActiveEmbeddingServer> {
    const binaryPath = this.options.binaryPath ? path.resolve(this.options.binaryPath) : resolveBundledLlamaServerBinary(this.options.runtimeRoot);
    if (!binaryPath) {
      throw new Error("Bundled llama-server binary was not found. Expected runtime/llama.cpp/llama-server(.exe).");
    }
    const port = await reserveLocalPort();
    this.assertCurrentServerGeneration(startGeneration);
    const command = buildEmbeddingServerCommand({ binaryPath, port, modelPath: key.modelPath, nCtx: key.nCtx, nGpuLayers: key.nGpuLayers });
    const process = this.spawnImpl(command.command, command.args, {
      cwd: command.cwd,
      windowsHide: true,
      stdio: "ignore"
    } as SpawnOptions);
    this.startingProcess = process;
    if (this.serverGeneration !== startGeneration) {
      if (process.exitCode === null) {
        process.kill();
      }
      throw new Error("Embedding llama-server startup was superseded.");
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    await this.waitUntilReady(process, baseUrl, binaryPath, startGeneration);
    if (this.startingProcess === process) {
      this.startingProcess = null;
    }
    if (this.serverGeneration !== startGeneration) {
      if (process.exitCode === null) {
        process.kill();
      }
      throw new Error("Embedding llama-server startup was superseded.");
    }
    return { key, baseUrl, process };
  }

  private async waitUntilReady(process: ChildProcess, baseUrl: string, binaryPath: string, startGeneration: number): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = "server did not become ready";
    let pollDelayMs = 100;
    while (Date.now() < deadline) {
      if (process.exitCode !== null) {
        throw new Error(`Embedding llama-server exited during startup with code ${process.exitCode}. Binary: ${binaryPath}`);
      }
      this.assertCurrentServerGeneration(startGeneration);
      try {
        const response = await this.fetchWithTimeout(`${baseUrl}/health`, 2_000);
        if (response.ok) {
          const body = await response.json().catch(() => ({})) as { status?: unknown };
          const status = String(body.status ?? "ok").toLowerCase();
          if (status && status !== "ok") {
            lastError = `health status ${status}`;
            await sleep(pollDelayMs);
            pollDelayMs = Math.min(500, Math.round(pollDelayMs * 1.35));
            continue;
          }
          return;
        }
        lastError = `${baseUrl}/health returned ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(pollDelayMs);
      pollDelayMs = Math.min(500, Math.round(pollDelayMs * 1.35));
    }
    throw new Error(`Embedding llama-server startup timed out: ${lastError}`);
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: abortController.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private assertCurrentServerGeneration(startGeneration: number): void {
    if (this.serverGeneration !== startGeneration) {
      throw new Error("Embedding llama-server startup was superseded.");
    }
  }
}

export function buildEmbeddingServerCommand(options: {
  binaryPath: string;
  port: number;
  modelPath: string;
  nCtx: number;
  nGpuLayers: number;
}): { command: string; cwd: string; args: string[] } {
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
      String(options.nCtx),
      "--ubatch-size",
      String(options.nCtx),
      "--n-gpu-layers",
      options.nGpuLayers < 0 ? "auto" : String(options.nGpuLayers),
      "--embedding",
      "--pooling",
      "mean",
      "-np",
      "1",
      "--no-webui"
    ]
  };
}

function embeddingInput(modelPath: string, role: "document" | "query", text: string): string {
  const normalizedPath = modelPath.toLowerCase();
  if (normalizedPath.includes("nomic-embed")) {
    return `${role === "document" ? "search_document" : "search_query"}: ${text}`;
  }
  if (normalizedPath.includes("e5")) {
    return `${role === "document" ? "passage" : "query"}: ${text}`;
  }
  return text;
}

function parseEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error("Embedding server returned a malformed embedding vector.");
  }
  const vector = value.map((item) => Number(item));
  if (vector.length === 0 || vector.some((item) => !Number.isFinite(item))) {
    throw new Error("Embedding server returned a malformed embedding vector.");
  }
  return vector;
}

function normalizeVector(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error("Embedding server returned an empty embedding vector.");
  }
  return vector.map((value) => value / norm);
}

function embeddingServerKeyMatches(a: EmbeddingServerKey, b: EmbeddingServerKey): boolean {
  return a.modelPath === b.modelPath && a.nCtx === b.nCtx && a.nGpuLayers === b.nGpuLayers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address?.port) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not reserve a local embedding server port.")));
      }
    });
    server.once("error", reject);
  });
}
