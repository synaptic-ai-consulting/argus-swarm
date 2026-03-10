import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const STORE_DIR = ".argus";
const METRICS_FILE = "metrics.json";

export interface RunMetrics {
  runId: string;
  intentFile: string;
  agentCount: number;
  startedAt: string;
  exceptions: number;
  autoApproved: number;
}

function getPath(): string {
  return join(process.cwd(), STORE_DIR, METRICS_FILE);
}

function ensureStore(): void {
  const dir = join(process.cwd(), STORE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): RunMetrics[] {
  ensureStore();
  const path = getPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

export function recordRun(metrics: RunMetrics): void {
  const all = load();
  all.push(metrics);
  writeFileSync(getPath(), JSON.stringify(all, null, 2));
}

export function getMetrics(): {
  totalRuns: number;
  totalAgents: number;
  exceptionRate: number;
  throughput: number;
} {
  const all = load();
  if (all.length === 0) {
    return { totalRuns: 0, totalAgents: 0, exceptionRate: 0, throughput: 0 };
  }
  const totalAgents = all.reduce((s, r) => s + r.agentCount, 0);
  const totalExceptions = all.reduce((s, r) => s + r.exceptions, 0);
  const totalOutputs = totalAgents;
  return {
    totalRuns: all.length,
    totalAgents,
    exceptionRate: totalOutputs > 0 ? totalExceptions / totalOutputs : 0,
    throughput: totalAgents,
  };
}
