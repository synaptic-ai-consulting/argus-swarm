import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ValidationResult } from "../validator/types.js";

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

export function addException(result: ValidationResult): Exception {
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

export function resolveException(id: string, resolved: "approved" | "rejected"): boolean {
  const exceptions = loadExceptions();
  const idx = exceptions.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  exceptions[idx].resolved = resolved;
  saveExceptions(exceptions);
  return true;
}
