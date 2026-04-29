import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ParsedIntentPreview, parseIntentYamlContent } from "./parseIntent";

// ── Types ──────────────────────────────────────────────────

/** θ from validation snapshot (confidence gate; not trust τ). */
interface ReviewGateRef {
  reviewThreshold: number;
}

interface AgentValidationSnapshot {
  agentId: string;
  validatedAt: string;
  confidence: number;
  decision: string;
  validationMode?: string;
  fallbackReason?: string;
  reviewGate?: ReviewGateRef;
  /** @deprecated Legacy persisted snapshots */
  trustThresholds?: { autoApprove?: number; escalate?: number; block?: number };
  checks: Array<{ name: string; passed: boolean; output?: string }>;
}

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
  /** Last validator output after FINISHED/ERROR webhook (`.argus/validation-snapshots.json`) */
  validation?: AgentValidationSnapshot | null;
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
  decision: "blocked" | "block" | "escalate" | "human_review" | "auto_approve" | string;
  createdAt: string;
  resolved?: "approved" | "rejected";
  /** Set by + Test — for UI labelling only */
  synthetic?: boolean;
  /** Paper θ for this row */
  reviewGate?: ReviewGateRef;
  /** @deprecated Legacy rows */
  trustThresholds?: { autoApprove?: number; escalate?: number; block?: number };
}

