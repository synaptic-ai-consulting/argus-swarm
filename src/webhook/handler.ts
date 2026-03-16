import { loadConfig, getApiKey } from "../config.js";
import { validate } from "../validator/index.js";
import { addException } from "../review/store.js";
import { setTrust } from "../trust/store.js";
import { getAgentContext } from "../orchestrator/run-context.js";
import { listAgents } from "../api/client.js";
import { getJob, updateJob } from "../jobs/store.js";
import { setAgentFinishedAt } from "../agent-events/store.js";
import type { WebhookPayload } from "../api/types.js";

const TERMINAL_STATUSES = new Set(["FINISHED", "ERROR", "STOPPED"]);

async function checkJobCompletion(jobId: string, apiKey: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || job.status !== "running") return;

  const { agents } = await listAgents(apiKey, { limit: 100 });
  const jobAgentSet = new Set(job.agentIds);
  const jobAgents = agents.filter((a) => jobAgentSet.has(a.id));

  if (jobAgents.length === 0) return;

  const allTerminal = jobAgents.every((a) => TERMINAL_STATUSES.has(a.status));
  if (!allTerminal) return;

  const hasError = jobAgents.some((a) => a.status === "ERROR" || a.status === "STOPPED");
  const newStatus = hasError ? "error" : "finished";
  updateJob(jobId, { status: newStatus });
  console.log(`[argus] Job ${jobId} marked as ${newStatus} (all ${jobAgents.length} agents terminal)`);
}

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

  setAgentFinishedAt(payload.id, payload.timestamp ?? new Date().toISOString());

  if (ctx?.jobId) {
    try {
      await checkJobCompletion(ctx.jobId, apiKey);
    } catch (err) {
      console.error("[argus] Error checking job completion:", err);
    }
  }
}
