import type { MovementCategory, SkillLevel, TrainingFocus } from "@/types";
import { listMovements } from "@/lib/data/repository";
import { errorResponse, requireSession } from "@/lib/auth/session";

/**
 * GET /api/movements
 * Query: category, level, focus, q
 *
 * The library is served from the repository layer, which the web client mostly
 * bypasses (it filters the full set locally). This route exists for the mobile
 * companion and for offline cache priming.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);

    const movements = await listMovements({
      category: (url.searchParams.get("category") as MovementCategory) ?? "all",
      level: (url.searchParams.get("level") as SkillLevel) ?? "all",
      focus: (url.searchParams.get("focus") as TrainingFocus) ?? "all",
      search: url.searchParams.get("q") ?? undefined,
    });

    return Response.json(
      { movements, count: movements.length },
      {
        headers: {
          // Library content changes rarely; let the edge and the SW hold it.
          "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
