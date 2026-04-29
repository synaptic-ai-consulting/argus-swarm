import { deleteAgentAllowMissing } from "../api/client.js";

export interface CursorDeleteFailure {
  id: string;
  error: string;
}

/** Best-effort parallel DELETE for each agent id in Cursor. */
export async function deleteCursorAgentsRemote(
  agentIds: string[],
  apiKey: string,
): Promise<{ failures: CursorDeleteFailure[] }> {
  if (agentIds.length === 0) return { failures: [] };

  const failures: CursorDeleteFailure[] = [];

  await Promise.all(
    agentIds.map(async (id) => {
      try {
        await deleteAgentAllowMissing(id, apiKey);
      } catch (e) {
        failures.push({ id, error: String(e) });
      }
    }),
  );

  return { failures };
}
