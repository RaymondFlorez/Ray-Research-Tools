"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./button";

const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.9 } as const;

/**
 * Modal — elevated #1C1C1F surface, spring entrance, focus trapped to the panel.
 * On narrow viewports it becomes a bottom sheet, which is how the mobile app reads.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );
      if (!focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-100 flex items-end justify-center sm:items-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            onClick={onClose}
            className="absolute inset-0 bg-void/80 backdrop-blur-sm"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.985 }}
            transition={SPRING}
            className={cn(
              "surface-elevated relative z-10 flex max-h-[88dvh] w-full flex-col",
              "rounded-b-none sm:rounded-b-panel",
              widths[size],
            )}
          >
            <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
              <div>
                <h2 className="text-heading text-ink">{title}</h2>
                {description && (
                  <p className="mt-1.5 text-small text-ink-2">{description}</p>
                )}
              </div>
              <IconButton label="Close" onClick={onClose}>
                <X size={16} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
            {footer && (
              <div className="flex items-center justify-end gap-3 border-t border-line px-6 py-4">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * Reveal — scroll-triggered entrance used across marketing and philosophy pages.
 * Deliberately restrained: 14px of travel, no bounce.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  y = 14,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  y?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Hover-lift wrapper for grid items that need spring physics rather than CSS. */
export function Lift({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.995 }}
      transition={SPRING}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Toast host — minimal, bottom-center, auto-dismiss. */
export function Toast({
  message,
  open,
}: {
  message: string | null;
  open: boolean;
}) {
  return (
    <AnimatePresence>
      {open && message && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={SPRING}
          role="status"
          className="pointer-events-none fixed bottom-24 left-1/2 z-100 -translate-x-1/2 rounded-pill border border-line bg-elevated px-4 py-2.5 text-small text-ink shadow-high md:bottom-8"
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
