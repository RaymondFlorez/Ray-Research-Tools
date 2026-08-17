"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

type Tone = "neutral" | "accent" | "positive" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "border-line bg-elevated text-ink-2",
  accent: "border-titanium/30 bg-titanium/10 text-accent-hi",
  positive: "border-positive/30 bg-positive/10 text-positive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5",
        "text-[11px] leading-5 font-medium tracking-[0.02em] whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Input / Textarea / Select — dark surfaces with accent focus rings          */
/* -------------------------------------------------------------------------- */

const FIELD =
  "w-full rounded-[11px] border border-line bg-void/60 px-3.5 text-small text-ink " +
  "placeholder:text-ink-3 transition-all duration-200 " +
  "hover:border-line-strong " +
  "focus:border-accent/55 focus:ring-2 focus:ring-accent/18 focus:outline-none " +
  "disabled:opacity-45";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(FIELD, "h-10", className)} {...props} />;
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(FIELD, "min-h-24 resize-y py-2.5 leading-relaxed", className)}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        FIELD,
        "h-10 appearance-none bg-[length:14px] bg-[right_0.85rem_center] bg-no-repeat pr-9",
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2371717a%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>')]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const id = React.useId();
  return (
    <label className={cn("block", className)} htmlFor={id}>
      <span className="mb-1.5 flex items-center gap-1 text-[13px] font-medium text-ink-2">
        {label}
        {required && <span className="text-danger">*</span>}
      </span>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {hint && <span className="mt-1.5 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton — refined dark shimmer, never a spinner                           */
/* -------------------------------------------------------------------------- */

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton", className)} aria-hidden {...props} />;
}

export function SkeletonCard() {
  return (
    <div className="surface-card p-5">
      <Skeleton className="mb-4 h-32 w-full rounded-[10px]" />
      <Skeleton className="mb-2.5 h-3.5 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-4/5" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Segmented control — the app's primary filter affordance                    */
/* -------------------------------------------------------------------------- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "md",
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex flex-wrap items-center gap-1 rounded-pill border border-line bg-surface/70 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative rounded-pill font-medium transition-all duration-250 ease-[var(--ease-out-quint)]",
              size === "sm" ? "px-3 py-1 text-[12px]" : "px-3.5 py-1.5 text-[13px]",
              active
                ? "bg-ink text-void shadow-low"
                : "text-ink-3 hover:bg-elevated hover:text-ink",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={cn(
                  "ml-1.5 tabular-nums",
                  active ? "text-void/55" : "text-ink-3/70",
                )}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Progress + Stat                                                            */
/* -------------------------------------------------------------------------- */

export function Progress({
  value,
  className,
  tone = "accent",
}: {
  value: number;
  className?: string;
  tone?: "accent" | "positive" | "warning";
}) {
  const tones = {
    accent: "from-titanium to-accent-hi",
    positive: "from-positive/70 to-positive",
    warning: "from-warning/70 to-warning",
  };
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1 w-full overflow-hidden rounded-pill bg-line", className)}
    >
      <div
        className={cn(
          "h-full rounded-pill bg-gradient-to-r transition-[width] duration-700 ease-[var(--ease-out-quint)]",
          tones[tone],
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  delta,
  className,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  delta?: { value: string; positive?: boolean };
  className?: string;
}) {
  return (
    <div className={cn("surface-card px-5 py-4", className)}>
      <p className="eyebrow">{label}</p>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[1.75rem] leading-none font-medium tracking-[-0.03em] text-ink tabular-nums">
          {value}
        </span>
        {unit && <span className="text-small text-ink-3">{unit}</span>}
      </div>
      {delta && (
        <p
          className={cn(
            "mt-2 text-[12px]",
            delta.positive === false ? "text-warning" : "text-positive",
          )}
        >
          {delta.value}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-panel border border-dashed border-line px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 grid h-11 w-11 place-items-center rounded-full border border-line bg-elevated text-ink-3">
          {icon}
        </div>
      )}
      <h3 className="text-[15px] font-medium text-ink">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-small leading-relaxed text-ink-3">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
