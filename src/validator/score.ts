import type { Agent } from "../api/types.js";
import type { TrustThresholds } from "../intent/schema.js";
import type { ValidationResult } from "./types.js";

const DEFAULT_THRESHOLDS: TrustThresholds = {
  autoApprove: 0.85,
  escalate: 0.6,
  block: 0.4,
};

/**
 * Pure scoring logic: compute confidence and decision from agent data.
 * No API calls - used by validate() and by tests.
 */
export function computeValidationResult(
  agent: Pick<Agent, "id" | "status" | "summary" | "target">,
  options: {
    thresholds?: TrustThresholds;
    llmScore?: number | null;
  } = {}
): ValidationResult {
  const { thresholds = DEFAULT_THRESHOLDS, llmScore = null } = options;
  const checks: ValidationResult["checks"] = [];

  const hasSummary = !!agent.summary?.trim();
  checks.push({ name: "summary", passed: hasSummary, output: agent.summary });

  const statusOk = agent.status === "FINISHED";
  checks.push({ name: "status", passed: statusOk, output: agent.status });

  const hasPr = !!agent.target?.prUrl;
  checks.push({
    name: "pr_created",
    passed: hasPr,
    output: agent.target?.prUrl,
  });

  const deterministicScore =
    checks.filter((c) => c.passed).length / Math.max(checks.length, 1);

  if (llmScore !== null) {
    checks.push({
      name: "llm_assessment",
      passed: llmScore >= thresholds.escalate,
      output: String(llmScore),
    });
  }

  const confidence =
    llmScore !== null ? 0.6 * deterministicScore + 0.4 * llmScore : deterministicScore;

  let decision: ValidationResult["decision"];
  if (confidence >= thresholds.autoApprove) decision = "auto_approve";
  else if (confidence >= thresholds.escalate) decision = "escalate";
  else decision = "block";

  return {
    agentId: agent.id,
    branchName: agent.target?.branchName,
    prUrl: agent.target?.prUrl,
    confidence,
    checks,
    decision,
  };
}
