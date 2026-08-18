import type { Metadata } from "next";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { SessionsWorkspace } from "./sessions-workspace";
import {
  listCoaches,
  listRecommendations,
  listSessionLogs,
  listSessions,
  startOfWeek,
} from "@/lib/data/repository";

export const metadata: Metadata = {
  title: "Sessions",
  description:
    "Schedule, build, and review Alpha Movement training sessions with drag-and-drop calendar management and per-session progress tracking.",
};

// The week anchor is computed once per request on the server and handed to the
// client, so both agree on what "this week" means with no hydration drift.
export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  const anchor = startOfWeek(new Date()).toISOString();
  const [sessions, coaches, logs, recommendations] = await Promise.all([
    listSessions(anchor),
    listCoaches(),
    listSessionLogs(anchor),
    listRecommendations(anchor),
  ]);

  return (
    <Container className="max-w-none 2xl:max-w-[110rem]">
      <PageHeader
        eyebrow="Personal sessions"
        title="Your training week."
        description="Drag to reschedule, click any session to open its programming, and log movement quality afterwards. Everything you log feeds the next block's recommendations."
      />
      <SessionsWorkspace
        anchorISO={anchor}
        initialSessions={sessions}
        coaches={coaches}
        logs={logs}
        recommendations={recommendations}
      />
    </Container>
  );
}
