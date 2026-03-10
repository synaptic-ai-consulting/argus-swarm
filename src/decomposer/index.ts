import { randomUUID } from "node:crypto";
import type { Intent } from "../intent/schema.js";
import type { WorkPackage } from "./types.js";

const MVP_AGENT_COUNT = 5;

/**
 * Rule-based decomposer for MVP.
 * Splits intent into N work packages with Explorer, Worker, Validator roles.
 */
export function decompose(intent: Intent, maxPackages = MVP_AGENT_COUNT): WorkPackage[] {
  const baseTask = intent.intent;
  const constraints = intent.constraints;

  // Heuristic: split by common software dev sub-tasks
  const subTasks = inferSubTasks(baseTask, constraints);

  const packages: WorkPackage[] = [];
  const roles: WorkPackage["role"][] = ["Explorer", "Worker", "Worker", "Worker", "Validator"];

  for (let i = 0; i < Math.min(maxPackages, Math.max(subTasks.length, 1)); i++) {
    const task = subTasks[i] ?? baseTask;
    packages.push({
      id: randomUUID().slice(0, 8),
      task,
      role: roles[i] ?? "Worker",
      constraints: [...constraints],
      intent,
    });
  }

  return packages;
}

function inferSubTasks(mainTask: string, constraints: string[]): string[] {
  const lower = mainTask.toLowerCase();

  const tasks: string[] = [];

  if (lower.includes("oauth") || lower.includes("authentication")) {
    tasks.push(
      "Set up OAuth2 configuration and provider endpoints (Google, GitHub)",
      "Implement OAuth2 callback handlers and token exchange",
      "Add session management and protected route middleware",
      "Write unit tests for auth flows (target 90%+ coverage)",
      "Generate OpenAPI documentation for auth endpoints"
    );
  } else if (lower.includes("api") || lower.includes("endpoint")) {
    tasks.push(
      "Design and implement API structure",
      "Add request validation and error handling",
      "Write integration tests",
      "Add API documentation"
    );
  } else {
    tasks.push(mainTask);
  }

  return tasks;
}
