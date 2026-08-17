import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Calendar, Compass, Newspaper } from "lucide-react";
import { Container } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Badge, Progress, Stat } from "@/components/ui/primitives";
import { RecommendationPanel } from "../sessions/recommendation-panel";
import { TodayGreeting, UpcomingSessions } from "./today-client";
import {
  getCoach,
  listPulse,
  listRecommendations,
  listSessionLogs,
  listSessions,
  startOfWeek,
} from "@/lib/data/repository";
import { CURRENT_USER } from "@/lib/data/people";
import { CATEGORIES } from "@/lib/data/taxonomy";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Today",
  description: "Your training week at a glance, with progress and recommendations.",
};

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const anchor = startOfWeek(new Date()).toISOString();
  const [sessions, logs, recommendations, pulse] = await Promise.all([
    listSessions(anchor),
    listSessionLogs(anchor),
    listRecommendations(anchor),
    listPulse(),
  ]);

  const completed = logs.length;
  const avgQuality =
    logs.reduce((sum, l) => sum + l.movementQuality, 0) / (logs.length || 1);
  const avgRpe = logs.reduce((sum, l) => sum + l.rpe, 0) / (logs.length || 1);
  const totalLoad = logs.reduce((sum, l) => sum + (l.loadKg ?? 0), 0);

  const thisWeek = sessions.filter((s) => {
    const start = new Date(s.startsAt).getTime();
    const weekStart = new Date(anchor).getTime();
    return start >= weekStart && start < weekStart + 7 * 86_400_000;
  });

  // Pillar balance across the week — the philosophy made auditable.
  const pillarMinutes = new Map<string, number>();
  for (const session of thisWeek) {
    for (const block of session.blocks) {
      pillarMinutes.set(
        block.category,
        (pillarMinutes.get(block.category) ?? 0) + block.durationMin,
      );
    }
  }
  const totalPillarMin =
    [...pillarMinutes.values()].reduce((sum, m) => sum + m, 0) || 1;

  const featuredArticle = pulse[0];

  return (
    <Container>
      <TodayGreeting name={CURRENT_USER.name.split(" ")[0]} />

      {/* ---- Stats -------------------------------------------------------- */}
      <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Sessions this week"
          value={thisWeek.length}
          delta={{ value: `${completed} logged last week` }}
        />
        <Stat
          label="Movement quality"
          value={avgQuality.toFixed(1)}
          unit="/ 5"
          delta={{
            value:
              avgQuality >= 4
                ? "Positions are being owned"
                : "Quality is the limiter",
            positive: avgQuality >= 4,
          }}
        />
        <Stat
          label="Average RPE"
          value={avgRpe.toFixed(1)}
          unit="/ 10"
          delta={{
            value: avgRpe <= 6.5 ? "Well within range" : "Running hot",
            positive: avgRpe <= 6.5,
          }}
        />
        <Stat
          label="Load moved"
          value={(totalLoad / 1000).toFixed(1)}
          unit="tonnes"
        />
      </section>

      {/* min-w-0 on both columns: grid items default to min-width:auto, which
          lets a nowrap child widen the track past the viewport on mobile. */}
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {/* ---- Upcoming --------------------------------------------------- */}
          <section className="surface-card p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-heading text-ink">Coming up</h2>
              <Button href="/sessions" variant="ghost" size="sm">
                Full calendar
                <ArrowRight size={14} />
              </Button>
            </div>
            <UpcomingSessions
              sessions={thisWeek.map((session) => ({
                id: session.id,
                title: session.title,
                startsAt: session.startsAt,
                durationMin: session.durationMin,
                status: session.status,
                coachName: getCoach(session.coachId)?.name ?? "Coach",
                pillars: [...new Set(session.blocks.map((b) => b.category))].map(
                  (c) => ({ short: CATEGORIES[c].short, color: CATEGORIES[c].colorVar }),
                ),
              }))}
            />
          </section>

          {/* ---- Pillar balance --------------------------------------------- */}
          <section className="surface-card p-6">
            <h2 className="text-heading text-ink">Pillar balance this week</h2>
            <p className="mt-2 text-small text-ink-2">
              A week weighted entirely toward one pillar is a week that will cost
              you something later. This is the audit.
            </p>
            <ul className="mt-6 space-y-4">
              {[...pillarMinutes.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([category, minutes]) => {
                  const meta = CATEGORIES[category as keyof typeof CATEGORIES];
                  const pct = (minutes / totalPillarMin) * 100;
                  return (
                    <li key={category}>
                      <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
                        <Link
                          href={`/library?category=${category}`}
                          className="transition-colors hover:text-accent-hi"
                          style={{ color: meta.colorVar }}
                        >
                          {meta.short}
                        </Link>
                        <span className="text-ink-3 tabular-nums">
                          {minutes} min · {Math.round(pct)}%
                        </span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-pill bg-line">
                        <div
                          className="h-full rounded-pill transition-[width] duration-700 ease-[var(--ease-out-quint)]"
                          style={{ width: `${pct}%`, background: meta.colorVar }}
                        />
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>

          {/* ---- Recent logs -------------------------------------------------- */}
          <section className="surface-card p-6">
            <h2 className="text-heading text-ink">Recent logs</h2>
            <ul className="mt-5 space-y-3">
              {logs.slice(0, 3).map((log) => (
                <li
                  key={log.sessionId}
                  className="rounded-card border border-line bg-void/40 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={log.movementQuality >= 4 ? "positive" : "warning"}>
                      Quality {log.movementQuality}/5
                    </Badge>
                    <Badge>RPE {log.rpe}/10</Badge>
                    {log.hrvMs && <Badge>HRV {log.hrvMs}ms</Badge>}
                    <span className="ml-auto text-[12px] text-ink-3">
                      {relativeTime(log.completedAt)}
                    </span>
                  </div>
                  {log.athleteNote && (
                    <p className="mt-2.5 text-small leading-relaxed text-ink-2">
                      {log.athleteNote}
                    </p>
                  )}
                  {log.coachNote && (
                    <p className="mt-2 border-l border-line pl-3 text-[13px] leading-relaxed text-ink-3">
                      {log.coachNote}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* ---- Sidebar -------------------------------------------------------- */}
        <aside className="min-w-0 space-y-4">
          <RecommendationPanel recommendations={recommendations} />

          <section className="surface-card p-5">
            <div className="flex items-center gap-2">
              <Compass size={15} className="text-ink-3" />
              <h2 className="text-[14px] font-medium text-ink">
                Foundations cycle
              </h2>
            </div>
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-2">
              Week 6 of 8. Joint prep ladders have progressed; deceleration work
              opens next week.
            </p>
            <Progress className="mt-4" value={75} />
            <Button href="/owned" variant="secondary" size="sm" className="mt-4 w-full">
              Open the cycle
            </Button>
          </section>

          {featuredArticle && (
            <section className="surface-card p-5">
              <div className="flex items-center gap-2">
                <Newspaper size={15} className="text-ink-3" />
                <h2 className="text-[14px] font-medium text-ink">From Pulse</h2>
              </div>
              <h3 className="mt-3 text-[14px] leading-snug font-medium text-ink">
                <Link
                  href={`/pulse/${featuredArticle.slug}`}
                  className="hover:text-accent-hi"
                >
                  {featuredArticle.title}
                </Link>
              </h3>
              <p className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-ink-2">
                {featuredArticle.summary}
              </p>
              <Link
                href="/pulse"
                className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink"
              >
                Open Pulse
                <ArrowRight size={12} />
              </Link>
            </section>
          )}

          <section className="surface-card p-5">
            <div className="flex items-center gap-2">
              <Calendar size={15} className="text-ink-3" />
              <h2 className="text-[14px] font-medium text-ink">
                Calendar sync
              </h2>
            </div>
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-2">
              Push your sessions to Google, Apple, or Outlook and keep reminders
              in one place.
            </p>
            <Button href="/profile" variant="secondary" size="sm" className="mt-4 w-full">
              Manage connections
            </Button>
          </section>
        </aside>
      </div>
    </Container>
  );
}
