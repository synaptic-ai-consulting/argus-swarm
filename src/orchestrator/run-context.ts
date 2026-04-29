import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REVIEW_THRESHOLD } from "../intent/schema.js";

const STORE_DIR = ".argus";
const CONTEXT_FILE = "run-context.json";

/** Stored when a job launches. θ gates merge confidence; τ stays out-of-band on the trust store. */
export interface AgentContext {
  intent: string;
  constraints: string[];
  jobId?: string;
  /** Paper θ snapshot at launch. */
  reviewThreshold?: number;
  /** @deprecated Legacy field from older snapshots; θ was `autoApprove`; not used as trust τ for the gate. */
  trustThresholds?: { autoApprove?: number; escalate?: number; block?: number };
}

const contexts: Map<string, AgentContext> = new Map();

/** Resolve θ for validation from persisted run context (prefer `reviewThreshold`, then legacy triple). */
export function resolveReviewThresholdFromStoredContext(ctx: AgentContext | undefined): number {
  if (!ctx) return DEFAULT_REVIEW_THRESHOLD;
  if (ctx.reviewThreshold != null && !Number.isNaN(ctx.reviewThreshold)) return ctx.reviewThreshold;
  const legacy = ctx.trustThresholds?.autoApprove;
  if (legacy != null && !Number.isNaN(legacy)) return legacy;
  return DEFAULT_REVIEW_THRESHOLD;
}

function getPath(): string {
  return join(process.cwd(), STORE_DIR, CONTEXT_FILE);
}

function load(): void {
  contexts.clear();
  const path = getPath();
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, AgentContext>;
    Object.entries(data).forEach(([k, v]) => contexts.set(k, v));
  } catch {
    // ignore
  }
}

function save(): void {
  const dir = join(process.cwd(), STORE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const obj: Record<string, AgentContext> = {};
  contexts.forEach((v, k) => (obj[k] = v));
  writeFileSync(getPath(), JSON.stringify(obj, null, 2));
}

export function setAgentContext(
  agentId: string,
  intent: string,
  constraints: string[],
  jobId?: string,
  reviewThreshold?: number,
): void {
  load();
  const entry: AgentContext = {
    intent,
    constraints,
    jobId,
    ...(reviewThreshold != null ? { reviewThreshold } : {}),
  };
  contexts.set(agentId, entry);
  save();
}

export function getAgentContext(agentId: string): AgentContext | undefined {
  load();
  return contexts.get(agentId);
}

export function getAgentIds(): string[] {
  load();
  return Array.from(contexts.keys());
}

export function getAgentIdsByJob(jobId: string): string[] {
  load();
  const ids: string[] = [];
  contexts.forEach((ctx, id) => {
    if (ctx.jobId === jobId) ids.push(id);
  });
  return ids;
}

export function removeAgentContexts(agentIds: string[]): void {
  if (agentIds.length === 0) return;
  load();
  let changed = false;
  for (const id of agentIds) {
    if (contexts.delete(id)) changed = true;
  }
  if (changed) save();
}
