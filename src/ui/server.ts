import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { loadConfig, getApiKey, saveConfig } from "../config.js";
import { listAgents, addFollowUp } from "../api/client.js";
import {
  listExceptions,
  resolveException,
  getException,
  addException,
} from "../review/store.js";
import { getMetrics } from "../metrics/index.js";
import { getTrust, getAllTrust } from "../trust/store.js";
import { getAgentContext, getAgentIdsByJob } from "../orchestrator/run-context.js";
import { getAgentFinishedAt } from "../agent-events/store.js";
import { listJobs, getJob, createJob, updateJob } from "../jobs/store.js";
import { purgeJobFromArgusStore } from "../jobs/purge-job.js";
import { loadIntent } from "../intent/loader.js";
import { IntentSchema } from "../intent/schema.js";
import { decompose } from "../decomposer/index.js";
import { launchSwarm } from "../orchestrator/index.js";
import { recordRun } from "../metrics/index.js";
import { startEmbeddedWebhook } from "../webhook/embedded.js";
import { startBlockedDetector } from "../oversight/blocked-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_DIR = join(__dirname, "app");
const APP_INDEX_HTML = join(APP_DIR, "index.html");

function getContentType(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function toRepoKey(url: string): string {
  const u = url.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  const m = u.match(/github\.com[/:]([\w-]+\/[\w.-]+)/);
  return m ? m[1] : u;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function getFilteredAgents(config: ReturnType<typeof loadConfig>, apiKey: string) {
  const { agents: allAgents } = await listAgents(apiKey, { limit: 100 });
  let agents = allAgents;
  if (config.repository) {
    const configKey = toRepoKey(config.repository);
    agents = agents.filter(
      (a) => toRepoKey(a.source?.repository ?? "") === configKey,
    );
  }
  return agents;
}

export function createUiServer(port: number) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    res.setHeader("Content-Type", "application/json");

    // ── Static SPA serving ─────────────────────────────────

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readFileSync(APP_INDEX_HTML, "utf-8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      } catch {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "UI build not found. Run npm run build." }));
      }
      return;
    }

    if (url.pathname.startsWith("/assets/") || (extname(url.pathname) && !url.pathname.startsWith("/api/"))) {
      const assetRelPath = normalize(url.pathname).replace(/^\/+/, "");
      const assetPath = join(APP_DIR, assetRelPath);
      if (!assetPath.startsWith(APP_DIR) || !existsSync(assetPath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Asset not found" }));
        return;
      }
      try {
        const content = readFileSync(assetPath);
        res.setHeader("Content-Type", getContentType(assetPath));
        res.end(content);
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // ── Jobs API ───────────────────────────────────────────

    if (url.pathname === "/api/jobs" && req.method === "GET") {
      try {
        const jobs = listJobs();

        const runningJobs = jobs.filter((j) => j.status === "running");
        if (runningJobs.length > 0) {
          try {
            const config = loadConfig();
            const apiKey = getApiKey(config);
            const { agents } = await listAgents(apiKey, { limit: 100 });
            for (const job of runningJobs) {
              const jobAgentSet = new Set(job.agentIds);
              const jobAgents = agents.filter((a) => jobAgentSet.has(a.id));
              if (jobAgents.length === 0) continue;
              const allTerminal = jobAgents.every(
                (a) => a.status === "FINISHED" || a.status === "ERROR" || a.status === "STOPPED",
              );
              if (allTerminal) {
                const hasError = jobAgents.some((a) => a.status === "ERROR" || a.status === "STOPPED");
                const newStatus = hasError ? "error" : "finished";
                updateJob(job.jobId, { status: newStatus });
                job.status = newStatus;
              }
            }
          } catch {
            // Non-critical: if we can't check agent statuses, return jobs as-is
          }
        }

        res.end(JSON.stringify(jobs));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    const jobDetailMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobDetailMatch && req.method === "GET") {
      try {
        const job = getJob(jobDetailMatch[1]);
        if (!job) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Job not found" }));
          return;
        }

        if (job.status === "running") {
          try {
            const config = loadConfig();
            const apiKey = getApiKey(config);
            const { agents } = await listAgents(apiKey, { limit: 100 });
            const jobAgentSet = new Set(job.agentIds);
            const jobAgents = agents.filter((a) => jobAgentSet.has(a.id));
            if (jobAgents.length > 0) {
              const allTerminal = jobAgents.every(
                (a) => a.status === "FINISHED" || a.status === "ERROR" || a.status === "STOPPED",
              );
              if (allTerminal) {
                const hasError = jobAgents.some((a) => a.status === "ERROR" || a.status === "STOPPED");
                const newStatus = hasError ? "error" : "finished";
                updateJob(job.jobId, { status: newStatus });
                job.status = newStatus;
              }
            }
          } catch {
            // Non-critical
          }
        }

        res.end(JSON.stringify(job));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (jobDetailMatch && req.method === "DELETE") {
      try {
        const jobId = jobDetailMatch[1];
        const job = getJob(jobId);
        if (!job) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Job not found" }));
          return;
        }

        if (job.status === "running" || job.status === "creating") {
          try {
            const config = loadConfig();
            const apiKey = getApiKey(config);
            const idSet = new Set([...job.agentIds, ...getAgentIdsByJob(jobId)]);
            if (idSet.size > 0) {
              const { agents } = await listAgents(apiKey, { limit: 100 });
              for (const a of agents) {
                if (!idSet.has(a.id)) continue;
                if (a.status === "RUNNING" || a.status === "CREATING") {
                  res.statusCode = 409;
                  res.end(
                    JSON.stringify({
                      error: "Cannot delete a job while agents are still running or creating.",
                    }),
                  );
                  return;
                }
              }
            }
          } catch {
            res.statusCode = 503;
            res.end(JSON.stringify({ error: "Could not verify agent status; try again." }));
            return;
          }
        }

        const result = await purgeJobFromArgusStore(jobId);
        res.end(JSON.stringify({ ok: true, removedAgentIds: result?.removedAgentIds ?? [] }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/jobs" && req.method === "POST") {
      try {
        const config = loadConfig();
        const apiKey = getApiKey(config);
        const body = JSON.parse(await readBody(req)) as {
          intentFile?: string;
          intent?: { intent: string; constraints?: string[]; trustThresholds?: Record<string, number> };
        };

        let intent;
        let intentFile: string | undefined;

        if (body.intentFile) {
          intentFile = body.intentFile;
          intent = loadIntent(intentFile);
        } else if (body.intent) {
          intent = IntentSchema.parse(body.intent);
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Provide intentFile or intent object" }));
          return;
        }

        const workPackages = decompose(intent);
        const jobId = `job-${Date.now()}`;

        if (!config.webhookSecret || config.webhookSecret.length < 32) {
          config.webhookSecret = randomBytes(32).toString("hex");
        }

        let webhookUrl = config.webhookUrl;
        let embedded: Awaited<ReturnType<typeof startEmbeddedWebhook>> | undefined;

        if (!webhookUrl) {
          embedded = await startEmbeddedWebhook(config.webhookSecret);
          webhookUrl = embedded.webhookUrl;
        }

        const results = await launchSwarm(apiKey, config, workPackages, webhookUrl, jobId);
        const agentIds = results.map((r) => r.agentId);

        createJob(jobId, intent.intent, agentIds, workPackages, intentFile);

        recordRun({
          runId: jobId,
          intentFile: intentFile ?? "(inline)",
          agentCount: results.length,
          startedAt: new Date().toISOString(),
          exceptions: 0,
          autoApproved: 0,
        });

        startBlockedDetector(apiKey, agentIds, (err) =>
          console.error("[argus] Blocked detector error:", err),
        );

        res.end(JSON.stringify({ jobId, agentIds, intentSummary: intent.intent.slice(0, 120), workPackages: workPackages.map((w) => ({ id: w.id, role: w.role, task: w.task })) }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // ── Intents API ────────────────────────────────────────

    if (url.pathname === "/api/intents" && req.method === "GET") {
      try {
        const intentsDir = join(process.cwd(), "intents");
        if (!existsSync(intentsDir)) {
          res.end(JSON.stringify([]));
          return;
        }
        const files = readdirSync(intentsDir).filter((f) => f.endsWith(".intent.yaml"));
        const items = files.map((f) => {
          const content = readFileSync(join(intentsDir, f), "utf-8");
          return { name: f.replace(/\.intent\.yaml$/, ""), file: `intents/${f}`, content };
        });
        res.end(JSON.stringify(items));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    const intentNameMatch = url.pathname.match(/^\/api\/intents\/([^/]+)$/);
    if (intentNameMatch) {
      const name = decodeURIComponent(intentNameMatch[1]);
      const filePath = join(process.cwd(), "intents", `${name}.intent.yaml`);

      if (req.method === "GET") {
        if (!existsSync(filePath)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Intent not found" }));
          return;
        }
        const content = readFileSync(filePath, "utf-8");
        res.end(JSON.stringify({ name, content }));
        return;
      }

      if (req.method === "PUT") {
        try {
          const body = JSON.parse(await readBody(req)) as { content: string };
          const dir = join(process.cwd(), "intents");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(filePath, body.content, "utf-8");
          res.end(JSON.stringify({ ok: true, name }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
        return;
      }
    }

    // ── Agents API (with optional jobId filter) ────────────

    if (url.pathname === "/api/agents") {
      try {
        const config = loadConfig();
        const apiKey = getApiKey(config);
        const agents = await getFilteredAgents(config, apiKey);

        const jobIdFilter = url.searchParams.get("jobId");
        const jobAgentIds = jobIdFilter ? new Set(getAgentIdsByJob(jobIdFilter)) : null;

        const enriched = await Promise.all(
          agents
            .filter((a) => !jobAgentIds || jobAgentIds.has(a.id))
            .map(async (a) => {
              const trust = await getTrust(a.id);
              const ctx = getAgentContext(a.id);
              const finishedAt = getAgentFinishedAt(a.id);
              return {
                id: a.id,
                name: a.name,
                status: a.status,
                branch: a.target?.branchName,
                prUrl: a.target?.prUrl,
                summary: a.summary,
                createdAt: a.createdAt,
                finishedAt: finishedAt ?? null,
                trust,
                intent: ctx?.intent ?? null,
                jobId: ctx?.jobId ?? null,
              };
            }),
        );
        res.end(JSON.stringify(enriched));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // ── Exceptions API (with optional jobId filter) ────────

    if (url.pathname === "/api/exceptions") {
      const showAll = url.searchParams.get("all") === "1";
      let exceptions = listExceptions(!showAll);

      const jobIdFilter = url.searchParams.get("jobId");
      if (jobIdFilter) {
        const jobAgentIds = new Set(getAgentIdsByJob(jobIdFilter));
        exceptions = exceptions.filter((e) => jobAgentIds.has(e.agentId));
      }

      res.end(JSON.stringify(exceptions));
      return;
    }

    if (url.pathname === "/api/exceptions/test" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as { jobId?: string };
        const jobId = body.jobId;
        if (!jobId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "jobId required" }));
          return;
        }
        let agentIds = getAgentIdsByJob(jobId);
        if (agentIds.length === 0) {
          const job = getJob(jobId);
          agentIds = job?.agentIds ?? [];
        }
        if (agentIds.length === 0) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "No agents found for this job. Run a job first." }));
          return;
        }
        const agentId = agentIds[0];
        const result = {
          agentId,
          confidence: 0.55,
          checks: [
            { name: "summary", passed: true, output: "Test exception for UI demo" },
            { name: "status", passed: true, output: "FINISHED" },
            { name: "pr_created", passed: false, output: undefined },
            { name: "test", passed: false, output: "Synthetic exception for testing Exception Review" },
          ],
          decision: "escalate" as const,
        };
        const ex = addException(result);
        res.end(JSON.stringify({ ok: true, exceptionId: ex.id }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // ── Metrics API (with optional jobId filter) ───────────

    if (url.pathname === "/api/metrics") {
      try {
        const config = loadConfig();
        const apiKey = getApiKey(config);
        const agents = await getFilteredAgents(config, apiKey);

        const jobIdFilter = url.searchParams.get("jobId");
        const jobAgentIds = jobIdFilter ? new Set(getAgentIdsByJob(jobIdFilter)) : null;
        const filteredAgents = jobAgentIds
          ? agents.filter((a) => jobAgentIds.has(a.id))
          : agents;

        const n = filteredAgents.length;
        const allExceptions = listExceptions();
        const jobExceptions = jobAgentIds
          ? allExceptions.filter((e) => jobAgentIds.has(e.agentId))
          : allExceptions;
        const exceptionRate = n > 0 ? jobExceptions.length / n : 0;
        const autoApproved = Math.max(0, n - jobExceptions.length);
        const containmentRatio = n > 0 ? autoApproved / n : 1;

        const allTrust = await getAllTrust();
        const trustByAgent = new Map(allTrust.map((t) => [t.agentId, t.tau]));
        const jobTrustValues = filteredAgents
          .map((a) => trustByAgent.get(a.id))
          .filter((t): t is number => t != null);
        const trustMean =
          jobTrustValues.length > 0
            ? jobTrustValues.reduce((s, t) => s + t, 0) / jobTrustValues.length
            : null;

        const effectiveFanOut = n > 0 ? n * (1 - exceptionRate * (2 / 15)) : 0;

        const statusCounts = { running: 0, finished: 0, error: 0, blocked: 0, creating: 0 };
        for (const a of filteredAgents) {
          switch (a.status) {
            case "RUNNING": statusCounts.running++; break;
            case "FINISHED": statusCounts.finished++; break;
            case "ERROR": statusCounts.error++; break;
            case "STOPPED": statusCounts.blocked++; break;
            case "CREATING": statusCounts.creating++; break;
          }
        }

        const oneHourAgo = Date.now() - 3600_000;
        const throughputPerHour = filteredAgents.filter(
          (a) =>
            a.status === "FINISHED" &&
            new Date(a.createdAt).getTime() >= oneHourAgo,
        ).length;

        const base = getMetrics();
        res.end(
          JSON.stringify({
            ...base,
            totalAgents: n,
            exceptionRate,
            effectiveFanOut,
            throughputPerHour,
            trustMean,
            containmentRatio,
            statusCounts,
          }),
        );
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // ── Config API ────────────────────────────────────────

    if (url.pathname === "/api/config" && req.method === "GET") {
      try {
        const config = loadConfig();
        res.end(
          JSON.stringify({
            repository: config.repository ?? "",
            apiKeyPath: config.apiKeyPath ?? "",
            webhookUrl: config.webhookUrl ?? "",
            webhookSecret: config.webhookSecret ?? "",
            defaultRef: config.defaultRef ?? "main",
            maxAgents: config.maxAgents ?? 5,
            openaiApiKeyPath: config.openaiApiKeyPath ?? "",
          }),
        );
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/config" && req.method === "PUT") {
      try {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const updates: Record<string, unknown> = {};
        if (typeof body.repository === "string") updates.repository = body.repository;
        if (typeof body.apiKeyPath === "string") updates.apiKeyPath = body.apiKeyPath;
        if (typeof body.webhookUrl === "string") updates.webhookUrl = body.webhookUrl;
        if (typeof body.webhookSecret === "string") updates.webhookSecret = body.webhookSecret;
        if (typeof body.defaultRef === "string") updates.defaultRef = body.defaultRef;
        if (typeof body.maxAgents === "number") updates.maxAgents = body.maxAgents;
        if (typeof body.openaiApiKeyPath === "string") updates.openaiApiKeyPath = body.openaiApiKeyPath;
        saveConfig(updates as Parameters<typeof saveConfig>[0]);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // ── Trust API ──────────────────────────────────────────

    if (url.pathname === "/api/trust") {
      try {
        const entries = await getAllTrust();
        res.end(JSON.stringify(entries));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // ── Review actions ─────────────────────────────────────

    const followupMatch = url.pathname.match(
      /^\/api\/review\/followup\/(.+)$/,
    );
    if (followupMatch && req.method === "POST") {
      try {
        const config = loadConfig();
        const apiKey = getApiKey(config);
        const exId = followupMatch[1];
        const ex = getException(exId);
        if (!ex) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Exception not found" }));
          return;
        }
        const body = JSON.parse(await readBody(req)) as { message?: string };
        if (!body.message) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "message required" }));
          return;
        }
        await addFollowUp(ex.agentId, apiKey, { text: body.message });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    const approveMatch = url.pathname.match(/^\/api\/review\/approve\/(.+)$/);
    if (approveMatch) {
      resolveException(approveMatch[1], "approved");
      if (req.headers.accept?.includes("application/json")) {
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(302, { Location: "/" });
        res.end();
      }
      return;
    }

    const rejectMatch = url.pathname.match(/^\/api\/review\/reject\/(.+)$/);
    if (rejectMatch) {
      resolveException(rejectMatch[1], "rejected");
      if (req.headers.accept?.includes("application/json")) {
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(302, { Location: "/" });
        res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
