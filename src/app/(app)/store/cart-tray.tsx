"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";
import { getProductById } from "@/lib/data/repository";
import { formatPrice } from "@/lib/utils";

/** Persistent cart summary that follows you across the storefront. */
export function CartTray() {
  const hydrated = useStoreHydrated();
  const cart = useAppStore((s) => s.cart);

  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = cart.reduce((sum, line) => {
    const product = getProductById(line.productId);
    return sum + (product ? product.priceCents * line.quantity : 0);
  }, 0);

  return (
    <AnimatePresence>
      {hydrated && count > 0 && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 34 }}
          className="fixed inset-x-3 bottom-20 z-50 mx-auto max-w-md lg:right-8 lg:bottom-8 lg:left-auto lg:mx-0"
        >
          <Link
            href="/store/cart"
            className="surface-elevated flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:border-line-strong"
          >
            <ShoppingBag size={17} className="text-accent" />
            <span className="flex-1">
              <span className="block text-[13px] font-medium text-ink">
                {count} {count === 1 ? "item" : "items"} in your cart
              </span>
              <span className="block text-[12px] text-ink-3 tabular-nums">
                {formatPrice(subtotal)} subtotal
              </span>
            </span>
            <span className="text-[13px] text-accent-hi">Checkout</span>
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
