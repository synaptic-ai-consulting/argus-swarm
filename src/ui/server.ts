import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, getApiKey } from "../config.js";
import { listAgents, addFollowUp } from "../api/client.js";
import {
  listExceptions,
  resolveException,
  getException,
} from "../review/store.js";
import { getMetrics } from "../metrics/index.js";
import { getTrust, getAllTrust } from "../trust/store.js";
import { getAgentContext } from "../orchestrator/run-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DASHBOARD_HTML = readFileSync(
  join(__dirname, "dashboard.html"),
  "utf-8"
);

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

export function createUiServer(port: number) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    res.setHeader("Content-Type", "application/json");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(DASHBOARD_HTML);
      return;
    }

    if (url.pathname === "/api/agents") {
      try {
        const config = loadConfig();
        const apiKey = getApiKey(config);
        const { agents: allAgents } = await listAgents(apiKey, { limit: 100 });
        let agents = allAgents;
        if (config.repository) {
          const configKey = toRepoKey(config.repository);
          agents = agents.filter(
            (a) => toRepoKey(a.source?.repository ?? "") === configKey
          );
        }

        const enriched = await Promise.all(
          agents.map(async (a) => {
            const trust = await getTrust(a.id);
            const ctx = getAgentContext(a.id);
            return {
              id: a.id,
              name: a.name,
              status: a.status,
              branch: a.target?.branchName,
              prUrl: a.target?.prUrl,
              summary: a.summary,
              createdAt: a.createdAt,
              trust,
              intent: ctx?.intent ?? null,
            };
          })
        );
        res.end(JSON.stringify(enriched));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/exceptions") {
      const showAll = url.searchParams.get("all") === "1";
      res.end(JSON.stringify(listExceptions(!showAll)));
      return;
    }

    if (url.pathname === "/api/metrics") {
      try {
        const base = getMetrics();
        const allTrust = await getAllTrust();
        const trustMean =
          allTrust.length > 0
            ? allTrust.reduce((s, t) => s + t.tau, 0) / allTrust.length
            : null;

        const pe = base.exceptionRate;
        const n = base.totalAgents;
        const effectiveFanOut = n > 0 ? n * (1 - pe * (2 / 15)) : 0;

        const allExceptions = listExceptions();
        const totalOutputs = base.totalAgents;
        const autoApproved = totalOutputs - allExceptions.length;
        const containmentRatio =
          totalOutputs > 0 ? Math.max(0, autoApproved) / totalOutputs : 1;

        const config = loadConfig();
        const apiKey = getApiKey(config);
        const { agents: allAgents } = await listAgents(apiKey, { limit: 100 });
        let agents = allAgents;
        if (config.repository) {
          const configKey = toRepoKey(config.repository);
          agents = agents.filter(
            (a) => toRepoKey(a.source?.repository ?? "") === configKey
          );
        }

        const statusCounts = { running: 0, finished: 0, error: 0, blocked: 0, creating: 0 };
        for (const a of agents) {
          switch (a.status) {
            case "RUNNING": statusCounts.running++; break;
            case "FINISHED": statusCounts.finished++; break;
            case "ERROR": statusCounts.error++; break;
            case "STOPPED": statusCounts.blocked++; break;
            case "CREATING": statusCounts.creating++; break;
          }
        }

        const oneHourAgo = Date.now() - 3600_000;
        const throughputPerHour = agents.filter(
          (a) =>
            a.status === "FINISHED" &&
            new Date(a.createdAt).getTime() >= oneHourAgo
        ).length;

        res.end(
          JSON.stringify({
            ...base,
            effectiveFanOut,
            throughputPerHour,
            trustMean,
            containmentRatio,
            statusCounts,
          })
        );
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

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

    const followupMatch = url.pathname.match(
      /^\/api\/review\/followup\/(.+)$/
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
