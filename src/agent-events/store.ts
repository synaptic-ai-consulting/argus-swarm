import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const STORE_DIR = ".argus";
const EVENTS_FILE = "agent-events.json";

interface AgentEvent {
  finishedAt?: string;
}

const events: Map<string, AgentEvent> = new Map();

function getPath(): string {
  return join(process.cwd(), STORE_DIR, EVENTS_FILE);
}

function load(): void {
  events.clear();
  const path = getPath();
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, AgentEvent>;
    Object.entries(data).forEach(([k, v]) => events.set(k, v));
  } catch {
    // ignore
  }
}

function save(): void {
  const dir = join(process.cwd(), STORE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const obj: Record<string, AgentEvent> = {};
  events.forEach((v, k) => (obj[k] = v));
  writeFileSync(getPath(), JSON.stringify(obj, null, 2));
}

export function setAgentFinishedAt(agentId: string, finishedAt: string): void {
  load();
  const existing = events.get(agentId) ?? {};
  events.set(agentId, { ...existing, finishedAt });
  save();
}

export function getAgentFinishedAt(agentId: string): string | undefined {
  load();
  return events.get(agentId)?.finishedAt;
}

export function removeAgentEvents(agentIds: string[]): void {
  if (agentIds.length === 0) return;
  load();
  let changed = false;
  for (const id of agentIds) {
    if (events.delete(id)) changed = true;
  }
  if (changed) save();
}
