import type { TrainingSession } from "@/types";
import { listSessions, startOfWeek } from "@/lib/data/repository";
import { errorResponse, requireSession } from "@/lib/auth/session";

/**
 * GET /api/sessions?week=<ISO Monday>
 * Returns the athlete's sessions for the requested week.
 */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const url = new URL(request.url);
    const week = url.searchParams.get("week");
    const anchor = week
      ? new Date(week).toISOString()
      : startOfWeek(new Date()).toISOString();

    const sessions = await listSessions(anchor);
    return Response.json({
      week: anchor,
      timezone: session.user.timezone,
      sessions,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/sessions
 * Creates a session request. Coaches confirm it, which moves the status from
 * REQUESTED to SCHEDULED and fires the calendar-sync and reminder jobs.
 */
export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as Partial<TrainingSession>;

    if (!body.startsAt || !body.coachId) {
      return Response.json(
        { error: "startsAt and coachId are required" },
        { status: 422 },
      );
    }

    const created: TrainingSession = {
      id: `ses-${Date.now().toString(36)}`,
      title: body.title?.trim() || "Training session",
      type: body.type ?? "live",
      status: "requested",
      coachId: body.coachId,
      clientId: session.user.id,
      startsAt: new Date(body.startsAt).toISOString(),
      durationMin: body.durationMin ?? 60,
      timezone: body.timezone ?? session.user.timezone,
      recurrence: body.recurrence ?? "none",
      blocks: body.blocks ?? [],
      location: body.location,
      joinUrl: body.joinUrl,
      notes: body.notes,
      reminders: body.reminders ?? [
        { channel: "push", minutesBefore: 30 },
        { channel: "email", minutesBefore: 720 },
      ],
    };

    // Production: persist via Prisma, enqueue calendar sync + reminder jobs,
    // and notify the coach. The demo build echoes the created record back so
    // the client can apply it optimistically.
    return Response.json({ session: created }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
