import { fetch } from "undici";
import type {
  Agent,
  AgentSource,
  AgentTarget,
  LaunchAgentRequest,
} from "./types.js";

const API_BASE = "https://api.cursor.com";

function getAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    apiKey: string;
  }
): Promise<T> {
  const { method = "GET", body, apiKey } = options;
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: getAuthHeader(apiKey),
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cursor API error ${res.status}: ${err}`);
  }

  return res.json() as Promise<T>;
}

export interface ListAgentsParams {
  limit?: number;
  cursor?: string;
  prUrl?: string;
}

export interface ListAgentsResponse {
  agents: Agent[];
  nextCursor?: string;
}

export async function listAgents(
  apiKey: string,
  params?: ListAgentsParams
): Promise<ListAgentsResponse> {
  const search = new URLSearchParams();
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.cursor) search.set("cursor", params.cursor);
  if (params?.prUrl) search.set("prUrl", params.prUrl);
  const qs = search.toString();
  return request<ListAgentsResponse>(
    `/v0/agents${qs ? `?${qs}` : ""}`,
    { apiKey }
  );
}

export async function getAgent(id: string, apiKey: string): Promise<Agent> {
  return request<Agent>(`/v0/agents/${id}`, { apiKey });
}

export async function launchAgent(
  apiKey: string,
  req: LaunchAgentRequest
): Promise<Agent> {
  return request<Agent>("/v0/agents", {
    method: "POST",
    body: req,
    apiKey,
  });
}

export async function stopAgent(id: string, apiKey: string): Promise<Agent> {
  return request<Agent>(`/v0/agents/${id}/stop`, {
    method: "POST",
    apiKey,
  });
}

export async function deleteAgent(id: string, apiKey: string): Promise<{ id: string }> {
  return request<{ id: string }>(`/v0/agents/${id}`, {
    method: "DELETE",
    apiKey,
  });
}

export async function addFollowUp(
  id: string,
  apiKey: string,
  prompt: { text: string }
): Promise<{ id: string }> {
  return request<{ id: string }>(`/v0/agents/${id}/followup`, {
    method: "POST",
    body: { prompt },
    apiKey,
  });
}
