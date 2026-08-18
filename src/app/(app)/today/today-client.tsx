"use client";

import * as React from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/primitives";
import { useAppStore } from "@/lib/store/app-store";
import { useIsHydrated, useNowMs } from "@/lib/hooks/use-client";
import { formatDayLong, formatTime } from "@/lib/calendar";

/**
 * The greeting depends on the viewer's clock, which the server cannot know —
 * so it reads the time through the external-store hook and holds a skeleton
 * until the client has a value.
 */
export function TodayGreeting({ name }: { name: string }) {
  const nowMs = useNowMs();

  const { greeting, today } = React.useMemo(() => {
    if (nowMs === null) return { greeting: null, today: null };
    const date = new Date(nowMs);
    const hour = date.getHours();
    return {
      greeting:
        hour < 5
          ? "Still up"
          : hour < 12
            ? "Good morning"
            : hour < 17
              ? "Good afternoon"
              : "Good evening",
      today: formatDayLong(date),
    };
  }, [nowMs]);

  return (
    <div className="border-b border-line pb-7">
      {today ? (
        <p className="eyebrow mb-3">{today}</p>
      ) : (
        <Skeleton className="mb-3 h-3 w-40" />
      )}
      {greeting ? (
        <h1 className="text-[clamp(1.9rem,4vw,2.6rem)] leading-[1.06] font-medium tracking-[-0.028em] text-ink">
          {greeting}, {name}.
        </h1>
      ) : (
        <Skeleton className="h-10 w-72" />
      )}
      <p className="mt-3.5 max-w-2xl text-body leading-relaxed text-ink-2">
        Everything below reads from what you have logged. Nothing is recommended
        without telling you the evidence behind it.
      </p>
    </div>
  );
}

/* --- Upcoming sessions ----------------------------------------------------- */

interface UpcomingSession {
  id: string;
  title: string;
  startsAt: string;
  durationMin: number;
  status: string;
  coachName: string;
  pillars: { short: string; color: string }[];
}

export function UpcomingSessions({ sessions }: { sessions: UpcomingSession[] }) {
  const hydrated = useIsHydrated();
  const nowMs = useNowMs();
  const timezone = useAppStore((s) => s.timezone);
  const cancelled = useAppStore((s) => s.cancelledSessionIds);

  const upcoming = React.useMemo(() => {
    if (nowMs === null) return [];
    return sessions
      .filter(
        (s) =>
          !cancelled.includes(s.id) &&
          new Date(s.startsAt).getTime() >= nowMs - 60 * 60_000,
      )
      .slice(0, 4);
  }, [sessions, cancelled, nowMs]);

  if (nowMs === null || !hydrated) {
    return (
      <div className="mt-5 space-y-2.5">
        <Skeleton className="h-16 w-full rounded-card" />
        <Skeleton className="h-16 w-full rounded-card" />
        <Skeleton className="h-16 w-full rounded-card" />
      </div>
    );
  }

  if (!upcoming.length) {
    return (
      <p className="mt-5 rounded-card border border-dashed border-line px-5 py-8 text-center text-small text-ink-3">
        Nothing left this week. Rest is programming too.
      </p>
    );
  }

  return (
    <ul className="mt-5 space-y-2.5">
      {upcoming.map((session) => (
        <li key={session.id}>
          <Link
            href="/sessions"
            className="flex items-center gap-4 rounded-card border border-line bg-void/40 px-4 py-3.5 transition-colors hover:border-line-strong"
          >
            <div className="w-20 shrink-0 text-[12px] text-ink-3 tabular-nums">
              {new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                weekday: "short",
              }).format(new Date(session.startsAt))}
              <span className="block text-ink-2">
                {formatTime(session.startsAt, timezone)}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-ink">
                {session.title}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-ink-3">
                {session.coachName} · {session.durationMin} min
                {session.status === "requested" && " · awaiting confirmation"}
              </p>
            </div>
            <div className="hidden shrink-0 gap-1 sm:flex">
              {session.pillars.map((pillar) => (
                <span
                  key={pillar.short}
                  className="rounded-pill border px-2 py-0.5 text-[10px]"
                  style={{
                    borderColor: `color-mix(in oklab, ${pillar.color} 30%, transparent)`,
                    color: pillar.color,
                  }}
                >
                  {pillar.short}
                </span>
              ))}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
