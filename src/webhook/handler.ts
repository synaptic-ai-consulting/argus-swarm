import { loadConfig, getApiKey } from "../config.js";
import { validate } from "../validator/index.js";
import { addException } from "../review/store.js";
import { setTrust } from "../trust/store.js";
import { getAgentContext } from "../orchestrator/run-context.js";
import type { WebhookPayload } from "../api/types.js";

export async function handleStatusChange(payload: WebhookPayload): Promise<void> {
  if (payload.status !== "FINISHED" && payload.status !== "ERROR") return;

  const config = loadConfig();
  let apiKey: string;
  try {
    apiKey = getApiKey(config);
  } catch {
    console.error("[argus] Cannot handle webhook: API key not configured");
    return;
  }

  const ctx = getAgentContext(payload.id);
  const result = await validate({
    apiKey,
    agentId: payload.id,
    intent: ctx?.intent,
    constraints: ctx?.constraints,
  });

  const outcomeQuality =
    result.decision === "auto_approve" ? 1 : result.decision === "escalate" ? 0.5 : 0;
  await setTrust(payload.id, result.confidence, outcomeQuality);

  if (result.decision === "escalate" || result.decision === "block") {
    addException(result);
    console.log(
      `[argus] Exception added: ${result.agentId} (confidence=${result.confidence.toFixed(2)}, decision=${result.decision})`
    );
  } else {
    console.log(
      `[argus] Auto-approved: ${result.agentId} (confidence=${result.confidence.toFixed(2)})`
    );
  }
}
