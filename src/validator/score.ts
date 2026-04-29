import type { Agent } from "../api/types.js";
import { DEFAULT_REVIEW_THRESHOLD } from "../intent/schema.js";
import type { CheckResult, ValidationMode, ValidationResult } from "./types.js";

/** Roadmap: cap when GitHub CI signals are unavailable (metadata + optional LLM only). */
export const METADATA_ONLY_CONFIDENCE_CAP = 0.7;

export interface ComputeScoreOptions {
  /** Paper θ — confidence ≥ reviewThreshold ⇒ auto_approve. Default 0.85 */
  reviewThreshold?: number;
  llmScore?: number | null;
  /** GitHub / CI checks from `runGithubValidationChecks` (or empty). */
  extraChecks?: CheckResult[];
  /** When true, cap final confidence with {@link METADATA_ONLY_CONFIDENCE_CAP}. */
  useConfidenceCap?: boolean;
  validationMode?: ValidationMode;
  fallbackReason?: string;
}

/**
 * Pure scoring logic: compute confidence and decision from agent data.
 * No API calls - used by validate() and by tests.
 */
export function computeValidationResult(
  agent: Pick<Agent, "id" | "status" | "summary" | "target">,
  options: ComputeScoreOptions = {},
): ValidationResult {
  const {
    reviewThreshold = DEFAULT_REVIEW_THRESHOLD,
    llmScore = null,
    extraChecks = [],
    useConfidenceCap = false,
    validationMode,
    fallbackReason,
  } = options;

  const checks: CheckResult[] = [];

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

  checks.push(...extraChecks);

  if (llmScore !== null) {
    checks.push({
      name: "llm_assessment",
      passed: llmScore >= reviewThreshold,
      output: String(llmScore),
    });
  }

  const deterministicScore =
    checks.filter((c) => c.passed).length / Math.max(checks.length, 1);

  const confidenceBase =
    llmScore !== null
      ? 0.6 * deterministicScore + 0.4 * llmScore
      : deterministicScore;

  let confidence = confidenceBase;
  if (useConfidenceCap) {
    confidence = Math.min(confidence, METADATA_ONLY_CONFIDENCE_CAP);
  }

  let decision: ValidationResult["decision"] =
    confidence >= reviewThreshold ? "auto_approve" : "human_review";

  const securityCheck = checks.find((c) => c.name === "security_passed");
  if (securityCheck && !securityCheck.passed && decision === "auto_approve") {
    decision = "human_review";
  }

  return {
    agentId: agent.id,
    branchName: agent.target?.branchName,
    prUrl: agent.target?.prUrl,
    confidence,
    checks,
    decision,
    validationMode,
    fallbackReason,
    reviewGate: { reviewThreshold },
  };
}
