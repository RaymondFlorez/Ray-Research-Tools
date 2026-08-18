import type { PulseTopic, TrainingFocus } from "@/types";
import { listPulse } from "@/lib/data/repository";
import { PULSE_IS_SAMPLE_CONTENT } from "@/lib/data/pulse";
import { errorResponse, requireSession } from "@/lib/auth/session";

/**
 * GET /api/pulse?topic=&focus=&q=
 *
 * `sampleContent: true` in the payload tells every client — web and mobile —
 * that the feed is placeholder editorial rather than ingested items, so the
 * disclosure travels with the data instead of being hardcoded in one UI.
 */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const url = new URL(request.url);

    const focusParam = url.searchParams.getAll("focus") as TrainingFocus[];
    const articles = await listPulse({
      topic: (url.searchParams.get("topic") as PulseTopic) ?? "all",
      focus: focusParam.length ? focusParam : undefined,
      search: url.searchParams.get("q") ?? undefined,
    });

    return Response.json(
      {
        articles,
        count: articles.length,
        sampleContent: PULSE_IS_SAMPLE_CONTENT,
        personalizedFor: session.user.focus,
      },
      {
        headers: {
          "cache-control": "public, s-maxage=900, stale-while-revalidate=3600",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
