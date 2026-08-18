"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "metal" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  // Solid dark with light text — the workhorse
  primary:
    "bg-ink text-void border border-transparent hover:bg-accent-hi hover:shadow-[0_0_28px_-10px_rgba(228,228,231,0.55)]",
  // Ghost / outline
  secondary:
    "bg-surface text-ink border border-line hover:border-line-strong hover:bg-elevated",
  ghost:
    "bg-transparent text-ink-2 border border-transparent hover:text-ink hover:bg-elevated",
  // Subtle metallic border on near-black — for premium CTAs
  metal:
    "bg-elevated text-ink border border-titanium/35 hover:border-titanium/70 hover:shadow-glow",
  danger:
    "bg-transparent text-danger border border-danger/35 hover:bg-danger/10 hover:border-danger/60",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-[9px]",
  md: "h-10 px-4 text-small gap-2 rounded-[11px]",
  lg: "h-12 px-6 text-body gap-2.5 rounded-[13px]",
};

const BASE =
  "relative inline-flex select-none items-center justify-center font-medium whitespace-nowrap " +
  "transition-[transform,background-color,border-color,color,box-shadow,opacity] duration-200 " +
  "ease-[var(--ease-out-quint)] active:scale-[0.985] hover:-translate-y-px " +
  "disabled:pointer-events-none disabled:opacity-40 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Renders as a next/link while keeping identical visuals. */
  href?: string;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "primary", size = "md", href, loading, children, ...props },
    ref,
  ) {
    const classes = cn(BASE, VARIANTS[variant], SIZES[size], className);

    if (href) {
      return (
        <Link href={href} className={classes} aria-busy={loading || undefined}>
          {children}
        </Link>
      );
    }

    return (
      <button
        ref={ref}
        className={classes}
        aria-busy={loading || undefined}
        disabled={loading || props.disabled}
        {...props}
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
          </span>
        ) : (
          children
        )}
      </button>
    );
  },
);

/** Compact icon-only action, used in cards and media chrome. */
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconButton({ className, label, active, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "inline-grid h-9 w-9 place-items-center rounded-[10px] border transition-all duration-200",
        "ease-[var(--ease-out-quint)] active:scale-95",
        active
          ? "border-accent/45 bg-accent/12 text-accent-hi"
          : "border-line bg-surface/70 text-ink-3 hover:border-line-strong hover:text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
