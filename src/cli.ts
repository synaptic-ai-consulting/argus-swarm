#!/usr/bin/env node

import "dotenv/config";

import { Command } from "commander";
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getApiKey } from "./config.js";
import { loadIntent } from "./intent/loader.js";
import { decompose } from "./decomposer/index.js";
import { launchSwarm } from "./orchestrator/index.js";
import { listAgents } from "./api/client.js";
import { createWebhookServer } from "./webhook/server.js";
import { handleStatusChange } from "./webhook/handler.js";
import { listExceptions, resolveException, getException } from "./review/store.js";
import { getTrust } from "./trust/store.js";
import { createUiServer } from "./ui/server.js";
import { recordRun } from "./metrics/index.js";

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
  .action(async (intentFile: string, opts: { repo?: string; ref?: string; webhook?: string }) => {
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

    const webhookUrl = opts.webhook ?? config.webhookUrl;
    const results = await launchSwarm(apiKey, config, workPackages, webhookUrl);

    recordRun({
      runId: `run-${Date.now()}`,
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
trustThresholds:
  autoApprove: 0.85
  escalate: 0.60
  block: 0.40
`;
    const dir = join(process.cwd(), "intents");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content);
    console.log(`Created ${path}`);
  });

const agentsCmd = program.command("agents").description("Manage agents");

agentsCmd
  .command("list")
  .description("List agents (filtered by configured repository when set)")
  .option("-a, --all", "Show agents from all repositories")
  .action(async (opts: { all?: boolean }) => {
    const config = loadConfig();
    const apiKey = getApiKey(config);
    const res = await listAgents(apiKey, { limit: 50 });
    let agents = res.agents;

    if (!opts.all && config.repository) {
      const toRepoKey = (url: string) => {
        const u = url.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
        const m = u.match(/github\.com[/:]([\w-]+\/[\w.-]+)/);
        return m ? m[1] : u;
      };
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
    console.log("Agents:");
    agents.forEach((a) => {
      console.log(`  ${a.id} [${a.status}] ${a.target?.branchName ?? "-"}`);
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
