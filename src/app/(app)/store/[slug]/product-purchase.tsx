"use client";

import * as React from "react";
import { Check, ShieldCheck } from "lucide-react";
import type { Product } from "@/types";
import { Button } from "@/components/ui/button";
import { Toast } from "@/components/ui/overlay";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { cn, formatPrice } from "@/lib/utils";

export function ProductPurchase({ product }: { product: Product }) {
  const hydrated = useStoreHydrated();
  const owned = useAppStore((s) => s.owned.includes(product.id));
  const addToCart = useAppStore((s) => s.addToCart);

  const inStockVariants = product.variants?.filter((v) => v.inStock) ?? [];
  const [variantId, setVariantId] = React.useState(
    inStockVariants[0]?.id ?? undefined,
  );
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className="surface-card p-6">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[26px] leading-none font-medium tracking-[-0.03em] text-ink tabular-nums">
          {formatPrice(product.priceCents, product.currency)}
        </span>
        {product.compareAtCents && (
          <span className="text-small text-ink-3 line-through tabular-nums">
            {formatPrice(product.compareAtCents, product.currency)}
          </span>
        )}
      </div>

      {product.variants && product.variants.length > 0 && (
        <div className="mt-6">
          <p className="mb-2.5 text-[13px] font-medium text-ink-2">Size</p>
          <div className="flex flex-wrap gap-1.5">
            {product.variants.map((variant) => (
              <button
                key={variant.id}
                disabled={!variant.inStock}
                onClick={() => setVariantId(variant.id)}
                aria-pressed={variantId === variant.id}
                className={cn(
                  "h-9 min-w-11 rounded-[9px] border px-3 text-[13px] transition-all duration-200",
                  !variant.inStock &&
                    "cursor-not-allowed border-line text-ink-3/40 line-through",
                  variant.inStock && variantId === variant.id
                    ? "border-accent-hi bg-accent-hi font-medium text-void"
                    : variant.inStock &&
                        "border-line text-ink-2 hover:border-line-strong hover:text-ink",
                )}
              >
                {variant.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {hydrated && owned ? (
          <>
            <div className="flex items-center gap-2 rounded-[11px] border border-positive/30 bg-positive/8 px-4 py-3 text-small text-positive">
              <Check size={15} />
              You already own this
            </div>
            <Button href="/owned" variant="secondary" className="w-full">
              Open in your library
            </Button>
          </>
        ) : (
          <>
            <Button
              className="w-full"
              size="lg"
              onClick={() => {
                addToCart({ productId: product.id, variantId, quantity: 1 });
                setToast("Added to cart");
              }}
            >
              Add to cart
            </Button>
            <Button href="/store/cart" variant="secondary" className="w-full">
              Go to checkout
            </Button>
          </>
        )}
      </div>

      <div className="mt-6 flex items-start gap-2.5 border-t border-line pt-5">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-ink-3" />
        <p className="text-[12px] leading-relaxed text-ink-3">
          {product.kind === "digital"
            ? "Lifetime access with free updates. Cancel any subscription at any time; purchased products stay yours."
            : "Secure checkout via Stripe. Free returns within 30 days."}
        </p>
      </div>

      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}