interface Metrics {
  exceptionRate?: number;
  effectiveFanOut?: number;
  throughputPerHour?: number;
  trustMean?: number | null;
  containmentRatio?: number;
  statusCounts?: {
    running?: number;
    /** Validator: human_review | blocked | legacy escalate/block */
    reviewRequired?: number;
    /** Policy outcome auto_approve */
    autoApproved?: number;
    /** FINISHED terminals with no validator snapshot yet */
    pendingValidation?: number;
    /** Cursor agent run failed (ERROR) */
    lifecycleError?: number;
    /** Cursor STOPPED */
    lifecycleStopped?: number;
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

/** Activity feed rows (exception entries carry policy bands like exception cards). */
type ActivityFeedEntry =
  | {
      key: string;
      time: string;
      agent: string;
      type: "exception";
      agentId: string;
      decision: string;
      confidence: number;
      /** Smoothed τ from trust store (not the same as policy confidence). */
      agentTrust: number | null;
      /** θ used to color policy confidence in the feed */
      reviewThreshold: number;
    }
  | { key: string; time: string; agent: string; type: "resolved"; result: string }
  | {
      key: string;
      time: string;
      agent: string;
      type: "finished";
      trust: number | null;
      /** Validator policy from snapshot; omitted means still loading — do not imply auto_approve */
      policyDecision: string | null;
    };

// ── Helpers ────────────────────────────────────────────────

/** CSS suffix for `.tag-*` in activity feed (matches `--red`/`--amber`/`--green` rules). */
function feedPolicyTagClass(decision: string): string {
  if (decision === "auto_approve") return "approve";
  if (decision === "block" || decision === "blocked") return "block";
  return "escalate";
}

/** Swarm dot color: aligns with validator / review queue, not raw Cursor status alone. */
type SwarmDotPolicy =
  | "running"
  | "review_required"
  | "auto_approve"
  | "pending_validation"
  | "lifecycle_error"
  | "lifecycle_stopped";

function swarmDotPolicy(agent: Agent, pendingReviewAgentIds: Set<string>): SwarmDotPolicy {
  const s = agent.status;
  if (s === "RUNNING" || s === "CREATING") return "running";
  if (s === "ERROR") return "lifecycle_error";
  if (s === "STOPPED") return "lifecycle_stopped";
  const d = agent.validation?.decision ?? null;
  if (d === "auto_approve") return "auto_approve";
  if (d === "block" || d === "blocked" || d === "escalate" || d === "human_review") return "review_required";
  if (pendingReviewAgentIds.has(agent.id)) return "review_required";
  return "pending_validation";
}

/** Solid fill for popover/list dots — mirrors `.agent-dot[data-policy]` in `index.css`. */
function swarmPolicyBackground(policy: SwarmDotPolicy): string {
  switch (policy) {
    case "running":
      return "var(--blue)";
    case "review_required":
      return "var(--amber)";
    case "auto_approve":
      return "var(--green)";
    case "pending_validation":
      return "var(--gray)";
    case "lifecycle_error":
      return "#dc2626";
    case "lifecycle_stopped":
      return "var(--amber)";
    default:
      return "var(--gray)";
  }
}

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

const DEFAULT_REVIEW_THETA = 0.85;

function resolveSnapshotTheta(v?: Pick<AgentValidationSnapshot, "reviewGate" | "trustThresholds">): number {
  return v?.reviewGate?.reviewThreshold ?? v?.trustThresholds?.autoApprove ?? DEFAULT_REVIEW_THETA;
}

function resolveExceptionTheta(ex: Pick<ReviewException, "reviewGate" | "trustThresholds">): number {
  return ex.reviewGate?.reviewThreshold ?? ex.trustThresholds?.autoApprove ?? DEFAULT_REVIEW_THETA;
}

/** Bar color: binary vs θ; blocked lifecycle uses red. */
function confidenceBarColor(confidence: number, theta: number, decision?: string): string {
  if (decision === "blocked" || decision === "block") return "var(--red)";
  return confidence >= theta ? "var(--green)" : "var(--amber)";
}

function reviewGateTooltip(theta: number): string {
  return `Policy confidence vs θ=${theta} (Layer 3); τ is shown separately where available`;
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
          {jobAgents.map((a) => {
            const c = STATUS_COLORS[a.status] ?? "var(--gray)";
            const spinning = a.status === "RUNNING" || a.status === "CREATING";
            return (
            <div key={a.id} className="pipeline-agent-row">
              <span className={`pipeline-agent-status ${spinning ? "spinning" : ""}`} style={spinning ? { background: "transparent", color: c } : { borderColor: c, background: c }} />
              <a
                className="pipeline-agent-name pipeline-agent-cursor-link"
                href={`https://cursor.com/agents/${encodeURIComponent(a.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open in Cursor · ${a.id}`}
              >
                {a.name ?? a.id.slice(0, 10)}
              </a>
              <span className="pipeline-agent-label">{a.status}</span>
            </div>
            );
          })}
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
  const [createReviewThreshold, setCreateReviewThreshold] = useState("0.85");
  const [creating, setCreating] = useState(false);

  // Exception review state
  const [resolvedVisible, setResolvedVisible] = useState(false);
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  const [followupOpen, setFollowupOpen] = useState<Record<string, boolean>>({});
  const [followupText, setFollowupText] = useState<Record<string, string>>({});
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [popoverEvidenceOpen, setPopoverEvidenceOpen] = useState(false);
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
  const jobQ = effectiveJobId ? `?jobId=${encodeURIComponent(effectiveJobId)}` : "";
  /** Must use `&jobId=` when the path already has `?` (e.g. `?all=1`); a second `?` breaks parsing and drops job filtering. */
  const jobAmp = effectiveJobId ? `&jobId=${encodeURIComponent(effectiveJobId)}` : "";

  /** Swarm tab: constrain UI to selected job IDs immediately (avoids showing full-repo agents before scoped fetch lands). */
  const reviewJobAgentSet = useMemo(() => {
    if (tab !== "review") return null;
    if (!effectiveJobId) return null;
    const job = jobs.find((j) => j.jobId === effectiveJobId);
    if (!job?.agentIds?.length) return null;
    return new Set(job.agentIds);
  }, [tab, effectiveJobId, jobs]);

  const agentsForReviewView = useMemo(() => {
    if (tab !== "review") return agents;
    if (!reviewJobAgentSet) return [];
    return agents.filter((a) => reviewJobAgentSet.has(a.id));
  }, [tab, agents, reviewJobAgentSet]);

  const exceptionsForReviewScope = useMemo(() => {
    if (tab !== "review") return exceptions;
    if (!reviewJobAgentSet) return [];
    return exceptions.filter((e) => reviewJobAgentSet.has(e.agentId));
  }, [tab, exceptions, reviewJobAgentSet]);

  const fetchAll = useCallback(async () => {
    try {
      const [agentsRes, exceptionsRes, metricsRes, jobsRes] = await Promise.all([
        fetch(`/api/agents${jobQ}`),
        fetch(`/api/exceptions?all=1${jobAmp}`),
        fetch(`/api/metrics${jobQ}`),
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
    setPopoverEvidenceOpen(false);
  }, [popover?.agent.id]);

  /** Poll faster while inspecting an agent card so webhook validation appears soon after FINISHED. */
  useEffect(() => {
    if (!popover) return;
    const burst = window.setInterval(() => void fetchAll(), 2000);
    return () => window.clearInterval(burst);
  }, [popover?.agent.id, fetchAll]);

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
      exceptionsForReviewScope
        .filter((e) => !e.resolved)
        .sort((a, b) => {
          const order: Record<string, number> = {
            blocked: 0,
            block: 1,
            human_review: 2,
            escalate: 3,
            auto_approve: 9,
          };
          return (order[a.decision] ?? 5) - (order[b.decision] ?? 5);
        }),
    [exceptionsForReviewScope],
  );

  const resolvedExceptions = useMemo(
    () => exceptionsForReviewScope.filter((e) => Boolean(e.resolved)),
    [exceptionsForReviewScope],
  );

  const pillCounts = metrics.statusCounts ?? {};

  const feedEvents = useMemo((): ActivityFeedEntry[] => {
    const events: ActivityFeedEntry[] = [];

    for (const ex of exceptionsForReviewScope) {
      const name = agentsForReviewView.find((a) => a.id === ex.agentId)?.name ?? ex.agentId.slice(0, 12);
      const agentTrust = agentsForReviewView.find((a) => a.id === ex.agentId)?.trust ?? null;
      events.push({
        key: `${ex.id}-exc`,
        time: ex.createdAt,
        agent: name,
        type: "exception",
        agentId: ex.agentId,
        decision: ex.decision ?? "human_review",
        confidence: ex.confidence ?? 0,
        agentTrust,
        reviewThreshold: resolveExceptionTheta(ex),
      });
      if (ex.resolved) {
        events.push({ key: `${ex.id}-res`, time: ex.createdAt, agent: name, type: "resolved", result: ex.resolved });
      }
    }
    for (const a of agentsForReviewView) {
      if (a.status === "FINISHED" || a.status === "ERROR" || a.status === "STOPPED") {
        const time = a.finishedAt ?? a.createdAt;
        events.push({
          key: `${a.id}-fin`,
          time,
          agent: a.name ?? a.id.slice(0, 12),
          type: "finished",
          trust: a.trust,
          policyDecision: a.validation?.decision ?? null,
        });
      }
    }
    return events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 25);
  }, [agentsForReviewView, exceptionsForReviewScope]);

  const selectedJob = pipelineJobId ? (jobs.find((j) => j.jobId === pipelineJobId) ?? null) : null;

  /** Swarm grid / popover may open before the next `/api/agents` poll merges webhook validation — always overlay live agent rows. */
  const popoverAgentLive = useMemo(() => {
    if (!popover) return null;
    return agents.find((a) => a.id === popover.agent.id) ?? popover.agent;
  }, [popover, agents]);

  const pendingReviewAgentIdsGlobal = useMemo(
    () => new Set(exceptionsForReviewScope.filter((e) => !e.resolved).map((e) => e.agentId)),
    [exceptionsForReviewScope],
  );

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
          reviewThreshold: parseFloat(createReviewThreshold) || 0.85,
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
        setCreateReviewThreshold("0.85");
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
            createReviewThreshold={createReviewThreshold}
            setCreateReviewThreshold={setCreateReviewThreshold}
            creating={creating}
            doCreateJob={doCreateJob}
            setPipelineJobId={setPipelineJobId}
            navigateToReview={navigateToReview}
          />
        )}

        {tab === "review" && (
          <ReviewView
            jobs={jobs}
            agents={agentsForReviewView}
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
      {popover && popoverAgentLive && (
        <div
          className="popover"
          style={{ left: popover.left, top: popover.top }}
          onMouseEnter={cancelClosePopover}
          onMouseLeave={closePopover}
        >
            <h3>
              <span className="dot" style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: swarmPolicyBackground(swarmDotPolicy(popoverAgentLive, pendingReviewAgentIdsGlobal)) }} />
              {popoverAgentLive.name ?? popoverAgentLive.id.slice(0, 12)}
            </h3>
            <div className="popover-row"><span className="label">Status</span><span className="value">{popoverAgentLive.status}</span></div>
            <div className="popover-row"><span className="label">ID</span><span className="value">{popoverAgentLive.id.slice(0, 16)}...</span></div>
            {popoverAgentLive.branch && <div className="popover-row"><span className="label">Branch</span><span className="value">{popoverAgentLive.branch}</span></div>}
            {popoverAgentLive.prUrl && (
              <div className="popover-row">
                <span className="label">PR</span>
                <span className="value">
                  <a
                    href={popoverAgentLive.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="From Cursor. If you see 404, the PR may not exist or the repository may be disconnected in Cursor for this project."
                  >
                    View PR
                  </a>
                </span>
              </div>
            )}
            <div className="popover-row popover-row-confidence">
              <span className="label">Confidence score</span>
              <span className="value value-confidence">
                <span className="popover-confidence-with-toggle">
                  {popoverAgentLive.validation ? (
                  <span
                    className="popover-confidence-kpi"
                    style={{
                      color: confidenceBarColor(
                        popoverAgentLive.validation.confidence,
                        resolveSnapshotTheta(popoverAgentLive.validation),
                        popoverAgentLive.validation.decision,
                      ),
                    }}
                  >
                    {(popoverAgentLive.validation.confidence * 100).toFixed(1)}%
                  </span>
                ) : (
                  <span className="popover-score-pending">pending job execution</span>
                )}
                  {popoverAgentLive.validation && (
                    <button
                      type="button"
                      className={`popover-evidence-toggle${popoverEvidenceOpen ? " open" : ""}`}
                      title="see evidence"
                      aria-label="see evidence"
                      aria-expanded={popoverEvidenceOpen}
                      onMouseDown={(e) => {
                        /* avoid focus/hover quirks when moving from swarm dot into popover */
                        e.preventDefault();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPopoverEvidenceOpen((o) => !o);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                    </button>
                  )}
                </span>
              </span>
            </div>
            {popoverAgentLive.validation && popoverEvidenceOpen && (
              <div className="popover-validation">
                <div className="popover-validation-title">Validator evidence</div>
                <div className="popover-row">
                  <span className="label">Decision</span>
                  <span className="value">{popoverAgentLive.validation.decision.replace(/_/g, " ")}</span>
                </div>
                {popoverAgentLive.validation.validationMode && (
                  <div className="popover-row">
                    <span className="label">CI signals</span>
                    <span className="value">{popoverAgentLive.validation.validationMode === "github_checks" ? "GitHub Checks" : "Metadata (+ cap)"}</span>
                  </div>
                )}
                {popoverAgentLive.validation.fallbackReason && (
                  <div className="popover-validation-note">
                    {popoverAgentLive.validation.validationMode === "metadata_fallback" ? "Without full CI, confidence is capped — " : ""}
                    {popoverAgentLive.validation.fallbackReason}
                  </div>
                )}
                <ul className="popover-checks">
                  {popoverAgentLive.validation.checks.map((c) => (
                    <li key={`${popoverAgentLive.id}-${c.name}`}>
                      <span className={c.passed ? "check-yes" : "check-no"}>{c.passed ? "\u2713" : "\u2717"}</span>
                      <span className="check-name">{c.name}</span>
                      {c.output != null && c.output !== "" && (
                        <div className="check-out">{String(c.output)}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {popoverAgentLive.trust != null && (
              <div className="popover-row">
                <span className="label">Trust score</span>
                <span className="value" title="Smoothed from outcomes (paper Eq. 4); separate from validator score above">
                  {popoverAgentLive.trust.toFixed(3)}
                </span>
              </div>
            )}
            <div className="popover-row"><span className="label">Elapsed</span><span className="value">{elapsed(popoverAgentLive.createdAt)}</span></div>
            {popoverAgentLive.intent && <div className="popover-row"><span className="label">Intent</span><span className="value">{popoverAgentLive.intent.length > 60 ? `${popoverAgentLive.intent.slice(0, 60)}...` : popoverAgentLive.intent}</span></div>}
            {popoverAgentLive.summary && <div className="popover-summary">{popoverAgentLive.summary}</div>}
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
  createReviewThreshold: string;
  setCreateReviewThreshold: (v: string) => void;
  creating: boolean;
  doCreateJob: () => void;
  setPipelineJobId: (v: string | null) => void;
  navigateToReview: (jobId: string) => void;
}

function DelegationView(props: DelegationProps) {
  const { jobs, agents, intents, pipelineJobId, selectedJob, createOpen, createMode, creating } = props;

  const fileIntentPreview = useMemo((): { parsed: ParsedIntentPreview | null; hasFile: boolean } => {
    if (props.createMode !== "file" || !props.createIntentFile) return { parsed: null, hasFile: false };
    const item = props.intents.find((i) => i.file === props.createIntentFile);
    if (!item?.content) return { parsed: null, hasFile: true };
    return { parsed: parseIntentYamlContent(item.content), hasFile: true };
  }, [props.createMode, props.createIntentFile, props.intents]);

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
                <h3>Pipeline &mdash; {selectedJob.jobId}</h3>
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
                <>
                  <div className="form-field">
                    <label>Intent File</label>
                    <select value={props.createIntentFile} onChange={(e) => props.setCreateIntentFile(e.target.value)}>
                      <option value="">Select an intent file...</option>
                      {intents.map((i) => <option key={i.file} value={i.file}>{i.name} ({i.file})</option>)}
                    </select>
                    {intents.length === 0 && <div className="form-hint">No intent files found in intents/ directory.</div>}
                  </div>
                  {fileIntentPreview.parsed ? (
                    <>
                      <p className="form-hint file-preview-hint">
                        Shown from the selected YAML. The job uses that file on the server. To change intent, constraints, or thresholds, edit the file in the repository (or switch to <strong>Inline</strong> to define a new intent here).
                      </p>
                      <div className="form-field">
                        <label>Intent</label>
                        <textarea
                          className="form-readonly"
                          readOnly
                          rows={4}
                          value={fileIntentPreview.parsed.intent}
                        />
                      </div>
                      <div className="form-field">
                        <label>Constraints (one per line)</label>
                        <textarea
                          className="form-readonly"
                          readOnly
                          rows={4}
                          value={fileIntentPreview.parsed.constraints.join("\n")}
                        />
                      </div>
                      <div className="form-field-group">
                        <div className="form-field-group-label">Review threshold θ (from file)</div>
                        <div className="threshold-row">
                          <div className="form-field">
                            <label>θ — auto-merge iff confidence ≥ θ</label>
                            <input
                              type="number"
                              className="form-readonly"
                              readOnly
                              step="0.01"
                              value={String(fileIntentPreview.parsed.reviewThreshold)}
                            />
                          </div>
                        </div>
                        {(fileIntentPreview.parsed.legacyEscalate != null || fileIntentPreview.parsed.legacyBlock != null) && (
                          <p className="form-hint">
                            Legacy YAML bands (ignored for the merge gate): escalate{" "}
                            {fileIntentPreview.parsed.legacyEscalate ?? "—"}, block {fileIntentPreview.parsed.legacyBlock ?? "—"}
                          </p>
                        )}
                      </div>
                    </>
                  ) : fileIntentPreview.hasFile && props.createIntentFile ? (
                    <div className="form-hint form-hint--warn">Could not parse this file as intent YAML. You can still launch; the server will load it. Fix the file or use Inline to define the intent in the request.</div>
                  ) : (
                    <div className="form-hint">Select a file to preview intent, constraints, and review threshold θ from the YAML.</div>
                  )}
                </>
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
                  <div className="form-field-group">
                    <div className="form-field-group-label">Review threshold θ</div>
                    <div className="threshold-row">
                      <div className="form-field form-field-sm">
                        <label title="Paper Layer 3 — auto-merge when validator confidence ≥ θ">θ (0–1)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={props.createReviewThreshold}
                          onChange={(e) => props.setCreateReviewThreshold(e.target.value)}
                        />
                      </div>
                    </div>
                    <p className="form-hint">Trust τ is tracked separately and does not gate merge; only confidence vs θ does.</p>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => props.setCreateOpen(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={creating || (props.createMode === "file" && !props.createIntentFile) || (props.createMode === "inline" && !props.createInlineIntent.trim())}
                onClick={() => props.doCreateJob()}
              >
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
  feedEvents: ActivityFeedEntry[];
}

function ReviewView(props: ReviewProps) {
  const { jobs, agents, loading, selectedJobId, pendingExceptions, resolvedExceptions, resolvedVisible, pillCounts, metricTiles, feedEvents } = props;

  const pendingReviewAgentIds = useMemo(
    () => new Set(pendingExceptions.map((e) => e.agentId)),
    [pendingExceptions],
  );

  const swarmStatusRows = useMemo(() => {
    const sc = pillCounts;
    const rows: Array<{ label: string; count: number; color: string; hint: string }> = [
      { label: "Running", count: sc?.running ?? 0, color: "var(--blue)", hint: "Agent is executing in Cursor (RUNNING or CREATING)." },
      {
        label: "Review required",
        count: sc?.reviewRequired ?? 0,
        color: "var(--amber)",
        hint: "Validator policy requires human review (confidence below θ or policy gate — same cue as exception cards).",
      },
      {
        label: "Auto-approved",
        count: sc?.autoApproved ?? 0,
        color: "var(--green)",
        hint: "Validator policy is auto_approve.",
      },
      {
        label: "Run failed",
        count: sc?.lifecycleError ?? 0,
        color: "#dc2626",
        hint: "Cursor reported ERROR for this agent run (not the same as policy block).",
      },
    ];
    if ((sc?.lifecycleStopped ?? 0) > 0) {
      rows.push({
        label: "Stopped",
        count: sc?.lifecycleStopped ?? 0,
        color: "var(--amber)",
        hint: "Cursor reported STOPPED for this agent.",
      });
    }
    if ((sc?.pendingValidation ?? 0) > 0) {
      rows.push({
        label: "Awaiting validator",
        count: sc?.pendingValidation ?? 0,
        color: "var(--gray)",
        hint: "Run finished but validation snapshot is not ready yet.",
      });
    }
    return rows;
  }, [pillCounts]);

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
                    {swarmStatusRows.map((r) => (
                      <div className="swarm-status-row" key={r.label} title={r.hint}>
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
                        const policy = swarmDotPolicy(agent, pendingReviewAgentIds);
                        const title =
                          `${agent.name ?? agent.id.slice(0, 8)} · Cursor: ${agent.status}` +
                          (agent.validation?.decision ? ` · Policy: ${agent.validation.decision}` : "") +
                          (agent.trust != null ? ` · τ=${agent.trust.toFixed(2)}` : "");
                        return (
                          <div
                            key={agent.id}
                            className={`agent-dot${isActive ? " agent-spinning" : ""}`}
                            data-policy={policy}
                            data-status={agent.status}
                            title={title}
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
                      {ev.type === "exception" &&
                        (() => {
                          const { confidence, reviewThreshold, decision, agentTrust } = ev;
                          const col = confidenceBarColor(confidence, reviewThreshold, decision);
                          const tipGate = reviewGateTooltip(reviewThreshold);
                          const confPct = (confidence * 100).toFixed(0);
                          return (
                            <>
                              Review queue{" "}
                              <span className={`tag-${feedPolicyTagClass(decision ?? "human_review")}`}>
                                {(decision ?? "human_review").replace(/_/g, " ")}
                              </span>
                              {" — "}
                              <span title={tipGate} style={{ color: col }}>
                                {confPct}% confidence
                              </span>
                              {agentTrust != null && (
                                <>
                                  {" "}
                                  · <span title="Smoothed agent trust (τ), separate from policy confidence">τ {agentTrust.toFixed(2)}</span>
                                </>
                              )}
                            </>
                          );
                        })()}
                      {ev.type === "resolved" && <>Resolved &rarr; <span className="tag-approve">{ev.result as string}</span></>}
                      {ev.type === "finished" && (
                        <>
                          Run finished
                          {ev.policyDecision === "auto_approve" && (
                            <>
                              {" "}
                              &rarr; <span className="tag-approve">auto_approved</span>
                            </>
                          )}
                          {ev.policyDecision && ev.policyDecision !== "auto_approve" && (
                            <>
                              {" "}
                              &rarr;{" "}
                              <span className={`tag-${feedPolicyTagClass(ev.policyDecision)}`}>{ev.policyDecision.replace(/_/g, " ")}</span>
                            </>
                          )}
                          {ev.trust != null && <> (\u03C4={ev.trust.toFixed(2)})</>}
                        </>
                      )}
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

function exceptionBadgeClass(decision: string): string {
  if (decision === "auto_approve") return "auto_approve";
  if (decision === "blocked" || decision === "block") return "blocked";
  return "escalate";
}

function ExceptionCard({ ex, agents, isOpen, toggleOpen, followupIsOpen, followupTextVal, onFollowupToggle, onFollowupChange, onReview, onFollowup, resolved }: ExceptionCardProps) {
  const name = agents.find((a) => a.id === ex.agentId)?.name ?? ex.agentId.slice(0, 12);
  const confidence = ex.confidence ?? 0;
  const pct = Math.round(confidence * 100);
  const color = confidenceBarColor(confidence, resolveExceptionTheta(ex), ex.decision);
  const d = ex.decision ?? "human_review";
  const badgeCls = exceptionBadgeClass(d);

  return (
    <div className={`exc-card${isOpen ? " open" : ""}${resolved ? " resolved-card" : ""}`} data-decision={badgeCls}>
      <div className="exc-header" onClick={toggleOpen}>
        <span className={`exc-badge ${resolved ? "resolved" : badgeCls}`}>
          {resolved ? ex.resolved : d.replace(/_/g, " ")}
        </span>
        {ex.synthetic && <span className="exc-demo-badge" title="Added via + Test">Demo</span>}
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
          {ex.prUrl && (
            <>
              PR:{" "}
              <a
                href={ex.prUrl}
                target="_blank"
                rel="noreferrer"
                title="If this 404s, the PR may not exist or the target repo may not be connected in Cursor."
              >
                {ex.prUrl}
              </a>
              <br />
            </>
          )}
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
