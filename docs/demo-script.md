# Argus Demo Script — Under 10 Minutes

A concise walkthrough for presenting **Argus** (Adaptive Stigmergic Oversight for AI Agent Swarms) to students. Based on the [ASO paper](aso_main.pdf).

---

## Before the Demo (Setup)

1. **Prerequisites**
   - Node.js 18+
   - `argus.config.local.yaml` with `repository` set to a GitHub repo you can push to
   - `CURSOR_API_KEY` env var (or `apiKeyPath` in config)
   - Optional: `GITHUB_TOKEN` for cleanup

2. **Build**
   ```bash
   npm install && npm run build
   ```

3. **Optional: Clean slate** (if re-running)
   ```bash
   export GITHUB_TOKEN=ghp_...
   npx argus cleanup
   ```

---

## Demo Flow (~10 min)

### 1. Introduction (30 sec)

> "Argus lets one human operator supervise many AI coding agents. It uses three ideas from the ASO paper: **intent delegation** (you specify what, not how), **stigmergic coordination** (agents work via a shared Git repo), and **exception-based review** (you only intervene when something needs attention)."

---

### 2. Launch a Swarm (1 min)

```bash
npx argus run intents/oauth2-auth.intent.yaml
```

- Explain: "This decomposes the intent into 5 work packages and launches 5 Cursor agents in parallel."
- The dashboard opens automatically at **http://localhost:3848** — open it in a browser.
- Keep the terminal visible so students see logs.

---

### 3. Intent Delegation Tab (2–3 min)

1. **Left panel — Job list**
   - Point out the new job with status RUNNING.
   - Show intent summary and "5 agents".

2. **Right panel — Pipeline**
   - Walk through stages:
     - **Intent Defined** — human specifies the goal
     - **Decomposer** — breaks it into work packages (Explorer, Workers, Validator)
     - **Orchestrator** — agents run in parallel (spinning = running)
     - **Calculating Stigmergic Metrics** — fan-out, exception rate, trust
     - **Create Exception Review** — validation and human review queue

3. **New Job**
   - Click "+ New Job".
   - Show "From File" vs "Inline" modes.
   - Show trust thresholds (auto-approve, escalate, block).
   - Cancel or launch a second job if time allows.

---

### 4. Swarm & Exception Review Tab (2–3 min)

1. **Switch to Swarm tab** (icon in sidebar).

2. **Metrics strip**
   - **Fan-out** — effective swarm size
   - **Exception rate** — % needing human review
   - **Throughput/hr** — agents finished per hour
   - **Trust mean** — average agent trust score
   - **Containment** — % auto-approved vs total

3. **Agent Swarm grid**
   - Dots = agents (green = finished, blue = running, red = error, orange = blocked).
   - Hover a dot to see work package details and PR link.

4. **Exception Review Queue**
   - Exceptions = low-confidence or blocked agents.
   - Use "+ Test" to add a synthetic exception for demo.
   - Approve / Reject / Follow-up for blocked agents.

5. **Activity feed**
   - Recent agent completions with timestamps.

---

### 5. Key Concepts (1 min)

| Concept | One-liner |
|--------|------------|
| Intent delegation | Human defines *what*; decomposer and agents handle *how* |
| Stigmergic coordination | Agents coordinate via shared Git (branches, PRs) |
| Exception-based review | Human intervenes only when validation flags issues |
| Trust scores (τ) | Per-agent confidence; low τ → more review |

---

### 6. Wrap-up & Cleanup (1 min)

- **Stop the run:** Ctrl+C in the terminal.
- **Inspect later:** `npx argus ui` → http://localhost:3848
- **Re-run from clean repo:**
  ```bash
  npx argus cleanup
  npx argus run intents/oauth2-auth.intent.yaml
  ```

---

## Quick Reference

| Action | Command / URL |
|--------|----------------|
| Run swarm + UI | `npx argus run intents/oauth2-auth.intent.yaml` |
| UI only | `npx argus ui` → http://localhost:3848 |
| List intents | `npx argus intent list` |
| Clean branches | `npx argus cleanup` (needs `GITHUB_TOKEN`) |
| Exception test intent | `intents/exception-test.intent.yaml` |

---

## Troubleshooting

- **Port in use:** `fuser -k 3848/tcp` then restart.
- **No exceptions:** Use "+ Test" in Exception Review Queue, or run `exception-test-strict.intent.yaml`.
- **API key:** Ensure `CURSOR_API_KEY` or `apiKeyPath` is set; see [README](../README.md#configuration).
