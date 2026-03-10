import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const STORE_DIR = ".argus";
const CONTEXT_FILE = "run-context.json";

interface AgentContext {
  intent: string;
  constraints: string[];
}

const contexts: Map<string, AgentContext> = new Map();

function getPath(): string {
  return join(process.cwd(), STORE_DIR, CONTEXT_FILE);
}

function load(): void {
  contexts.clear();
  const path = getPath();
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, AgentContext>;
    Object.entries(data).forEach(([k, v]) => contexts.set(k, v));
  } catch {
    // ignore
  }
}

function save(): void {
  const dir = join(process.cwd(), STORE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const obj: Record<string, AgentContext> = {};
  contexts.forEach((v, k) => (obj[k] = v));
  writeFileSync(getPath(), JSON.stringify(obj, null, 2));
}

export function setAgentContext(agentId: string, intent: string, constraints: string[]): void {
  load();
  contexts.set(agentId, { intent, constraints });
  save();
}

export function getAgentContext(agentId: string): AgentContext | undefined {
  load();
  return contexts.get(agentId);
}

export function getAgentIds(): string[] {
  load();
  return Array.from(contexts.keys());
}
