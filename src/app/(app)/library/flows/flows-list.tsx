"use client";

import * as React from "react";
import Link from "next/link";
import { Heart, ListMusic, Play, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { EmptyState, SkeletonCard } from "@/components/ui/primitives";
import { MovementRow } from "@/components/movement/movement-card";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { getMovementById } from "@/lib/data/repository";
import { formatDuration, relativeTime } from "@/lib/utils";

export function FlowsList() {
  const hydrated = useStoreHydrated();
  const flows = useAppStore((s) => s.flows);
  const deleteFlow = useAppStore((s) => s.deleteFlow);
  const favorites = useAppStore((s) => s.favorites);

  const favoriteMovements = React.useMemo(
    () => favorites.map(getMovementById).filter((m) => m !== null),
    [favorites],
  );

  if (!hydrated) {
    return (
      <div className="grid gap-4 py-8 sm:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="space-y-12 py-8">
      {/* ---- Flows -------------------------------------------------------- */}
      <section>
        <h2 className="text-heading text-ink">Sequences</h2>
        {flows.length ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {flows.map((flow) => {
              const movements = flow.items
                .map((item) => getMovementById(item.movementId))
                .filter((m) => m !== null);
              const totalSec = flow.items.reduce(
                (sum, item) => sum + item.durationSec,
                0,
              );
              return (
                <article key={flow.id} className="surface-card p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="text-[16px] font-medium tracking-[-0.012em] text-ink">
                        {flow.name}
                      </h3>
                      <p className="mt-1 text-[12px] text-ink-3 tabular-nums">
                        {flow.items.length} movements ·{" "}
                        {formatDuration(Math.round(totalSec / 60))} · saved{" "}
                        {relativeTime(flow.createdAt)}
                      </p>
                      {flow.description && (
                        <p className="mt-2.5 text-small leading-relaxed text-ink-2">
                          {flow.description}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <IconButton label={`Start ${flow.name}`}>
                        <Play size={15} />
                      </IconButton>
                      <IconButton
                        label={`Delete ${flow.name}`}
                        onClick={() => deleteFlow(flow.id)}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                  </div>

                  <div className="mt-4 space-y-1.5">
                    {movements.map((movement, index) => (
                      <MovementRow
                        key={`${flow.id}-${movement.id}`}
                        movement={movement}
                        right={
                          <span className="text-[11px] text-ink-3 tabular-nums">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                        }
                      />
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mt-5">
            <EmptyState
              icon={<ListMusic size={18} />}
              title="No flows yet"
              description="Add movements from the library using the + button on any card. They collect in a tray you can name and save."
              action={
                <Button href="/library" variant="secondary">
                  Open the library
                </Button>
              }
            />
          </div>
        )}
      </section>

      {/* ---- Favourites ---------------------------------------------------- */}
      <section>
        <h2 className="text-heading text-ink">Favourites</h2>
        <p className="mt-2 text-small text-ink-3">
          Pinned movements, available offline once their media is downloaded.
        </p>
        {favoriteMovements.length ? (
          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {favoriteMovements.map((movement) => (
              <MovementRow
                key={movement.id}
                movement={movement}
                right={
                  <Link
                    href={`/library/${movement.slug}`}
                    className="text-[12px] text-ink-3 hover:text-ink"
                  >
                    Open
                  </Link>
                }
              />
            ))}
          </div>
        ) : (
          <div className="mt-5">
            <EmptyState
              icon={<Heart size={18} />}
              title="Nothing pinned yet"
              description="Favourite a movement to keep it here."
            />
          </div>
        )}
      </section>
    </div>
  );
}
