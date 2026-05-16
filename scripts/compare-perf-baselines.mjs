#!/usr/bin/env node
import fs from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("Usage: node scripts/compare-perf-baselines.mjs <before.jsonl> <after.jsonl>");
  process.exit(1);
}

const before = readRecords(beforePath);
const after = readRecords(afterPath);
const caseIds = [...new Set([...before.keys(), ...after.keys()])].sort();

for (const caseId of caseIds) {
  const beforeRows = before.get(caseId) ?? [];
  const afterRows = after.get(caseId) ?? [];
  console.log(`\n${caseId}`);
  if (beforeRows.length === 0 || afterRows.length === 0) {
    console.log(`  missing data: before=${beforeRows.length} after=${afterRows.length}`);
    continue;
  }
  const metricNames = [...new Set([
    ...beforeRows.flatMap((row) => Object.keys(row.metrics)),
    ...afterRows.flatMap((row) => Object.keys(row.metrics))
  ])].sort();
  for (const metricName of metricNames) {
    const beforeValues = numericMetric(beforeRows, metricName);
    const afterValues = numericMetric(afterRows, metricName);
    if (beforeValues.length === 0 || afterValues.length === 0) {
      continue;
    }
    const beforeMedian = median(beforeValues);
    const afterMedian = median(afterValues);
    const delta = afterMedian - beforeMedian;
    const pct = beforeMedian === 0 ? 0 : (delta / beforeMedian) * 100;
    console.log(`  ${metricName}: ${round(beforeMedian)} -> ${round(afterMedian)} (${formatSigned(round(delta))}, ${formatSigned(round(pct))}%)`);
  }
}

function readRecords(filePath) {
  const grouped = new Map();
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/g)) {
    if (!line.trim()) {
      continue;
    }
    const record = JSON.parse(line);
    const rows = grouped.get(record.caseId) ?? [];
    rows.push(record);
    grouped.set(record.caseId, rows);
  }
  return grouped;
}

function numericMetric(rows, metricName) {
  return rows
    .map((row) => row.metrics?.[metricName])
    .filter((value) => typeof value === "number" && Number.isFinite(value));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatSigned(value) {
  return value > 0 ? `+${value}` : String(value);
}
