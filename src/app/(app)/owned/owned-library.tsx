"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check, CloudDownload, HardDriveDownload, LibraryBig, Play } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { EmptyState, Progress, Skeleton } from "@/components/ui/primitives";
import { Toast } from "@/components/ui/overlay";
import { PRODUCT_TYPE_LABELS, OWNED_ITEMS } from "@/lib/data/products";
import { posterStyle } from "@/lib/data/taxonomy";
import { getProductById } from "@/lib/data/repository";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { relativeTime } from "@/lib/utils";

export function OwnedLibrary() {
  const params = useSearchParams();
  const hydrated = useStoreHydrated();
  const owned = useAppStore((s) => s.owned);
  const downloads = useAppStore((s) => s.downloads);
  const toggleDownload = useAppStore((s) => s.toggleDownload);

  const [toast, setToast] = React.useState<string | null>(
    params.get("purchased") ? "Purchase complete — added to your library" : null,
  );

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const items = React.useMemo(() => {
    const progressById = new Map(
      OWNED_ITEMS.map((item) => [item.productId, item]),
    );
    return owned
      .map((productId) => {
        const product = getProductById(productId);
        if (!product) return null;
        return {
          product,
          meta: progressById.get(productId) ?? {
            productId,
            purchasedAt: new Date().toISOString(),
            progressPct: 0,
            downloaded: false,
          },
        };
      })
      .filter((entry) => entry !== null);
  }, [owned]);

  if (!hydrated) {
    return (
      <div className="space-y-3 py-8">
        <Skeleton className="h-28 w-full rounded-card" />
        <Skeleton className="h-28 w-full rounded-card" />
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="py-8">
        <EmptyState
          icon={<LibraryBig size={18} />}
          title="Nothing here yet"
          description="Programs, manuals, video series, and audio guides you buy will appear here, downloadable for offline training."
          action={
            <Button href="/store" variant="secondary">
              Browse the store
            </Button>
          }
        />
      </div>
    );
  }

  const downloadedCount = items.filter((i) =>
    downloads.includes(i.product.id),
  ).length;

  return (
    <div className="space-y-6 py-8">
      <div className="surface-card flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <HardDriveDownload size={16} className="text-ink-3" />
          <p className="text-small text-ink-2">
            {downloadedCount} of {items.length} available offline
          </p>
        </div>
        <p className="text-[12px] text-ink-3">
          Downloads are cached by the service worker and survive going offline.
        </p>
      </div>

      <ul className="space-y-3">
        {items.map(({ product, meta }) => {
          const downloaded = downloads.includes(product.id);
          return (
            <li key={product.id} className="surface-card p-5">
              <div className="flex flex-wrap gap-5">
                <Link
                  href={`/store/${product.slug}`}
                  aria-hidden
                  className="h-24 w-32 shrink-0 rounded-[10px] border border-line"
                  style={posterStyle(product.poster)}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] tracking-[0.1em] text-ink-3 uppercase">
                    {PRODUCT_TYPE_LABELS[product.type]}
                  </p>
                  <h2 className="mt-1.5 text-[17px] font-medium tracking-[-0.012em] text-ink">
                    {product.name}
                  </h2>
                  <p className="mt-1 text-[12px] text-ink-3">
                    Purchased {relativeTime(meta.purchasedAt)}
                    {product.creatorName && ` · by ${product.creatorName}`}
                  </p>

                  <div className="mt-4 max-w-md">
                    <div className="mb-1.5 flex items-center justify-between text-[12px]">
                      <span className="text-ink-3">
                        {meta.progressPct === 100 ? "Complete" : "Progress"}
                      </span>
                      <span className="text-ink-2 tabular-nums">
                        {meta.progressPct}%
                      </span>
                    </div>
                    <Progress
                      value={meta.progressPct}
                      tone={meta.progressPct === 100 ? "positive" : "accent"}
                    />
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end justify-between gap-3">
                  <IconButton
                    label={
                      downloaded
                        ? `Remove ${product.name} download`
                        : `Download ${product.name} for offline`
                    }
                    active={downloaded}
                    onClick={() => {
                      toggleDownload(product.id);
                      setToast(
                        downloaded
                          ? "Removed from offline storage"
                          : "Downloading for offline use",
                      );
                    }}
                  >
                    {downloaded ? <Check size={15} /> : <CloudDownload size={15} />}
                  </IconButton>
                  <Button size="sm" variant="secondary">
                    <Play size={13} />
                    {meta.progressPct > 0 && meta.progressPct < 100
                      ? "Resume"
                      : "Open"}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}
