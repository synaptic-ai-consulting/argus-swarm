import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────

interface Agent {
  id: string;
  name?: string;
  status: "RUNNING" | "FINISHED" | "ERROR" | "STOPPED" | "CREATING" | string;
  branch?: string;
  prUrl?: string;
  summary?: string;
  createdAt: string;
  finishedAt?: string | null;
  trust: number | null;
  intent: string | null;
  jobId: string | null;
}

interface ExceptionCheck {
  name: string;
  passed: boolean;
  output?: unknown;
}

interface ReviewException {
  id: string;
  agentId: string;
  branchName?: string;
  prUrl?: string;
  confidence: number;
  checks: ExceptionCheck[];
  decision: "blocked" | "block" | "escalate" | "auto_approve" | string;
  createdAt: string;
  resolved?: "approved" | "rejected";
}

interface Metrics {
  exceptionRate?: number;
  effectiveFanOut?: number;
  throughputPerHour?: number;
  trustMean?: number | null;
  containmentRatio?: number;
  statusCounts?: {
    running?: number;
    finished?: number;
    error?: number;
    blocked?: number;
    creating?: number;
  };
}

interface JobRecord {
  jobId: string;
  intentFile?: string;
  intentSummary: string;
  status: "creating" | "running" | "finished" | "error";
  createdAt: string;
  agentIds: string[];
  workPackages?: Array<{ id: string; role: string; task: string }>;
}

interface IntentFile {
  name: string;
  file: string;
  content: string;
}

interface PopoverState {
  agent: Agent;
  left: number;
  top: number;
}

interface AppConfig {
  repository: string;
  apiKeyPath: string;
  webhookUrl: string;
  webhookSecret: string;
  defaultRef: string;
  maxAgents: number;
  openaiApiKeyPath: string;
}

type Tab = "delegation" | "review";

// ── Helpers ────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  RUNNING: "var(--blue)",
  FINISHED: "var(--green)",
  ERROR: "var(--red)",
  STOPPED: "var(--amber)",
  CREATING: "var(--gray)",
};

