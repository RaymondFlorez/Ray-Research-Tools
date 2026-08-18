"use client";

import * as React from "react";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  Sparkles,
} from "lucide-react";
import type {
  Coach,
  ProgrammingRecommendation,
  SessionLog,
  TrainingSession,
} from "@/types";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/primitives";
import { Toast } from "@/components/ui/overlay";
import { WeekGrid } from "./week-grid";
import { SessionDetail } from "./session-detail";
import { SessionBuilder } from "./session-builder";
import { RecommendationPanel } from "./recommendation-panel";
import {
  addDays,
  formatRangeLabel,
  toICS,
  zoneAbbrev,
} from "@/lib/calendar";
import { applyLocalSessionEdits, useAppStore } from "@/lib/store/app-store";
import { useIsHydrated, useNow } from "@/lib/hooks/use-client";

const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Stockholm",
  "Asia/Singapore",
  "Australia/Sydney",
];

export function SessionsWorkspace({
  anchorISO,
  initialSessions,
  coaches,
  logs,
  recommendations,
}: {
  anchorISO: string;
  initialSessions: TrainingSession[];
  coaches: Coach[];
  logs: SessionLog[];
  recommendations: ProgrammingRecommendation[];
}) {
  const hydrated = useIsHydrated();
  const storedTimezone = useAppStore((s) => s.timezone);
  const sessionOverrides = useAppStore((s) => s.sessionOverrides);
  const createdSessions = useAppStore((s) => s.createdSessions);
  const cancelledSessionIds = useAppStore((s) => s.cancelledSessionIds);
  const localLogs = useAppStore((s) => s.logs);
  const moveSession = useAppStore((s) => s.moveSession);

  const [weekOffset, setWeekOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<TrainingSession | null>(null);
  const [builderSeed, setBuilderSeed] = React.useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  // The viewer's clock is an external system, not React state.
  const now = useNow();

  // The display zone follows the profile until the viewer overrides it here.
  const [timezoneOverride, setTimezoneOverride] = React.useState<string | null>(
    null,
  );
  const timezone =
    timezoneOverride ?? (hydrated ? storedTimezone : "America/Los_Angeles");

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const weekStart = React.useMemo(
    () => addDays(new Date(anchorISO), weekOffset * 7),
    [anchorISO, weekOffset],
  );

  const sessions = React.useMemo(
    () =>
      applyLocalSessionEdits(initialSessions, {
        sessionOverrides,
        createdSessions,
        cancelledSessionIds,
      }),
    [initialSessions, sessionOverrides, createdSessions, cancelledSessionIds],
  );

  const mergedLogs = React.useMemo(() => {
    const map = new Map(logs.map((log) => [log.sessionId, log]));
    for (const [id, log] of Object.entries(localLogs)) map.set(id, log);
    return map;
  }, [logs, localLogs]);

  const exportICS = () => {
    const blob = new Blob([toICS(sessions)], {
      type: "text/calendar;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "alpha-movement.ics";
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("Calendar exported — import into Google, Apple, or Outlook");
  };

  return (
    <div className="space-y-6 py-8">
      {/* ---- Toolbar ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconButton
            label="Previous week"
            onClick={() => setWeekOffset((w) => w - 1)}
          >
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton
            label="Next week"
            onClick={() => setWeekOffset((w) => w + 1)}
          >
            <ChevronRight size={16} />
          </IconButton>
          <div className="ml-1.5">
            <p className="text-[15px] font-medium text-ink">
              {formatRangeLabel(weekStart)}
            </p>
            {weekOffset !== 0 && (
              <button
                onClick={() => setWeekOffset(0)}
                className="text-[12px] text-ink-3 hover:text-ink-2"
              >
                Back to this week
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-[11px] border border-line bg-surface/70 px-2.5 py-1.5">
            <Globe size={14} className="text-ink-3" />
            <Select
              value={timezone}
              onChange={(e) => setTimezoneOverride(e.target.value)}
              aria-label="Display timezone"
              className="h-auto border-0 bg-transparent px-0 pr-6 text-[13px] hover:border-0 focus:ring-0"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.split("/")[1]?.replace(/_/g, " ") ?? tz}
                </option>
              ))}
            </Select>
            <span className="text-[11px] text-ink-3">
              {zoneAbbrev(timezone, now ?? new Date(anchorISO))}
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={exportICS}>
            <Download size={14} />
            Export .ics
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setBuilderSeed(null);
              setBuilderOpen(true);
            }}
          >
            <CalendarPlus size={14} />
            New session
          </Button>
        </div>
      </div>

      {/* ---- Calendar + recommendations ----------------------------------- */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <WeekGrid
          weekStart={weekStart}
          sessions={sessions}
          coaches={coaches}
          timezone={timezone}
          now={now}
          onMove={(id, startsAt) => {
            moveSession(id, startsAt);
            setToast("Session rescheduled");
          }}
          onSelect={setSelected}
          onCreateAt={(startsAt) => {
            setBuilderSeed(startsAt);
            setBuilderOpen(true);
          }}
        />

        <aside className="min-w-0 space-y-4">
          <div className="surface-card p-5">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-accent" />
              <h2 className="text-[15px] font-medium text-ink">
                Programming feedback
              </h2>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
              Generated from your logged sessions. Every recommendation states
              what it read, so you can disagree with it.
            </p>
          </div>
          <RecommendationPanel recommendations={recommendations} />

          <div className="surface-card p-5">
            <p className="eyebrow">Legend</p>
            <ul className="mt-3 space-y-2 text-[12px] text-ink-2">
              <li className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-sm border border-l-2 border-line border-l-titanium bg-elevated" />
                Scheduled
              </li>
              <li className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-sm border border-dashed border-line bg-elevated" />
                Requested — awaiting coach
              </li>
              <li className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-sm bg-titanium/10" />
                Coach availability
              </li>
              <li className="flex items-center gap-2.5">
                <span className="h-px w-3 bg-danger" />
                Current time
              </li>
            </ul>
          </div>
        </aside>
      </div>

      {/* ---- Panels -------------------------------------------------------- */}
      <SessionDetail
        session={selected}
        coaches={coaches}
        timezone={timezone}
        log={selected ? (mergedLogs.get(selected.id) ?? null) : null}
        onClose={() => setSelected(null)}
        onToast={setToast}
      />

      <SessionBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        coaches={coaches}
        timezone={timezone}
        seedStartsAt={builderSeed}
        weekStart={weekStart}
        onCreated={() => {
          setBuilderOpen(false);
          setToast("Session requested — your coach will confirm");
        }}
      />

      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}
