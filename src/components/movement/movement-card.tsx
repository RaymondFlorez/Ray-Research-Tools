"use client";

import Link from "next/link";
import { Heart, Plus, Timer } from "lucide-react";
import { motion } from "motion/react";
import type { Movement } from "@/types";
import { CATEGORIES, posterStyle } from "@/lib/data/taxonomy";
import { useAppStore } from "@/lib/store/app-store";
import { cn, formatDuration } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";

/**
 * Movement card. The poster is a generated gradient rather than a fetched
 * image, so the grid paints instantly and works offline; real deployments
 * swap in the video's first frame at the same aspect ratio.
 */
export function MovementCard({
  movement,
  onAddToFlow,
  index = 0,
}: {
  movement: Movement;
  onAddToFlow?: (movement: Movement) => void;
  index?: number;
}) {
  const favorite = useAppStore((s) => s.favorites.includes(movement.id));
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const meta = CATEGORIES[movement.category];

  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.5,
        delay: Math.min(index * 0.035, 0.32),
        ease: [0.22, 1, 0.36, 1],
      }}
      className="surface-card group relative flex flex-col transition-all duration-300 ease-[var(--ease-out-quint)] hover:-translate-y-1 hover:border-line-strong hover:shadow-mid"
    >
      <Link
        href={`/library/${movement.slug}`}
        className="relative block aspect-16/10 overflow-hidden"
        style={posterStyle(movement.poster)}
      >
        {/* Category hairline — the only colour on the card */}
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background: `linear-gradient(90deg,transparent,${meta.colorVar},transparent)`,
            opacity: 0.55,
          }}
        />
        <span
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_40%,rgba(255,255,255,0.06),transparent_70%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        />
        <span className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-pill border border-line/70 bg-void/70 px-2.5 py-1 text-[11px] text-ink-2 backdrop-blur-sm">
          <Timer size={11} />
          {formatDuration(Math.round(movement.durationSec / 60) || 1)}
        </span>
      </Link>

      <div className="flex flex-1 flex-col p-4">
        <p
          className="text-[11px] font-medium tracking-[0.1em] uppercase"
          style={{ color: meta.colorVar }}
        >
          {movement.group}
        </p>
        <h3 className="mt-2 text-[15px] leading-snug font-medium tracking-[-0.01em] text-ink">
          <Link href={`/library/${movement.slug}`} className="hover:text-accent-hi">
            {movement.name}
          </Link>
        </h3>
        <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-ink-2">
          {movement.summary}
        </p>

        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <Badge>{movement.level}</Badge>
          <div className="flex items-center gap-1.5">
            {onAddToFlow && (
              <IconButton
                label={`Add ${movement.name} to a flow`}
                onClick={() => onAddToFlow(movement)}
              >
                <Plus size={15} />
              </IconButton>
            )}
            <IconButton
              label={favorite ? "Remove from favourites" : "Add to favourites"}
              active={favorite}
              onClick={() => toggleFavorite(movement.id)}
            >
              <Heart size={15} fill={favorite ? "currentColor" : "none"} />
            </IconButton>
          </div>
        </div>
      </div>
    </motion.article>
  );
}

/** Compact row used inside session blocks, flows, and search results. */
export function MovementRow({
  movement,
  right,
  className,
}: {
  movement: Movement;
  right?: React.ReactNode;
  className?: string;
}) {
  const meta = CATEGORIES[movement.category];
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[11px] border border-line bg-surface/60 px-3 py-2.5",
        className,
      )}
    >
      <span
        aria-hidden
        className="h-8 w-8 shrink-0 rounded-[8px] border border-line"
        style={posterStyle(movement.poster)}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={`/library/${movement.slug}`}
          className="block truncate text-[13px] font-medium text-ink hover:text-accent-hi"
        >
          {movement.name}
        </Link>
        <p className="truncate text-[11px]" style={{ color: meta.colorVar }}>
          {meta.short} · {movement.group}
        </p>
      </div>
      {right}
    </div>
  );
}
