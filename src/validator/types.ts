export interface ValidationResult {
  agentId: string;
  branchName?: string;
  prUrl?: string;
  confidence: number;
  checks: CheckResult[];
  decision: "auto_approve" | "escalate" | "block";
}

export interface CheckResult {
  name: string;
  passed: boolean;
  output?: string;
}
