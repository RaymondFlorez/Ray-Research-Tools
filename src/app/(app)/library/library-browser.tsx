"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Heart, Search, SlidersHorizontal, X } from "lucide-react";
import type { Movement, MovementCategory, SkillLevel, TrainingFocus } from "@/types";
import {
  CATEGORIES,
  CATEGORY_ORDER,
  FOCUS_META,
  FOCUS_ORDER,
  LEVEL_META,
} from "@/lib/data/taxonomy";
import { filterMovements } from "@/lib/data/repository";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { Button, IconButton } from "@/components/ui/button";
import {
  EmptyState,
  Input,
  Segmented,
  SkeletonCard,
} from "@/components/ui/primitives";
import { MovementCard } from "@/components/movement/movement-card";
import { FlowComposer } from "./flow-composer";

/* ============================================================================
   LIBRARY BROWSER
   Filtering happens client-side against the full library — it is small enough
   that a round trip per keystroke would be slower and worse.
   ========================================================================= */

export function LibraryBrowser({ movements }: { movements: Movement[] }) {
  const params = useSearchParams();
  const hydrated = useStoreHydrated();

  const initialCategory = (params.get("category") ?? "all") as
    | MovementCategory
    | "all";

  const [category, setCategory] = React.useState<MovementCategory | "all">(
    CATEGORY_ORDER.includes(initialCategory as MovementCategory)
      ? initialCategory
      : "all",
  );
  const [level, setLevel] = React.useState<SkillLevel | "all">("all");
  const [focus, setFocus] = React.useState<TrainingFocus | "all">("all");
  const [search, setSearch] = React.useState("");
  const [favoritesOnly, setFavoritesOnly] = React.useState(false);
  const [showFilters, setShowFilters] = React.useState(false);

  const favorites = useAppStore((s) => s.favorites);
  const [flowDraft, setFlowDraft] = React.useState<Movement[]>([]);

  const results = React.useMemo(() => {
    const base = filterMovements(movements, { category, level, focus, search });
    return favoritesOnly ? base.filter((m) => favorites.includes(m.id)) : base;
  }, [movements, category, level, focus, search, favoritesOnly, favorites]);

  const categoryOptions = React.useMemo(
    () => [
      { value: "all" as const, label: "All", count: movements.length },
      ...CATEGORY_ORDER.map((id) => ({
        value: id,
        label: CATEGORIES[id].short,
        count: movements.filter((m) => m.category === id).length,
      })),
    ],
    [movements],
  );

  const filtersActive =
    level !== "all" || focus !== "all" || favoritesOnly || search.length > 0;

  const addToFlow = (movement: Movement) =>
    setFlowDraft((current) =>
      current.some((m) => m.id === movement.id) ? current : [...current, movement],
    );

  return (
    <div className="py-8">
      {/* ---- Controls ---------------------------------------------------- */}
      <div className="sticky top-[57px] z-40 -mx-5 mb-7 bg-void/85 px-5 py-3 backdrop-blur-lg sm:-mx-8 sm:px-8 lg:top-0">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            options={categoryOptions}
            value={category}
            onChange={setCategory}
          />
          <div className="relative min-w-[13rem] flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search movements, cues, chains…"
              aria-label="Search movements"
              className="pl-9"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3 hover:text-ink"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <IconButton
            label="More filters"
            active={showFilters || filtersActive}
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal size={15} />
          </IconButton>
          <IconButton
            label="Favourites only"
            active={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
          >
            <Heart size={15} fill={favoritesOnly ? "currentColor" : "none"} />
          </IconButton>
        </div>

        {showFilters && (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-3">
            <div className="flex items-center gap-2.5">
              <span className="eyebrow">Level</span>
              <Segmented
                size="sm"
                value={level}
                onChange={setLevel}
                options={[
                  { value: "all" as const, label: "Any" },
                  ...(Object.keys(LEVEL_META) as SkillLevel[]).map((id) => ({
                    value: id,
                    label: LEVEL_META[id].label,
                  })),
                ]}
              />
            </div>
            <div className="flex items-center gap-2.5">
              <span className="eyebrow">Focus</span>
              <Segmented
                size="sm"
                value={focus}
                onChange={setFocus}
                options={[
                  { value: "all" as const, label: "Any" },
                  ...FOCUS_ORDER.map((id) => ({
                    value: id,
                    label: FOCUS_META[id].label.split(" ")[0],
                  })),
                ]}
              />
            </div>
            {filtersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLevel("all");
                  setFocus("all");
                  setFavoritesOnly(false);
                  setSearch("");
                }}
              >
                Reset
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ---- Category premise -------------------------------------------- */}
      {category !== "all" && (
        <div className="mb-7 rounded-card border border-line bg-surface/50 p-5">
          <p
            className="text-[11px] font-medium tracking-[0.12em] uppercase"
            style={{ color: CATEGORIES[category].colorVar }}
          >
            {CATEGORIES[category].name}
          </p>
          <p className="mt-2.5 max-w-3xl text-body leading-relaxed text-ink-2">
            {CATEGORIES[category].detail}
          </p>
        </div>
      )}

      {/* ---- Results ------------------------------------------------------ */}
      <p className="mb-5 text-[13px] text-ink-3 tabular-nums">
        {results.length} {results.length === 1 ? "movement" : "movements"}
      </p>

      {!hydrated ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : results.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((movement, index) => (
            <MovementCard
              key={movement.id}
              movement={movement}
              index={index}
              onAddToFlow={addToFlow}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Search size={18} />}
          title="Nothing matches those filters"
          description="Try widening the level or focus, or clear the search term."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setCategory("all");
                setLevel("all");
                setFocus("all");
                setFavoritesOnly(false);
                setSearch("");
              }}
            >
              Reset filters
            </Button>
          }
        />
      )}

      <FlowComposer
        draft={flowDraft}
        onRemove={(id) =>
          setFlowDraft((current) => current.filter((m) => m.id !== id))
        }
        onReorder={setFlowDraft}
        onClear={() => setFlowDraft([])}
      />
    </div>
  );
}
