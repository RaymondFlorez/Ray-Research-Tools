import { listSessions, startOfWeek } from "@/lib/data/repository";
import { toICS } from "@/lib/calendar";
import { errorResponse, requireSession } from "@/lib/auth/session";

/**
 * GET /api/calendar/ics
 *
 * Serves the athlete's schedule as an RFC 5545 feed. Google, Apple, and Outlook
 * can all subscribe to this URL directly; the OAuth-based two-way sync in
 * CalendarConnection is the richer path, and this is the fallback that works
 * everywhere with no integration at all.
 */
export async function GET() {
  try {
    const session = await requireSession();
    const anchor = startOfWeek(new Date()).toISOString();
    const sessions = await listSessions(anchor);

    return new Response(toICS(sessions, `Alpha Movement — ${session.user.name}`), {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'attachment; filename="alpha-movement.ics"',
        "cache-control": "private, max-age=300",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
