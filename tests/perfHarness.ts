import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type PerfRecord = {
  caseId: string;
  label: string;
  timestamp: string;
  metrics: Record<string, number | string | boolean | null>;
};

export function nowMs(): number {
  return performance.now();
}

export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function memorySnapshot(): { rss: number; heapUsed: number } {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed
  };
}

export function writePerfRecord(caseId: string, metrics: Record<string, number | string | boolean | null>): void {
  const outputPath = process.env.UNIT0_PERF_OUT?.trim();
  if (!outputPath) {
    return;
  }
  const record: PerfRecord = {
    caseId,
    label: process.env.UNIT0_PERF_LABEL?.trim() || "unspecified",
    timestamp: new Date().toISOString(),
    metrics
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`);
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
