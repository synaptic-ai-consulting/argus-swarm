import { getAgent } from "../api/client.js";
import type { TrustThresholds } from "../intent/schema.js";
import type { ValidationResult } from "./types.js";
import { computeValidationResult } from "./score.js";
import { llmAssess } from "./llm-assess.js";

const DEFAULT_THRESHOLDS: TrustThresholds = {
  autoApprove: 0.85,
  escalate: 0.6,
  block: 0.4,
};

export interface ValidateOptions {
  apiKey: string;
  agentId: string;
  thresholds?: TrustThresholds;
  intent?: string;
  constraints?: string[];
}

export { computeValidationResult };

/**
 * Validation pipeline: fetch agent, optional LLM assessment, then score.
 */
export async function validate(options: ValidateOptions): Promise<ValidationResult> {
  const { apiKey, agentId, thresholds = DEFAULT_THRESHOLDS } = options;

  const agent = await getAgent(agentId, apiKey);

  let llmScore: number | null = null;
  if (options.intent && options.constraints) {
    llmScore = await llmAssess(
      agent.summary ?? "",
      options.intent,
      options.constraints
    );
  }

  return computeValidationResult(agent, { thresholds, llmScore });
}
