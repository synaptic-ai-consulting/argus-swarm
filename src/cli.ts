#!/usr/bin/env node

import "dotenv/config";

import { randomBytes } from "node:crypto";
import { Command } from "commander";
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getApiKey } from "./config.js";
import { loadIntent } from "./intent/loader.js";
import { decompose } from "./decomposer/index.js";
import { launchSwarm } from "./orchestrator/index.js";
import { listAgents, getAgent, deleteAgent, addFollowUp } from "./api/client.js";
import { createWebhookServer } from "./webhook/server.js";
import { handleStatusChange } from "./webhook/handler.js";
import { startEmbeddedWebhook } from "./webhook/embedded.js";
import { listExceptions, resolveException, getException } from "./review/store.js";
import { getTrust } from "./trust/store.js";
import { createUiServer } from "./ui/server.js";
import { recordRun } from "./metrics/index.js";
import { cleanupArgusBranches } from "./cleanup/github.js";
import { startBlockedDetector } from "./oversight/blocked-detector.js";
import { createJob, getJob, listJobs } from "./jobs/store.js";

const program = new Command();

program
  .name("argus")
  .description("Adaptive Stigmergic Oversight for AI Agent Swarms")
  .version("0.1.0");

program
  .command("run <intent-file>")
  .description("Run an intent: decompose intent and launch agent swarm")
  .option("-r, --repo <url>", "Override repository URL")
  .option("--ref <branch>", "Base branch (default: main)")
  .option("-w, --webhook <url>", "Webhook URL for status notifications")
  .option("--no-tunnel", "Disable auto webhook tunnel (requires webhook URL in config)")
  .action(async (intentFile: string, opts: { repo?: string; ref?: string; webhook?: string; tunnel?: boolean }) => {
    const config = loadConfig();
    if (opts.repo) config.repository = opts.repo;
    if (opts.ref) config.defaultRef = opts.ref;
    if (opts.webhook) config.webhookUrl = opts.webhook;

    const apiKey = getApiKey(config);
    const intent = loadIntent(intentFile);
    const workPackages = decompose(intent);

    console.log(`Decomposed intent into ${workPackages.length} work packages:`);
    workPackages.forEach((p, i) => {
      console.log(`  ${i + 1}. [${p.role}] ${p.task.slice(0, 60)}...`);
    });

    let webhookUrl = opts.webhook ?? config.webhookUrl;
    let embedded: Awaited<ReturnType<typeof startEmbeddedWebhook>> | undefined;

    if (!webhookUrl && opts.tunnel !== false) {
      if (!config.webhookSecret || config.webhookSecret.length < 32) {
        config.webhookSecret = randomBytes(32).toString("hex");
      }
      console.log("Starting webhook server...");
      embedded = await startEmbeddedWebhook(config.webhookSecret);
      webhookUrl = embedded.webhookUrl;
      console.log(`Webhook URL: ${webhookUrl}`);
      console.log("(Press Ctrl+C to stop)");
    } else if (!webhookUrl) {
      console.log("No webhook URL. Set webhookUrl in config or use -w/--webhook.");
    } else if (webhookUrl && (!config.webhookSecret || config.webhookSecret.length < 32)) {
      config.webhookSecret = randomBytes(32).toString("hex");
    }

    const jobId = `job-${Date.now()}`;
    const results = await launchSwarm(apiKey, config, workPackages, webhookUrl, jobId);

    createJob(jobId, intent.intent, results.map((r) => r.agentId), workPackages, intentFile);

    recordRun({
      runId: jobId,
      intentFile,
      agentCount: results.length,
      startedAt: new Date().toISOString(),
      exceptions: 0,
      autoApproved: 0,
    });

    console.log("\nLaunched agents:");
    results.forEach((r) => {
      console.log(`  ${r.agentId} -> ${r.branchName}`);
    });

    const UI_PORT = 3848;
    const uiServer = createUiServer(UI_PORT);
    uiServer.listen(UI_PORT, "127.0.0.1", () => {
      console.log(`\nDashboard: http://localhost:${UI_PORT}`);
    });

    if (embedded) {
      const agentIds = results.map((r) => r.agentId);
      const stopBlockedDetector = startBlockedDetector(apiKey, agentIds, (err) =>
        console.error("[argus] Blocked detector error:", err)
      );

      const shutdown = async () => {
        console.log("\nShutting down...");
        stopBlockedDetector();
        await new Promise<void>((resolve) => {
          uiServer.close(() => resolve());
        });
        await embedded!.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Keep process alive; webhook server receives agent status callbacks
    } else {
      const shutdown = async () => {
        console.log("\nShutting down...");
        await new Promise<void>((resolve) => {
          uiServer.close(() => resolve());
        });
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
  });

const intentCmd = program.command("intent").description("Manage intent files");

intentCmd
  .command("list")
  .description("List available intent files")
  .action(() => {
    const intentsDir = join(process.cwd(), "intents");
    if (!existsSync(intentsDir)) {
      console.log("No intents directory found.");
      return;
    }
    const files = readdirSync(intentsDir).filter((f) => f.endsWith(".intent.yaml"));
    if (files.length === 0) {
      console.log("No intent files found in intents/");
      return;
    }
    console.log("Available intents:");
    files.forEach((f) => console.log(`  intents/${f}`));
  });

intentCmd
  .command("add <name>")
  .description("Create a new intent file from template")
  .action((name: string) => {
    const path = join(process.cwd(), "intents", `${name}.intent.yaml`);
    if (existsSync(path)) {
      console.error(`Intent already exists: ${path}`);
      process.exit(1);
    }
    const content = `# Intent: ${name}
intent: "Describe your high-level objective here"
constraints:
  - Constraint 1
  - Constraint 2
# Example intent (Layer 3 gate: compare validator confidence c to a single threshold θ)
intent: "Describe your high-level objective here"
constraints:
  - Constraint 1
  - Constraint 2
reviewThreshold: 0.85
# Legacy (still accepted): trustThresholds.autoApprove is read as θ if reviewThreshold is omitted.
# trustThresholds:
#   autoApprove: 0.85
`;
    const dir = join(process.cwd(), "intents");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content);
    console.log(`Created ${path}`);
  });

const agentsCmd = program.command("agents").description("Manage agents");

function toRepoKey(url: string): string {
  const u = url.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  const m = u.match(/github\.com[/:]([\w-]+\/[\w.-]+)/);
  return m ? m[1]! : u;
}

agentsCmd
  .command("list")
  .description("List agents (filtered by configured repository when set)")
  .option("-a, --all", "Show agents from all repositories")
  .option("--job <jobId>", "Only agents from an Argus job (uses .argus/jobs.json; always shows all job agents)")
  .action(async (opts: { all?: boolean; job?: string }) => {
    const config = loadConfig();
    const apiKey = getApiKey(config);

    if (opts.job) {
      const job = getJob(opts.job);
      if (!job) {
        console.error(`Unknown job: ${opts.job}. Use: npx argus jobs`);
        process.exit(1);
      }
      const agents: Awaited<ReturnType<typeof getAgent>>[] = [];
      for (const id of job.agentIds) {
        try {
          agents.push(await getAgent(id, apiKey));
        } catch {
          console.error(`  (could not load agent ${id} — it may have been deleted in Cursor)`);
        }
      }
      let filtered = agents;
      if (!opts.all && config.repository) {
        const configKey = toRepoKey(config.repository);
        filtered = agents.filter((a) => toRepoKey(a.source?.repository ?? "") === configKey);
      }
      if (filtered.length === 0) {
        console.log("No agents found for this job (or repo filter excluded all).");
        return;
      }
      console.log(`Agents for job ${opts.job} (${job.intentSummary.slice(0, 60)}…):`);
      filtered.forEach((a) => {
        console.log(`  ${a.id} [${a.status}] ${a.target?.branchName ?? "-"}`);
      });
      return;
    }

    const res = await listAgents(apiKey, { limit: 100 });
    let agents = res.agents;

    if (!opts.all && config.repository) {
      const configKey = toRepoKey(config.repository);
      agents = agents.filter((a) => {
        const src = a.source?.repository ?? "";
        return toRepoKey(src) === configKey;
      });
    }

    if (agents.length === 0) {
      console.log("No agents found.");
      return;
    }
    console.log("Agents (newest from Cursor API, max 100):");
    agents.forEach((a) => {
      console.log(`  ${a.id} [${a.status}] ${a.target?.branchName ?? "-"}`);
    });
  });

agentsCmd
  .command("delete <agent-id>")
  .description("Permanently remove a cloud agent record in Cursor (Git branches are unchanged; use argus cleanup for those)")
  .action(async (agentId: string) => {
    const config = loadConfig();
    const apiKey = getApiKey(config);
    await deleteAgent(agentId, apiKey);
    console.log(`Deleted cloud agent ${agentId}`);
  });

program
  .command("jobs")
  .description("List Argus jobs from .argus/jobs.json (for use with: npx argus agents list --job <id>)")
  .action(() => {
    const jobs = listJobs();
    if (jobs.length === 0) {
      console.log("No jobs recorded locally.");
      return;
    }
    console.log("Jobs (most recent last):");
    const sorted = [...jobs].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    sorted.forEach((j) => {
      console.log(
        `  ${j.jobId} [${j.status}] ${j.agentIds.length} agent(s)  ${j.createdAt}  ${j.intentSummary.slice(0, 50)}…`,
      );
    });
  });

program
  .command("webhook serve")
  .description("Start webhook server (use with ngrok for local testing)")
  .option("-p, --port <port>", "Port", "3847")
  .action(async (opts: { port: string }) => {
    const config = loadConfig();
    const port = parseInt(opts.port, 10);
    const path = "/webhook/cursor-agent";

    const server = createWebhookServer(
      path,
      config.webhookSecret,
      (payload) => void handleStatusChange(payload)
    );

    server.listen(port, () => {
      console.log(`Webhook server listening on http://localhost:${port}${path}`);
      console.log("Use ngrok to expose: ngrok http " + port);
    });
  });

const reviewCmd = program.command("review").description("Human review queue");

reviewCmd
  .command("list")
  .description("List exceptions pending review")
  .option("-a, --all", "Show all exceptions including resolved")
  .action((opts: { all?: boolean }) => {
    const exceptions = listExceptions(!opts.all);
    if (exceptions.length === 0) {
      console.log("No exceptions.");
      return;
    }
    console.log("Exceptions:");
    exceptions.forEach((e) => {
      const status = e.resolved ? `[${e.resolved}]` : "[pending]";
      console.log(`  ${e.id} ${status} agent=${e.agentId} confidence=${e.confidence.toFixed(2)}`);
    });
  });

reviewCmd
  .command("approve <id>")
  .description("Approve an exception")
  .action((id: string) => {
    if (resolveException(id, "approved")) {
      console.log(`Approved ${id}`);
    } else {
      console.error(`Exception ${id} not found`);
      process.exit(1);
    }
  });

reviewCmd
  .command("reject <id>")
  .description("Reject an exception")
  .action((id: string) => {
    if (resolveException(id, "rejected")) {
      console.log(`Rejected ${id}`);
    } else {
      console.error(`Exception ${id} not found`);
      process.exit(1);
    }
  });

reviewCmd
  .command("show <id>")
  .description("Show exception details")
  .action((id: string) => {
    const ex = getException(id);
    if (!ex) {
      console.error(`Exception ${id} not found`);
      process.exit(1);
    }
    console.log(JSON.stringify(ex, null, 2));
  });

reviewCmd
  .command("follow-up <id> <message...>")
  .description("Send a follow-up prompt to a blocked agent (e.g. unblock with guidance)")
  .action(async (id: string, messageParts: string[]) => {
    const ex = getException(id);
    if (!ex) {
      console.error(`Exception ${id} not found`);
      process.exit(1);
    }
    const message = messageParts.join(" ");
    if (!message) {
      console.error("Provide a follow-up message");
      process.exit(1);
    }
    const config = loadConfig();
    const apiKey = getApiKey(config);
    await addFollowUp(ex.agentId, apiKey, { text: message });
    console.log(`Follow-up sent to agent ${ex.agentId}`);
  });

program
  .command("ui")
  .description("Start minimal web UI for monitoring and human decisions")
  .option("-p, --port <port>", "Port", "3848")
  .action((opts: { port: string }) => {
    const port = parseInt(opts.port, 10);
    const server = createUiServer(port);
    server.listen(port, () => {
      console.log(`Argus UI: http://localhost:${port}`);
    });
  });

program
  .command("cleanup")
  .description("Delete argus/* branches from the configured repo (for re-running demos). Requires GITHUB_TOKEN.")
  .option("-r, --repo <url>", "Override repository URL")
  .option("--dry-run", "List branches that would be deleted without deleting")
  .action(async (opts: { repo?: string; dryRun?: boolean }) => {
    const config = loadConfig();
    const repo = opts.repo ?? config.repository;
    if (!repo) {
      console.error("No repository configured. Set repository in config or use -r/--repo.");
      process.exit(1);
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token && !opts.dryRun) {
      console.error("GITHUB_TOKEN env var required for cleanup. Set it or use --dry-run to list branches.");
      process.exit(1);
    }

    try {
      const result = await cleanupArgusBranches(repo, token, { dryRun: opts.dryRun });
      if (!opts.dryRun && (result.branchesDeleted > 0 || result.branchesFailed.length > 0)) {
        console.log(`Done. Deleted ${result.branchesDeleted}, failed: ${result.branchesFailed.length}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("trust show <agent-id>")
  .description("Show trust score for an agent")
  .action(async (agentId: string) => {
    const tau = await getTrust(agentId);
    if (tau === null) {
      console.log(`No trust record for ${agentId}`);
      return;
    }
    console.log(`Agent ${agentId}: τ = ${tau.toFixed(3)}`);
  });

program.parse();
