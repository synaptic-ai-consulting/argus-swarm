import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ValidationResult } from "../validator/types.js";
import type { ValidationSnapshot } from "../validator/snapshot-store.js";

const STORE_DIR = ".argus";
const EXCEPTIONS_FILE = "exceptions.json";

export interface Exception {
  id: string;
  agentId: string;
  branchName?: string;
  prUrl?: string;
  confidence: number;
  checks: ValidationResult["checks"];
  decision: string;
  createdAt: string;
  resolved?: "approved" | "rejected";
  /** True for `/api/exceptions/test` — UI may label as demo-only. */
  synthetic?: boolean;
  /** Paper θ used for this exception (confidence bar vs gate). */
  reviewGate?: { reviewThreshold: number };
  /**
   * @deprecated Older rows; `autoApprove` was the prior name for θ — not trust τ.
   */
  trustThresholds?: {
    autoApprove: number;
    escalate: number;
    block: number;
  };
}

function getStorePath(): string {
  const base = process.env.ARGUS_STORE_DIR ?? process.cwd();
  return join(base, STORE_DIR);
}

function getExceptionsPath(): string {
  return join(getStorePath(), EXCEPTIONS_FILE);
}

function ensureStore(): void {
  const dir = getStorePath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadExceptions(): Exception[] {
  ensureStore();
  const path = getExceptionsPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function saveExceptions(exceptions: Exception[]): void {
  ensureStore();
  writeFileSync(getExceptionsPath(), JSON.stringify(exceptions, null, 2));
}

/** True when validator outcome should surface in the exception review queue. */
export function validatorNeedsHumanReview(decision: ValidationResult["decision"]): boolean {
  return (
    decision === "human_review" ||
    decision === "blocked" ||
    decision === "escalate" ||
    decision === "block"
  );
}

/**
 * Add a review exception when policy says human review (θ gate or blocked) and there is no unresolved row yet.
 * Idempotent per agent for the common case (duplicate webhooks or backfill + webhook).
 * @returns whether a new exception row was created.
 */
export function enqueueHumanReviewIfNeeded(result: ValidationResult, options?: { synthetic?: boolean }): boolean {
  if (!validatorNeedsHumanReview(result.decision)) return false;
  if (hasUnresolvedExceptionForAgent(result.agentId)) return false;
  addException(result, options);
  return true;
}

/**
 * If a validation snapshot says review is needed but exceptions.json has no open row (e.g. missed webhooks before backfill enqueued), add it on read.
 */
export function repairHumanReviewGapFromStoredSnapshot(
  snapshot: ValidationSnapshot | undefined,
  extras: { branchName?: string; prUrl?: string },
): boolean {
  if (!snapshot) return false;
  const result: ValidationResult = {
    agentId: snapshot.agentId,
    branchName: extras.branchName,
    prUrl: extras.prUrl,
    confidence: snapshot.confidence,
    checks: snapshot.checks,
    decision: snapshot.decision as ValidationResult["decision"],
    validationMode: snapshot.validationMode,
    fallbackReason: snapshot.fallbackReason,
    reviewGate: snapshot.reviewGate,
    trustThresholds: snapshot.trustThresholds,
  };
  return enqueueHumanReviewIfNeeded(result);
}

export function addException(result: ValidationResult, options?: { synthetic?: boolean }): Exception {
  const exceptions = loadExceptions();
  const ex: Exception = {
    id: `ex-${Date.now()}-${result.agentId.slice(-6)}`,
    agentId: result.agentId,
    branchName: result.branchName,
    prUrl: result.prUrl,
    confidence: result.confidence,
    checks: result.checks,
    decision: result.decision,
    createdAt: new Date().toISOString(),
  };
  if (result.reviewGate) ex.reviewGate = result.reviewGate;
  if (result.trustThresholds) ex.trustThresholds = result.trustThresholds as Exception["trustThresholds"];
  if (options?.synthetic) ex.synthetic = true;
  exceptions.push(ex);
  saveExceptions(exceptions);
  return ex;
}

export function listExceptions(pendingOnly = false): Exception[] {
  const exceptions = loadExceptions();
  if (pendingOnly) return exceptions.filter((e) => !e.resolved);
  return exceptions;
}

export function getException(id: string): Exception | undefined {
  return loadExceptions().find((e) => e.id === id);
}

export function hasUnresolvedExceptionForAgent(agentId: string): boolean {
  return loadExceptions().some((e) => e.agentId === agentId && !e.resolved);
}

export function resolveException(id: string, resolved: "approved" | "rejected"): boolean {
  const exceptions = loadExceptions();
  const idx = exceptions.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  exceptions[idx].resolved = resolved;
  saveExceptions(exceptions);
  return true;
}
