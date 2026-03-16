import { launchAgent } from "../api/client.js";
import type { Config } from "../config.js";
import type { WorkPackage } from "../decomposer/types.js";
import { setAgentContext } from "./run-context.js";

export interface LaunchResult {
  agentId: string;
  branchName: string;
  workPackage: WorkPackage;
}

export async function launchSwarm(
  apiKey: string,
  config: Config,
  workPackages: WorkPackage[],
  webhookUrl?: string,
  jobId?: string,
): Promise<LaunchResult[]> {
  const repo = config.repository;
  if (!repo) {
    throw new Error("repository not configured in argus.config.yaml");
  }

  const results: LaunchResult[] = [];

  for (const pkg of workPackages) {
    const branchName = `argus/agent-${pkg.id}-${slugify(pkg.task)}`;
    const promptText = buildPrompt(pkg);

    const agent = await launchAgent(apiKey, {
      prompt: { text: promptText },
      source: { repository: repo, ref: config.defaultRef },
      target: {
        branchName,
        autoCreatePr: true,
      },
      ...(webhookUrl && {
        webhook: {
          url: webhookUrl,
          secret: config.webhookSecret,
        },
      }),
    });

    setAgentContext(agent.id, pkg.intent.intent, pkg.intent.constraints, jobId);

    results.push({
      agentId: agent.id,
      branchName,
      workPackage: pkg,
    });
  }

  return results;
}

function buildPrompt(pkg: WorkPackage): string {
  const constraints = pkg.constraints.join("\n- ");
  return `You are an AI coding agent in the ${pkg.role} role.

TASK: ${pkg.task}

CONSTRAINTS (must follow):
- ${constraints}

Complete the task and ensure all constraints are satisfied.`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}
