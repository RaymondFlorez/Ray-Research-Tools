"use client";

import Link from "next/link";
import type { ProgrammingRecommendation } from "@/types";
import { CATEGORIES } from "@/lib/data/taxonomy";
import { getMovementsByIds } from "@/lib/data/repository";
import { Progress } from "@/components/ui/primitives";

/**
 * Recommendations always show their confidence and the evidence they read.
 * A recommendation an athlete cannot interrogate is a recommendation they
 * should not follow.
 */
export function RecommendationPanel({
  recommendations,
}: {
  recommendations: ProgrammingRecommendation[];
}) {
  if (!recommendations.length) return null;

  return (
    <div className="space-y-3">
      {recommendations.map((rec) => {
        const meta = CATEGORIES[rec.suggestedCategory];
        const movements = getMovementsByIds(rec.suggestedMovementIds);
        return (
          <article key={rec.id} className="surface-card p-5">
            <p
              className="text-[11px] font-medium tracking-[0.1em] uppercase"
              style={{ color: meta.colorVar }}
            >
              {meta.short}
            </p>
            <h3 className="mt-2.5 text-[14px] leading-snug font-medium text-ink">
              {rec.headline}
            </h3>
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-2">
              {rec.rationale}
            </p>

            {movements.length > 0 && (
              <ul className="mt-3.5 space-y-1.5">
                {movements.map((movement) => (
                  <li key={movement.id}>
                    <Link
                      href={`/library/${movement.slug}`}
                      className="text-[12px] text-ink-2 transition-colors hover:text-accent-hi"
                    >
                      → {movement.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-3">
                <span>Confidence</span>
                <span className="tabular-nums">
                  {Math.round(rec.confidence * 100)}%
                </span>
              </div>
              <Progress
                value={rec.confidence * 100}
                tone={rec.confidence > 0.75 ? "accent" : "warning"}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}
