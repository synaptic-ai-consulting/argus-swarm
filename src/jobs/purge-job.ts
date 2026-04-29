import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeAgentEvents } from "../agent-events/store.js";
import { removeRunsWithRunId } from "../metrics/index.js";
import { getAgentIdsByJob, removeAgentContexts } from "../orchestrator/run-context.js";
import { removeExceptionsForAgentIds } from "../review/store.js";
import { deleteTrustForAgents } from "../trust/store.js";
import { deleteJob, getJob } from "./store.js";

const VALIDATION_SNAPSHOTS = join(process.cwd(), ".argus", "validation-snapshots.json");

function removeValidationSnapshotEntries(agentIds: string[]): void {
  if (agentIds.length === 0 || !existsSync(VALIDATION_SNAPSHOTS)) return;
  try {
    const data = JSON.parse(readFileSync(VALIDATION_SNAPSHOTS, "utf-8")) as Record<string, unknown>;
    let changed = false;
    for (const id of agentIds) {
      if (data[id] !== undefined) {
        delete data[id];
        changed = true;
      }
    }
    if (changed) writeFileSync(VALIDATION_SNAPSHOTS, JSON.stringify(data, null, 2));
  } catch {
    /* ignore corrupt snapshot file */
  }
}

/**
 * Remove a job and all Argus-local rows for its agents (trust DB, run context,
 * agent events, exceptions, metrics run entry). Does not call the Cursor API.
 */
export async function purgeJobFromArgusStore(jobId: string): Promise<{ removedAgentIds: string[] } | null> {
  const job = getJob(jobId);
  if (!job) return null;

  const idSet = new Set<string>([...job.agentIds, ...getAgentIdsByJob(jobId)]);
  const removedAgentIds = [...idSet];

  removeExceptionsForAgentIds(idSet);
  removeAgentContexts(removedAgentIds);
  removeAgentEvents(removedAgentIds);
  removeValidationSnapshotEntries(removedAgentIds);
  await deleteTrustForAgents(removedAgentIds);
  removeRunsWithRunId(jobId);
  deleteJob(jobId);

  return { removedAgentIds };
}