function elapsed(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const JOB_STATUS_LABEL: Record<string, string> = {
  creating: "Creating",
  running: "Running",
  finished: "Finished",
  error: "Error",
};

// ── SVG Icons (inline, minimal) ────────────────────────────

function IconIntents({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "var(--accent)" : "var(--text-dim)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function IconSwarm({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "var(--accent)" : "var(--text-dim)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="2.5" />
      <circle cx="6" cy="16" r="2.5" />
      <circle cx="18" cy="16" r="2.5" />
      <path d="M12 10.5v2M9 14l-1.5 1M15 14l1.5 1" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function SwarmDot() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="8" r="2" />
      <circle cx="7" cy="15" r="2" />
      <circle cx="17" cy="15" r="2" />
    </svg>
  );
}

// ── Pipeline component ─────────────────────────────────────

function PipelineDiagram({ job, agents }: { job: JobRecord; agents: Agent[] }) {
  const jobAgents = agents.filter((a) => job.agentIds.includes(a.id));
  const allFinished = jobAgents.length > 0 && jobAgents.every((a) => a.status === "FINISHED");
  const anyError = jobAgents.some((a) => a.status === "ERROR" || a.status === "STOPPED");
  const someRunning = jobAgents.some((a) => a.status === "RUNNING" || a.status === "CREATING");
  const intentDone = true;
  const decomposerDone = (job.workPackages?.length ?? 0) > 0;
  const orchestratorStatus = allFinished ? "done" : anyError && !someRunning ? "error" : someRunning || job.status === "running" ? "running" : "pending";

  const orchestratorDone = allFinished || anyError;
  const asoLayer2Status = orchestratorDone ? "done" : "pending";
  const asoLayer3Status = asoLayer2Status;

  return (
    <div className="pipeline">
      <PipelineStep label="Intent Defined" status={intentDone ? "done" : "pending"} detail={job.intentSummary.slice(0, 60)} />
      <div className="pipeline-connector" />
      <PipelineStep label="Decomposer" status={decomposerDone ? "done" : "running"} detail={`${job.workPackages?.length ?? 0} work packages`} />
      <div className="pipeline-connector" />
      <PipelineStep label="Orchestrator" status={orchestratorStatus} detail={`${jobAgents.length} agents`}>
        <div className="pipeline-agents">
          {jobAgents.map((a) => (
            <div key={a.id} className="pipeline-agent-row">
              <span className={`pipeline-agent-status ${a.status === "RUNNING" || a.status === "CREATING" ? "spinning" : ""}`} style={{ borderColor: STATUS_COLORS[a.status] ?? "var(--gray)", background: a.status === "RUNNING" || a.status === "CREATING" ? "transparent" : STATUS_COLORS[a.status] ?? "var(--gray)" }} />
              <span className="pipeline-agent-name">{a.name ?? a.id.slice(0, 10)}</span>
              <span className="pipeline-agent-label">{a.status}</span>
            </div>
          ))}
        </div>
      </PipelineStep>
      <div className="pipeline-connector" />
      <PipelineStep label="Calculating Stigmergic Metrics" status={asoLayer2Status} detail="Fan-out, exception rate, trust" />
      <div className="pipeline-connector" />
      <PipelineStep label="Create Exception Review" status={asoLayer3Status} detail="Validation, approve/reject queue" />
    </div>
  );
}

function PipelineStep({ label, status, detail, children }: { label: string; status: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className={`pipeline-step pipeline-step--${status}`}>
      <div className="pipeline-step-icon">
        {status === "done" && <span className="step-check">&#10003;</span>}
        {status === "running" && <span className="step-spinner" />}
        {status === "error" && <span className="step-error">!</span>}
        {status === "pending" && <span className="step-pending" />}
      </div>
      <div className="pipeline-step-content">
        <div className="pipeline-step-label">{label}</div>
        {detail && <div className="pipeline-step-detail">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────

function App() {
  const [tab, setTab] = useState<Tab>("delegation");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [exceptions, setExceptions] = useState<ReviewException[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({});
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [intents, setIntents] = useState<IntentFile[]>([]);
  const [loading, setLoading] = useState(true);

  // Job selection
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [pipelineJobId, setPipelineJobId] = useState<string | null>(null);

  // Create-job form
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"file" | "inline">("file");
  const [createIntentFile, setCreateIntentFile] = useState("");
  const [createInlineIntent, setCreateInlineIntent] = useState("");
  const [createConstraints, setCreateConstraints] = useState("");
  const [createAutoApprove, setCreateAutoApprove] = useState("0.85");
  const [createEscalate, setCreateEscalate] = useState("0.60");
  const [createBlock, setCreateBlock] = useState("0.40");
  const [creating, setCreating] = useState(false);

  // Exception review state
  const [resolvedVisible, setResolvedVisible] = useState(false);
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  const [followupOpen, setFollowupOpen] = useState<Record<string, boolean>>({});
  const [followupText, setFollowupText] = useState<Record<string, string>>({});
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const popoverCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<AppConfig>({
    repository: "",
    apiKeyPath: "",
    webhookUrl: "",
    webhookSecret: "",
    defaultRef: "main",
    maxAgents: 5,
    openaiApiKeyPath: "",
  });
  const [configSaving, setConfigSaving] = useState(false);
  const [testExceptionAdding, setTestExceptionAdding] = useState(false);

  const mostRecentJobId = useMemo(() => {
    if (jobs.length === 0) return null;
    const sorted = [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sorted[0]?.jobId ?? null;
  }, [jobs]);

  const effectiveJobId = tab === "review"
    ? (selectedJobId ?? mostRecentJobId)
    : pipelineJobId;
  const jobIdParam = effectiveJobId ? `?jobId=${effectiveJobId}` : "";

  const fetchAll = useCallback(async () => {
    try {
      const [agentsRes, exceptionsRes, metricsRes, jobsRes] = await Promise.all([
        fetch(`/api/agents${jobIdParam}`),
        fetch(`/api/exceptions?all=1${jobIdParam}`),
        fetch(`/api/metrics${jobIdParam}`),
        fetch("/api/jobs"),
      ]);
      const [agentsJson, exceptionsJson, metricsJson, jobsJson] = await Promise.all([
        agentsRes.json() as Promise<Agent[]>,
        exceptionsRes.json() as Promise<ReviewException[]>,
        metricsRes.json() as Promise<Metrics>,
        jobsRes.json() as Promise<JobRecord[]>,
      ]);
      setAgents(agentsJson);
      setExceptions(exceptionsJson);
      setMetrics(metricsJson);
      setJobs(jobsJson);
      setLoading(false);
    } catch (error) {
      console.error("Fetch error:", error);
      setLoading(false);
    }

    try {
      const intentsRes = await fetch("/api/intents");
      if (intentsRes.ok) {
        const intentsJson = (await intentsRes.json()) as IntentFile[];
        if (Array.isArray(intentsJson)) setIntents(intentsJson);
      }
    } catch {
      // intents fetch is non-critical
    }
  }, [tab, selectedJobId, pipelineJobId, mostRecentJobId]);

  useEffect(() => {
    if (tab === "review" && jobs.length > 0 && selectedJobId === null) {
      const mostRecent = [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      setSelectedJobId(mostRecent.jobId);
    }
  }, [tab, jobs, selectedJobId]);

  useEffect(() => {
    void fetchAll();
    const timer = window.setInterval(() => void fetchAll(), 5000);
    return () => window.clearInterval(timer);
  }, [fetchAll]);

  useEffect(() => {
    if (settingsOpen) {
      fetch("/api/config")
        .then((r) => r.json())
        .then((c) => setConfig(c as AppConfig))
        .catch(() => {});
    }
  }, [settingsOpen]);

  const saveConfig = async () => {
    setConfigSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...config,
          maxAgents: Number(config.maxAgents) || 5,
        }),
      });
      if (res.ok) {
        setSettingsOpen(false);
      } else {
        const err = (await res.json()) as { error?: string };
        alert(err.error ?? "Failed to save settings");
      }
    } catch (e) {
      alert(String(e));
    } finally {
      setConfigSaving(false);
    }
  };

  // ── Derived data ────────────────────────────────────────

  const pendingExceptions = useMemo(
    () =>
      exceptions
        .filter((e) => !e.resolved)
        .sort((a, b) => {
          const order: Record<string, number> = { blocked: 0, block: 1, escalate: 2 };
          return (order[a.decision] ?? 9) - (order[b.decision] ?? 9);
        }),
    [exceptions],
  );

  const resolvedExceptions = useMemo(
    () => exceptions.filter((e) => Boolean(e.resolved)),
    [exceptions],
  );

  const pillCounts = metrics.statusCounts ?? {};

  const feedEvents = useMemo(() => {
    type FeedEvent =
      | { key: string; time: string; agent: string; type: "exception"; decision: string; confidence: number }
      | { key: string; time: string; agent: string; type: "resolved"; result: string }
      | { key: string; time: string; agent: string; type: "finished"; trust: number | null };
    const events: FeedEvent[] = [];

    for (const ex of exceptions) {
      const name = agents.find((a) => a.id === ex.agentId)?.name ?? ex.agentId.slice(0, 12);
      events.push({ key: `${ex.id}-exc`, time: ex.createdAt, agent: name, type: "exception", decision: ex.decision ?? "escalate", confidence: ex.confidence ?? 0 });
      if (ex.resolved) {
        events.push({ key: `${ex.id}-res`, time: ex.createdAt, agent: name, type: "resolved", result: ex.resolved });
      }
    }
    for (const a of agents) {
      if (a.status === "FINISHED" || a.status === "ERROR" || a.status === "STOPPED") {
        const time = a.finishedAt ?? a.createdAt;
        events.push({ key: `${a.id}-fin`, time, agent: a.name ?? a.id.slice(0, 12), type: "finished", trust: a.trust });
      }
    }
    return events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 25);
  }, [agents, exceptions]);

  const selectedJob = pipelineJobId ? (jobs.find((j) => j.jobId === pipelineJobId) ?? null) : null;

  // ── Metric tiles ────────────────────────────────────────

  const metricExceptionRate = metrics.exceptionRate ?? 0;
  const metricTiles = [
    { label: "Fan-Out", value: metrics.effectiveFanOut != null ? metrics.effectiveFanOut.toFixed(1) : "\u2014", target: "N(1 - Pe\u00b7Tr/Tc)", cls: "target-ok" },
    { label: "Exception Rate", value: `${(metricExceptionRate * 100).toFixed(1)}%`, target: metricExceptionRate <= 0.1 ? "< 10% \u2713" : "> 10% \u26A0", cls: metricExceptionRate <= 0.1 ? "target-ok" : "target-warn" },
    { label: "Throughput/hr", value: metrics.throughputPerHour != null ? String(metrics.throughputPerHour) : "\u2014", target: "Finished 1h", cls: "target-ok" },
    { label: "Trust \u03BC", value: metrics.trustMean != null ? metrics.trustMean.toFixed(2) : "\u2014", target: metrics.trustMean == null ? "" : metrics.trustMean >= 0.7 ? "Healthy" : "Low", cls: metrics.trustMean == null ? "target-na" : metrics.trustMean >= 0.7 ? "target-ok" : "target-warn" },
    { label: "Containment", value: metrics.containmentRatio != null ? `${(metrics.containmentRatio * 100).toFixed(0)}%` : "\u2014", target: "Auto / total", cls: (metrics.containmentRatio ?? 0) >= 0.9 ? "target-ok" : "target-warn" },
  ];

  // ── Actions ─────────────────────────────────────────────

  const doReview = async (exceptionId: string, action: "approve" | "reject") => {
    await fetch(`/api/review/${action}/${exceptionId}`, { headers: { Accept: "application/json" } });
    await fetchAll();
  };

  const doFollowup = async (exceptionId: string, message: string) => {
    await fetch(`/api/review/followup/${exceptionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    setFollowupText((p) => ({ ...p, [exceptionId]: "" }));
    setFollowupOpen((p) => ({ ...p, [exceptionId]: false }));
    await fetchAll();
  };

  const doAddTestException = async () => {
    const jobId = tab === "review" ? selectedJobId : pipelineJobId;
    if (!jobId) {
      alert("Select a job first.");
      return;
    }
    setTestExceptionAdding(true);
    try {
      const res = await fetch("/api/exceptions/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        await fetchAll();
      } else {
        alert(data.error ?? "Failed to add test exception");
      }
    } catch (e) {
      alert(String(e));
    } finally {
      setTestExceptionAdding(false);
    }
  };

  const openPopover = (agent: Agent, target: HTMLDivElement) => {
    if (popoverCloseTimeoutRef.current) {
      clearTimeout(popoverCloseTimeoutRef.current);
      popoverCloseTimeoutRef.current = null;
    }
    const rect = target.getBoundingClientRect();
    const width = 320;
    let left = rect.right + 8;
    let top = rect.top - 20;
    if (left + width > window.innerWidth) left = rect.left - width - 8;
    if (top + 300 > window.innerHeight) top = window.innerHeight - 310;
    if (top < 8) top = 8;
    setPopover({ agent, left, top });
  };

  const closePopover = useCallback(() => {
    setPopover(null);
  }, []);

  const scheduleClosePopover = useCallback(() => {
    if (popoverCloseTimeoutRef.current) clearTimeout(popoverCloseTimeoutRef.current);
    popoverCloseTimeoutRef.current = setTimeout(() => {
      setPopover(null);
      popoverCloseTimeoutRef.current = null;
    }, 150);
  }, []);

  const cancelClosePopover = useCallback(() => {
    if (popoverCloseTimeoutRef.current) {
      clearTimeout(popoverCloseTimeoutRef.current);
      popoverCloseTimeoutRef.current = null;
    }
  }, []);

  const doCreateJob = async () => {
    setCreateOpen(false);
    setCreating(true);
    const intentSummary = createMode === "file"
      ? (intents.find((i) => i.file === createIntentFile)?.name ?? createIntentFile)
      : createInlineIntent.slice(0, 80);
    try {
      const body: Record<string, unknown> = {};
      if (createMode === "file" && createIntentFile) {
        body.intentFile = createIntentFile;
      } else {
        body.intent = {
          intent: createInlineIntent,
          constraints: createConstraints.split("\n").map((s) => s.trim()).filter(Boolean),
          trustThresholds: {
            autoApprove: parseFloat(createAutoApprove) || 0.85,
            escalate: parseFloat(createEscalate) || 0.60,
            block: parseFloat(createBlock) || 0.40,
          },
        };
      }
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as { jobId: string; agentIds: string[]; intentSummary?: string; workPackages?: Array<{ id: string; role: string; task: string }> };
        setJobs((prev) => [
          {
            jobId: data.jobId,
            intentFile: createMode === "file" ? createIntentFile : undefined,
            intentSummary: data.intentSummary ?? intentSummary,
            status: "creating",
            createdAt: new Date().toISOString(),
            agentIds: data.agentIds ?? [],
            workPackages: data.workPackages,
          },
          ...prev,
        ]);
        setPipelineJobId(data.jobId);
        setCreateIntentFile("");
        setCreateInlineIntent("");
        setCreateConstraints("");
        setCreateAutoApprove("0.85");
        setCreateEscalate("0.60");
        setCreateBlock("0.40");
        await fetchAll();
      } else {
        const err = (await res.json()) as { error?: string };
        alert(err.error ?? "Failed to create job");
      }
    } finally {
      setCreating(false);
    }
  };

  const navigateToReview = (jobId: string) => {
    setSelectedJobId(jobId);
    setTab("review");
  };

  // ── Render ──────────────────────────────────────────────

  return (
    <div className="app-shell">
      {/* Top bar: logo, name, description */}
      <header className="app-topbar">
        <div className="app-logo-wrap">
          <img src="/assets/argus.png" alt="Argus" className="app-logo" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; const fb = (e.target as HTMLImageElement).parentElement?.querySelector(".app-logo-fallback"); if (fb) (fb as HTMLElement).style.display = "flex"; }} />
          <span className="app-logo-fallback">A</span>
        </div>
        <div className="app-branding">
          <h1 className="app-name">ARGUS</h1>
          <p className="app-description">Adaptive Stigmergic Oversight for AI Agent Swarms</p>
        </div>
      </header>

      {/* Body: sidebar + main */}
      <div className="app-body">
        <nav className="sidebar">
          <div className="sidebar-tabs">
            <button className={`sidebar-btn${tab === "delegation" ? " active" : ""}`} onClick={() => setTab("delegation")} title="Intent Delegation">
              <IconIntents active={tab === "delegation"} />
              <span className="sidebar-label">Intents</span>
            </button>
            <button className={`sidebar-btn${tab === "review" ? " active" : ""}`} onClick={() => setTab("review")} title="Swarm & Exception Review">
              <IconSwarm active={tab === "review"} />
              <span className="sidebar-label">Swarm</span>
            </button>
          </div>
          <button className="sidebar-btn sidebar-btn-settings" onClick={() => setSettingsOpen(true)} title="Settings">
            <IconSettings />
            <span className="sidebar-label">Settings</span>
          </button>
        </nav>

        <main className="main-content">
        {tab === "delegation" && (
          <DelegationView
            jobs={jobs}
            agents={agents}
            intents={intents}
            pipelineJobId={pipelineJobId}
            selectedJob={selectedJob}
            createOpen={createOpen}
            setCreateOpen={setCreateOpen}
            createMode={createMode}
            setCreateMode={setCreateMode}
            createIntentFile={createIntentFile}
            setCreateIntentFile={setCreateIntentFile}
            createInlineIntent={createInlineIntent}
            setCreateInlineIntent={setCreateInlineIntent}
            createConstraints={createConstraints}
            setCreateConstraints={setCreateConstraints}
            createAutoApprove={createAutoApprove}
            setCreateAutoApprove={setCreateAutoApprove}
            createEscalate={createEscalate}
            setCreateEscalate={setCreateEscalate}
            createBlock={createBlock}
            setCreateBlock={setCreateBlock}
            creating={creating}
            doCreateJob={doCreateJob}
            setPipelineJobId={setPipelineJobId}
            navigateToReview={navigateToReview}
          />
        )}

        {tab === "review" && (
          <ReviewView
            jobs={jobs}
            agents={agents}
            exceptions={exceptions}
            metrics={metrics}
            loading={loading}
            selectedJobId={selectedJobId}
            setSelectedJobId={setSelectedJobId}
            pendingExceptions={pendingExceptions}
            resolvedExceptions={resolvedExceptions}
            resolvedVisible={resolvedVisible}
            setResolvedVisible={setResolvedVisible}
            openCards={openCards}
            setOpenCards={setOpenCards}
            followupOpen={followupOpen}
            setFollowupOpen={setFollowupOpen}
            followupText={followupText}
            setFollowupText={setFollowupText}
            doReview={doReview}
            doFollowup={doFollowup}
            doAddTestException={doAddTestException}
            testExceptionAdding={testExceptionAdding}
            openPopover={openPopover}
            onDotMouseLeave={scheduleClosePopover}
            pillCounts={pillCounts}
            metricTiles={metricTiles}
            feedEvents={feedEvents}
          />
        )}
        </main>
      </div>

      {/* Settings modal */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="modal-close" onClick={() => setSettingsOpen(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p className="settings-hint">Configure GitHub repository, Cursor Cloud Agent, and API keys. Saved to <code>argus.config.local.yaml</code>.</p>
              <div className="form-field-group">
                <label>GitHub Repository</label>
                <input
                  type="text"
                  placeholder="https://github.com/org/repo.git"
                  value={config.repository}
                  onChange={(e) => setConfig((c) => ({ ...c, repository: e.target.value }))}
                />
              </div>
              <div className="form-field-group">
                <label>Cursor API Key Path</label>
                <input
                  type="text"
                  placeholder="~/.cursor/argus-api-key"
                  value={config.apiKeyPath}
                  onChange={(e) => setConfig((c) => ({ ...c, apiKeyPath: e.target.value }))}
                />
                <span className="field-hint">Path to file containing Cursor Cloud Agent API key, or set CURSOR_API_KEY env var</span>
              </div>
              <div className="form-field-group">
                <label>Webhook URL</label>
                <input
                  type="text"
                  placeholder="https://your-tunnel.ngrok.io/webhook"
                  value={config.webhookUrl}
                  onChange={(e) => setConfig((c) => ({ ...c, webhookUrl: e.target.value }))}
                />
                <span className="field-hint">Optional; set when using external webhook (e.g. ngrok)</span>
              </div>
              <div className="form-field-group">
                <label>Webhook Secret</label>
                <input
                  type="password"
                  placeholder="Min 32 characters for HMAC"
                  value={config.webhookSecret}
                  onChange={(e) => setConfig((c) => ({ ...c, webhookSecret: e.target.value }))}
                />
              </div>
              <div className="form-field-row">
                <div className="form-field-group">
                  <label>Default Branch</label>
                  <input
                    type="text"
                    placeholder="main"
                    value={config.defaultRef}
                    onChange={(e) => setConfig((c) => ({ ...c, defaultRef: e.target.value }))}
                  />
                </div>
                <div className="form-field-group">
                  <label>Max Agents</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={config.maxAgents}
                    onChange={(e) => setConfig((c) => ({ ...c, maxAgents: Number(e.target.value) || 5 }))}
                  />
                </div>
              </div>
              <div className="form-field-group">
                <label>OpenAI API Key Path</label>
                <input
                  type="text"
                  placeholder="~/.openai/api-key"
                  value={config.openaiApiKeyPath}
                  onChange={(e) => setConfig((c) => ({ ...c, openaiApiKeyPath: e.target.value }))}
                />
                <span className="field-hint">For future LLM-based decomposer capabilities</span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setSettingsOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={configSaving} onClick={saveConfig}>
                {configSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Popover (hover to show; stays open when moving to popover so user can click PR link) */}
      {popover && (
        <div
          className="popover"
          style={{ left: popover.left, top: popover.top }}
          onMouseEnter={cancelClosePopover}
          onMouseLeave={closePopover}
        >
            <h3>
              <span className="dot" style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: STATUS_COLORS[popover.agent.status] ?? "var(--gray)" }} />
              {popover.agent.name ?? popover.agent.id.slice(0, 12)}
            </h3>
            <div className="popover-row"><span className="label">Status</span><span className="value">{popover.agent.status}</span></div>
            <div className="popover-row"><span className="label">ID</span><span className="value">{popover.agent.id.slice(0, 16)}...</span></div>
            {popover.agent.branch && <div className="popover-row"><span className="label">Branch</span><span className="value">{popover.agent.branch}</span></div>}
            {popover.agent.prUrl && <div className="popover-row"><span className="label">PR</span><span className="value"><a href={popover.agent.prUrl} target="_blank" rel="noreferrer">View PR</a></span></div>}
            {popover.agent.trust != null && <div className="popover-row"><span className="label">Trust (\u03C4)</span><span className="value">{popover.agent.trust.toFixed(3)}</span></div>}
            <div className="popover-row"><span className="label">Elapsed</span><span className="value">{elapsed(popover.agent.createdAt)}</span></div>
            {popover.agent.intent && <div className="popover-row"><span className="label">Intent</span><span className="value">{popover.agent.intent.length > 60 ? `${popover.agent.intent.slice(0, 60)}...` : popover.agent.intent}</span></div>}
            {popover.agent.summary && <div className="popover-summary">{popover.agent.summary}</div>}
        </div>
      )}
    </div>
  );
}

// ── Intent Delegation View ─────────────────────────────────

interface DelegationProps {
  jobs: JobRecord[];
  agents: Agent[];
  intents: IntentFile[];
  pipelineJobId: string | null;
  selectedJob: JobRecord | null;
  createOpen: boolean;
  setCreateOpen: (v: boolean) => void;
  createMode: "file" | "inline";
  setCreateMode: (v: "file" | "inline") => void;
  createIntentFile: string;
  setCreateIntentFile: (v: string) => void;
  createInlineIntent: string;
  setCreateInlineIntent: (v: string) => void;
  createConstraints: string;
  setCreateConstraints: (v: string) => void;
  createAutoApprove: string;
  setCreateAutoApprove: (v: string) => void;
  createEscalate: string;
  setCreateEscalate: (v: string) => void;
  createBlock: string;
  setCreateBlock: (v: string) => void;
  creating: boolean;
  doCreateJob: () => void;
  setPipelineJobId: (v: string | null) => void;
  navigateToReview: (jobId: string) => void;
}

function DelegationView(props: DelegationProps) {
  const { jobs, agents, intents, pipelineJobId, selectedJob, createOpen, createMode, creating } = props;

  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [jobs],
  );

  return (
    <div className="delegation-view">
      <div className="view-header">
        <div className="view-header-title">
          <h2>Intent Delegation</h2>
          <span className="view-tab-name">Intents</span>
        </div>
        <button className="btn btn-primary" onClick={() => props.setCreateOpen(true)}>
          + New Job
        </button>
      </div>

      <div className="delegation-body">
        {/* Job list */}
        <div className="job-list">
          {sortedJobs.length === 0 && <div className="empty-state">No jobs yet. Create one to get started.</div>}
          {sortedJobs.map((job) => (
            <div key={job.jobId} className={`job-card${pipelineJobId === job.jobId ? " selected" : ""}`} onClick={() => props.setPipelineJobId(job.jobId)}>
              <div className="job-card-top">
                <span className={`job-status-badge job-status--${job.status}`}>{JOB_STATUS_LABEL[job.status] ?? job.status}</span>
                <span className="job-agent-count">{job.agentIds.length} agents</span>
              </div>
              <div className="job-card-intent">{job.intentSummary.length > 80 ? `${job.intentSummary.slice(0, 80)}...` : job.intentSummary}</div>
              <div className="job-card-meta">
                {job.intentFile && <span>{job.intentFile}</span>}
                <span>{elapsed(job.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Pipeline */}
        <div className="pipeline-panel">
          {selectedJob ? (
            <>
              <div className="pipeline-header">
                <h3>Pipeline &mdash; {selectedJob.jobId.slice(0, 16)}</h3>
                <button className="btn btn-accent" onClick={() => props.navigateToReview(selectedJob.jobId)}>
                  <SwarmDot /> View Swarm
                </button>
              </div>
              <PipelineDiagram job={selectedJob} agents={agents} />
            </>
          ) : (
            <div className="empty-state">Select a job to view its pipeline.</div>
          )}
        </div>
      </div>

      {/* Create-job modal */}
      {createOpen && (
        <>
          <div className="modal-overlay" onClick={() => props.setCreateOpen(false)} />
          <div className="modal">
            <div className="modal-header">
              <h3>New Job</h3>
              <button className="modal-close" onClick={() => props.setCreateOpen(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-tabs">
                <button className={`form-tab${createMode === "file" ? " active" : ""}`} onClick={() => props.setCreateMode("file")}>From File</button>
                <button className={`form-tab${createMode === "inline" ? " active" : ""}`} onClick={() => props.setCreateMode("inline")}>Inline</button>
              </div>
              {createMode === "file" ? (
                <div className="form-field">
                  <label>Intent File</label>
                  <select value={props.createIntentFile} onChange={(e) => props.setCreateIntentFile(e.target.value)}>
                    <option value="">Select an intent file...</option>
                    {intents.map((i) => <option key={i.file} value={i.file}>{i.name} ({i.file})</option>)}
                  </select>
                  {intents.length === 0 && <div className="form-hint">No intent files found in intents/ directory.</div>}
                </div>
              ) : (
                <>
                  <div className="form-field">
                    <label>Intent</label>
                    <textarea rows={3} value={props.createInlineIntent} onChange={(e) => props.setCreateInlineIntent(e.target.value)} placeholder="Describe the high-level objective..." />
                  </div>
                  <div className="form-field">
                    <label>Constraints (one per line)</label>
                    <textarea rows={3} value={props.createConstraints} onChange={(e) => props.setCreateConstraints(e.target.value)} placeholder="Use TypeScript&#10;Write tests&#10;All CI checks must pass" />
                  </div>
                </>
              )}
              <div className="form-field-group">
                <div className="form-field-group-label">Trust Thresholds</div>
                <div className="threshold-row">
                  <div className="form-field form-field-sm">
                    <label>Auto-Approve</label>
                    <input type="number" step="0.01" min="0" max="1" value={props.createAutoApprove} onChange={(e) => props.setCreateAutoApprove(e.target.value)} />
                  </div>
                  <div className="form-field form-field-sm">
                    <label>Escalate</label>
                    <input type="number" step="0.01" min="0" max="1" value={props.createEscalate} onChange={(e) => props.setCreateEscalate(e.target.value)} />
                  </div>
                  <div className="form-field form-field-sm">
                    <label>Block</label>
                    <input type="number" step="0.01" min="0" max="1" value={props.createBlock} onChange={(e) => props.setCreateBlock(e.target.value)} />
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => props.setCreateOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={creating} onClick={() => props.doCreateJob()}>
                {creating ? "Launching..." : "Launch Job"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Swarm & Exception Review View ──────────────────────────

interface ReviewProps {
  jobs: JobRecord[];
  agents: Agent[];
  exceptions: ReviewException[];
  metrics: Metrics;
  loading: boolean;
  selectedJobId: string | null;
  setSelectedJobId: (v: string | null) => void;
  pendingExceptions: ReviewException[];
  resolvedExceptions: ReviewException[];
  resolvedVisible: boolean;
  setResolvedVisible: React.Dispatch<React.SetStateAction<boolean>>;
  openCards: Record<string, boolean>;
  setOpenCards: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  followupOpen: Record<string, boolean>;
  setFollowupOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  followupText: Record<string, string>;
  setFollowupText: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  doReview: (id: string, action: "approve" | "reject") => void;
  doFollowup: (id: string, msg: string) => void;
  doAddTestException: () => void;
  testExceptionAdding: boolean;
  openPopover: (agent: Agent, target: HTMLDivElement) => void;
  onDotMouseLeave: () => void;
  pillCounts: Metrics["statusCounts"] & Record<string, unknown>;
  metricTiles: Array<{ label: string; value: string; target: string; cls: string }>;
  feedEvents: Array<{ key: string; time: string; agent: string; type: string; [k: string]: unknown }>;
}

function ReviewView(props: ReviewProps) {
  const { jobs, agents, loading, selectedJobId, pendingExceptions, resolvedExceptions, resolvedVisible, pillCounts, metricTiles, feedEvents } = props;

  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [jobs],
  );

  return (
    <div className="delegation-view">
      <div className="view-header view-header--no-actions">
        <div className="view-header-title">
          <h2>Swarm &amp; Exception Review</h2>
          <span className="view-tab-name">Swarm</span>
        </div>
      </div>

      <div className="delegation-body">
        {/* Left: Job list — same as Intent Delegation */}
        <div className="job-list">
          {sortedJobs.length === 0 && <div className="empty-state">No jobs yet. Create one from the Intents tab.</div>}
          {sortedJobs.map((job) => (
            <div key={job.jobId} className={`job-card${selectedJobId === job.jobId ? " selected" : ""}`} onClick={() => props.setSelectedJobId(job.jobId)}>
              <div className="job-card-top">
                <span className={`job-status-badge job-status--${job.status}`}>{JOB_STATUS_LABEL[job.status] ?? job.status}</span>
                <span className="job-agent-count">{job.agentIds.length} agents</span>
              </div>
              <div className="job-card-intent">{job.intentSummary.length > 80 ? `${job.intentSummary.slice(0, 80)}...` : job.intentSummary}</div>
              <div className="job-card-meta">
                {job.intentFile && <span>{job.intentFile}</span>}
                <span>{elapsed(job.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Right: Dashboard */}
        <div className="review-dashboard">
          {/* Metrics strip */}
          <div className="metrics-strip metrics-strip--inline">
            {metricTiles.map((t) => (
              <div key={t.label} className="metric-tile">
                <div className="metric-value">{t.value}</div>
                <div className="metric-label">{t.label}</div>
                <div className={`metric-target ${t.cls}`}>{t.target}</div>
              </div>
            ))}
          </div>

          <div className="review-body">
            {/* Left: Swarm grid */}
            <div className="panel swarm-panel">
              <div className="panel-header">Agent Swarm</div>
              {loading ? (
                <div className="loading-msg">Loading...</div>
              ) : (
                <>
                  <div className="swarm-section">
                    {[
                      { label: "Running", count: pillCounts?.running ?? 0, color: "var(--blue)" },
                      { label: "Finished", count: pillCounts?.finished ?? 0, color: "var(--green)" },
                      { label: "Error", count: pillCounts?.error ?? 0, color: "var(--red)" },
                      { label: "Blocked", count: pillCounts?.blocked ?? 0, color: "var(--amber)" },
                      { label: "Creating", count: pillCounts?.creating ?? 0, color: "var(--gray)" },
                    ].map((r) => (
                      <div className="swarm-status-row" key={r.label}>
                        <span className="dot" style={{ background: r.color }} />
                        <span>{r.label}</span>
                        <span className="count">{r.count}</span>
                      </div>
                    ))}
                  </div>
                  <div className="swarm-section">
                    <div className="agent-grid">
                      {agents.map((agent) => {
                        const isActive = agent.status === "RUNNING" || agent.status === "CREATING";
                        return (
                          <div
                            key={agent.id}
                            className={`agent-dot${isActive ? " agent-spinning" : ""}`}
                            data-status={agent.status}
                            title={`${agent.name ?? agent.id.slice(0, 8)} [${agent.status}]${agent.trust != null ? ` \u03C4=${agent.trust.toFixed(2)}` : ""}`}
                            onMouseEnter={(e) => props.openPopover(agent, e.currentTarget)}
                            onMouseLeave={props.onDotMouseLeave}
                          />
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Right: Exception queue */}
            <div className="panel exception-panel">
              <div className="panel-header-row">
                <span>Exception Review Queue</span>
                {selectedJobId && (
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={props.doAddTestException}
                    disabled={props.testExceptionAdding}
                    title="Add a synthetic exception for testing"
                  >
                    {props.testExceptionAdding ? "Adding…" : "+ Test"}
                  </button>
                )}
              </div>
              {loading ? (
                <div className="loading-msg">Loading...</div>
              ) : (
                <>
                  <div className="exception-list">
                    {pendingExceptions.map((ex) => (
                      <ExceptionCard
                        key={ex.id}
                        ex={ex}
                        agents={agents}
                        isOpen={Boolean(props.openCards[ex.id])}
                        toggleOpen={() => props.setOpenCards((p) => ({ ...p, [ex.id]: !p[ex.id] }))}
                        followupIsOpen={Boolean(props.followupOpen[ex.id])}
                        followupTextVal={props.followupText[ex.id] ?? ""}
                        onFollowupToggle={() => props.setFollowupOpen((p) => ({ ...p, [ex.id]: !p[ex.id] }))}
                        onFollowupChange={(v) => props.setFollowupText((p) => ({ ...p, [ex.id]: v }))}
                        onReview={props.doReview}
                        onFollowup={props.doFollowup}
                        resolved={false}
                      />
                    ))}
                  </div>
                  {resolvedExceptions.length > 0 && (
                    <div className="exc-resolved-section">
                      <button className="exc-resolved-toggle" onClick={() => props.setResolvedVisible((p) => !p)}>
                        Resolved ({resolvedExceptions.length})
                      </button>
                      <div className={`exc-resolved-list${resolvedVisible ? " open" : ""}`}>
                        <div className="exception-list">
                          {resolvedExceptions.map((ex) => (
                            <ExceptionCard
                              key={ex.id}
                              ex={ex}
                              agents={agents}
                              isOpen={Boolean(props.openCards[ex.id])}
                              toggleOpen={() => props.setOpenCards((p) => ({ ...p, [ex.id]: !p[ex.id] }))}
                              followupIsOpen={false}
                              followupTextVal=""
                              onFollowupToggle={() => {}}
                              onFollowupChange={() => {}}
                              onReview={props.doReview}
                              onFollowup={props.doFollowup}
                              resolved
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Activity feed */}
          <div className="activity-feed">
            <div className="panel-header">Activity Feed</div>
            <div className="feed-list">
              {loading ? (
                <div className="loading-msg feed-loading">Loading...</div>
              ) : feedEvents.length === 0 ? (
                <div className="loading-msg feed-loading">No activity yet</div>
              ) : (
                feedEvents.map((ev) => (
                  <div className="feed-item" key={ev.key}>
                    <span className="feed-time">{formatTime(ev.time)}</span>
                    <span className="feed-agent">{ev.agent}</span>
                    <span className="feed-event">
                      {ev.type === "exception" && <>Exception <span className={`tag-${(ev.decision as string) ?? "escalate"}`}>[{(ev.decision as string) ?? "escalate"}]</span> confidence={(ev.confidence as number).toFixed(2)}</>}
                      {ev.type === "resolved" && <>Resolved &rarr; <span className="tag-approve">{ev.result as string}</span></>}
                      {ev.type === "finished" && <>FINISHED{(ev.trust as number | null) != null && <> &rarr; <span className="tag-approve">auto_approved</span> (\u03C4={(ev.trust as number).toFixed(2)})</>}</>}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Exception Card (reusable) ──────────────────────────────

interface ExceptionCardProps {
  ex: ReviewException;
  agents: Agent[];
  isOpen: boolean;
  toggleOpen: () => void;
  followupIsOpen: boolean;
  followupTextVal: string;
  onFollowupToggle: () => void;
  onFollowupChange: (v: string) => void;
  onReview: (id: string, action: "approve" | "reject") => void;
  onFollowup: (id: string, msg: string) => void;
  resolved: boolean;
}

function ExceptionCard({ ex, agents, isOpen, toggleOpen, followupIsOpen, followupTextVal, onFollowupToggle, onFollowupChange, onReview, onFollowup, resolved }: ExceptionCardProps) {
  const name = agents.find((a) => a.id === ex.agentId)?.name ?? ex.agentId.slice(0, 12);
  const confidence = ex.confidence ?? 0;
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.85 ? "var(--green)" : confidence >= 0.6 ? "var(--amber)" : "var(--red)";

  return (
    <div className={`exc-card${isOpen ? " open" : ""}${resolved ? " resolved-card" : ""}`} data-decision={ex.decision ?? "escalate"}>
      <div className="exc-header" onClick={toggleOpen}>
        <span className={`exc-badge ${resolved ? "resolved" : (ex.decision ?? "escalate")}`}>
          {resolved ? ex.resolved : (ex.decision ?? "escalate")}
        </span>
        <span className="exc-name">{name}</span>
        <div className="exc-confidence">
          <div className="conf-bar-track"><div className="conf-bar-fill" style={{ width: `${pct}%`, background: color }} /></div>
          <div className="conf-label">{pct}%</div>
        </div>
      </div>
      <div className="exc-body">
        <ul className="exc-checks">
          {(ex.checks ?? []).map((c) => (
            <li key={`${ex.id}-${c.name}`}>
              <span className={`check-icon ${c.passed ? "check-pass" : "check-fail"}`}>{c.passed ? "\u2713" : "\u2717"}</span>
              <span>{c.name}{c.output ? `: ${String(c.output).slice(0, 80)}` : ""}</span>
            </li>
          ))}
        </ul>
        <div className="exc-meta">
          {ex.branchName && <>Branch: {ex.branchName}<br /></>}
          {ex.prUrl && <>PR: <a href={ex.prUrl} target="_blank" rel="noreferrer">{ex.prUrl}</a><br /></>}
          Created: {elapsed(ex.createdAt)}
        </div>
        {!resolved && (
          <>
            <div className="exc-actions">
              <button className="btn btn-approve" onClick={(e) => { e.stopPropagation(); onReview(ex.id, "approve"); }}>Approve</button>
              <button className="btn btn-reject" onClick={(e) => { e.stopPropagation(); onReview(ex.id, "reject"); }}>Reject</button>
              {ex.decision === "blocked" && <button className="btn btn-followup" onClick={(e) => { e.stopPropagation(); onFollowupToggle(); }}>Follow-up</button>}
            </div>
            <div className={`followup-input${followupIsOpen ? " open" : ""}`}>
              <input type="text" value={followupTextVal} placeholder="Send guidance to agent..." onChange={(e) => onFollowupChange(e.target.value)} />
              <button className="btn followup-send" onClick={() => { const m = followupTextVal.trim(); if (m) onFollowup(ex.id, m); }}>Send</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
