import { useEffect, useMemo, useState } from "react";

interface Agent {
  id: string;
  name?: string;
  status: "RUNNING" | "FINISHED" | "ERROR" | "STOPPED" | "CREATING" | string;
  branch?: string;
  prUrl?: string;
  summary?: string;
  createdAt: string;
  trust: number | null;
  intent: string | null;
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

interface PopoverState {
  agent: Agent;
  left: number;
  top: number;
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

function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [exceptions, setExceptions] = useState<ReviewException[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({});
  const [loading, setLoading] = useState(true);
  const [resolvedVisible, setResolvedVisible] = useState(false);
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  const [followupOpen, setFollowupOpen] = useState<Record<string, boolean>>({});
  const [followupText, setFollowupText] = useState<Record<string, string>>({});
  const [popover, setPopover] = useState<PopoverState | null>(null);

  const fetchAll = async () => {
    try {
      const [agentsRes, exceptionsRes, metricsRes] = await Promise.all([
        fetch("/api/agents"),
        fetch("/api/exceptions?all=1"),
        fetch("/api/metrics"),
      ]);
      const [agentsJson, exceptionsJson, metricsJson] = await Promise.all([
        agentsRes.json() as Promise<Agent[]>,
        exceptionsRes.json() as Promise<ReviewException[]>,
        metricsRes.json() as Promise<Metrics>,
      ]);
      setAgents(agentsJson);
      setExceptions(exceptionsJson);
      setMetrics(metricsJson);
      setLoading(false);
    } catch (error) {
      console.error("Fetch error:", error);
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAll();
    const timer = window.setInterval(() => {
      void fetchAll();
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const pendingExceptions = useMemo(
    () =>
      exceptions
        .filter((e) => !e.resolved)
        .sort((a, b) => {
          const severityOrder: Record<string, number> = { blocked: 0, block: 1, escalate: 2 };
          return (severityOrder[a.decision] ?? 9) - (severityOrder[b.decision] ?? 9);
        }),
    [exceptions],
  );

  const resolvedExceptions = useMemo(
    () => exceptions.filter((e) => Boolean(e.resolved)),
    [exceptions],
  );

  const pillCounts = metrics.statusCounts ?? {};
  const exceptionsCount = pendingExceptions.length;

  const trustCounts = useMemo(() => {
    const counts = { high: 0, med: 0, low: 0 };
    for (const agent of agents) {
      if (agent.trust == null) continue;
      if (agent.trust >= 0.85) counts.high += 1;
      else if (agent.trust >= 0.6) counts.med += 1;
      else counts.low += 1;
    }
    return counts;
  }, [agents]);

  const feedEvents = useMemo(() => {
    const events: Array<
      | {
          key: string;
          time: string;
          agent: string;
          type: "exception";
          decision: string;
          confidence: number;
        }
      | {
          key: string;
          time: string;
          agent: string;
          type: "resolved";
          result: string;
        }
      | {
          key: string;
          time: string;
          agent: string;
          type: "finished";
          trust: number | null;
        }
    > = [];

    for (const exception of exceptions) {
      const agentName =
        agents.find((a) => a.id === exception.agentId)?.name ??
        exception.agentId.slice(0, 12);
      events.push({
        key: `${exception.id}-exception`,
        time: exception.createdAt,
        agent: agentName,
        type: "exception",
        decision: exception.decision ?? "escalate",
        confidence: exception.confidence ?? 0,
      });
      if (exception.resolved) {
        events.push({
          key: `${exception.id}-resolved`,
          time: exception.createdAt,
          agent: agentName,
          type: "resolved",
          result: exception.resolved,
        });
      }
    }

    for (const agent of agents) {
      if (agent.status === "FINISHED") {
        events.push({
          key: `${agent.id}-finished`,
          time: agent.createdAt,
          agent: agent.name ?? agent.id.slice(0, 12),
          type: "finished",
          trust: agent.trust,
        });
      }
    }

    return events
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 25);
  }, [agents, exceptions]);

  const doReview = async (exceptionId: string, action: "approve" | "reject") => {
    await fetch(`/api/review/${action}/${exceptionId}`, {
      headers: { Accept: "application/json" },
    });
    await fetchAll();
  };

  const doFollowup = async (exceptionId: string, message: string) => {
    await fetch(`/api/review/followup/${exceptionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    setFollowupText((prev) => ({ ...prev, [exceptionId]: "" }));
    setFollowupOpen((prev) => ({ ...prev, [exceptionId]: false }));
    await fetchAll();
  };

  const openPopover = (agent: Agent, target: HTMLDivElement) => {
    const rect = target.getBoundingClientRect();
    const width = 320;
    let left = rect.right + 8;
    let top = rect.top - 20;
    if (left + width > window.innerWidth) left = rect.left - width - 8;
    if (top + 300 > window.innerHeight) top = window.innerHeight - 310;
    if (top < 8) top = 8;
    setPopover({ agent, left, top });
  };

  const metricExceptionRate = metrics.exceptionRate ?? 0;
  const metricTiles = [
    {
      label: "Effective Fan-Out",
      value: metrics.effectiveFanOut != null ? metrics.effectiveFanOut.toFixed(1) : "—",
      target: "Eq. 2: N(1 - Pe·Tr/Tc)",
      className: "target-ok",
    },
    {
      label: "Exception Rate",
      value: `${(metricExceptionRate * 100).toFixed(1)}%`,
      target: metricExceptionRate <= 0.1 ? "< 10% ✓" : "> 10% ⚠",
      className: metricExceptionRate <= 0.1 ? "target-ok" : "target-warn",
    },
    {
      label: "Throughput / hr",
      value: metrics.throughputPerHour != null ? String(metrics.throughputPerHour) : "—",
      target: "FINISHED in last 1h",
      className: "target-ok",
    },
    {
      label: "Trust Mean",
      value: metrics.trustMean != null ? metrics.trustMean.toFixed(2) : "—",
      target:
        metrics.trustMean == null
          ? ""
          : metrics.trustMean >= 0.7
            ? "Healthy"
            : "Low",
      className:
        metrics.trustMean == null
          ? "target-na"
          : metrics.trustMean >= 0.7
            ? "target-ok"
            : "target-warn",
    },
    {
      label: "Containment",
      value: metrics.containmentRatio != null ? `${(metrics.containmentRatio * 100).toFixed(0)}%` : "—",
      target: "Auto-approved / total",
      className: (metrics.containmentRatio ?? 0) >= 0.9 ? "target-ok" : "target-warn",
    },
    {
      label: "Coord. Cost",
      value: "N/A",
      target: "Not yet instrumented",
      className: "target-na",
      dimmed: true,
    },
    {
      label: "Adapt. Speed",
      value: "N/A",
      target: "Not yet instrumented",
      className: "target-na",
      dimmed: true,
    },
    {
      label: "Intent Fidelity",
      value: "N/A",
      target: "Not yet instrumented",
      className: "target-na",
      dimmed: true,
    },
  ];

  return (
    <div className="app-root">
      <div className="header">
        <div className="header-left">
          <div className="logo">
            ARGUS<span>Adaptive Stigmergic Oversight</span>
          </div>
        </div>
        <div className="status-pills">
          <div className="pill pill-running">
            <div className="dot" />
            <span>{pillCounts.running ?? 0}</span> Running
          </div>
          <div className="pill pill-finished">
            <div className="dot" />
            <span>{pillCounts.finished ?? 0}</span> Done
          </div>
          <div className="pill pill-error">
            <div className="dot" />
            <span>{pillCounts.error ?? 0}</span> Error
          </div>
          <div className="pill pill-exceptions">
            <div className="dot" />
            <span>{exceptionsCount}</span> Exceptions
          </div>
        </div>
      </div>

      <div className="metrics-strip">
        {metricTiles.map((tile) => (
          <div
            key={tile.label}
            className={`metric-tile${tile.dimmed ? " dimmed" : ""}`}
          >
            <div className="metric-value">{tile.value}</div>
            <div className="metric-label">{tile.label}</div>
            <div className={`metric-target ${tile.className}`}>{tile.target}</div>
          </div>
        ))}
      </div>

      <div className="main">
        <div className="panel">
          <div className="panel-header">Agent Swarm</div>
          {loading ? (
            <div className="loading-msg">Loading agents...</div>
          ) : (
            <>
              <div className="swarm-section">
                {[
                  { label: "Running", count: pillCounts.running ?? 0, color: "var(--blue)" },
                  { label: "Finished", count: pillCounts.finished ?? 0, color: "var(--green)" },
                  { label: "Error", count: pillCounts.error ?? 0, color: "var(--red)" },
                  { label: "Blocked", count: pillCounts.blocked ?? 0, color: "var(--amber)" },
                  { label: "Creating", count: pillCounts.creating ?? 0, color: "var(--gray)" },
                ].map((row) => (
                  <div className="swarm-status-row" key={row.label}>
                    <div className="dot" style={{ background: row.color }} />
                    <span>{row.label}</span>
                    <span className="count">{row.count}</span>
                  </div>
                ))}
              </div>

              <div className="swarm-section">
                <div className="agent-grid">
                  {agents.map((agent) => {
                    let trustClass = "";
                    if (agent.trust != null) {
                      trustClass = agent.trust >= 0.85 ? " trust-high" : agent.trust < 0.6 ? " trust-low" : "";
                    }
                    const title = `${agent.name ?? agent.id.slice(0, 8)} [${agent.status}]${agent.trust != null ? ` τ=${agent.trust.toFixed(2)}` : ""} ${elapsed(agent.createdAt)}`;
                    return (
                      <div
                        key={agent.id}
                        className={`agent-dot${trustClass}`}
                        data-status={agent.status}
                        title={title}
                        onClick={(event) => openPopover(agent, event.currentTarget)}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="swarm-section">
                <div className="subsection-label">Trust Distribution</div>
                <div className="trust-bars">
                  {[
                    { label: "High (≥.85)", count: trustCounts.high, cls: "high" },
                    { label: "Med (.6–.85)", count: trustCounts.med, cls: "med" },
                    { label: "Low (<.6)", count: trustCounts.low, cls: "low" },
                  ].map((item) => {
                    const pct = agents.length > 0 ? (item.count / agents.length) * 100 : 0;
                    return (
                      <div className="trust-row" key={item.label}>
                        <span className="label">{item.label}</span>
                        <div className="trust-bar-track">
                          <div
                            className={`trust-bar-fill ${item.cls}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="count">{item.count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel-header">Exception Review Queue</div>
          {loading ? (
            <div className="loading-msg">Loading exceptions...</div>
          ) : (
            <>
              <div className="exception-list">
                {pendingExceptions.map((exception) => {
                  const agent = agents.find((a) => a.id === exception.agentId);
                  const name = agent?.name ?? exception.agentId.slice(0, 12);
                  const confidence = exception.confidence ?? 0;
                  const confidencePct = Math.round(confidence * 100);
                  const confidenceColor =
                    confidence >= 0.85
                      ? "var(--green)"
                      : confidence >= 0.6
                        ? "var(--amber)"
                        : "var(--red)";
                  const isOpen = Boolean(openCards[exception.id]);
                  const followupIsOpen = Boolean(followupOpen[exception.id]);

                  return (
                    <div
                      key={exception.id}
                      className={`exc-card${isOpen ? " open" : ""}`}
                      data-decision={exception.decision ?? "escalate"}
                    >
                      <div
                        className="exc-header"
                        onClick={() =>
                          setOpenCards((prev) => ({
                            ...prev,
                            [exception.id]: !prev[exception.id],
                          }))
                        }
                      >
                        <span className={`exc-badge ${exception.decision ?? "escalate"}`}>
                          {exception.decision ?? "escalate"}
                        </span>
                        <span className="exc-name">{name}</span>
                        <div className="exc-confidence">
                          <div className="conf-bar-track">
                            <div
                              className="conf-bar-fill"
                              style={{ width: `${confidencePct}%`, background: confidenceColor }}
                            />
                          </div>
                          <div className="conf-label">{confidencePct}%</div>
                        </div>
                      </div>
                      <div className="exc-body">
                        <ul className="exc-checks">
                          {(exception.checks ?? []).map((check) => (
                            <li key={`${exception.id}-${check.name}`}>
                              <span className={`check-icon ${check.passed ? "check-pass" : "check-fail"}`}>
                                {check.passed ? "✓" : "✗"}
                              </span>
                              <span>
                                {check.name}
                                {check.output ? `: ${String(check.output).slice(0, 80)}` : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <div className="exc-meta">
                          {exception.branchName && (
                            <>
                              Branch: {exception.branchName}
                              <br />
                            </>
                          )}
                          {exception.prUrl && (
                            <>
                              PR:{" "}
                              <a href={exception.prUrl} target="_blank" rel="noreferrer">
                                {exception.prUrl}
                              </a>
                              <br />
                            </>
                          )}
                          Created: {elapsed(exception.createdAt)}
                        </div>

                        <div className="exc-actions">
                          <button
                            className="btn btn-approve"
                            onClick={(event) => {
                              event.stopPropagation();
                              void doReview(exception.id, "approve");
                            }}
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-reject"
                            onClick={(event) => {
                              event.stopPropagation();
                              void doReview(exception.id, "reject");
                            }}
                          >
                            Reject
                          </button>
                          {exception.decision === "blocked" && (
                            <button
                              className="btn btn-followup"
                              onClick={(event) => {
                                event.stopPropagation();
                                setFollowupOpen((prev) => ({
                                  ...prev,
                                  [exception.id]: !prev[exception.id],
                                }));
                              }}
                            >
                              Follow-up
                            </button>
                          )}
                        </div>

                        <div className={`followup-input${followupIsOpen ? " open" : ""}`}>
                          <input
                            type="text"
                            value={followupText[exception.id] ?? ""}
                            placeholder="Send guidance to agent..."
                            onChange={(event) =>
                              setFollowupText((prev) => ({
                                ...prev,
                                [exception.id]: event.target.value,
                              }))
                            }
                          />
                          <button
                            className="btn followup-send"
                            onClick={() => {
                              const msg = (followupText[exception.id] ?? "").trim();
                              if (msg) void doFollowup(exception.id, msg);
                            }}
                          >
                            Send
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {resolvedExceptions.length > 0 && (
                <div className="exc-resolved-section">
                  <button
                    className="exc-resolved-toggle"
                    onClick={() => setResolvedVisible((prev) => !prev)}
                  >
                    Resolved ({resolvedExceptions.length})
                  </button>
                  <div className={`exc-resolved-list${resolvedVisible ? " open" : ""}`}>
                    <div className="exception-list">
                      {resolvedExceptions.map((exception) => {
                        const agent = agents.find((a) => a.id === exception.agentId);
                        const name = agent?.name ?? exception.agentId.slice(0, 12);
                        const confidence = exception.confidence ?? 0;
                        const confidencePct = Math.round(confidence * 100);
                        const confidenceColor =
                          confidence >= 0.85
                            ? "var(--green)"
                            : confidence >= 0.6
                              ? "var(--amber)"
                              : "var(--red)";
                        const isOpen = Boolean(openCards[exception.id]);
                        return (
                          <div
                            key={exception.id}
                            className={`exc-card resolved-card${isOpen ? " open" : ""}`}
                            data-decision={exception.decision ?? "escalate"}
                          >
                            <div
                              className="exc-header"
                              onClick={() =>
                                setOpenCards((prev) => ({
                                  ...prev,
                                  [exception.id]: !prev[exception.id],
                                }))
                              }
                            >
                              <span className="exc-badge resolved">{exception.resolved}</span>
                              <span className="exc-name">{name}</span>
                              <div className="exc-confidence">
                                <div className="conf-bar-track">
                                  <div
                                    className="conf-bar-fill"
                                    style={{ width: `${confidencePct}%`, background: confidenceColor }}
                                  />
                                </div>
                                <div className="conf-label">{confidencePct}%</div>
                              </div>
                            </div>
                            <div className="exc-body">
                              <ul className="exc-checks">
                                {(exception.checks ?? []).map((check) => (
                                  <li key={`${exception.id}-${check.name}`}>
                                    <span className={`check-icon ${check.passed ? "check-pass" : "check-fail"}`}>
                                      {check.passed ? "✓" : "✗"}
                                    </span>
                                    <span>
                                      {check.name}
                                      {check.output ? `: ${String(check.output).slice(0, 80)}` : ""}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                              <div className="exc-meta">
                                {exception.branchName && (
                                  <>
                                    Branch: {exception.branchName}
                                    <br />
                                  </>
                                )}
                                {exception.prUrl && (
                                  <>
                                    PR:{" "}
                                    <a href={exception.prUrl} target="_blank" rel="noreferrer">
                                      {exception.prUrl}
                                    </a>
                                    <br />
                                  </>
                                )}
                                Created: {elapsed(exception.createdAt)}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="activity-feed">
        <div className="panel-header">Activity Feed</div>
        <div className="feed-list">
          {loading ? (
            <div className="loading-msg feed-loading">Loading...</div>
          ) : feedEvents.length === 0 ? (
            <div className="loading-msg feed-loading">No activity yet</div>
          ) : (
            feedEvents.map((event) => (
              <div className="feed-item" key={event.key}>
                <span className="feed-time">{formatTime(event.time)}</span>
                <span className="feed-agent">{event.agent}</span>
                <span className="feed-event">
                  {event.type === "exception" && (
                    <>
                      Exception{" "}
                      <span className={`tag-${event.decision ?? "escalate"}`}>
                        [{event.decision ?? "escalate"}]
                      </span>{" "}
                      confidence={event.confidence.toFixed(2)}
                    </>
                  )}
                  {event.type === "resolved" && (
                    <>
                      Resolved {"\u2192"} <span className="tag-approve">{event.result}</span>
                    </>
                  )}
                  {event.type === "finished" && (
                    <>
                      FINISHED
                      {event.trust != null && (
                        <>
                          {" "}
                          {"\u2192"} <span className="tag-approve">auto_approved</span>{" "}
                          (τ={event.trust.toFixed(2)})
                        </>
                      )}
                    </>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {popover && (
        <>
          <div className="popover-overlay open" onClick={() => setPopover(null)} />
          <div className="popover" style={{ left: popover.left, top: popover.top }}>
            <h3>
              <div
                className="dot"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: STATUS_COLORS[popover.agent.status] ?? "var(--gray)",
                }}
              />
              {popover.agent.name ?? popover.agent.id.slice(0, 12)}
            </h3>
            <div className="popover-row">
              <span className="label">Status</span>
              <span className="value">{popover.agent.status}</span>
            </div>
            <div className="popover-row">
              <span className="label">ID</span>
              <span className="value">{`${popover.agent.id.slice(0, 16)}...`}</span>
            </div>
            {popover.agent.branch && (
              <div className="popover-row">
                <span className="label">Branch</span>
                <span className="value">{popover.agent.branch}</span>
              </div>
            )}
            {popover.agent.prUrl && (
              <div className="popover-row">
                <span className="label">PR</span>
                <span className="value">
                  <a href={popover.agent.prUrl} target="_blank" rel="noreferrer">
                    View PR
                  </a>
                </span>
              </div>
            )}
            {popover.agent.trust != null && (
              <div className="popover-row">
                <span className="label">Trust (τ)</span>
                <span className="value">{popover.agent.trust.toFixed(3)}</span>
              </div>
            )}
            <div className="popover-row">
              <span className="label">Elapsed</span>
              <span className="value">{elapsed(popover.agent.createdAt)}</span>
            </div>
            {popover.agent.intent && (
              <div className="popover-row">
                <span className="label">Intent</span>
                <span className="value">
                  {popover.agent.intent.length > 60
                    ? `${popover.agent.intent.slice(0, 60)}...`
                    : popover.agent.intent}
                </span>
              </div>
            )}
            {popover.agent.summary && (
              <div className="popover-summary">{popover.agent.summary}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default App;
