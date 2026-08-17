"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import { Check, Download, ShoppingBag } from "lucide-react";
import type { Product, ProductKind } from "@/types";
import { PRODUCT_TYPE_LABELS } from "@/lib/data/products";
import { posterStyle } from "@/lib/data/taxonomy";
import { Badge, Segmented } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Toast } from "@/components/ui/overlay";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { cn, formatPrice } from "@/lib/utils";
import { CartTray } from "./cart-tray";

type Filter = "all" | ProductKind | "featured";

export function StoreBrowser({ products }: { products: Product[] }) {
  const params = useSearchParams();
  const hydrated = useStoreHydrated();
  const owned = useAppStore((s) => s.owned);
  const addToCart = useAppStore((s) => s.addToCart);

  const [filter, setFilter] = React.useState<Filter>(
    (params.get("kind") as Filter) ?? "all",
  );
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const filtered = React.useMemo(() => {
    if (filter === "all") return products;
    if (filter === "featured") return products.filter((p) => p.featured);
    return products.filter((p) => p.kind === filter);
  }, [products, filter]);

  const featured = products.filter((p) => p.featured).slice(0, 2);

  return (
    <div className="space-y-10 py-8">
      {/* ---- Featured ----------------------------------------------------- */}
      {filter === "all" && featured.length > 0 && (
        <section className="grid gap-4 lg:grid-cols-2">
          {featured.map((product) => (
            <Link
              key={product.id}
              href={`/store/${product.slug}`}
              className="group surface-card relative flex min-h-56 flex-col justify-end overflow-hidden p-7 transition-all duration-300 ease-[var(--ease-out-quint)] hover:-translate-y-1 hover:border-line-strong hover:shadow-mid"
            >
              <span
                aria-hidden
                className="absolute inset-0"
                style={posterStyle(product.poster)}
              />
              <span
                aria-hidden
                className="absolute inset-0 bg-gradient-to-t from-void via-void/50 to-transparent"
              />
              <span className="relative">
                <Badge tone="accent">{PRODUCT_TYPE_LABELS[product.type]}</Badge>
                <h2 className="mt-3.5 text-[22px] leading-tight font-medium tracking-[-0.02em] text-ink">
                  {product.name}
                </h2>
                <p className="mt-2 max-w-sm text-small leading-relaxed text-ink-2">
                  {product.tagline}
                </p>
                <p className="mt-4 text-[15px] font-medium text-ink tabular-nums">
                  {formatPrice(product.priceCents, product.currency)}
                </p>
              </span>
            </Link>
          ))}
        </section>
      )}

      {/* ---- Filters ------------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Everything", count: products.length },
            {
              value: "digital",
              label: "Digital",
              count: products.filter((p) => p.kind === "digital").length,
            },
            {
              value: "physical",
              label: "Merch & gear",
              count: products.filter((p) => p.kind === "physical").length,
            },
            {
              value: "featured",
              label: "Featured",
              count: products.filter((p) => p.featured).length,
            },
          ]}
        />
        <Button href="/store/cart" variant="secondary" size="sm">
          <ShoppingBag size={14} />
          Cart
        </Button>
      </div>

      {/* ---- Grid ---------------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((product, index) => {
          const isOwned = hydrated && owned.includes(product.id);
          return (
            <motion.article
              key={product.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.5,
                delay: Math.min(index * 0.035, 0.3),
                ease: [0.22, 1, 0.36, 1],
              }}
              className="surface-card group flex flex-col transition-all duration-300 ease-[var(--ease-out-quint)] hover:-translate-y-1 hover:border-line-strong hover:shadow-mid"
            >
              <Link
                href={`/store/${product.slug}`}
                className="relative block aspect-4/3 overflow-hidden"
                style={posterStyle(product.poster)}
              >
                <span className="absolute top-3 left-3">
                  <Badge>{PRODUCT_TYPE_LABELS[product.type]}</Badge>
                </span>
                {product.kind === "digital" && (
                  <span className="absolute right-3 bottom-3 grid h-7 w-7 place-items-center rounded-full border border-line bg-void/70 text-ink-3 backdrop-blur-sm">
                    <Download size={13} />
                  </span>
                )}
              </Link>

              <div className="flex flex-1 flex-col p-4">
                <h3 className="text-[15px] leading-snug font-medium tracking-[-0.01em] text-ink">
                  <Link
                    href={`/store/${product.slug}`}
                    className="hover:text-accent-hi"
                  >
                    {product.name}
                  </Link>
                </h3>
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-ink-2">
                  {product.tagline}
                </p>
                {product.creatorName && (
                  <p className="mt-2 text-[12px] text-ink-3">
                    By {product.creatorName}
                  </p>
                )}

                <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[15px] font-medium text-ink tabular-nums">
                      {formatPrice(product.priceCents, product.currency)}
                    </span>
                    {product.compareAtCents && (
                      <span className="text-[12px] text-ink-3 line-through tabular-nums">
                        {formatPrice(product.compareAtCents, product.currency)}
                      </span>
                    )}
                  </span>
                  {isOwned ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-positive">
                      <Check size={13} />
                      Owned
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        addToCart({
                          productId: product.id,
                          quantity: 1,
                          variantId: product.variants?.find((v) => v.inStock)?.id,
                        });
                        setToast(`${product.name} added to cart`);
                      }}
                    >
                      Add
                    </Button>
                  )}
                </div>
              </div>
            </motion.article>
          );
        })}
      </div>

      {/* ---- Creator note --------------------------------------------------- */}
      <section className={cn("surface-card p-6")}>
        <p className="eyebrow">For coaches and creators</p>
        <h2 className="mt-3 text-[17px] font-medium text-ink">
          Publish your own Alpha Movement-aligned products.
        </h2>
        <p className="mt-2.5 max-w-2xl text-small leading-relaxed text-ink-2">
          Approved coaches can publish programs, video series, manuals, and audio
          guides through the platform. Every submission is reviewed against the
          system&rsquo;s principles before it reaches the storefront — the
          moderation queue lives in the admin panel.
        </p>
        <Button href="/admin" variant="secondary" size="sm" className="mt-4">
          Open the moderation queue
        </Button>
      </section>

      <CartTray />
      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}
