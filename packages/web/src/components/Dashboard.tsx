"use client";

import { startTransition, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type DashboardIssue,
  type AttentionLevel,
  getAttentionLevel,
  isPRRateLimited,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { ThemeToggle } from "./ThemeToggle";

interface DashboardProps {
  initialSessions: DashboardSession[];
  initialIssues?: DashboardIssue[];
  hasIssuesTab?: boolean;
  stats: DashboardStats;
  orchestratorId?: string | null;
  projectName?: string;
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;

export function Dashboard({
  initialSessions,
  initialIssues = [],
  hasIssuesTab = false,
  stats,
  orchestratorId,
  projectName,
}: DashboardProps) {
  const router = useRouter();
  const sessions = useSessionEvents(initialSessions);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [activeTab, setActiveTab] = useState<"agents" | "issues">("agents");
  const [spawningIssueKey, setSpawningIssueKey] = useState<string | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const hasKanbanSessions = KANBAN_LEVELS.some((l) => grouped[l].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );
  const showProjectColumn = useMemo(
    () => new Set(initialIssues.map((issue) => issue.projectId)).size > 1,
    [initialIssues],
  );
  const activeIssueSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (getAttentionLevel(session) === "done") continue;
      const normalizedIssue = normalizeSessionIssue(session);
      if (!normalizedIssue) continue;
      const key = issueKey(session.projectId, normalizedIssue);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [sessions]);

  const handleSpawnIssue = async (issue: DashboardIssue) => {
    const key = issueKey(issue.projectId, issue.id);
    setSpawnError(null);
    setSpawningIssueKey(key);

    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: issue.projectId,
          issueId: issue.id,
        }),
      });

      if (!res.ok) {
        let message = "Failed to spawn session";
        try {
          const data = await res.json() as { error?: string };
          if (data.error) message = data.error;
        } catch {
          const text = await res.text().catch(() => "");
          if (text) message = text;
        }
        throw new Error(message);
      }

      startTransition(() => router.refresh());
    } catch (error) {
      setSpawnError(error instanceof Error ? error.message : "Failed to spawn session");
    } finally {
      setSpawningIssueKey(null);
    }
  };

  return (
    <div className="dashboard-shell px-5 py-5 sm:px-8 sm:py-7">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      {/* Header */}
      <div className="dashboard-header mb-7 rounded-[18px] px-5 py-5 sm:px-7 sm:py-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
              Agent Board
            </div>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:gap-6">
              <h1 className="text-[24px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)] sm:text-[30px]">
                Orchestrator
              </h1>
              <p className="max-w-[640px] text-[12px] leading-relaxed text-[var(--color-text-secondary)] sm:text-[13px]">
                Parallel workstreams, review state, and issue intake on a single board.
              </p>
            </div>
            <StatusLine stats={stats} />
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start">
            <ThemeToggle />
            {orchestratorId && (
              <a
                href={`/sessions/${encodeURIComponent(orchestratorId)}`}
                className="orchestrator-btn flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-semibold hover:no-underline"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
                orchestrator
                <svg className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                </svg>
              </a>
            )}
          </div>
        </div>
      </div>

      {hasIssuesTab && (
        <div className="mb-6 flex w-full items-center gap-2 rounded-[16px] border border-[var(--color-border-default)] bg-[var(--color-bg-panel-strong)] p-1.5 sm:w-auto">
          <button
            onClick={() => setActiveTab("agents")}
            className={
              activeTab === "agents"
                ? "flex-1 rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-accent-subtle)] px-4 py-1.5 text-[12px] font-semibold text-[var(--color-accent)] sm:flex-none"
                : "flex-1 rounded-[12px] border border-transparent px-4 py-1.5 text-[12px] font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-border-default)] hover:text-[var(--color-text-primary)] sm:flex-none"
            }
          >
            Agents
          </button>
          <button
            onClick={() => setActiveTab("issues")}
            className={
              activeTab === "issues"
                ? "flex-1 rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-accent-subtle)] px-4 py-1.5 text-[12px] font-semibold text-[var(--color-accent)] sm:flex-none"
                : "flex-1 rounded-[12px] border border-transparent px-4 py-1.5 text-[12px] font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-border-default)] hover:text-[var(--color-text-primary)] sm:flex-none"
            }
          >
            Issues
            <span className="ml-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)]">
              {initialIssues.length}
            </span>
          </button>
        </div>
      )}

      {activeTab === "agents" ? (
        <>
          {/* Rate limit notice */}
          {anyRateLimited && !rateLimitDismissed && (
            <div className="surface-panel mb-6 flex items-center gap-2.5 rounded-[14px] border-[rgba(203,138,82,0.28)] bg-[var(--zone-review-bg)] px-4 py-3 text-[11px] text-[var(--color-status-attention)]">
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <span className="flex-1">
                GitHub API rate limited — PR data (CI status, review state, sizes) may be stale.
                {" "}Will retry automatically on next refresh.
              </span>
              <button
                onClick={() => setRateLimitDismissed(true)}
                className="ml-1 shrink-0 opacity-60 hover:opacity-100"
                aria-label="Dismiss"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Kanban columns for active zones */}
          {hasKanbanSessions && (
            <div className="mb-8 flex flex-col gap-4 pb-2 lg:flex-row lg:overflow-x-auto">
              {KANBAN_LEVELS.map((level) =>
                grouped[level].length > 0 ? (
                  <div key={level} className="min-w-0 lg:min-w-[200px] lg:flex-1">
                    <AttentionZone
                      level={level}
                      sessions={grouped[level]}
                      variant="column"
                      onSend={handleSend}
                      onKill={handleKill}
                      onMerge={handleMerge}
                      onRestore={handleRestore}
                    />
                  </div>
                ) : null,
              )}
            </div>
          )}

          {/* Done — full-width grid below Kanban */}
          {grouped.done.length > 0 && (
            <div className="mb-8">
              <AttentionZone
                level="done"
                sessions={grouped.done}
                variant="grid"
                onSend={handleSend}
                onKill={handleKill}
                onMerge={handleMerge}
                onRestore={handleRestore}
              />
            </div>
          )}

          {/* PR Table */}
          {openPRs.length > 0 && (
            <div className="mx-auto max-w-[980px]">
              <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
                Pull Requests
              </h2>
              <div className="soft-table overflow-x-auto rounded-[16px]">
                <table className="min-w-[720px] w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border-muted)]">
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        PR
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Title
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Size
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        CI
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Review
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Unresolved
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPRs.map((pr) => (
                      <PRTableRow key={pr.number} pr={pr} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {spawnError && (
            <div className="surface-panel mb-4 rounded-[14px] border-[rgba(201,109,98,0.26)] bg-[var(--zone-respond-bg)] px-4 py-3 text-[11px] text-[var(--color-status-error)]">
              {spawnError}
            </div>
          )}
          <IssuesTable
            issues={initialIssues}
            showProjectColumn={showProjectColumn}
            activeIssueSessionCounts={activeIssueSessionCounts}
            spawningIssueKey={spawningIssueKey}
            onSpawn={handleSpawnIssue}
          />
        </>
      )}
    </div>
  );
}

function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {parts.map((p, i) => (
        <span key={p.label} className="soft-pill flex items-baseline rounded-full px-3 py-1">
          {i > 0 && (
            <span className="mx-2 text-[11px] text-[var(--color-border-strong)]">·</span>
          )}
          <span
            className="text-[18px] font-semibold tabular-nums tracking-tight"
            style={{ color: p.color ?? "var(--color-text-primary)" }}
          >
            {p.value}
          </span>
          <span className="ml-1.5 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
            {p.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}

function IssuesTable(
  {
    issues,
    showProjectColumn,
    activeIssueSessionCounts,
    spawningIssueKey,
    onSpawn,
  }: {
    issues: DashboardIssue[];
    showProjectColumn: boolean;
    activeIssueSessionCounts: Map<string, number>;
    spawningIssueKey: string | null;
    onSpawn: (issue: DashboardIssue) => void;
  },
) {
  if (issues.length === 0) {
    return (
      <div className="surface-panel rounded-[16px] px-5 py-10 text-center">
        <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">No open issues</p>
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
          The connected tracker did not return any open issues for this dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px]">
      <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
        Issues
      </h2>
      <div className="space-y-3 md:hidden">
        {issues.map((issue) => {
          const key = issueKey(issue.projectId, issue.id);
          const activeSessionCount = activeIssueSessionCounts.get(key) ?? 0;
          const alreadySpawned = activeSessionCount > 0;
          const isSpawning = spawningIssueKey === key;

          return (
            <div
              key={`${issue.projectId}-${issue.id}`}
              className="surface-panel rounded-[16px] px-4 py-4"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    #{issue.id}
                  </a>
                  <h3 className="mt-1 text-[14px] font-semibold leading-snug text-[var(--color-text-primary)]">
                    {issue.title}
                  </h3>
                </div>
                <button
                  onClick={() => onSpawn(issue)}
                  disabled={alreadySpawned || isSpawning}
                  className="shrink-0 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-accent-subtle)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[rgba(95,132,199,0.18)] disabled:cursor-not-allowed disabled:border-[var(--color-border-default)] disabled:bg-transparent disabled:text-[var(--color-text-tertiary)]"
                >
                  {isSpawning ? "spawning..." : alreadySpawned ? "session exists" : "spawn"}
                </button>
              </div>

              {(showProjectColumn || issue.repo) && (
                <div className="mb-3 rounded-[12px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                    Project
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                    {issue.projectName}
                  </div>
                  {issue.repo && (
                    <div className="mt-1 font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
                      {issue.repo}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[12px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                    Assignee
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                    {issue.assignee ?? "—"}
                  </div>
                </div>
                <div className="rounded-[12px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                    Labels
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {issue.labels.length > 0 ? issue.labels.map((label) => (
                      <span
                        key={label}
                        className="rounded-[999px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]"
                      >
                        {label}
                      </span>
                    )) : <span className="text-[12px] text-[var(--color-text-tertiary)]">—</span>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden md:block">
        <div className="soft-table overflow-x-auto rounded-[16px]">
          <table className="min-w-[760px] w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-border-muted)]">
                {showProjectColumn && (
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Project
                  </th>
                )}
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Issue
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Title
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Labels
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Assignee
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => {
                const key = issueKey(issue.projectId, issue.id);
                const activeSessionCount = activeIssueSessionCounts.get(key) ?? 0;
                const alreadySpawned = activeSessionCount > 0;
                const isSpawning = spawningIssueKey === key;

                return (
                  <tr key={`${issue.projectId}-${issue.id}`} className="border-b border-[var(--color-border-muted)] hover:bg-[var(--color-accent-subtle)]">
                    {showProjectColumn && (
                      <td className="px-3 py-2.5 text-[12px] text-[var(--color-text-muted)]">
                        <div>{issue.projectName}</div>
                        {issue.repo && (
                          <div className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
                            {issue.repo}
                          </div>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-sm">
                      <a href={issue.url} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--color-accent)] hover:underline">
                        #{issue.id}
                      </a>
                    </td>
                    <td className="max-w-[520px] px-3 py-2.5 text-sm font-medium text-[var(--color-text-primary)]">
                      <div className="truncate">{issue.title}</div>
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap gap-1">
                        {issue.labels.length > 0 ? issue.labels.map((label) => (
                          <span
                            key={label}
                            className="rounded-[999px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]"
                          >
                            {label}
                          </span>
                        )) : <span className="text-[var(--color-text-tertiary)]">—</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-[var(--color-text-secondary)]">
                      {issue.assignee ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      <button
                        onClick={() => onSpawn(issue)}
                        disabled={alreadySpawned || isSpawning}
                        className="rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-accent-subtle)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[rgba(95,132,199,0.18)] disabled:cursor-not-allowed disabled:border-[var(--color-border-default)] disabled:bg-transparent disabled:text-[var(--color-text-tertiary)]"
                      >
                        {isSpawning ? "spawning..." : alreadySpawned ? "session exists" : "spawn"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function issueKey(projectId: string, issueId: string): string {
  return `${projectId}:${issueId.trim().replace(/^#/, "").toLowerCase()}`;
}

function normalizeSessionIssue(session: DashboardSession): string | null {
  if (session.issueLabel) {
    return session.issueLabel.trim().replace(/^#/, "").toLowerCase();
  }

  const candidate = session.issueUrl ?? session.issueId;
  if (!candidate) return null;
  const parts = candidate.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? last.trim().replace(/^#/, "").toLowerCase() : null;
}
