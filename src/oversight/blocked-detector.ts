import { getAgent } from "../api/client.js";
import { addException, hasUnresolvedExceptionForAgent } from "../review/store.js";
import { getAgentContext, resolveReviewThresholdFromStoredContext } from "../orchestrator/run-context.js";
import type { Agent } from "../api/types.js";
import type { ValidationResult } from "../validator/types.js";
import { recordValidationSnapshot } from "../validator/snapshot-store.js";

const BLOCKED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Check if an agent appears blocked: RUNNING for > threshold with no branch/PR.
 * Blocked agents typically can't create output (e.g. empty repo, missing deps).
 */
function isBlocked(agent: Agent): boolean {
  if (agent.status !== "RUNNING") return false;
  const hasOutput = !!(agent.target?.branchName || agent.target?.prUrl);
  if (hasOutput) return false;

  const createdAt = new Date(agent.createdAt).getTime();
  const elapsed = Date.now() - createdAt;
  return elapsed >= BLOCKED_THRESHOLD_MS;
}

/**
 * Create a ValidationResult for a blocked agent (no branch/PR, needs human intervention).
 */
function toBlockedResult(agent: Agent): ValidationResult {
  const ctx = getAgentContext(agent.id);
  const reviewThreshold = resolveReviewThresholdFromStoredContext(ctx);
  return {
    agentId: agent.id,
    branchName: agent.target?.branchName,
    prUrl: agent.target?.prUrl,
    confidence: 0,
    checks: [
      { name: "blocked", passed: false, output: "Agent RUNNING with no branch/PR after 5+ min" },
      { name: "summary", passed: !!agent.summary?.trim(), output: agent.summary },
    ],
    decision: "blocked",
    reviewGate: { reviewThreshold },
  };
}

/**
 * Poll agents and add exceptions for any that appear blocked.
 * Call periodically while argus run is active.
 */
export async function detectBlockedAgents(
  apiKey: string,
  agentIds: string[],
  seenBlocked: Set<string>,
): Promise<void> {
  for (const id of agentIds) {
    if (seenBlocked.has(id) || hasUnresolvedExceptionForAgent(id)) continue;

    let agent: Agent;
    try {
      agent = await getAgent(id, apiKey);
    } catch {
      continue;
    }

    if (!isBlocked(agent)) continue;

    seenBlocked.add(id);
    const result = toBlockedResult(agent);
    recordValidationSnapshot(result);
    addException(result);
    console.log(
      `[argus] Blocked agent detected: ${agent.id} (${agent.name ?? "unnamed"}) — no branch/PR after 5+ min. Added to review queue.`,
    );
  }
}

/**
 * Start periodic blocked-agent detection. Returns a stop function.
 */
export function startBlockedDetector(
  apiKey: string,
  agentIds: string[],
  onError?: (err: unknown) => void,
): () => void {
  const seenBlocked = new Set<string>();
  const interval = setInterval(async () => {
    try {
      await detectBlockedAgents(apiKey, agentIds, seenBlocked);
    } catch (err) {
      onError?.(err);
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}
