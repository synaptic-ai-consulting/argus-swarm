import type { Intent } from "../intent/schema.js";

export type AgentRole = "Explorer" | "Worker" | "Validator";

export interface WorkPackage {
  id: string;
  task: string;
  role: AgentRole;
  constraints: string[];
  intent: Intent;
}
