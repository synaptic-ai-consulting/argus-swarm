import { createServer } from "node:http";
import { loadConfig, getApiKey } from "../config.js";
import { listAgents } from "../api/client.js";
import { listExceptions, resolveException } from "../review/store.js";
import { getMetrics } from "../metrics/index.js";

const HTML = `
<!DOCTYPE html>
<html>
<head><title>Argus</title><meta charset="utf-8"></head>
<body style="font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem">
<h1>Argus</h1>
<h2>Adaptive Stigmergic Oversight for AI Agent Swarms</h2>
<h2>Agents</h2>
<div id="agents">Loading...</div>
<h2>Exceptions (pending review)</h2>
<div id="exceptions">Loading...</div>
<h2>Metrics</h2>
<div id="metrics">Loading...</div>
<script>
async function load() {
  try {
    const [agents, exceptions, metrics] = await Promise.all([
      fetch('/api/agents').then(r=>r.json()),
      fetch('/api/exceptions').then(r=>r.json()),
      fetch('/api/metrics').then(r=>r.json())
    ]);
    document.getElementById('agents').innerHTML = agents.length ? 
      '<ul>' + agents.map(a => '<li>' + a.id + ' [' + a.status + '] ' + (a.branch||'') + '</li>').join('') + '</ul>' : 'None';
    const pending = exceptions.filter(e => !e.resolved);
    document.getElementById('exceptions').innerHTML = pending.length ?
      '<ul>' + pending.map(e => '<li>' + e.id + ' agent=' + e.agentId + ' [' + (e.decision || 'escalate') + ']' + 
        ' <a href="/api/review/approve/' + e.id + '">approve</a> <a href="/api/review/reject/' + e.id + '">reject</a></li>').join('') + '</ul>' : 'None';
    document.getElementById('metrics').innerHTML = 
      'Runs: ' + metrics.totalRuns + ' | Agents: ' + metrics.totalAgents + ' | Exception rate: ' + (metrics.exceptionRate * 100).toFixed(1) + '%';
  } catch (e) {
    document.getElementById('agents').innerHTML = 'Error: ' + e.message;
  }
}
load();
setInterval(load, 10000);
</script>
</body>
</html>
`;

export function createUiServer(port: number) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    res.setHeader("Content-Type", "application/json");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(HTML);
      return;
    }

    if (url.pathname === "/api/agents") {
      try {
        const config = loadConfig();
        const apiKey = getApiKey(config);
        const { agents: allAgents } = await listAgents(apiKey, { limit: 50 });
        let agents = allAgents;
        if (config.repository) {
          const toRepoKey = (url: string) => {
            const u = url.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
            const m = u.match(/github\.com[/:]([\w-]+\/[\w.-]+)/);
            return m ? m[1] : u;
          };
          const configKey = toRepoKey(config.repository);
          agents = agents.filter((a) => toRepoKey(a.source?.repository ?? "") === configKey);
        }
        res.end(
          JSON.stringify(
            agents.map((a) => ({
              id: a.id,
              status: a.status,
              branch: a.target?.branchName,
            }))
          )
        );
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/exceptions") {
      res.end(JSON.stringify(listExceptions(true)));
      return;
    }

    if (url.pathname === "/api/metrics") {
      res.end(JSON.stringify(getMetrics()));
      return;
    }

    const approveMatch = url.pathname.match(/^\/api\/review\/approve\/(.+)$/);
    if (approveMatch) {
      resolveException(approveMatch[1], "approved");
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    const rejectMatch = url.pathname.match(/^\/api\/review\/reject\/(.+)$/);
    if (rejectMatch) {
      resolveException(rejectMatch[1], "rejected");
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
