import type { AgentStatus } from "../api/types.js";
import { getAgentContext, resolveReviewThresholdFromStoredContext } from "../orchestrator/run-context.js";
import { getTrust, setTrust } from "../trust/store.js";
import { validate } from "./index.js";
import { enqueueHumanReviewIfNeeded } from "../review/store.js";
import { getValidationSnapshot, recordValidationSnapshot } from "./snapshot-store.js";

/** Dedupe concurrent backfills per agent ID. */
const inFlight = new Map<string, Promise<void>>();

/** Cooldown after a failed attempt so polls do not hammer Cursor/GitHub every 2–5 s. */
const lastBackfillFailMs = new Map<string, number>();
const BACKFILL_RETRY_MS = 60_000;

function isTerminal(status: AgentStatus): boolean {
  return status === "FINISHED" || status === "ERROR" || status === "STOPPED";
}

/**
 * If there is no stored snapshot yet (typically Cursor webhooks missed us), validate once on read path
 * so dashboards still show scores and checker evidence after job completion.
 */
export async function ensureValidationSnapshotBackfill(agentId: string, status: AgentStatus, apiKey: string): Promise<void> {
  if (!isTerminal(status)) return;
  if (getValidationSnapshot(agentId)) return;

  const lf = lastBackfillFailMs.get(agentId);
  if (lf != null && Date.now() - lf < BACKFILL_RETRY_MS) return;

  let p = inFlight.get(agentId);
  if (p) {
    await p;
    return;
  }

  p = (async () => {
    try {
      const ctx = getAgentContext(agentId);
      const result = await validate({
        apiKey,
        agentId,
        intent: ctx?.intent,
        constraints: ctx?.constraints,
        reviewThreshold: resolveReviewThresholdFromStoredContext(ctx),
      });
      recordValidationSnapshot(result);

      enqueueHumanReviewIfNeeded(result);

      const tau = await getTrust(agentId);
      if (tau === null) {
        const outcomeQuality =
          result.decision === "auto_approve"
            ? 1
            : result.decision === "human_review" || result.decision === "escalate"
              ? 0.5
              : result.decision === "blocked"
                ? 0
                : 0;
        await setTrust(agentId, result.confidence, outcomeQuality);
      }
      lastBackfillFailMs.delete(agentId);
    } catch (e) {
      lastBackfillFailMs.set(agentId, Date.now());
      console.error(`[argus] Validation backfill failed for ${agentId}:`, e);
    }
  })();

  inFlight.set(agentId, p);
  try {
    await p;
  } finally {
    inFlight.delete(agentId);
  }
}
