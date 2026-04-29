/** P0.1: whether GitHub Checks supplied real CI signals or we fell back to metadata-only. */
export type ValidationMode = "github_checks" | "metadata_fallback";

/** Snapshot of θ used for this validation (paper: single confidence gate). */
export interface ReviewGateSnapshot {
  reviewThreshold: number;
}

export interface ValidationResult {
  agentId: string;
  branchName?: string;
  prUrl?: string;
  confidence: number;
  checks: CheckResult[];
  /** Paper binary gate; `escalate` / `block` may appear on older persisted snapshots. */
  decision: "auto_approve" | "human_review" | "blocked" | "escalate" | "block";
  /** Set when P0.1 used GitHub API or cap path; omitted for direct unit tests. */
  validationMode?: ValidationMode;
  /** Human-readable, when in metadata_fallback. */
  fallbackReason?: string;
  /** θ used for this run (UI confidence bar vs gate). */
  reviewGate?: ReviewGateSnapshot;
  /**
   * @deprecated Old persisted payloads only; prefer `reviewGate`.
   */
  trustThresholds?: { autoApprove?: number; escalate?: number; block?: number };
}

export interface CheckResult {
  name: string;
  passed: boolean;
  output?: string;
}
