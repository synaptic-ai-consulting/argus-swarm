import { getAgent } from "../api/client.js";
import { DEFAULT_REVIEW_THRESHOLD } from "../intent/schema.js";
import type { ValidationResult } from "./types.js";
import { computeValidationResult } from "./score.js";
import { llmAssess } from "./llm-assess.js";
import { runGithubValidationChecks, collectPrUrl } from "./checks/index.js";

export interface ValidateOptions {
  apiKey: string;
  agentId: string;
  /** Defaults to `process.env.GITHUB_TOKEN`. */
  githubToken?: string;
  /** Paper θ; defaults to 0.85. */
  reviewThreshold?: number;
  intent?: string;
  constraints?: string[];
}

export { computeValidationResult, METADATA_ONLY_CONFIDENCE_CAP, type ComputeScoreOptions } from "./score.js";

/**
 * Validation pipeline: fetch agent, optional GitHub Checks, optional LLM assessment, then score.
 */
export async function validate(options: ValidateOptions): Promise<ValidationResult> {
  const { apiKey, agentId, reviewThreshold = DEFAULT_REVIEW_THRESHOLD } = options;

  const agent = await getAgent(agentId, apiKey);

  let llmScore: number | null = null;
  if (options.intent && options.constraints) {
    llmScore = await llmAssess(
      agent.summary ?? "",
      options.intent,
      options.constraints,
    );
  }

  const token = options.githubToken ?? process.env.GITHUB_TOKEN;
  const gh = await runGithubValidationChecks(collectPrUrl(agent), token);

  return computeValidationResult(agent, {
    reviewThreshold,
    llmScore,
    extraChecks: gh.checks,
    useConfidenceCap: gh.useConfidenceCap,
    validationMode: gh.mode,
    fallbackReason: gh.fallbackReason,
  });
}
