import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationResult } from "./types.js";

const STORE_DIR = ".argus";
const FILE = "validation-snapshots.json";

const MAX_OUTPUT_LEN = 480;

export interface ValidationSnapshot {
  agentId: string;
  validatedAt: string;
  confidence: number;
  decision: string;
  validationMode?: ValidationResult["validationMode"];
  fallbackReason?: string;
  /** Paper θ captured for this run. */
  reviewGate?: ValidationResult["reviewGate"];
  /**
   * @deprecated Legacy persisted field; omitted for new snapshots.
   */
  trustThresholds?: ValidationResult["trustThresholds"];
  checks: Array<{ name: string; passed: boolean; output?: string }>;
}

function path(): string {
  return join(process.cwd(), STORE_DIR, FILE);
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_LEN) return s;
  return `${s.slice(0, MAX_OUTPUT_LEN)}…`;
}

function loadAll(): Record<string, ValidationSnapshot> {
  const p = path();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, ValidationSnapshot>;
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, ValidationSnapshot>): void {
  const dir = join(process.cwd(), STORE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path(), JSON.stringify(data, null, 2));
}

/**
 * Persist the latest validator output for an agent (happy path and exceptions).
 * Used by the Control Hub to show confidence + check evidence per agent.
 */
export function recordValidationSnapshot(result: ValidationResult): void {
  const data = loadAll();
  const checks = result.checks.map((c) => ({
    name: c.name,
    passed: c.passed,
    output: c.output != null ? truncate(String(c.output)) : undefined,
  }));
  const snap: ValidationSnapshot = {
    agentId: result.agentId,
    validatedAt: new Date().toISOString(),
    confidence: result.confidence,
    decision: result.decision,
    validationMode: result.validationMode,
    fallbackReason: result.fallbackReason,
    reviewGate: result.reviewGate,
    checks,
  };
  if (result.trustThresholds) snap.trustThresholds = result.trustThresholds;
  data[result.agentId] = snap;
  saveAll(data);
}

export function getValidationSnapshot(agentId: string): ValidationSnapshot | undefined {
  return loadAll()[agentId];
}

/** For tests — reset persisted file in temp dirs. */
export function clearValidationSnapshotsForTesting(): void {
  try {
    if (existsSync(path())) writeFileSync(path(), "{}");
  } catch {
    /* ignore */
  }
}
