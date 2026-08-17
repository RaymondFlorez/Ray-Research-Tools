"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/primitives";
import { Toast } from "@/components/ui/overlay";
import { posterStyle } from "@/lib/data/taxonomy";
import { PRODUCT_TYPE_LABELS } from "@/lib/data/products";
import { getProductById } from "@/lib/data/repository";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { formatPrice } from "@/lib/utils";

const TAX_RATE = 0.0875;

export function CartView() {
  const router = useRouter();
  const hydrated = useStoreHydrated();
  const cart = useAppStore((s) => s.cart);
  const updateQuantity = useAppStore((s) => s.updateCartQuantity);
  const removeFromCart = useAppStore((s) => s.removeFromCart);
  const clearCart = useAppStore((s) => s.clearCart);
  const grantOwnership = useAppStore((s) => s.grantOwnership);

  const [processing, setProcessing] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const lines = cart
    .map((line) => ({ line, product: getProductById(line.productId) }))
    .filter((entry) => entry.product !== null);

  const subtotal = lines.reduce(
    (sum, { line, product }) => sum + product!.priceCents * line.quantity,
    0,
  );
  const hasPhysical = lines.some(({ product }) => product!.kind === "physical");
  const shipping = hasPhysical ? 900 : 0;
  const tax = Math.round(subtotal * TAX_RATE);
  const total = subtotal + shipping + tax;

  /**
   * Checkout calls our own API route, which in production creates a Stripe
   * Checkout Session and redirects. Here it resolves locally and grants the
   * digital entitlements so the owned-library flow is exercisable end to end.
   */
  const checkout = async () => {
    setProcessing(true);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: cart }),
      });
      const result = await response.json();

      if (result.url) {
        // Stripe Checkout redirect — leaves the SPA entirely.
        window.location.assign(result.url);
        return;
      }

      grantOwnership(
        lines
          .filter(({ product }) => product!.kind === "digital")
          .map(({ product }) => product!.id),
      );
      clearCart();
      router.push("/owned?purchased=1");
    } catch {
      setToast("Checkout is unavailable right now — nothing was charged");
      setProcessing(false);
    }
  };

  if (!hydrated) {
    return (
      <div className="space-y-3 py-8">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    );
  }

  if (!lines.length) {
    return (
      <div className="py-8">
        <EmptyState
          icon={<ShoppingBag size={18} />}
          title="Your cart is empty"
          description="Programs, manuals, and gear are in the store. Digital products land in your library instantly."
          action={
            <Button href="/store" variant="secondary">
              Browse the store
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <ul className="space-y-3">
        {lines.map(({ line, product }) => (
          <li key={line.productId} className="surface-card flex gap-4 p-4">
            <Link
              href={`/store/${product!.slug}`}
              aria-hidden
              className="h-20 w-24 shrink-0 rounded-[10px] border border-line"
              style={posterStyle(product!.poster)}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] tracking-[0.1em] text-ink-3 uppercase">
                {PRODUCT_TYPE_LABELS[product!.type]}
              </p>
              <h3 className="mt-1 text-[15px] font-medium text-ink">
                <Link
                  href={`/store/${product!.slug}`}
                  className="hover:text-accent-hi"
                >
                  {product!.name}
                </Link>
              </h3>
              {line.variantId && (
                <p className="mt-0.5 text-[12px] text-ink-3 uppercase">
                  Size {line.variantId}
                </p>
              )}
              <div className="mt-3 flex items-center gap-3">
                {product!.kind === "physical" ? (
                  <div className="flex items-center gap-1">
                    <IconButton
                      label="Decrease quantity"
                      className="h-7 w-7"
                      onClick={() =>
                        updateQuantity(line.productId, line.quantity - 1)
                      }
                    >
                      <Minus size={13} />
                    </IconButton>
                    <span className="w-7 text-center text-[13px] text-ink tabular-nums">
                      {line.quantity}
                    </span>
                    <IconButton
                      label="Increase quantity"
                      className="h-7 w-7"
                      onClick={() =>
                        updateQuantity(line.productId, line.quantity + 1)
                      }
                    >
                      <Plus size={13} />
                    </IconButton>
                  </div>
                ) : (
                  <span className="text-[12px] text-ink-3">
                    Digital · lifetime access
                  </span>
                )}
                <button
                  onClick={() => removeFromCart(line.productId)}
                  className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-ink-3 transition-colors hover:text-danger"
                >
                  <Trash2 size={13} />
                  Remove
                </button>
              </div>
            </div>
            <p className="shrink-0 text-[15px] font-medium text-ink tabular-nums">
              {formatPrice(product!.priceCents * line.quantity, product!.currency)}
            </p>
          </li>
        ))}
      </ul>

      <aside className="min-w-0 lg:sticky lg:top-8 lg:self-start">
        <div className="surface-card p-5">
          <h2 className="text-[15px] font-medium text-ink">Order summary</h2>
          <dl className="mt-4 space-y-2.5 text-small">
            <SummaryRow label="Subtotal" value={formatPrice(subtotal)} />
            <SummaryRow
              label="Shipping"
              value={hasPhysical ? formatPrice(shipping) : "—"}
            />
            <SummaryRow label="Estimated tax" value={formatPrice(tax)} />
            <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
              <dt className="text-[15px] font-medium text-ink">Total</dt>
              <dd className="text-[19px] font-medium text-ink tabular-nums">
                {formatPrice(total)}
              </dd>
            </div>
          </dl>

          <Button
            className="mt-5 w-full"
            size="lg"
            onClick={checkout}
            loading={processing}
          >
            <Lock size={14} />
            Secure checkout
          </Button>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
            Payments are processed by Stripe. This build runs against a local
            checkout stub — no card is collected and nothing is charged.
          </p>
        </div>
      </aside>

      <Toast message={toast} open={Boolean(toast)} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink-2 tabular-nums">{value}</dd>
    </div>
  );
}
