"use client";

import { useState } from "react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { SessionCard } from "./SessionCard";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  variant?: "column" | "grid";
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const zoneConfig: Record<
  AttentionLevel,
  {
    label: string;
    color: string;
    bg: string;
    defaultCollapsed: boolean;
  }
> = {
  merge: {
    label: "Merge",
    color: "var(--color-status-ready)",
    bg: "var(--zone-merge-bg)",
    defaultCollapsed: false,
  },
  respond: {
    label: "Respond",
    color: "var(--color-status-error)",
    bg: "var(--zone-respond-bg)",
    defaultCollapsed: false,
  },
  review: {
    label: "Review",
    color: "var(--color-accent-orange)",
    bg: "var(--zone-review-bg)",
    defaultCollapsed: false,
  },
  pending: {
    label: "Pending",
    color: "var(--color-status-attention)",
    bg: "var(--zone-pending-bg)",
    defaultCollapsed: false,
  },
  working: {
    label: "Working",
    color: "var(--color-status-working)",
    bg: "var(--zone-working-bg)",
    defaultCollapsed: false,
  },
  done: {
    label: "Done",
    color: "var(--color-text-tertiary)",
    bg: "var(--zone-done-bg)",
    defaultCollapsed: true,
  },
};

export function AttentionZone({
  level,
  sessions,
  variant = "grid",
  onSend,
  onKill,
  onMerge,
  onRestore,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed);

  if (sessions.length === 0) return null;

  if (variant === "column") {
    return (
      <div
        className="surface-panel flex flex-col rounded-[16px] p-3"
        style={{ backgroundColor: config.bg }}
      >
        {/* Column header */}
        <button
          className="mb-3 flex items-center gap-2 py-0.5 text-left"
          onClick={() => setCollapsed(!collapsed)}
        >
          <div
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: config.color }}
          />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
            {config.label}
          </span>
          <span
            className="soft-pill rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]"
          >
            {sessions.length}
          </span>
          <div className="flex-1" />
          <svg
            className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform duration-150"
            style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {!collapsed && (
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onSend={onSend}
                onKill={onKill}
                onMerge={onMerge}
                onRestore={onRestore}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="surface-panel mb-7 rounded-[18px] px-4 py-4"
      style={{ backgroundColor: config.bg }}
    >
      {/* Zone header: [●] LABEL ──────────────────────────────── count [▾] */}
      <button
        className="mb-4 flex w-full items-center gap-2.5 py-0.5 text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        {/* Semantic dot — only zone-colored element */}
        <div
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: config.color }}
        />
        {/* Label — neutral, not zone-colored */}
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
          {config.label}
        </span>
        {/* Divider */}
        <div className="h-px flex-1 bg-[var(--color-border-subtle)]" />
        {/* Count — plain */}
        <span className="soft-pill tabular-nums rounded-full px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">
          {sessions.length}
        </span>
        {/* Collapse chevron */}
        <svg
          className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform duration-150"
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onSend={onSend}
              onKill={onKill}
              onMerge={onMerge}
              onRestore={onRestore}
            />
          ))}
        </div>
      )}
    </div>
  );
}
